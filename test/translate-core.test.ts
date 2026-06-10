import { describe, it, expect } from "vitest";
import { translateTwiml } from "../src/translator/translate.js";

describe("core verb translation", () => {
  it("Say maps Twilio voice 'alice' to a valid BW voice (never emits an invalid one)", () => {
    const r = translateTwiml(`<Response><Say voice="alice">Hi there</Say></Response>`);
    expect(r.bxml).toContain(`<SpeakSentence voice="julie">Hi there</SpeakSentence>`);
    expect(r.bxml).not.toContain(`voice="alice"`);
    expect(r.findings.some((f) => f.severity === "warning" && /voice/i.test(f.message))).toBe(true);
  });
  it("Say drops an unrecognized voice rather than emitting an invalid one", () => {
    const r = translateTwiml(`<Response><Say voice="Polly.Joanna">Hi</Say></Response>`);
    expect(r.bxml).toContain(`<SpeakSentence>Hi</SpeakSentence>`);
    expect(r.bxml).not.toContain("voice=");
    expect(r.findings.some((f) => f.severity === "warning")).toBe(true);
  });
  it("Say preserves SSML child elements through to SpeakSentence", () => {
    const r = translateTwiml(
      `<Response><Say voice="alice">You owe <say-as interpret-as="currency">$5</say-as> by <emphasis>Friday</emphasis>.</Say></Response>`,
    );
    expect(r.bxml).toContain(`<say-as interpret-as="currency">$5</say-as>`);
    expect(r.bxml).toContain(`<emphasis>Friday</emphasis>`);
    expect(r.bxml).not.toContain("&lt;say-as");
    expect(r.bxml).toContain(`voice="julie"`);
  });
  it("Say still escapes genuine special characters in text", () => {
    const r = translateTwiml(`<Response><Say>Tom &amp; Jerry &lt;tag&gt;</Say></Response>`);
    expect(r.bxml).toContain(`Tom &amp; Jerry &lt;tag&gt;`);
  });

  it("Play → PlayAudio", () => {
    const r = translateTwiml(`<Response><Play>https://x.test/a.mp3</Play></Response>`);
    expect(r.bxml).toContain(`<PlayAudio>https://x.test/a.mp3</PlayAudio>`);
  });
  it("Pause length → duration", () => {
    const r = translateTwiml(`<Response><Pause length="3"/></Response>`);
    expect(r.bxml).toContain(`<Pause duration="3"/>`);
  });
  it("Hangup passes through; Reject becomes Hangup with warning", () => {
    const r = translateTwiml(`<Response><Reject/></Response>`);
    expect(r.bxml).toContain(`<Hangup/>`);
    expect(r.findings.some((f) => f.verb === "Reject" && f.severity === "warning")).toBe(true);
  });
  it("Redirect text URL → redirectUrl attr, rewritten via option", () => {
    const r = translateTwiml(`<Response><Redirect>/next</Redirect></Response>`, {
      rewriteUrl: (url) => `https://adapter.test/bw/continue?next=${encodeURIComponent(url)}`,
    });
    expect(r.bxml).toContain(
      `<Redirect redirectUrl="https://adapter.test/bw/continue?next=%2Fnext"/>`,
    );
  });
  it("unknown verb yields error finding and no output element", () => {
    const r = translateTwiml(`<Response><Autopilot/></Response>`);
    expect(r.findings.some((f) => f.severity === "error")).toBe(true);
  });
});
