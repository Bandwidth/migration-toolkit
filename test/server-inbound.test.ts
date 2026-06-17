import { describe, it, expect, vi } from "vitest";
import { buildApp } from "../src/server/app.js";

const config = {
  accountSid: "AC123",
  authToken: "tok",
  publicBaseUrl: "https://adapter.test",
  voiceUrl: "https://customer.test/voice",
};

function appWithTwiml(twimlByUrl: Record<string, string>) {
  const fetchImpl = vi.fn(async (url: any) => {
    const u = String(url);
    const twiml = twimlByUrl[u];
    if (!twiml) return new Response("not found", { status: 404 });
    return new Response(twiml, { status: 200 });
  }) as unknown as typeof fetch;
  const bwClient = { createCall: vi.fn(), modifyCall: vi.fn(), getCall: vi.fn(), listRecordings: vi.fn(), getRecording: vi.fn(), getRecordingMedia: vi.fn(), updateRecording: vi.fn() };
  return { app: buildApp(config, { fetchImpl, bwClient }), fetchImpl };
}

describe("POST /bw/initiate", () => {
  it("calls customer voiceUrl and returns translated BXML", async () => {
    const { app, fetchImpl } = appWithTwiml({
      "https://customer.test/voice": `<Response><Say>Hello</Say><Hangup/></Response>`,
    });
    const res = await app.inject({
      method: "POST",
      url: "/bw/initiate",
      payload: {
        eventType: "initiate",
        callId: "c-1",
        from: "+15550001111",
        to: "+15552223333",
        direction: "inbound",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/xml");
    expect(res.body).toContain("<SpeakSentence>Hello</SpeakSentence>");
    const [, init] = (fetchImpl as any).mock.calls[0];
    expect(init.headers["X-Twilio-Signature"]).toBeTruthy();
    expect(init.body).toContain("CallStatus=ringing");
  });

  it("rewrites Gather action through /bw/continue", async () => {
    const { app } = appWithTwiml({
      "https://customer.test/voice": `<Response><Gather numDigits="1" action="/menu"><Say>Press 1</Say></Gather></Response>`,
    });
    const res = await app.inject({
      method: "POST",
      url: "/bw/initiate",
      payload: { eventType: "initiate", callId: "c-2", from: "+1", to: "+2", direction: "inbound" },
    });
    expect(res.body).toContain(
      `gatherUrl="https://adapter.test/bw/continue?next=${encodeURIComponent("https://customer.test/menu")}"`,
    );
  });

  it("speaks a loud error on unsupported TwiML", async () => {
    const { app } = appWithTwiml({
      "https://customer.test/voice": `<Response><Enqueue>support</Enqueue></Response>`,
    });
    const res = await app.inject({
      method: "POST",
      url: "/bw/initiate",
      payload: { eventType: "initiate", callId: "c-3", from: "+1", to: "+2", direction: "inbound" },
    });
    expect(res.body).toContain("not yet supported");
    expect(res.body).toContain("<Hangup/>");
  });
});

describe("POST /bw/continue", () => {
  it("forwards Digits to the customer action URL and translates the reply", async () => {
    const { app, fetchImpl } = appWithTwiml({
      "https://customer.test/voice": `<Response><Gather numDigits="1" action="/menu"><Say>Press 1</Say></Gather></Response>`,
      "https://customer.test/menu": `<Response><Say>You pressed one</Say></Response>`,
    });
    await app.inject({
      method: "POST",
      url: "/bw/initiate",
      payload: { eventType: "initiate", callId: "c-4", from: "+1", to: "+2", direction: "inbound" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/bw/continue?next=${encodeURIComponent("https://customer.test/menu")}`,
      payload: { eventType: "gather", callId: "c-4", digits: "1" },
    });
    expect(res.body).toContain("You pressed one");
    const [, init] = (fetchImpl as any).mock.calls[1];
    expect(init.body).toContain("Digits=1");
  });
});

describe("POST /bw/disconnect", () => {
  it("returns 204", async () => {
    const { app } = appWithTwiml({});
    const res = await app.inject({
      method: "POST",
      url: "/bw/disconnect",
      payload: { eventType: "disconnect", callId: "c-9" },
    });
    expect(res.statusCode).toBe(204);
  });
});
