import { describe, it, expect, vi } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { CreateCallOpts } from "../src/bw/client.js";

const config = {
  accountSid: "AC123",
  authToken: "tok",
  publicBaseUrl: "https://adapter.test",
  voiceUrl: "https://customer.test/voice",
};

describe("POST /2010-04-01/Accounts/:sid/Calls.json", () => {
  function makeApp() {
    const bwClient = {
      createCall: vi.fn(async (_opts: CreateCallOpts) => ({ callId: "c-out-1" })),
    };
    const app = buildApp(config, { fetchImpl: fetch, bwClient });
    return { app, bwClient };
  }
  const auth = "Basic " + Buffer.from("AC123:tok").toString("base64");

  it("creates a BW call with adapter answerUrl and returns Twilio-shaped JSON", async () => {
    const { app, bwClient } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/2010-04-01/Accounts/AC123/Calls.json",
      headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" },
      payload: "To=%2B15552223333&From=%2B15550001111&Url=https%3A%2F%2Fcustomer.test%2Foutbound",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.sid).toMatch(/^CA[0-9a-f]{32}$/);
    expect(body.status).toBe("queued");
    expect(body.direction).toBe("outbound-api");
    const callArgs = bwClient.createCall.mock.calls[0][0];
    expect(callArgs.to).toBe("+15552223333");
    expect(callArgs.answerUrl).toBe(
      `https://adapter.test/bw/initiate?voiceUrl=${encodeURIComponent("https://customer.test/outbound")}`,
    );
  });

  it("rejects bad credentials with Twilio-shaped 401", async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/2010-04-01/Accounts/AC123/Calls.json",
      headers: { authorization: "Basic " + Buffer.from("AC123:wrong").toString("base64") },
      payload: { To: "+1", From: "+2", Url: "https://x.test" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe(20003);
  });

  it("rejects missing params with Twilio-shaped 400", async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/2010-04-01/Accounts/AC123/Calls.json",
      headers: { authorization: auth },
      payload: { To: "+1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe(21201);
  });
});
