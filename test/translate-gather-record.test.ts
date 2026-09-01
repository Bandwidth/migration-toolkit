import { describe, it, expect } from "vitest";
import { translateTwiml } from "../src/translator/translate.js";

const rw = (url: string) => `https://translator.test/bw/continue?next=${encodeURIComponent(url)}`;

describe("Gather", () => {
  it("maps attributes and nested prompts", () => {
    const r = translateTwiml(
      `<Response><Gather numDigits="1" timeout="7" finishOnKey="#" action="/menu"><Say>Press 1</Say></Gather></Response>`,
      { rewriteUrl: rw },
    );
    expect(r.bxml).toContain(`maxDigits="1"`);
    expect(r.bxml).toContain(`firstDigitTimeout="7"`);
    expect(r.bxml).toContain(`terminatingDigits="#"`);
    expect(r.bxml).toContain(`gatherUrl="https://translator.test/bw/continue?next=%2Fmenu"`);
    expect(r.bxml).toContain(`<SpeakSentence>Press 1</SpeakSentence>`);
    expect(r.hasErrors).toBe(false);
  });
  it("maps speech input to BW input=speech (supported, not an error)", () => {
    const r = translateTwiml(`<Response><Gather input="speech" action="/a"/></Response>`, {
      rewriteUrl: rw,
    });
    expect(r.hasErrors).toBe(false);
    expect(r.bxml).toContain(`input="speech"`);
  });
  it("maps 'dtmf speech' to BW input=dtmf_speech", () => {
    const r = translateTwiml(`<Response><Gather input="dtmf speech" action="/a"/></Response>`, {
      rewriteUrl: rw,
    });
    expect(r.bxml).toContain(`input="dtmf_speech"`);
    expect(r.hasErrors).toBe(false);
  });
  it("warns when action is missing (Twilio re-requests current URL)", () => {
    const r = translateTwiml(`<Response><Gather numDigits="1"/></Response>`);
    expect(r.findings.some((f) => f.severity === "warning" && /action/.test(f.message))).toBe(true);
  });
});

describe("Record", () => {
  it("maps attributes", () => {
    const r = translateTwiml(
      `<Response><Record maxLength="30" finishOnKey="#" action="/done"/></Response>`,
      { rewriteUrl: rw },
    );
    expect(r.bxml).toContain(`maxDuration="30"`);
    expect(r.bxml).toContain(`terminatingDigits="#"`);
    expect(r.bxml).toContain(`recordCompleteUrl="https://translator.test/bw/continue?next=%2Fdone"`);
  });
});
