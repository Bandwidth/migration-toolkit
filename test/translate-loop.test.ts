import { describe, it, expect } from "vitest";
import { translateTwiml } from "../src/translator/translate.js";

// Twilio's loop="N" repeats a <Say>/<Play>. BXML has no loop attribute, so the
// adapter expands a finite count into repeated verbs. loop="0" (infinite) and
// invalid counts can't be expressed inline, so they fall back to a single play
// plus a warning (no silent degradation).
describe("Say loop", () => {
  it("loop=3 emits the SpeakSentence three times with no warning", () => {
    const r = translateTwiml(`<Response><Say loop="3">Hi</Say></Response>`);
    expect(r.bxml.match(/<SpeakSentence>Hi<\/SpeakSentence>/g)?.length).toBe(3);
    expect(r.findings.some((f) => f.verb === "Say")).toBe(false);
  });
  it("loop=1 (and absent) emits once", () => {
    const r = translateTwiml(`<Response><Say loop="1">Hi</Say></Response>`);
    expect(r.bxml.match(/<SpeakSentence>Hi<\/SpeakSentence>/g)?.length).toBe(1);
    const r2 = translateTwiml(`<Response><Say>Hi</Say></Response>`);
    expect(r2.bxml.match(/<SpeakSentence>Hi<\/SpeakSentence>/g)?.length).toBe(1);
  });
  it("loop=0 (infinite) emits once and warns", () => {
    const r = translateTwiml(`<Response><Say loop="0">Hi</Say></Response>`);
    expect(r.bxml.match(/<SpeakSentence>Hi<\/SpeakSentence>/g)?.length).toBe(1);
    expect(r.findings.some((f) => f.verb === "Say" && f.severity === "warning")).toBe(true);
  });
  it("invalid loop emits once and warns", () => {
    const r = translateTwiml(`<Response><Say loop="abc">Hi</Say></Response>`);
    expect(r.bxml.match(/<SpeakSentence>Hi<\/SpeakSentence>/g)?.length).toBe(1);
    expect(r.findings.some((f) => f.verb === "Say" && f.severity === "warning")).toBe(true);
  });
});

describe("Play loop", () => {
  it("loop=2 emits the PlayAudio twice with no warning", () => {
    const r = translateTwiml(`<Response><Play loop="2">https://x.test/a.mp3</Play></Response>`);
    expect(r.bxml.match(/<PlayAudio>https:\/\/x\.test\/a\.mp3<\/PlayAudio>/g)?.length).toBe(2);
    expect(r.findings.some((f) => f.verb === "Play")).toBe(false);
  });
  it("loop repeats both PlayAudio and SendDtmf as a unit", () => {
    const r = translateTwiml(
      `<Response><Play loop="2" digits="123">https://x.test/a.mp3</Play></Response>`,
    );
    expect(r.bxml.match(/<PlayAudio>/g)?.length).toBe(2);
    expect(r.bxml.match(/<SendDtmf>/g)?.length).toBe(2);
  });
  it("loop=0 (infinite) emits once and warns", () => {
    const r = translateTwiml(`<Response><Play loop="0">https://x.test/a.mp3</Play></Response>`);
    expect(r.bxml.match(/<PlayAudio>/g)?.length).toBe(1);
    expect(r.findings.some((f) => f.verb === "Play" && f.severity === "warning")).toBe(true);
  });
});
