import { describe, it, expect } from "vitest";
import { translateTwiml } from "../src/translator/translate.js";

describe("Dial", () => {
  it("plain number text → Transfer/PhoneNumber", () => {
    const r = translateTwiml(
      `<Response><Dial callerId="+15550001111">+15552223333</Dial></Response>`,
    );
    expect(r.bxml).toContain(`<Transfer transferCallerId="+15550001111">`);
    expect(r.bxml).toContain(`<PhoneNumber>+15552223333</PhoneNumber>`);
  });
  it("multiple Number nouns ring simultaneously", () => {
    const r = translateTwiml(
      `<Response><Dial><Number>+15551</Number><Number>+15552</Number></Dial></Response>`,
    );
    expect(r.bxml.match(/<PhoneNumber>/g)?.length).toBe(2);
  });
  it("Sip noun → SipUri", () => {
    const r = translateTwiml(`<Response><Dial><Sip>sip:agent@pbx.test</Sip></Dial></Response>`);
    expect(r.bxml).toContain(`<SipUri>sip:agent@pbx.test</SipUri>`);
  });
  it("Conference noun → Conference; waitUrl is an error-level finding", () => {
    const r = translateTwiml(
      `<Response><Dial><Conference waitUrl="/hold">support</Conference></Dial></Response>`,
    );
    expect(r.bxml).toContain(`<Conference>support</Conference>`);
    expect(r.findings.some((f) => f.severity === "error" && /waitUrl/.test(f.message))).toBe(true);
  });
  it("Queue noun is unsupported", () => {
    const r = translateTwiml(`<Response><Dial><Queue>q1</Queue></Dial></Response>`);
    expect(r.hasErrors).toBe(true);
  });
});

describe("Connect/Stream", () => {
  it("maps to StartStream with destination and partial warning", () => {
    const r = translateTwiml(
      `<Response><Connect><Stream url="wss://bot.test/audio"/></Connect></Response>`,
      {
        rewriteUrl: (u, k) =>
          k === "stream" ? `wss://adapter.test/streams?dest=${encodeURIComponent(u)}` : u,
      },
    );
    expect(r.bxml).toContain(
      `<StartStream destination="wss://adapter.test/streams?dest=wss%3A%2F%2Fbot.test%2Faudio"`,
    );
    expect(r.findings.some((f) => f.severity === "warning" && f.verb === "Stream")).toBe(true);
  });
});
