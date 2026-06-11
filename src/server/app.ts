import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import formbody from "@fastify/formbody";
import { translateTwiml, type UrlKind } from "../translator/translate.js";
import { bxmlDocument } from "../xml/build-xml.js";
import { initiateParams, gatherParams, statusParams, postToCustomer } from "../twilio/egress.js";
import { toCallSid } from "../twilio/call-sid.js";
import { createdCallResource, twilioErrors } from "../twilio/call-resource.js";
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
}

export function buildApp(config: AdapterConfig, deps: AdapterDeps): FastifyInstance {
  // Logging off by default; set ADAPTER_LOG=1 to enable request/error logs.
  const app = Fastify({ logger: process.env.ADAPTER_LOG === "1" });
  app.register(formbody);
  const store = new CallStore();

  const rewriter = (base: string) => (url: string, _kind: UrlKind) => {
    const absolute = new URL(url, base).toString();
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
    const twiml = await postToCustomer({
      url: customerUrl,
      params,
      authToken: config.authToken,
      fetchImpl: deps.fetchImpl,
    });
    const result = translateTwiml(twiml, { rewriteUrl: rewriter(customerUrl) });
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
      // P0: log the Twilio-style completion params; a configurable statusCallback egress lands post-P0.
      app.log.info(
        { callId: event.callId, params: statusParams(record, config.accountSid, 0) },
        "call completed",
      );
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
    store.put(callId, { sid, from: From, to: To, direction: "outbound-api", voiceUrl: Url });
    return reply
      .code(201)
      .send(createdCallResource({ sid, accountSid: config.accountSid, to: To, from: From }));
  });

  return app;
}
