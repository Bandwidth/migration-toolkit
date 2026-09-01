import { describe, it, expect, vi } from "vitest";
import { buildApp } from "../src/server/app.js";

// Ingress defense-in-depth: /bw/* event ids are validated at the boundary (after
// Basic auth) so a malformed id never enters the call store, gets hashed into a
// SID, or flows toward the upstream API.

const config = {
  accountSid: "AC123",
  authToken: "tok",
  publicBaseUrl: "https://translator.test",
  voiceUrl: "https://customer.test/voice",
  webhookUser: "u",
  webhookPassword: "p",
  allowPrivateEgress: true,
};
const auth = "Basic " + Buffer.from("u:p").toString("base64");

function makeApp() {
  const fetchImpl = vi.fn(async () => new Response("<Response><Hangup/></Response>", { status: 200 })) as unknown as typeof fetch;
  const bwClient = {
    createCall: vi.fn(),
    modifyCall: vi.fn(),
    getCall: vi.fn(),
    listRecordings: vi.fn(),
    getRecording: vi.fn(),
    getRecordingMedia: vi.fn(),
    updateRecording: vi.fn(),
  };
  return { app: buildApp(config, { fetchImpl, bwClient }), fetchImpl };
}

describe("/bw/* ingress id validation", () => {
  it("400s /bw/initiate with a path-traversal callId (and does not fetch)", async () => {
    const { app, fetchImpl } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/bw/initiate",
      headers: { authorization: auth },
      payload: { eventType: "initiate", callId: "../../x" },
    });
    expect(res.statusCode).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("400s /bw/recording-status with an unsafe recordingId", async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/bw/recording-status?cb=https://customer.test/x",
      headers: { authorization: auth },
      payload: { callId: "c-1", recordingId: ".." },
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts a valid callId", async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/bw/initiate",
      headers: { authorization: auth },
      payload: { eventType: "initiate", callId: "c-1" },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("/bw/* ingress id validation — more cases", () => {
  const cfg = { accountSid: "AC123", authToken: "tok", publicBaseUrl: "https://translator.test", voiceUrl: "https://customer.test/voice", webhookUser: "u", webhookPassword: "p", allowPrivateEgress: true };
  const authHdr = "Basic " + Buffer.from("u:p").toString("base64");
  function app() {
    const fetchImpl = vi.fn(async () => new Response("<Response><Hangup/></Response>", { status: 200 })) as unknown as typeof fetch;
    const bwClient = { createCall: vi.fn(), modifyCall: vi.fn(), getCall: vi.fn(), listRecordings: vi.fn(), getRecording: vi.fn(), getRecordingMedia: vi.fn(), updateRecording: vi.fn() };
    return buildApp(cfg, { fetchImpl, bwClient });
  }
  it("400s /bw/continue with a bad callId", async () => {
    const res = await app().inject({ method: "POST", url: "/bw/continue?next=https://customer.test/x", headers: { authorization: authHdr }, payload: { eventType: "gather", callId: "../x", digits: "1" } });
    expect(res.statusCode).toBe(400);
  });
  it("400s /bw/disconnect with a bad callId", async () => {
    const res = await app().inject({ method: "POST", url: "/bw/disconnect", headers: { authorization: authHdr }, payload: { eventType: "disconnect", callId: "a/b" } });
    expect(res.statusCode).toBe(400);
  });
  it("400s /bw/recording-status with a bad callId", async () => {
    const res = await app().inject({ method: "POST", url: "/bw/recording-status?cb=https://customer.test/x", headers: { authorization: authHdr }, payload: { callId: "..", recordingId: "r-1" } });
    expect(res.statusCode).toBe(400);
  });
  it("400s a null JSON body (does not 500)", async () => {
    const res = await app().inject({ method: "POST", url: "/bw/initiate", headers: { authorization: authHdr, "content-type": "application/json" }, payload: "null" });
    expect(res.statusCode).toBe(400);
  });
});
