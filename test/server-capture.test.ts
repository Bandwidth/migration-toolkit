import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server/app.js";

const webhookAuth = "Basic " + Buffer.from("u:p").toString("base64");

function baseConfig(captureDir?: string) {
  return {
    accountSid: "AC123",
    authToken: "tok",
    publicBaseUrl: "https://adapter.test",
    voiceUrl: "https://customer.test/voice",
    allowPrivateEgress: true,
    webhookUser: "u",
    webhookPassword: "p",
    captureDir,
  };
}

function appWithTwiml(config: ReturnType<typeof baseConfig>, twimlByUrl: Record<string, string>) {
  const fetchImpl = vi.fn(async (url: any) => {
    const twiml = twimlByUrl[String(url)];
    if (!twiml) return new Response("not found", { status: 404 });
    return new Response(twiml, { status: 200 });
  }) as unknown as typeof fetch;
  const bwClient = { createCall: vi.fn(), modifyCall: vi.fn(), getCall: vi.fn(), listRecordings: vi.fn(), getRecording: vi.fn(), getRecordingMedia: vi.fn(), updateRecording: vi.fn() };
  return buildApp(config, { fetchImpl, bwClient });
}

async function initiate(app: ReturnType<typeof appWithTwiml>, callId: string) {
  return app.inject({
    method: "POST",
    url: "/bw/initiate",
    headers: { authorization: webhookAuth },
    payload: { eventType: "initiate", callId, from: "+1", to: "+2", direction: "inbound" },
  });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "server-capture-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("live capture", () => {
  it("writes the customer's raw TwiML (not the translated BXML) when captureDir is set", async () => {
    const raw = `<Response><Say>Hello</Say><Hangup/></Response>`;
    const app = appWithTwiml(baseConfig(dir), { "https://customer.test/voice": raw });
    await initiate(app, "c-1");

    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const content = readFileSync(join(dir, files[0]), "utf8");
    expect(content).toContain(raw);
    // The captured artifact is the source TwiML, not the proxy's BXML output.
    expect(content).not.toContain("SpeakSentence");
  });

  it("preserves the customer's URLs verbatim (no proxy rewrite) so generate can reuse them", async () => {
    const raw = `<Response><Gather numDigits="1" action="/menu"><Say>Press 1</Say></Gather></Response>`;
    const app = appWithTwiml(baseConfig(dir), { "https://customer.test/voice": raw });
    await initiate(app, "c-2");

    const content = readFileSync(join(dir, readdirSync(dir)[0]), "utf8");
    expect(content).toContain(`action="/menu"`);
    expect(content).not.toContain("/bw/continue");
  });

  it("writes nothing when captureDir is unset", async () => {
    const app = appWithTwiml(baseConfig(undefined), {
      "https://customer.test/voice": `<Response><Say>Hello</Say></Response>`,
    });
    await initiate(app, "c-3");
    expect(readdirSync(dir)).toHaveLength(0);
  });
});
