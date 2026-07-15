// test/server-errors.test.ts
import { describe, it, expect } from "vitest";
import { buildApp, type AdapterConfig, type AdapterDeps } from "../src/server/app.js";

const config: AdapterConfig = {
  accountSid: "AC123",
  authToken: "tok",
  publicBaseUrl: "https://adapter.test",
  voiceUrl: "https://customer.test/voice",
};
const auth = "Basic " + Buffer.from("AC123:tok").toString("base64");

describe("structured adapter errors", () => {
  it("returns the Twilio-shaped body for a missing parameter", async () => {
    const app = buildApp(config, { fetchImpl: fetch, bwClient: {} as AdapterDeps["bwClient"] });
    // /bw/continue with no ?next= is a missing-param error
    const res = await app.inject({ method: "POST", url: "/bw/continue", payload: { callId: "c1" } });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body).toMatchObject({ code: 90001, message: expect.any(String), more_info: expect.any(String), status: 400 });
  });

  it("maps an unhandled route throw to a neutral structured 500 without leaking detail", async () => {
    const bwClient = {
      // createCall must succeed so the store gets seeded and we learn the real SID.
      createCall: async () => ({ callId: "bw-call-1" }),
      getCall: async () => { throw new Error("BW 503 SECRET-UPSTREAM-BODY"); },
    } as unknown as AdapterDeps["bwClient"];
    const app = buildApp(config, { fetchImpl: fetch, bwClient });

    const created = await app.inject({
      method: "POST",
      url: "/2010-04-01/Accounts/AC123/Calls.json",
      headers: { authorization: auth },
      payload: { To: "+15551112222", From: "+15553334444", Url: "https://customer.test/voice" },
    });
    expect(created.statusCode).toBe(201);
    const sid = created.json().sid as string;

    const res = await app.inject({
      method: "GET",
      url: `/2010-04-01/Accounts/AC123/Calls/${sid}.json`,
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 90002, status: 500 });
    // Never echo the upstream error detail to the client.
    expect(JSON.stringify(res.json())).not.toContain("SECRET-UPSTREAM-BODY");
  });
});
