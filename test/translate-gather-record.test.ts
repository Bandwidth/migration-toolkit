import { describe, it, expect } from "vitest";
import { translateTwiml, type RewriteContext, type UrlKind } from "../src/translator/translate.js";

const rw = (url: string) => `https://translator.test/bw/continue?next=${encodeURIComponent(url)}`;

/** A rewriter that behaves like the server's: resolves a relative/empty url
 *  against `base` and records every call, so a Gather/Record's "no action"
 *  rewrite can be inspected. */
function serverLikeRewriter(base = "https://customer.test/voice") {
  const calls: { url: string; kind: UrlKind; ctx?: RewriteContext }[] = [];
  const rewriteUrl = (url: string, kind: UrlKind, ctx?: RewriteContext) => {
    calls.push({ url, kind, ctx });
    return `https://translator.test/bw/continue?next=${encodeURIComponent(new URL(url, base).toString())}`;
  };
  return { calls, rewriteUrl, base };
}

describe("Gather", () => {
  it("maps attributes and nested prompts", () => {
    const r = translateTwiml(
      `<Response><Gather numDigits="1" timeout="7" finishOnKey="#" action="/menu"><Say>Press 1</Say></Gather></Response>`,
      { rewriteUrl: rw },
    );
    expect(r.bxml).toContain(`maxDigits="1"`);
    expect(r.bxml).toContain(`firstDigitTimeout="7"`);
    expect(r.bxml).toContain(`interDigitTimeout="7"`);
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

  describe("Twilio defaults (VAPI-4042)", () => {
    it("emits finishOnKey's Twilio default (#) when omitted, rather than Bandwidth's own default (disabled)", () => {
      const r = translateTwiml(`<Response><Gather action="/menu"/></Response>`, { rewriteUrl: rw });
      expect(r.bxml).toContain(`terminatingDigits="#"`);
      expect(r.findings).toEqual([]);
    });

    it("passes finishOnKey=\"\" through unchanged (Twilio and Bandwidth both treat it as disabled)", () => {
      const r = translateTwiml(`<Response><Gather action="/menu" finishOnKey=""/></Response>`, {
        rewriteUrl: rw,
      });
      expect(r.bxml).toContain(`terminatingDigits=""`);
      expect(r.findings).toEqual([]);
    });

    it("drops a character Bandwidth doesn't recognize as a key, and warns", () => {
      // "ab" would never match a real key press, so it would silently disable
      // the stop-key feature if passed through as written.
      const r = translateTwiml(`<Response><Gather action="/menu" finishOnKey="ab"/></Response>`, {
        rewriteUrl: rw,
      });
      expect(r.bxml).not.toContain(`terminatingDigits="ab"`);
      expect(
        r.findings.some((f) => f.severity === "warning" && /finishOnKey="ab"/.test(f.message)),
      ).toBe(true);
    });

    it("keeps the valid characters in a mixed set and drops only the invalid one", () => {
      const r = translateTwiml(`<Response><Gather action="/menu" finishOnKey="1a#"/></Response>`, {
        rewriteUrl: rw,
      });
      expect(r.bxml).toContain(`terminatingDigits="1#"`);
    });

    it("emits timeout's Twilio default (5) as both firstDigitTimeout and interDigitTimeout when omitted", () => {
      const r = translateTwiml(`<Response><Gather action="/menu"/></Response>`, { rewriteUrl: rw });
      expect(r.bxml).toContain(`firstDigitTimeout="5"`);
      expect(r.bxml).toContain(`interDigitTimeout="5"`);
    });

    it("does not emit maxDigits when numDigits is omitted (Bandwidth's own default of 50 is close enough to Twilio's unbounded default)", () => {
      const r = translateTwiml(`<Response><Gather action="/menu"/></Response>`, { rewriteUrl: rw });
      expect(r.bxml).not.toContain("maxDigits");
    });
  });

  describe("keeping values within Bandwidth's limits (VAPI-4042)", () => {
    it("brings an out-of-range timeout back within limits for both firstDigitTimeout and interDigitTimeout, with a warning for each", () => {
      const r = translateTwiml(`<Response><Gather action="/menu" timeout="100"/></Response>`, {
        rewriteUrl: rw,
      });
      expect(r.bxml).toContain(`firstDigitTimeout="60"`);
      expect(r.bxml).toContain(`interDigitTimeout="60"`);
      const warnings = r.findings.filter((f) => f.severity === "warning");
      // Warnings name "timeout" (what the customer wrote), not Bandwidth's
      // attribute names, but still say which BXML attribute is affected.
      expect(warnings.some((f) => /timeout="100".*firstDigitTimeout/.test(f.message))).toBe(true);
      expect(warnings.some((f) => /timeout="100".*interDigitTimeout/.test(f.message))).toBe(true);
    });

    it("enforces interDigitTimeout's minimum (1) separately from firstDigitTimeout's minimum (0)", () => {
      const r = translateTwiml(`<Response><Gather action="/menu" timeout="0"/></Response>`, {
        rewriteUrl: rw,
      });
      // firstDigitTimeout="0" is in range (0-60): left alone.
      expect(r.bxml).toContain(`firstDigitTimeout="0"`);
      // interDigitTimeout's minimum is 1: timeout="0" is raised to 1.
      expect(r.bxml).toContain(`interDigitTimeout="1"`);
      expect(
        r.findings.some((f) => f.severity === "warning" && /timeout="0".*interDigitTimeout/.test(f.message)),
      ).toBe(true);
      expect(r.findings.some((f) => /firstDigitTimeout/.test(f.message))).toBe(false);
    });

    it("limits numDigits to Bandwidth's 50-digit maximum", () => {
      const r = translateTwiml(`<Response><Gather action="/menu" numDigits="75"/></Response>`, {
        rewriteUrl: rw,
      });
      expect(r.bxml).toContain(`maxDigits="50"`);
      expect(
        r.findings.some((f) => f.severity === "warning" && /numDigits="75"/.test(f.message)),
      ).toBe(true);
    });

    it("leaves an in-range value untouched with no warning", () => {
      const r = translateTwiml(`<Response><Gather action="/menu" timeout="10" numDigits="4"/></Response>`, {
        rewriteUrl: rw,
      });
      expect(r.bxml).toContain(`firstDigitTimeout="10"`);
      expect(r.bxml).toContain(`interDigitTimeout="10"`);
      expect(r.bxml).toContain(`maxDigits="4"`);
      expect(r.findings).toEqual([]);
    });

    it("treats timeout=\"\" the same as omitted, not as 0", () => {
      // Number("") is 0, which is in-range for firstDigitTimeout (min 0) but
      // below interDigitTimeout's minimum (1) -- either way, an empty value
      // should fall back to Twilio's default (5), not be read as a number.
      const r = translateTwiml(`<Response><Gather action="/menu" timeout=""/></Response>`, {
        rewriteUrl: rw,
      });
      expect(r.bxml).toContain(`firstDigitTimeout="5"`);
      expect(r.bxml).toContain(`interDigitTimeout="5"`);
      expect(r.findings).toEqual([]);
    });

    it("treats a whitespace-only timeout the same as empty, not as 0", () => {
      // Number(" ") is also 0 -- a template variable that rendered as a
      // space, not nothing, must not be read as a real zero either.
      const r = translateTwiml(`<Response><Gather action="/menu" timeout="  "/></Response>`, {
        rewriteUrl: rw,
      });
      expect(r.bxml).toContain(`firstDigitTimeout="5"`);
      expect(r.bxml).toContain(`interDigitTimeout="5"`);
      expect(r.findings).toEqual([]);
    });

    it("treats a whitespace-only numDigits the same as omitted", () => {
      const r = translateTwiml(`<Response><Gather action="/menu" numDigits=" "/></Response>`, {
        rewriteUrl: rw,
      });
      expect(r.bxml).not.toContain("maxDigits");
      expect(r.findings).toEqual([]);
    });

    it("normalizes a non-decimal but in-range value instead of passing it through as written", () => {
      // Number("0x3C") is 60 in JavaScript, but Bandwidth's BXML parser almost
      // certainly expects a plain decimal number, not a hex literal.
      const r = translateTwiml(`<Response><Gather action="/menu" timeout="0x3C"/></Response>`, {
        rewriteUrl: rw,
      });
      expect(r.bxml).toContain(`firstDigitTimeout="60"`);
      expect(r.bxml).toContain(`interDigitTimeout="60"`);
      expect(r.bxml).not.toContain("0x3C");
    });

    it("normalizes scientific notation to a plain decimal", () => {
      const r = translateTwiml(`<Response><Gather action="/menu" numDigits="1e1"/></Response>`, {
        rewriteUrl: rw,
      });
      expect(r.bxml).toContain(`maxDigits="10"`);
      expect(r.bxml).not.toContain("1e1");
    });

    it("falls back to Bandwidth's own default and warns when the value isn't a number at all", () => {
      const r = translateTwiml(`<Response><Gather action="/menu" numDigits="abc"/></Response>`, {
        rewriteUrl: rw,
      });
      expect(r.bxml).toContain(`maxDigits="50"`);
      expect(r.bxml).not.toContain("abc");
      expect(
        r.findings.some((f) => f.severity === "warning" && /numDigits="abc"/.test(f.message)),
      ).toBe(true);
    });
  });

  describe("no action, re-requesting the current document (VAPI-4042)", () => {
    it("points gatherUrl at the current document when the server provides one, with no warning", () => {
      const { calls, rewriteUrl, base } = serverLikeRewriter();
      const r = translateTwiml(`<Response><Gather numDigits="1"/></Response>`, {
        rewriteUrl,
        documentUrl: base,
      });
      expect(r.bxml).toContain(`gatherUrl="https://translator.test/bw/continue?next=${encodeURIComponent(base)}"`);
      expect(r.findings.some((f) => /action attribute/.test(f.message))).toBe(false);
      // The rewriter still gets the Gather's document position and empty-result
      // flag, exactly as it would for an explicit action, plus selfReference so
      // the server can tell this apart from a real customer action.
      const call = calls.find((c) => c.kind === "action");
      expect(call?.ctx).toEqual({ gatherIndex: 1, actionOnEmptyResult: false, selfReference: true });
    });

    it("still warns when no documentUrl is given (standalone BXML generation has no server to re-request)", () => {
      const { rewriteUrl } = serverLikeRewriter();
      const r = translateTwiml(`<Response><Gather numDigits="1"/></Response>`, { rewriteUrl });
      expect(r.bxml).not.toContain("gatherUrl");
      expect(r.findings.some((f) => f.severity === "warning" && /action attribute/.test(f.message))).toBe(
        true,
      );
    });
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

  describe("Twilio defaults (VAPI-4042)", () => {
    it("emits maxLength's Twilio default (3600) when omitted, rather than Bandwidth's own default (60)", () => {
      const r = translateTwiml(`<Response><Record action="/done"/></Response>`, { rewriteUrl: rw });
      expect(r.bxml).toContain(`maxDuration="3600"`);
    });

    it("emits timeout as silenceTimeout, defaulting to Twilio's 5 seconds (Bandwidth has no silence timeout today)", () => {
      const r = translateTwiml(`<Response><Record action="/done"/></Response>`, { rewriteUrl: rw });
      expect(r.bxml).toContain(`silenceTimeout="5"`);
    });

    it("passes timeout=\"0\" through unchanged (Twilio and Bandwidth both treat it as disabled)", () => {
      const r = translateTwiml(`<Response><Record action="/done" timeout="0"/></Response>`, {
        rewriteUrl: rw,
      });
      expect(r.bxml).toContain(`silenceTimeout="0"`);
    });
  });

  describe("keeping values within Bandwidth's limits (VAPI-4042)", () => {
    it("limits maxLength to Bandwidth's 10800s (3h) maximum", () => {
      const r = translateTwiml(`<Response><Record action="/done" maxLength="14400"/></Response>`, {
        rewriteUrl: rw,
      });
      expect(r.bxml).toContain(`maxDuration="10800"`);
      expect(
        r.findings.some((f) => f.severity === "warning" && /maxLength="14400".*maxDuration/.test(f.message)),
      ).toBe(true);
    });

    it("limits timeout (silenceTimeout) to Bandwidth's 10800s maximum", () => {
      const r = translateTwiml(`<Response><Record action="/done" timeout="99999"/></Response>`, {
        rewriteUrl: rw,
      });
      expect(r.bxml).toContain(`silenceTimeout="10800"`);
    });

    it("treats maxLength=\"\" the same as omitted, not as 0", () => {
      // Number("") is 0, which is below maxDuration's minimum of 1 -- without
      // treating "" as missing, a maxLength="" cuts a recording off at 1s.
      const r = translateTwiml(`<Response><Record action="/done" maxLength=""/></Response>`, {
        rewriteUrl: rw,
      });
      expect(r.bxml).toContain(`maxDuration="3600"`);
    });

    it("treats timeout=\"\" the same as omitted, not as 0", () => {
      const r = translateTwiml(`<Response><Record action="/done" timeout=""/></Response>`, {
        rewriteUrl: rw,
      });
      expect(r.bxml).toContain(`silenceTimeout="5"`);
    });

    it("treats a whitespace-only maxLength the same as empty, not as 0", () => {
      const r = translateTwiml(`<Response><Record action="/done" maxLength="   "/></Response>`, {
        rewriteUrl: rw,
      });
      expect(r.bxml).toContain(`maxDuration="3600"`);
    });

    it("treats a whitespace-only timeout the same as empty, not as 0", () => {
      const r = translateTwiml(`<Response><Record action="/done" timeout="   "/></Response>`, {
        rewriteUrl: rw,
      });
      expect(r.bxml).toContain(`silenceTimeout="5"`);
    });
  });

  describe("finishOnKey -> a single terminatingDigit (VAPI-4042)", () => {
    it("warns when omitted: Bandwidth's own default (#) only covers one of Twilio's default any-key set", () => {
      const r = translateTwiml(`<Response><Record action="/done"/></Response>`, { rewriteUrl: rw });
      expect(r.bxml).toContain(`terminatingDigits="#"`);
      expect(
        r.findings.some((f) => f.severity === "warning" && /finishOnKey defaults to/.test(f.message)),
      ).toBe(true);
    });

    it("passes a single explicit digit through with no warning (exact match)", () => {
      const r = translateTwiml(`<Response><Record action="/done" finishOnKey="5"/></Response>`, {
        rewriteUrl: rw,
      });
      expect(r.bxml).toContain(`terminatingDigits="5"`);
      expect(r.findings.some((f) => /finishOnKey/.test(f.message))).toBe(false);
    });

    it("prefers # when a multi-character set includes it, and warns", () => {
      const r = translateTwiml(`<Response><Record action="/done" finishOnKey="12#"/></Response>`, {
        rewriteUrl: rw,
      });
      expect(r.bxml).toContain(`terminatingDigits="#"`);
      expect(
        r.findings.some((f) => f.severity === "warning" && /finishOnKey="12#"/.test(f.message)),
      ).toBe(true);
    });

    it("falls back to the first character when # is not in a multi-character set, and warns", () => {
      const r = translateTwiml(`<Response><Record action="/done" finishOnKey="123"/></Response>`, {
        rewriteUrl: rw,
      });
      expect(r.bxml).toContain(`terminatingDigits="1"`);
      expect(r.findings.some((f) => /finishOnKey="123"/.test(f.message))).toBe(true);
    });

    it("picks the first valid character in a mixed set rather than blindly the first character", () => {
      const r = translateTwiml(`<Response><Record action="/done" finishOnKey="ab1"/></Response>`, {
        rewriteUrl: rw,
      });
      expect(r.bxml).toContain(`terminatingDigits="1"`);
      expect(r.bxml).not.toContain(`terminatingDigits="a"`);
    });

    it("disables the stop key and warns when there is no valid key at all, rather than falling back to Bandwidth's own default", () => {
      // On Twilio, "a" never matches a real key either, so no key stops the
      // recording early. Falling back to Bandwidth's own default ("#") would
      // introduce a stop key the customer never asked for.
      const r = translateTwiml(`<Response><Record action="/done" finishOnKey="a"/></Response>`, {
        rewriteUrl: rw,
      });
      expect(r.bxml).toContain(`terminatingDigits=""`);
      expect(
        r.findings.some((f) => f.severity === "warning" && /finishOnKey="a"/.test(f.message)),
      ).toBe(true);
    });
  });

  describe("playBeep and trim (VAPI-4042)", () => {
    it("warns when playBeep is omitted (Twilio's default is true) and when explicitly true", () => {
      for (const twiml of [
        `<Response><Record action="/done"/></Response>`,
        `<Response><Record action="/done" playBeep="true"/></Response>`,
      ]) {
        const r = translateTwiml(twiml, { rewriteUrl: rw });
        expect(r.findings.some((f) => f.severity === "warning" && /playBeep/.test(f.message))).toBe(true);
      }
    });

    it("does not warn about playBeep when explicitly false (the one value Bandwidth matches)", () => {
      const r = translateTwiml(`<Response><Record action="/done" playBeep="false"/></Response>`, {
        rewriteUrl: rw,
      });
      expect(r.findings.some((f) => /playBeep/.test(f.message))).toBe(false);
    });

    it("warns when trim is omitted (Twilio's default is trim-silence) and when explicitly trim-silence", () => {
      for (const twiml of [
        `<Response><Record action="/done"/></Response>`,
        `<Response><Record action="/done" trim="trim-silence"/></Response>`,
      ]) {
        const r = translateTwiml(twiml, { rewriteUrl: rw });
        expect(r.findings.some((f) => f.severity === "warning" && /trim/.test(f.message))).toBe(true);
      }
    });

    it("does not warn about trim when explicitly do-not-trim (the one value Bandwidth matches)", () => {
      const r = translateTwiml(`<Response><Record action="/done" trim="do-not-trim"/></Response>`, {
        rewriteUrl: rw,
      });
      expect(r.findings.some((f) => /trim/.test(f.message))).toBe(false);
    });
  });

  describe("no action, re-requesting the current document (VAPI-4042)", () => {
    it("points recordCompleteUrl at the current document when the server provides one, with no 'missing action' warning", () => {
      const { calls, rewriteUrl, base } = serverLikeRewriter();
      const r = translateTwiml(`<Response><Record/></Response>`, { rewriteUrl, documentUrl: base });
      expect(r.bxml).toContain(
        `recordCompleteUrl="https://translator.test/bw/continue?next=${encodeURIComponent(base)}"`,
      );
      expect(r.findings.some((f) => /action attribute/.test(f.message))).toBe(false);
      expect(calls.some((c) => c.kind === "record" && c.url === base)).toBe(true);
    });

    it("warns when no documentUrl is given (standalone BXML generation has no server to re-request)", () => {
      const { rewriteUrl } = serverLikeRewriter();
      const r = translateTwiml(`<Response><Record/></Response>`, { rewriteUrl });
      expect(r.bxml).not.toContain("recordCompleteUrl");
      expect(r.findings.some((f) => f.severity === "warning" && /action attribute/.test(f.message))).toBe(
        true,
      );
    });
  });
});

describe("repeated identical findings collapse to one (VAPI-4042)", () => {
  it("a document with many bare Records reports each generic warning once, not once per Record", () => {
    const manyRecords = Array.from({ length: 10 }, (_, i) => `<Record action="/done${i}"/>`).join("");
    const r = translateTwiml(`<Response>${manyRecords}</Response>`, { rewriteUrl: rw });
    const playBeepWarnings = r.findings.filter((f) => /playBeep/.test(f.message));
    expect(playBeepWarnings).toHaveLength(1);
  });

  it("does not collapse findings that differ, e.g. out-of-range warnings naming different values", () => {
    const r = translateTwiml(
      `<Response><Record action="/a" maxLength="14400"/><Record action="/b" maxLength="20000"/></Response>`,
      { rewriteUrl: rw },
    );
    const maxLengthWarnings = r.findings.filter((f) => /maxLength=/.test(f.message));
    expect(maxLengthWarnings).toHaveLength(2);
  });
});
