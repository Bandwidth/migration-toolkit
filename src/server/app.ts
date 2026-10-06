import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import formbody from "@fastify/formbody";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import {
  translateTwiml,
  type UrlKind,
  type RewriteContext,
  type TranslateOptions,
} from "../translator/translate.js";
import { TwilioStreamBridge, customParametersFromBwStart } from "../streams/bridge.js";
import { BwWebSocketSource } from "../streams/bw-source.js";
import { bxmlDocument } from "../xml/build-xml.js";
import {
  initiateParams,
  gatherParams,
  statusParams,
  recordingStatusParams,
  dialActionParams,
  recordActionParams,
  bwCauseToDialCallStatus,
  postToCustomer,
} from "../twilio/egress.js";
import { EgressBlockedError, assertPublicUrl } from "../twilio/egress-guard.js";
import { toCallSid, toRecordingSid } from "../twilio/call-sid.js";
import { createdCallResource, bwStateToTwilioStatus, twilioErrors } from "../twilio/call-resource.js";
import { serverErrors } from "./errors.js";
import {
  recordingList,
  recordingResource,
  iso8601DurationToSeconds,
  bwRecordingStatus,
} from "../twilio/recording-resource.js";
import { CallStore, type CallRecord } from "./call-store.js";
import { isSafeBwId, type BwClient } from "../bw/client.js";
import { checkReadiness } from "./readiness.js";
import { safeEqual } from "./safe-equal.js";
import { captureTwiml, captureStreamFrame } from "./capture.js";

export interface ServerConfig {
  accountSid: string;
  authToken: string;
  publicBaseUrl: string;
  voiceUrl: string;
  /** Allow outbound fetches to private/loopback ranges (local dev). Default false. */
  allowPrivateEgress?: boolean;
  /** Opt-in egress allowlist of expected customer hosts. Empty/undefined → range denylist applies. */
  egressAllowHosts?: string[];
  /** Basic-auth credentials Bandwidth presents on inbound webhooks (must match the app's CallbackCreds). */
  webhookUser: string;
  webhookPassword: string;
  /** Opt-in dir to persist each customer TwiML response for the later BXML Generator, and
   *  raw Bandwidth StartStream frames under <dir>/streams/. Undefined → no capture. */
  captureDir?: string;
  /** How long a Bandwidth StartStream WebSocket may sit without a "start" event before it is closed. Default 5000. */
  streamStartTimeoutMs?: number;
  /** How long the bridge waits for the bot's WebSocket handshake before giving up and ending the
   *  Bandwidth stream. Bounds a bot that accepts TCP but never completes the upgrade. Default 10000. */
  streamBotConnectTimeoutMs?: number;
  /** Passed to TwilioStreamBridge.playoutLatencyPadMs for every stream. Default 0. */
  streamPlayoutLatencyPadMs?: number;
  /** How long a transferComplete waits for the dialed leg's transferDisconnect
   *  event before answering the Dial action without DialCallSid/DialCallDuration.
   *  Bandwidth documents no ordering between the two. Default 400. */
  transferLegWaitMs?: number;
}

export interface ServerDeps {
  fetchImpl: typeof fetch;
  bwClient: BwClient;
}

interface BwEvent {
  eventType: string;
  callId: string;
  from?: string;
  to?: string;
  direction?: string;
  digits?: string;
  terminatingDigit?: string;
  text?: string; // BW gather event speech transcription
  startTime?: string; // BW call answer/start time (for status-callback duration)
  answerTime?: string;
  endTime?: string; // BW call end time
  cause?: string; // transferComplete / transferDisconnect / disconnect
  parentCallId?: string; // transferDisconnect: the call that ran the <Transfer>
  transferTo?: string;
  recordingId?: string; // recordComplete
  duration?: string; // recordComplete, ISO-8601
  channels?: number;
}

/** Bandwidth's speech gather reports a timeout as this text rather than "". */
const SPEECH_TIMEOUT_TEXT = /^speech timeout elapsed/i;

/** True when a gather event carries no usable input, i.e. Twilio's "no digits or speech" case. */
function gatherIsEmpty(event: BwEvent): boolean {
  const hasDigits = typeof event.digits === "string" && event.digits.length > 0;
  const hasSpeech =
    typeof event.text === "string" && event.text.length > 0 && !SPEECH_TIMEOUT_TEXT.test(event.text);
  return !hasDigits && !hasSpeech;
}

