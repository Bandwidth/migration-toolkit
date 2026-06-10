import { describe, it, expect } from "vitest";
import { translateTwiml } from "../src/translator/translate.js";

const rw = (url: string) => `https://adapter.test/bw/continue?next=${encodeURIComponent(url)}`;

describe("Gather", () => {
  it("maps attributes and nested prompts", () => {
    const r = translateTwiml(
      `<Response><Gather numDigits="1" timeout="7" finishOnKey="#" action="/menu"><Say>Press 1</Say></Gather></Response>`,
      { rewriteUrl: rw },
    );
    expect(r.bxml).toContain(`maxDigits="1"`);
    expect(r.bxml).toContain(`firstDigitTimeout="7"`);
    expect(r.bxml).toContain(`terminatingDigits="#"`);
    expect(r.bxml).toContain(`gatherUrl="https://adapter.test/bw/continue?next=%2Fmenu"`);
    expect(r.bxml).toContain(`<SpeakSentence>Press 1</SpeakSentence>`);
    expect(r.hasErrors).toBe(false);
  });
  it("rejects speech input as error", () => {
    const r = translateTwiml(`<Response><Gather input="speech" action="/a"/></Response>`);
    expect(r.hasErrors).toBe(true);
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
    expect(r.bxml).toContain(`recordCompleteUrl="https://adapter.test/bw/continue?next=%2Fdone"`);
  });
});
