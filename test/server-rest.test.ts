import { describe, it, expect, vi } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { CreateCallOpts } from "../src/bw/client.js";

const config = {
  accountSid: "AC123",
  authToken: "tok",
  publicBaseUrl: "https://translator.test",
  voiceUrl: "https://customer.test/voice",
  webhookUser: "u",
  webhookPassword: "p",
};

describe("POST /2010-04-01/Accounts/:sid/Calls.json", () => {
  function makeApp() {
    const bwClient = {
      createCall: vi.fn(async (_opts: CreateCallOpts) => ({ callId: "c-out-1" })),
      modifyCall: vi.fn(),
      getCall: vi.fn(),
      listRecordings: vi.fn(),
    getRecording: vi.fn(),
    getRecordingMedia: vi.fn(),
    updateRecording: vi.fn(),
    };
    const app = buildApp(config, { fetchImpl: fetch, bwClient });
    return { app, bwClient };
  }
  const auth = "Basic " + Buffer.from("AC123:tok").toString("base64");

  it("creates a BW call with translator answerUrl and returns Twilio-shaped JSON", async () => {
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
    // Shape parity with the live fixture (test/fixtures/twilio/call-resource.json):
    expect(body.duration).toBeNull();
    expect(body.price).toBeNull();
    expect(body.date_created).toMatch(/\+0000$/);
    expect(body.uri).toBe(`/2010-04-01/Accounts/AC123/Calls/${body.sid}.json`);
    expect(body.subresource_uris.recordings).toBe(
      `/2010-04-01/Accounts/AC123/Calls/${body.sid}/Recordings.json`,
    );
    const callArgs = bwClient.createCall.mock.calls[0][0];
    expect(callArgs.to).toBe("+15552223333");
    expect(callArgs.answerUrl).toBe(
      `https://translator.test/bw/initiate?voiceUrl=${encodeURIComponent("https://customer.test/outbound")}`,
    );
  });

  it("rejects bad credentials with the exact live 401 body", async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/2010-04-01/Accounts/AC123/Calls.json",
      headers: { authorization: "Basic " + Buffer.from("AC123:wrong").toString("base64") },
      payload: { To: "+1", From: "+2", Url: "https://x.test" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      code: 20003,
      message: "Authenticate",
      more_info: "https://www.twilio.com/docs/errors/20003",
      status: 401,
    });
  });

  it("validates To, then Url, then From — matching live Twilio order and bodies", async () => {
    const { app } = makeApp();
    const post = (payload: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: "/2010-04-01/Accounts/AC123/Calls.json",
        headers: { authorization: auth },
        payload,
      });

    const noTo = await post({});
    expect(noTo.statusCode).toBe(400);
    expect(noTo.json().code).toBe(21201);
    expect(noTo.json().message).toBe("No 'To' number is specified");

    const noUrl = await post({ To: "+1" });
    expect(noUrl.statusCode).toBe(400);
    expect(noUrl.json().code).toBe(21205);
    expect(noUrl.json().message).toBe("Url parameter is required.");

    const noFrom = await post({ To: "+1", Url: "https://x.test" });
    expect(noFrom.statusCode).toBe(400);
    expect(noFrom.json().code).toBe(21213);
  });
});
