import { describe, it, expect, vi } from "vitest";
import { buildApp } from "../src/server/app.js";

const base = { accountSid: "AC123", authToken: "tok", publicBaseUrl: "https://adapter.test", voiceUrl: "http://127.0.0.1:4000/voice", webhookUser: "u", webhookPassword: "p" };
const bwClient = { createCall: vi.fn(), modifyCall: vi.fn(), getCall: vi.fn(), listRecordings: vi.fn(), getRecording: vi.fn(), getRecordingMedia: vi.fn(), updateRecording: vi.fn() };
const authHeader = "Basic " + Buffer.from("u:p").toString("base64");

it("blocks a loopback voiceUrl by default", async () => {
  const fetchImpl = vi.fn(async () => new Response("<Response/>", { status: 200 })) as unknown as typeof fetch;
  const app = buildApp(base, { fetchImpl, bwClient });
  const res = await app.inject({ method: "POST", url: "/bw/initiate", headers: { authorization: authHeader }, payload: { eventType: "initiate", callId: "c1" } });
  expect(res.statusCode).toBe(502);
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("permits a loopback voiceUrl when allowPrivateEgress is set", async () => {
  const fetchImpl = vi.fn(async () => new Response("<Response><Hangup/></Response>", { status: 200 })) as unknown as typeof fetch;
  const app = buildApp({ ...base, allowPrivateEgress: true }, { fetchImpl, bwClient });
  const res = await app.inject({ method: "POST", url: "/bw/initiate", headers: { authorization: authHeader }, payload: { eventType: "initiate", callId: "c2" } });
  expect(res.statusCode).toBe(200);
  expect(fetchImpl).toHaveBeenCalled();
});
