import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import formbody from "@fastify/formbody";
import { translateTwiml, type UrlKind } from "../translator/translate.js";
import { bxmlDocument } from "../xml/build-xml.js";
import {
  initiateParams,
  gatherParams,
  statusParams,
  recordingStatusParams,
  postToCustomer,
} from "../twilio/egress.js";
import { toCallSid, toRecordingSid } from "../twilio/call-sid.js";
import { createdCallResource, bwStateToTwilioStatus, twilioErrors } from "../twilio/call-resource.js";
import {
  recordingList,
  recordingResource,
  iso8601DurationToSeconds,
  bwRecordingStatus,
} from "../twilio/recording-resource.js";
import { CallStore, type CallRecord } from "./call-store.js";
import type { BwClient } from "../bw/client.js";

export interface AdapterConfig {
  accountSid: string;
  authToken: string;
  publicBaseUrl: string;
  voiceUrl: string;
}

export interface AdapterDeps {
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
  text?: string; // BW gather event speech transcription
  startTime?: string; // BW call answer/start time (for status-callback duration)
  endTime?: string; // BW call end time
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

export function buildApp(config: AdapterConfig, deps: AdapterDeps): FastifyInstance {
  // Logging off by default; set ADAPTER_LOG=1 to enable request/error logs.
  const app = Fastify({ logger: process.env.ADAPTER_LOG === "1" });
  app.register(formbody);
  const store = new CallStore();

  const rewriter = (base: string) => (url: string, kind: UrlKind) => {
    const absolute = new URL(url, base).toString();
    // Recording-available events are async, fire-and-forget (no BXML continuation),
    // so they route to a dedicated egress endpoint rather than /bw/continue.
    if (kind === "recordingStatus") {
      return `${config.publicBaseUrl}/bw/recording-status?cb=${encodeURIComponent(absolute)}`;
    }
    return `${config.publicBaseUrl}/bw/continue?next=${encodeURIComponent(absolute)}`;
  };

  function errorBxml(verbs: string[]): string {
    return bxmlDocument([
      {
        name: "SpeakSentence",
        children: [
          `This application uses a Twilio feature not yet supported by the adapter: ${verbs.join(", ")}. The call will now end.`,
        ],
      },
      { name: "Hangup" },
    ]);
  }

  async function fetchAndTranslate(
    customerUrl: string,
    params: Record<string, string>,
    reply: FastifyReply,
  ) {
    // Split the per-turn latency into the customer webhook round-trip (network,
    // not ours) and the TwiML→BXML translation tax (CPU, ours). With ADAPTER_LOG=1
    // each turn logs both; see `npm run bench` for the translation tax in isolation.
    const fetchStart = performance.now();
    const twiml = await postToCustomer({
      url: customerUrl,
      params,
      authToken: config.authToken,
      fetchImpl: deps.fetchImpl,
    });
    const translateStart = performance.now();
    const result = translateTwiml(twiml, { rewriteUrl: rewriter(customerUrl) });
    app.log.info(
      {
        customerUrl,
        fetchMs: Math.round((translateStart - fetchStart) * 1000) / 1000,
        translateMs: Math.round((performance.now() - translateStart) * 1000) / 1000,
      },
      "fetchAndTranslate timing",
    );
    if (result.hasErrors) {
      const verbs = [
        ...new Set(result.findings.filter((f) => f.severity === "error").map((f) => f.verb)),
      ];
      app.log.error({ findings: result.findings }, "unsupported TwiML");
      return reply.type("application/xml").send(errorBxml(verbs));
    }
    return reply.type("application/xml").send(result.bxml);
  }

  app.post("/bw/initiate", async (req, reply) => {
    const event = req.body as BwEvent;
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
    return fetchAndTranslate(voiceUrl, initiateParams(record, config.accountSid), reply);
  });

  app.post("/bw/continue", async (req, reply) => {
    const event = req.body as BwEvent;
    const query = req.query as { next?: string };
    if (!query.next) return reply.code(400).send({ error: "missing next" });
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
    const params =
      event.eventType === "gather" && (event.digits !== undefined || event.text !== undefined)
        ? gatherParams(record, config.accountSid, { digits: event.digits, speech: event.text })
        : { ...initiateParams(record, config.accountSid), CallStatus: "in-progress" };
    return fetchAndTranslate(query.next, params, reply);
  });

  app.post("/bw/disconnect", async (req, reply) => {
    const event = req.body as BwEvent;
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
        });
      } catch (err) {
        app.log.error({ callId: event.callId, err }, "recording status callback POST failed");
      }
    }
    return reply.code(204).send();
  });

  app.post("/2010-04-01/Accounts/:accountSid/Calls.json", async (req, reply) => {
    const header = req.headers.authorization ?? "";
    const expected =
      "Basic " + Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");
    if (header !== expected) return reply.code(401).send(twilioErrors.auth401);
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
      const header = req.headers.authorization ?? "";
      const expected =
        "Basic " + Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");
      if (header !== expected) return reply.code(401).send(twilioErrors.auth401);
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
    const header = req.headers.authorization ?? "";
    const expected =
      "Basic " + Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");
    if (header !== expected) return reply.code(401).send(twilioErrors.auth401);
    const { recordingSid } = req.params as { recordingSid: string };
    const ref = store.getRecording(recordingSid);
    if (!ref) return reply.code(404).send(twilioErrors.notFound(config.accountSid, recordingSid));
    const rec = await deps.bwClient.getRecording(ref.bwCallId, ref.bwRecordingId);
    return reply.send(recordingResource(rec, config.accountSid));
  });

  // Twilio serves recording audio at .../Recordings/RE....{mp3,wav}; both map to
  // the same BW media stream (BW returns the format the recording is stored in).
  const mediaHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? "";
    const expected =
      "Basic " + Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");
    if (header !== expected) return reply.code(401).send(twilioErrors.auth401);
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
      const header = req.headers.authorization ?? "";
      const expected =
        "Basic " + Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");
      if (header !== expected) return reply.code(401).send(twilioErrors.auth401);
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
    const header = req.headers.authorization ?? "";
    const expected =
      "Basic " + Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");
    if (header !== expected) return reply.code(401).send(twilioErrors.auth401);
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
    const header = req.headers.authorization ?? "";
    const expected =
      "Basic " + Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");
    if (header !== expected) return reply.code(401).send(twilioErrors.auth401);
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

  return app;
}
