import { describe, it, expect, vi } from "vitest";
import { buildApp } from "../src/server/app.js";

const config = {
  accountSid: "AC123",
  authToken: "tok",
  publicBaseUrl: "https://adapter.test",
  voiceUrl: "https://customer.test/voice",
  webhookUser: "bw-user",
  webhookPassword: "bw-pass",
  // customer.test never resolves via real DNS (RFC 2606), so allow private
  // egress to keep this test about auth, not the egress guard.
  allowPrivateEgress: true,
};
function makeApp() {
  const fetchImpl = vi.fn(
    async () => new Response("<Response><Hangup/></Response>", { status: 200 }),
  ) as unknown as typeof fetch;
  const bwClient = {
    createCall: vi.fn(),
    modifyCall: vi.fn(),
    getCall: vi.fn(),
    listRecordings: vi.fn(),
    getRecording: vi.fn(),
    getRecordingMedia: vi.fn(),
    updateRecording: vi.fn(),
  };
  return buildApp(config, { fetchImpl, bwClient });
}
const good = "Basic " + Buffer.from("bw-user:bw-pass").toString("base64");

describe("/bw/* inbound auth", () => {
  it("401s a request with no credentials", async () => {
    const res = await makeApp().inject({
      method: "POST",
      url: "/bw/initiate",
      payload: { eventType: "initiate", callId: "c1" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Basic");
  });
  it("401s a request with wrong credentials", async () => {
    const res = await makeApp().inject({
      method: "POST",
      url: "/bw/initiate",
      headers: { authorization: "Basic " + Buffer.from("bw-user:wrong").toString("base64") },
      payload: { eventType: "initiate", callId: "c1" },
    });
    expect(res.statusCode).toBe(401);
  });
  it("allows a request with correct credentials", async () => {
    const res = await makeApp().inject({
      method: "POST",
      url: "/bw/initiate",
      headers: { authorization: good },
      payload: { eventType: "initiate", callId: "c1" },
    });
    expect(res.statusCode).toBe(200);
  });
  it("does not gate the REST facade with webhook creds", async () => {
    const res = await makeApp().inject({
      method: "GET",
      url: "/2010-04-01/Accounts/AC123/Calls/CA0.json",
      headers: { authorization: good },
    });
    expect(res.statusCode).not.toBe(200); // rejected by REST auth (different secret), not accepted
  });
});