/** Whole seconds between two ISO timestamps, or undefined if either is missing/invalid. */
function secondsBetween(start?: string, end?: string): number | undefined {
  if (!start || !end) return undefined;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : undefined;
}

interface BwRecordingEvent {
  eventType?: string;
  callId: string;
  recordingId: string;
  mediaUrl?: string;
  duration?: string; // ISO-8601 duration, e.g. "PT13.5S"
  channels?: number;
  status?: string;
  startTime?: string;
}

export function buildApp(config: ServerConfig, deps: ServerDeps): FastifyInstance {
  // Logging off by default; set TRANSLATOR_LOG=1 to enable request/error logs.
  const app = Fastify({ logger: process.env.TRANSLATOR_LOG === "1" });
  app.register(formbody);

  app.setErrorHandler((err, _req, reply) => {
    // Full detail (incl. upstream bodies) goes to logs only, never the response.
    app.log.error({ err }, "unhandled translator error");
    const sc = (err as { statusCode?: number }).statusCode;
    // Preserve a client-error status Fastify already classified (e.g. malformed
    // body → 400); everything else is a neutral internal 500. We do NOT relabel
    // arbitrary throws as "Bandwidth" failures or forward err.message.
    if (sc && sc >= 400 && sc < 500) {
      return reply.code(sc).send({ ...serverErrors.internal(), status: sc, code: 90003, message: "Invalid request" });
    }
    return reply.code(500).send(serverErrors.internal());
  });

  const expectedWebhookAuth =
    "Basic " + Buffer.from(`${config.webhookUser}:${config.webhookPassword}`).toString("base64");
  // Bandwidth authenticates its inbound webhooks with Basic auth (CallbackCreds
  // on the Voice app + username/password on the BXML callback verbs we emit).
  // Gate on the ROUTER-matched route (req.routeOptions.url), not the raw
  // req.url: find-my-way percent-decodes the target before matching, so a raw
  // path like /%62%77/continue routes to /bw/continue while never starting with
  // "/bw/". Keying on the matched route closes that decode divergence and can't
  // be bypassed by encoding. onRequest runs before body parsing, so unauthorized
  // requests are rejected before any payload is read.
  app.addHook("onRequest", async (req, reply) => {
    if (!(req.routeOptions?.url ?? "").startsWith("/bw/")) return;
    if (!safeEqual(req.headers.authorization ?? "", expectedWebhookAuth)) {
      return reply.code(401).header("WWW-Authenticate", "Basic").send({ error: "unauthorized" });
    }
  });

  const store = new CallStore();

  const expectedAuth =
    "Basic " + Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");
  const authOk = (req: FastifyRequest) => safeEqual(req.headers.authorization ?? "", expectedAuth);

  // The WebSocket form of PUBLIC_BASE_URL: Bandwidth's StartStream destination
  // must be ws(s)://, so https → wss and http → ws (local dev).
  const publicWsBase = (() => {
    const u = new URL(config.publicBaseUrl);
    u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
    return u.toString().replace(/\/$/, "");
  })();

  /** `doc` identifies one translation, so a Dial's key is unique for the whole
   *  call, not just within its document (two documents can each have "Dial 1"). */
  const rewriter = (base: string, doc: string) => (url: string, kind: UrlKind, ctx?: RewriteContext) => {
    const absolute = new URL(url, base).toString();
    // Recording-available events are async, fire-and-forget (no BXML continuation),
    // so they route to a dedicated egress endpoint rather than /bw/continue.
    if (kind === "recordingStatus") {
      return `${config.publicBaseUrl}/bw/recording-status?cb=${encodeURIComponent(absolute)}`;
    }
    // A Gather's action carries its document position so /bw/continue can resume
    // the document after it when Bandwidth reports no input (Twilio semantics),
    // plus the flag that says the customer wants the action even then.
    if (kind === "action" && ctx?.gatherIndex !== undefined) {
      const onEmpty = ctx.actionOnEmptyResult ? "&onEmpty=1" : "";
      return `${config.publicBaseUrl}/bw/continue?next=${encodeURIComponent(absolute)}&gather=${ctx.gatherIndex}${onEmpty}`;
    }
    // A Dial's action names the Dial (matching its legs' transferDisconnectUrl)
    // and how many legs it rings, so /bw/continue joins only that Dial's legs.
    if (kind === "transfer" && ctx?.dialIndex !== undefined) {
      return `${config.publicBaseUrl}/bw/continue?next=${encodeURIComponent(absolute)}&dial=${doc}.${ctx.dialIndex}&legs=${ctx.dialTargets ?? 1}`;
    }
    // A Twilio <Stream url> is the customer's bot. Bandwidth speaks its own
    // StartStream protocol, so the stream must come to us first; /bw/stream
    // bridges it to the bot in Twilio's Media Streams protocol.
    if (kind === "stream") {
      return `${publicWsBase}/bw/stream?dest=${encodeURIComponent(absolute)}`;
    }
    return `${config.publicBaseUrl}/bw/continue?next=${encodeURIComponent(absolute)}`;
  };

  // ── Media Streams: Bandwidth → /bw/stream → TwilioStreamBridge → bot ───────
  // Fastify has no WebSocket routing of its own, so the HTTP upgrade is taken
  // off the underlying server and handed to ws. The upgrade must carry the same
  // Basic-auth credentials as the /bw/* webhooks (the translator stamps them on
  // StartStream as destinationUsername/destinationPassword), and `dest` goes
  // through the egress guard like any customer-supplied URL. Once Bandwidth's
  // "start" event arrives, a bridge is built per stream; caller audio is held
  // until the bot's socket is open so the first words are not lost.
  const streamServer = new WebSocketServer({ noServer: true });
  const bridges = new Set<TwilioStreamBridge>();

  const rejectUpgrade = (socket: Duplex, status: number, reason: string, extraHeaders = ""): void => {
    if (socket.destroyed) return;
    socket.write(`HTTP/1.1 ${status} ${reason}\r\n${extraHeaders}Connection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  async function handleStreamUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    // Node hands over the raw socket with no error listener; ws attaches one only
    // inside handleUpgrade, and the egress check below can await a DNS lookup for
    // seconds. A reset in that window would otherwise be an uncaught exception.
    socket.on("error", () => socket.destroy());
    const url = new URL(req.url ?? "/", "http://placeholder.invalid");
    if (url.pathname !== "/bw/stream") return rejectUpgrade(socket, 404, "Not Found");
    if (!safeEqual(req.headers.authorization ?? "", expectedWebhookAuth)) {
      return rejectUpgrade(socket, 401, "Unauthorized", "WWW-Authenticate: Basic\r\n");
    }
    const dest = url.searchParams.get("dest");
    if (!dest) return rejectUpgrade(socket, 400, "Bad Request");
    try {
      await assertPublicUrl(dest, {
        allowPrivate: config.allowPrivateEgress,
        allowHosts: config.egressAllowHosts,
        schemes: ["ws:", "wss:"],
      });
    } catch (err) {
      app.log.error({ dest, err }, "stream dest blocked");
      return err instanceof EgressBlockedError
        ? rejectUpgrade(socket, 400, "Bad Request")
        : rejectUpgrade(socket, 500, "Internal Server Error");
    }
    if (socket.destroyed) return;

    streamServer.handleUpgrade(req, socket, head, (ws) => {
      // Per-connection key for capture; never derived from Bandwidth input.
      const captureKey = randomUUID();
      const source = new BwWebSocketSource(ws, {
        onFrame: config.captureDir
          ? (raw) => {
              try {
                captureStreamFrame(config.captureDir!, captureKey, raw);
              } catch (err) {
                app.log.error({ err }, "stream capture failed");
              }
            }
          : undefined,
      });
      let bridge: TwilioStreamBridge | undefined;
      source
        .waitForStart(config.streamStartTimeoutMs ?? 5000)
        .then((start) => {
          bridge = new TwilioStreamBridge({
            botUrl: dest,
            callSid: toCallSid(start.callId),
            accountSid: config.accountSid,
            customParameters: customParametersFromBwStart(start.raw),
            source,
            playoutLatencyPadMs: config.streamPlayoutLatencyPadMs,
            connectTimeoutMs: config.streamBotConnectTimeoutMs,
          });
          const b = bridge;
          bridges.add(b);
          source.once("stop", () => bridges.delete(b));
          app.log.info({ callId: start.callId, streamId: start.streamId, dest }, "stream bridge started");
          return b.ready();
        })
        .then(() => source.release())
        .catch((err) => {
          // No start, or the bot could not be reached: end the Bandwidth stream so
          // the <StopStream wait="true"> returns and the call's BXML moves on.
          app.log.error({ dest, err }, "stream bridge setup failed");
          if (bridge) {
            bridges.delete(bridge);
            bridge.close();
          }
          source.close();
        });
    });
  }

  app.server.on("upgrade", (req, socket, head) => {
    void handleStreamUpgrade(req, socket, head);
  });
  // preClose, not onClose: Fastify waits for the HTTP server's connections to
  // drain before onClose runs, and an upgraded socket counts as one of them, so
  // it must be torn down first or close() would wait for Bandwidth to hang up.
  app.addHook("preClose", async () => {
    for (const b of bridges) b.close();
    bridges.clear();
    // In noServer mode close() does not end established clients, and a socket
    // that upgraded but has not sent "start" yet has no bridge to close it.
    for (const client of streamServer.clients) client.terminate();
    streamServer.close();
  });

  function errorBxml(verbs: string[]): string {
    return bxmlDocument([
      {
        name: "SpeakSentence",
        children: [
          `This application uses a Twilio feature not yet supported by the translator: ${verbs.join(", ")}. The call will now end.`,
        ],
      },
      { name: "Hangup" },
    ]);
  }

  /** Translate a TwiML document already in hand (no customer round-trip). */
  function replyWithTranslation(
    twiml: string,
    documentUrl: string,
    reply: FastifyReply,
    extra: Pick<TranslateOptions, "resumeAfterGather"> = {},
  ) {
    const doc = randomUUID().slice(0, 8);
    const result = translateTwiml(twiml, {
      rewriteUrl: rewriter(documentUrl, doc),
      callbackAuth: { username: config.webhookUser, password: config.webhookPassword },
      transferLegUrl: (dialIndex) => `${config.publicBaseUrl}/bw/transfer-leg?dial=${doc}.${dialIndex}`,
      ...extra,
    });
    if (result.hasErrors) {
      const verbs = [
        ...new Set(result.findings.filter((f) => f.severity === "error").map((f) => f.verb)),
      ];
      app.log.error({ findings: result.findings }, "unsupported TwiML");
      return reply.type("application/xml").send(errorBxml(verbs));
    }
    return reply.type("application/xml").send(result.bxml);
  }

  async function fetchAndTranslate(
    customerUrl: string,
    params: Record<string, string>,
    reply: FastifyReply,
    /** When given, the fetched TwiML is remembered on the record for Gather resume. */
    record?: CallRecord,
  ) {
    // Split the per-turn latency into the customer webhook round-trip (network,
    // not ours) and the TwiML→BXML translation tax (CPU, ours). With TRANSLATOR_LOG=1
    // each turn logs both; see `npm run bench` for the translation tax in isolation.
    const fetchStart = performance.now();
    let twiml: string;
    try {
      twiml = await postToCustomer({
        url: customerUrl,
        params,
        authToken: config.authToken,
        fetchImpl: deps.fetchImpl,
        allowPrivate: config.allowPrivateEgress,
        allowHosts: config.egressAllowHosts,
      });
    } catch (err) {
      if (err instanceof EgressBlockedError) {
        app.log.error({ customerUrl, err }, "egress blocked");
        return reply.code(502).send({ error: "blocked egress target" });
      }
      throw err;
    }
    // Capture the raw customer TwiML (URLs verbatim, pre-rewrite) before we
    // translate it — this is exactly what the BXML Generator ingests to produce
    // standalone BXML for the paths a test call exercised.
    if (config.captureDir) {
      try {
        captureTwiml(config.captureDir, twiml);
      } catch (err) {
        app.log.error({ err }, "twiml capture failed");
      }
    }
    if (record) {
      record.lastTwiml = twiml;
      record.lastTwimlUrl = customerUrl;
      store.put(record.bwCallId, record);
    }
    const translateStart = performance.now();
    const out = replyWithTranslation(twiml, customerUrl, reply);
    app.log.info(
      {
        customerUrl,
        fetchMs: Math.round((translateStart - fetchStart) * 1000) / 1000,
        translateMs: Math.round((performance.now() - translateStart) * 1000) / 1000,
      },
      "fetchAndTranslate timing",
    );
    return out;
  }

  app.post("/bw/initiate", async (req, reply) => {
    const event = req.body as BwEvent;
    if (!event || !isSafeBwId(event.callId)) return reply.code(400).send(serverErrors.invalidParam("callId"));
    const query = req.query as { voiceUrl?: string };
    const existing = store.get(event.callId);
    const voiceUrl = query.voiceUrl ?? existing?.voiceUrl ?? config.voiceUrl;
    const record: CallRecord = existing ?? {
      sid: toCallSid(event.callId),
      bwCallId: event.callId,
      from: event.from ?? "",
      to: event.to ?? "",
      direction: "inbound",
      voiceUrl,
    };
    store.put(event.callId, record);
    return fetchAndTranslate(voiceUrl, initiateParams(record, config.accountSid), reply, record);
  });

  /**
   * Wait briefly for one Dial's legs to report, then pick the leg its action
   * describes. A Dial with several targets rings them at once; when one answers
   * the rest are cancelled and usually report first, so the answered leg wins
   * regardless of arrival order. Waits until a leg that answered has arrived,
   * every expected leg has, or transferLegWaitMs passes.
   */
  async function awaitTransferLeg(parentCallId: string, dialKey: string, expectedLegs: number, parentCause?: string) {
    const deadline = Date.now() + (config.transferLegWaitMs ?? 400);
    let legs = store.peekTransferLegs(parentCallId, dialKey);
    while (!legs.some((l) => l.answerTime) && legs.length < expectedLegs && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      legs = store.peekTransferLegs(parentCallId, dialKey);
    }
    store.dropTransferLegs(parentCallId, dialKey);
    const answered = legs.find((l) => l.answerTime);
    if (answered) return answered;
    // The parent says the transfer bridged but the answered leg has not reported:
    // the legs in hand are the cancelled losers, so report none rather than one of them.
    if (parentCause === "hangup") return undefined;
    return legs.at(-1);
  }

  /** Dial key as minted by the rewriter: `<8 hex>.<index>`. */
  const isDialKey = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}\.\d{1,4}$/.test(v);

  // Synchronous BXML continuations: Bandwidth posts the verb's completion event
  // here (via a rewritten action URL) and executes whatever BXML we answer with.
  // Each event type is reshaped into the params Twilio would send to that verb's
  // action, so the customer's handler branches the way it did on Twilio.
  app.post("/bw/continue", async (req, reply) => {
    const event = req.body as BwEvent;
    if (!event || !isSafeBwId(event.callId)) return reply.code(400).send(serverErrors.invalidParam("callId"));
    const query = req.query as { next?: string; gather?: string; onEmpty?: string; dial?: string; legs?: string };
    if (!query.next) return reply.code(400).send(serverErrors.missingParam("next"));
    const record =
      store.get(event.callId) ??
      ({
        sid: toCallSid(event.callId),
        bwCallId: event.callId,
        from: event.from ?? "",
        to: event.to ?? "",
        direction: "inbound",
        voiceUrl: config.voiceUrl,
      } satisfies CallRecord);

    let params: Record<string, string>;
    switch (event.eventType) {
      case "gather": {
        if (gatherIsEmpty(event) && query.onEmpty !== "1") {
          // Twilio does not request the action on no input; it continues with the
          // verbs after the <Gather>. Bandwidth has already discarded them, so
          // re-translate the document from just past this Gather.
          const gatherIndex = Number(query.gather);
          if (record.lastTwiml && record.lastTwimlUrl && Number.isInteger(gatherIndex) && gatherIndex > 0) {
            return replyWithTranslation(record.lastTwiml, record.lastTwimlUrl, reply, {
              resumeAfterGather: gatherIndex,
            });
          }
          // No document to resume (fresh instance, or an old-style URL): the only
          // way to keep the call alive is to ask the action anyway.
          app.log.warn({ callId: event.callId }, "empty gather with no document to resume; requesting action");
        }
        params = gatherParams(record, config.accountSid, {
          digits: event.digits ?? "",
          speech: event.text !== undefined && !SPEECH_TIMEOUT_TEXT.test(event.text) ? event.text : undefined,
        });
        break;
      }
      case "transferComplete": {
        // A URL without a valid dial key (minted before this change) shares the
        // "" bucket with legs that likewise carry none.
        const legsParam = Number(query.legs);
        const leg = await awaitTransferLeg(
          event.callId,
          isDialKey(query.dial) ? query.dial : "",
          Number.isInteger(legsParam) && legsParam > 0 ? legsParam : 1,
          event.cause,
        );
        // The leg's own cause is authoritative for how the dialed call ended;
        // the parent's cause is the fallback when the leg event has not arrived.
        const cause = leg?.cause ?? event.cause;
        const bridged = leg ? Boolean(leg.answerTime) : cause === "hangup";
        params = dialActionParams(record, config.accountSid, {
          dialCallStatus: bwCauseToDialCallStatus(cause, leg ? bridged : undefined),
          bridged,
          dialCallSid: leg ? toCallSid(leg.bwCallId) : undefined,
          durationSec: leg ? (bridged ? secondsBetween(leg.answerTime, leg.endTime) ?? 0 : 0) : undefined,
        });
        break;
      }
      case "recordComplete": {
        if (event.recordingId && isSafeBwId(event.recordingId)) {
          const recordingSid = toRecordingSid(event.recordingId);
          store.putRecording(recordingSid, { bwCallId: event.callId, bwRecordingId: event.recordingId });
          params = recordActionParams(record, config.accountSid, {
            recordingSid,
            recordingUrl: `${config.publicBaseUrl}/2010-04-01/Accounts/${config.accountSid}/Recordings/${recordingSid}`,
            durationSec: event.duration ? Number(iso8601DurationToSeconds(event.duration)) : 0,
          });
        } else {
          params = { ...initiateParams(record, config.accountSid), CallStatus: "in-progress" };
        }
        break;
      }
      default:
        params = { ...initiateParams(record, config.accountSid), CallStatus: "in-progress" };
    }
    return fetchAndTranslate(query.next, params, reply, record);
  });

  // Async: Bandwidth reports how a dialed (B) leg ended. Held until the parent
  // call's transferComplete arrives, which turns it into Dial action params.
  app.post("/bw/transfer-leg", async (req, reply) => {
    const event = req.body as BwEvent;
    if (!event || !isSafeBwId(event.callId)) return reply.code(400).send(serverErrors.invalidParam("callId"));
    if (!isSafeBwId(event.parentCallId)) return reply.code(400).send(serverErrors.invalidParam("parentCallId"));
    const { dial } = req.query as { dial?: string };
    if (dial !== undefined && !isDialKey(dial)) return reply.code(400).send(serverErrors.invalidParam("dial"));
    if (event.eventType === "transferDisconnect") {
      store.putTransferLeg(event.parentCallId, dial ?? "", {
        bwCallId: event.callId,
        cause: event.cause ?? "unknown",
        startTime: event.startTime,
        answerTime: event.answerTime,
        endTime: event.endTime,
        transferTo: event.transferTo,
      });
    }
    return reply.code(204).send();
  });

  app.post("/bw/disconnect", async (req, reply) => {
    const event = req.body as BwEvent;
    if (!event || !isSafeBwId(event.callId)) return reply.code(400).send(serverErrors.invalidParam("callId"));
    // Legs that reported after their Dial's wait will never be read.
    store.clearTransferLegs(event.callId);
    const record = store.get(event.callId);
    if (record) {
      // Bandwidth bills (and Twilio reports) from answer to end; fall back to 0
      // if the BW event didn't carry timing.
      const durationSec =
        event.startTime && event.endTime
          ? Math.max(0, Math.round((Date.parse(event.endTime) - Date.parse(event.startTime)) / 1000))
          : 0;
      const params = statusParams(record, config.accountSid, durationSec);
      if (record.statusCallback) {
        // Fire the Twilio-shaped status callback to the customer. A failing
        // customer endpoint must not fail the BW disconnect, so swallow + log.
        try {
          await postToCustomer({
            url: record.statusCallback,
            params,
            authToken: config.authToken,
            fetchImpl: deps.fetchImpl,
            allowPrivate: config.allowPrivateEgress,
            allowHosts: config.egressAllowHosts,
          });
        } catch (err) {
          app.log.error({ callId: event.callId, err }, "status callback POST failed");
        }
      } else {
        app.log.info({ callId: event.callId, params }, "call completed (no statusCallback configured)");
      }
    }
    return reply.code(204).send();
  });

  // Async recording-available egress. Bandwidth posts here (via the rewritten
  // recordingAvailableUrl) when a recording is ready; we reshape it into Twilio's
  // recordingStatusCallback payload and forward it to the customer's callback URL.
  app.post("/bw/recording-status", async (req, reply) => {
    const event = req.body as BwRecordingEvent;
    if (!event || !isSafeBwId(event.callId)) return reply.code(400).send(serverErrors.invalidParam("callId"));
    if (event.recordingId !== undefined && !isSafeBwId(event.recordingId))
      return reply.code(400).send(serverErrors.invalidParam("recordingId"));
    const cb = (req.query as { cb?: string }).cb;
    const record = store.get(event.callId);
    if (cb && record && event.recordingId) {
      const recordingSid = toRecordingSid(event.recordingId);
      // Remember the BW ids so a later GET /Recordings/{sid} (which the customer
      // reaches via the forwarded RecordingUrl) can resolve back to Bandwidth.
      store.putRecording(recordingSid, {
        bwCallId: event.callId,
        bwRecordingId: event.recordingId,
      });
      const params = recordingStatusParams(record, config.accountSid, {
        recordingSid,
        recordingUrl: `${config.publicBaseUrl}/2010-04-01/Accounts/${config.accountSid}/Recordings/${recordingSid}`,
        durationSec: event.duration ? Number(iso8601DurationToSeconds(event.duration)) : 0,
        channels: event.channels,
        status: bwRecordingStatus(event.status ?? "complete"),
        startTime: event.startTime,
      });
      try {
        await postToCustomer({
          url: cb,
          params,
          authToken: config.authToken,
          fetchImpl: deps.fetchImpl,
          allowPrivate: config.allowPrivateEgress,
          allowHosts: config.egressAllowHosts,
        });
      } catch (err) {
        app.log.error({ callId: event.callId, err }, "recording status callback POST failed");
      }
    }
    return reply.code(204).send();
  });

  app.post("/2010-04-01/Accounts/:accountSid/Calls.json", async (req, reply) => {
    if (!authOk(req)) return reply.code(401).send(twilioErrors.auth401);
    const body = req.body as Record<string, string>;
    const { To, From, Url } = body;
    // Validation order matches live Twilio: To, then Url, then From.
    if (!To) return reply.code(400).send(twilioErrors.missingTo400);
    if (!Url) return reply.code(400).send(twilioErrors.missingUrl400);
    if (!From) return reply.code(400).send(twilioErrors.missingFrom400);
    const answerUrl = `${config.publicBaseUrl}/bw/initiate?voiceUrl=${encodeURIComponent(Url)}`;
    const { callId } = await deps.bwClient.createCall({ to: To, from: From, answerUrl });
    const sid = toCallSid(callId);
    store.put(callId, {
      sid,
      bwCallId: callId,
      from: From,
      to: To,
      direction: "outbound-api",
      voiceUrl: Url,
      // Twilio fires a status callback to this URL when the call completes; we
      // mirror that from the BW disconnect event (see /bw/disconnect).
      statusCallback: body.StatusCallback,
      statusCallbackMethod: body.StatusCallbackMethod,
    });
    return reply
      .code(201)
      .send(createdCallResource({ sid, accountSid: config.accountSid, to: To, from: From }));
  });

  app.get(
    "/2010-04-01/Accounts/:accountSid/Calls/:callSid/Recordings.json",
    async (req, reply) => {
      if (!authOk(req)) return reply.code(401).send(twilioErrors.auth401);
      const { callSid } = req.params as { callSid: string };
      const record = store.getBySid(callSid);
      if (!record) return reply.code(404).send(twilioErrors.notFound(config.accountSid, callSid));
      const recs = await deps.bwClient.listRecordings(record.bwCallId);
      // Remember each recording's BW ids so it can later be fetched by its RE sid.
      for (const rec of recs)
        store.putRecording(toRecordingSid(rec.recordingId), {
          bwCallId: rec.callId,
          bwRecordingId: rec.recordingId,
        });
      return reply.send(recordingList(recs, config.accountSid, record.sid));
    },
  );

  app.get("/2010-04-01/Accounts/:accountSid/Recordings/:recordingSid.json", async (req, reply) => {
    if (!authOk(req)) return reply.code(401).send(twilioErrors.auth401);
    const { recordingSid } = req.params as { recordingSid: string };
    const ref = store.getRecording(recordingSid);
    if (!ref) return reply.code(404).send(twilioErrors.notFound(config.accountSid, recordingSid));
    const rec = await deps.bwClient.getRecording(ref.bwCallId, ref.bwRecordingId);
    return reply.send(recordingResource(rec, config.accountSid));
  });

  // Twilio serves recording audio at .../Recordings/RE....{mp3,wav}; both map to
  // the same BW media stream (BW returns the format the recording is stored in).
  const mediaHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!authOk(req)) return reply.code(401).send(twilioErrors.auth401);
    const { recordingSid } = req.params as { recordingSid: string };
    const ref = store.getRecording(recordingSid);
    if (!ref) return reply.code(404).send(twilioErrors.notFound(config.accountSid, recordingSid));
    const media = await deps.bwClient.getRecordingMedia(ref.bwCallId, ref.bwRecordingId);
    return reply.type(media.contentType).send(media.body);
  };
  app.get("/2010-04-01/Accounts/:accountSid/Recordings/:recordingSid.mp3", mediaHandler);
  app.get("/2010-04-01/Accounts/:accountSid/Recordings/:recordingSid.wav", mediaHandler);

  // Pause/resume a live recording. Twilio Status=paused|in-progress map to BW
  // recording state paused|recording. Status=stopped has no BW REST equivalent
  // (StopRecording is BXML-verb-only), so it fails loudly rather than silently.
  app.post(
    "/2010-04-01/Accounts/:accountSid/Calls/:callSid/Recordings/:recordingSid.json",
    async (req, reply) => {
      if (!authOk(req)) return reply.code(401).send(twilioErrors.auth401);
      const { recordingSid } = req.params as { recordingSid: string };
      const ref = store.getRecording(recordingSid);
      if (!ref) return reply.code(404).send(twilioErrors.notFound(config.accountSid, recordingSid));
      const status = (req.body as Record<string, string>).Status;
      const stateByStatus: Record<string, "paused" | "recording"> = {
        paused: "paused",
        "in-progress": "recording",
      };
      const state = stateByStatus[status];
      if (!state) return reply.code(400).send(twilioErrors.recordingControl400(status));
      await deps.bwClient.updateRecording(ref.bwCallId, state);
      const rec = await deps.bwClient.getRecording(ref.bwCallId, ref.bwRecordingId);
      return reply.send({ ...recordingResource(rec, config.accountSid), status });
    },
  );

  app.get("/2010-04-01/Accounts/:accountSid/Calls/:callSid.json", async (req, reply) => {
    if (!authOk(req)) return reply.code(401).send(twilioErrors.auth401);
    const { callSid } = req.params as { callSid: string };
    const record = store.getBySid(callSid);
    if (!record) return reply.code(404).send(twilioErrors.notFound(config.accountSid, callSid));
    const bw = await deps.bwClient.getCall(record.bwCallId);
    // Twilio bills from answer to end; fall back to start if the call was never answered.
    const started = bw.answerTime ?? bw.startTime;
    const duration =
      started && bw.endTime
        ? String(Math.round((Date.parse(bw.endTime) - Date.parse(started)) / 1000))
        : undefined;
    return reply.send(
      createdCallResource({
        sid: record.sid,
        accountSid: config.accountSid,
        to: record.to,
        from: record.from,
        direction: record.direction,
        status: bwStateToTwilioStatus(bw.state),
        startTime: bw.startTime,
        endTime: bw.endTime,
        duration,
      }),
    );
  });

  app.post("/2010-04-01/Accounts/:accountSid/Calls/:callSid.json", async (req, reply) => {
    if (!authOk(req)) return reply.code(401).send(twilioErrors.auth401);
    const { callSid } = req.params as { callSid: string };
    const record = store.getBySid(callSid);
    if (!record) return reply.code(404).send(twilioErrors.notFound(config.accountSid, callSid));
    const body = req.body as Record<string, string>;
    const resource = (status: string) =>
      createdCallResource({
        sid: record.sid,
        accountSid: config.accountSid,
        to: record.to,
        from: record.from,
        direction: record.direction,
        status,
      });
    // Twilio precedence: Status=completed hangs up; otherwise Url redirects.
    if (body.Status === "completed") {
      await deps.bwClient.modifyCall(record.bwCallId, { state: "completed" });
      return reply.send(resource("completed"));
    }
    if (body.Url) {
      const redirectUrl = `${config.publicBaseUrl}/bw/initiate?voiceUrl=${encodeURIComponent(body.Url)}`;
      await deps.bwClient.modifyCall(record.bwCallId, {
        state: "active",
        redirectUrl,
        redirectMethod: "POST",
      });
      return reply.send(resource("in-progress"));
    }
    return reply.code(400).send(twilioErrors.missingUrl400);
  });

  // Config/liveness check: reports required-env presence only. Deliberately
  // side-effect-free and secret-free — no outbound Bandwidth call — so it is
  // safe to expose unauthenticated. The live token probe lives only in the
  // local `npm run doctor` CLI, so an anonymous caller can neither trigger an
  // authenticated OAuth exchange nor observe upstream auth detail here.
  app.get("/readyz", async (_req, reply) => {
    const report = await checkReadiness({ env: process.env });
    return reply.code(report.ready ? 200 : 503).send(report);
  });

  return app;
}
