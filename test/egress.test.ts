import { describe, it, expect, vi } from "vitest";
import {
  initiateParams,
  gatherParams,
  statusParams,
  postToCustomer,
} from "../src/twilio/egress.js";
import { twilioSignature } from "../src/twilio/signature.js";

const call = {
  sid: "CAdeadbeef",
  bwCallId: "c-deadbeef",
  from: "+15550001111",
  to: "+15552223333",
  direction: "inbound" as const,
  voiceUrl: "https://x.test/voice",
};

describe("param builders", () => {
  it("initiate → ringing", () => {
    const p = initiateParams(call, "AC123");
    expect(p).toMatchObject({
      CallSid: "CAdeadbeef",
      AccountSid: "AC123",
      From: "+15550001111",
      To: "+15552223333",
      CallStatus: "ringing",
      Direction: "inbound",
      ApiVersion: "2010-04-01",
    });
  });
  it("gather adds Digits and in-progress status", () => {
    const p = gatherParams(call, "AC123", { digits: "42" });
    expect(p.Digits).toBe("42");
    expect(p.CallStatus).toBe("in-progress");
    expect(p.SpeechResult).toBeUndefined();
  });
  it("gather surfaces speech text as SpeechResult", () => {
    const p = gatherParams(call, "AC123", { speech: "schedule a checkup" });
    expect(p.SpeechResult).toBe("schedule a checkup");
    expect(p.Digits).toBeUndefined();
  });
  it("status → completed with duration", () => {
    const p = statusParams(call, "AC123", 17);
    expect(p.CallStatus).toBe("completed");
    expect(p.CallDuration).toBe("17");
  });
});

describe("postToCustomer", () => {
  it("sends signed form-encoded POST and returns body text", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("<Response><Hangup/></Response>", { status: 200 }),
    ) as unknown as typeof fetch;
    const params = initiateParams(call, "AC123");
    const body = await postToCustomer({
      url: "https://x.test/voice",
      params,
      authToken: "tok",
      fetchImpl,
      allowPrivate: true,
    });
    expect(body).toContain("<Hangup/>");
    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe("https://x.test/voice");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(init.headers["X-Twilio-Signature"]).toBe(
      twilioSignature("tok", "https://x.test/voice", params),
    );
    expect(init.body).toContain("CallSid=CAdeadbeef");
  });
  it("throws on non-2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(
      postToCustomer({
        url: "https://x.test/voice",
        params: {},
        authToken: "tok",
        fetchImpl,
        allowPrivate: true,
      }),
    ).rejects.toThrow(/500/);
  });
});
