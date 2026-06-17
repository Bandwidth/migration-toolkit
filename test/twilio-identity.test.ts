import { describe, it, expect } from "vitest";
import { toCallSid } from "../src/twilio/call-sid.js";
import { twilioSignature } from "../src/twilio/signature.js";
import { CallStore } from "../src/server/call-store.js";

describe("toCallSid", () => {
  it("is deterministic, CA-prefixed, 34 chars", () => {
    const sid = toCallSid("c-abc-123");
    expect(sid).toMatch(/^CA[0-9a-f]{32}$/);
    expect(toCallSid("c-abc-123")).toBe(sid);
    expect(toCallSid("c-other")).not.toBe(sid);
  });
});

describe("twilioSignature", () => {
  // Canonical example from Twilio's security docs. If this fails, verify the
  // expected value against https://www.twilio.com/docs/usage/security before
  // changing the implementation.
  it("matches Twilio's documented example", () => {
    const sig = twilioSignature("12345", "https://example.com/myapp.php?foo=1&bar=2", {
      CallSid: "CA1234567890ABCDE",
      Caller: "+14158675310",
      Digits: "1234",
      From: "+14158675310",
      To: "+18005551212",
    });
    expect(sig).toBe("L/OH5YylLD5NRKLltdqwSvS0BnU=");
  });
});

describe("CallStore", () => {
  it("stores and retrieves by bwCallId", () => {
    const store = new CallStore();
    store.put("c-1", {
      sid: toCallSid("c-1"),
      bwCallId: "c-1",
      from: "+1",
      to: "+2",
      direction: "inbound",
      voiceUrl: "https://x.test/voice",
    });
    expect(store.get("c-1")?.to).toBe("+2");
    expect(store.get("missing")).toBeUndefined();
  });
});
