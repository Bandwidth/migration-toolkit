import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initiateParams, statusParams } from "../src/twilio/egress.js";

// Fields Twilio sends that we intentionally do NOT reproduce (its own trust
// model / call-routing internals). BW has a different trust model.
const NOT_REPRODUCED = new Set([
  "StirVerstat",
  "StirStatus",
  "CallToken",
  "Timestamp", // real wall-clock of the event; not modeled in P0
  "SipResponseCode", // real SIP result; not modeled in P0
]);

const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures/twilio/webhooks.json"), "utf8"),
);

const call = {
  sid: "CAdeadbeef",
  from: "+15550001111",
  to: "+15552223333",
  direction: "inbound" as const,
  voiceUrl: "https://x.test/voice",
};

describe("egress conformance against live Twilio capture", () => {
  it("initiate emits every stable field of the real inbound voice webhook", () => {
    const emitted = new Set(Object.keys(initiateParams(call, "AC123")));
    const missing = Object.keys(fixture.inboundVoiceWebhook.params).filter(
      (k) => !NOT_REPRODUCED.has(k) && !emitted.has(k),
    );
    expect(missing, `missing fields vs live capture: ${missing.join(", ")}`).toEqual([]);
  });

  it("status callback emits every stable field of the real status callback", () => {
    const emitted = new Set(Object.keys(statusParams(call, "AC123", 30)));
    const missing = Object.keys(fixture.statusCallback.params).filter(
      (k) => !NOT_REPRODUCED.has(k) && !emitted.has(k),
    );
    expect(missing, `missing fields vs live capture: ${missing.join(", ")}`).toEqual([]);
  });

  it("Caller/Called mirror From/To as Twilio does", () => {
    const p = initiateParams(call, "AC123");
    expect(p.Caller).toBe(p.From);
    expect(p.Called).toBe(p.To);
  });
});
