import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import formbody from "@fastify/formbody";
import { translateTwiml, type UrlKind } from "../translator/translate.js";
import { bxmlDocument } from "../xml/build-xml.js";
import { initiateParams, gatherParams, statusParams, postToCustomer } from "../twilio/egress.js";
import { toCallSid } from "../twilio/call-sid.js";
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
}

export function buildApp(config: AdapterConfig, deps: AdapterDeps): FastifyInstance {
  const app = Fastify({ logger: false });
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
      event.eventType === "gather" && event.digits !== undefined
        ? gatherParams(record, config.accountSid, event.digits)
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

  return app;
}
