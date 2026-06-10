import { describe, it, expect } from "vitest";
import { translateTwiml } from "../src/translator/translate.js";

describe("core verb translation", () => {
  it("Say → SpeakSentence with voice warning", () => {
    const r = translateTwiml(`<Response><Say voice="alice">Hi there</Say></Response>`);
    expect(r.bxml).toContain(`<SpeakSentence voice="alice">Hi there</SpeakSentence>`);
    expect(r.findings.some((f) => f.severity === "warning" && /voice/i.test(f.message))).toBe(true);
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
