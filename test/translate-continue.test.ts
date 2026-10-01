/**
 * VAPI-4041: what the translator gives the server so /bw/continue can answer a
 * verb's action the way Twilio would.
 *
 *  - Gather actions carry their document position and the actionOnEmptyResult
 *    flag through the rewriter, and a document can be resumed after the Nth Gather.
 *  - Dial targets get a transferDisconnectUrl (with callback creds) when the
 *    server provides one, so the dialed leg's outcome can be joined to the action.
 */
import { describe, it, expect } from "vitest";
import { translateTwiml, type RewriteContext, type UrlKind } from "../src/translator/translate.js";

function recordingRewriter() {
  const calls: { url: string; kind: UrlKind; ctx?: RewriteContext }[] = [];
  const rewriteUrl = (url: string, kind: UrlKind, ctx?: RewriteContext) => {
    calls.push({ url, kind, ctx });
    return `https://tr.test/bw/${kind}?u=${encodeURIComponent(url)}` + (ctx?.gatherIndex ? `&g=${ctx.gatherIndex}` : "");
  };
  return { calls, rewriteUrl };
}

const TWO_GATHERS = `<Response>
  <Say>Welcome</Say>
  <Gather action="/menu" numDigits="1"><Say>Press 1</Say></Gather>
  <Say>No input on menu</Say>
  <Gather action="/again" numDigits="1" actionOnEmptyResult="true"><Say>Try again</Say></Gather>
  <Record action="/voicemail"/>
</Response>`;

describe("Gather action context for the rewriter", () => {
  it("passes a 1-based document index and the actionOnEmptyResult flag for each Gather", () => {
    const { calls, rewriteUrl } = recordingRewriter();
    translateTwiml(TWO_GATHERS, { rewriteUrl });
    const gathers = calls.filter((c) => c.kind === "action");
    expect(gathers.map((c) => c.ctx)).toEqual([
      { gatherIndex: 1, actionOnEmptyResult: false },
      { gatherIndex: 2, actionOnEmptyResult: true },
    ]);
    // Other kinds get no Gather context.
    expect(calls.find((c) => c.kind === "record")?.ctx).toBeUndefined();
  });

  it("restarts the index for every document", () => {
    const { calls, rewriteUrl } = recordingRewriter();
    translateTwiml(`<Response><Gather action="/a"/></Response>`, { rewriteUrl });
    translateTwiml(`<Response><Gather action="/b"/></Response>`, { rewriteUrl });
    expect(calls.map((c) => c.ctx?.gatherIndex)).toEqual([1, 1]);
  });
});

describe("resumeAfterGather", () => {
  it("emits only the verbs after the Nth Gather", () => {
    const { rewriteUrl } = recordingRewriter();
    const r = translateTwiml(TWO_GATHERS, { rewriteUrl, resumeAfterGather: 1 });
    expect(r.hasErrors).toBe(false);
    expect(r.bxml).not.toContain("Welcome");
    expect(r.bxml).not.toContain("Press 1");
    expect(r.bxml).toMatch(/^<\?xml[^>]*><Response><SpeakSentence>No input on menu<\/SpeakSentence><Gather /);
    expect(r.bxml).toContain("<Record ");
  });

  it("keeps later Gathers at their original document index", () => {
    const { calls, rewriteUrl } = recordingRewriter();
    translateTwiml(TWO_GATHERS, { rewriteUrl, resumeAfterGather: 1 });
    const gathers = calls.filter((c) => c.kind === "action");
    expect(gathers).toHaveLength(1);
    expect(gathers[0].ctx).toEqual({ gatherIndex: 2, actionOnEmptyResult: true });
  });

  it("resuming after the last Gather yields an empty Response, which ends the call as Twilio would", () => {
    const { rewriteUrl } = recordingRewriter();
    const r = translateTwiml(`<Response><Gather action="/only"><Say>Hi</Say></Gather></Response>`, {
      rewriteUrl,
      resumeAfterGather: 1,
    });
    expect(r.bxml).toMatch(/<Response\/>$/);
    expect(r.findings).toEqual([]);
  });

  it("resuming past a Gather that does not exist also yields an empty Response", () => {
    const r = translateTwiml(TWO_GATHERS, { resumeAfterGather: 5 });
    expect(r.bxml).toMatch(/<Response\/>$/);
  });

  it("is a no-op when unset or zero", () => {
    const a = translateTwiml(TWO_GATHERS);
    const b = translateTwiml(TWO_GATHERS, { resumeAfterGather: 0 });
    expect(b.bxml).toBe(a.bxml);
    expect(a.bxml).toContain("Welcome");
  });
});

describe("Dial transferDisconnectUrl", () => {
  const dial = `<Response><Dial action="/after"><Number>+15552223333</Number><Sip>sip:agent@pbx.test</Sip></Dial></Response>`;

  it("stamps the server's transfer-leg URL and callback creds on every target when a Dial has an action", () => {
    const r = translateTwiml(dial, {
      rewriteUrl: (u) => `https://tr.test/bw/continue?next=${encodeURIComponent(u)}`,
      callbackAuth: { username: "u", password: "p" },
      transferLegUrl: "https://tr.test/bw/transfer-leg",
    });
    expect(r.bxml).toMatch(
      /<PhoneNumber transferDisconnectUrl="https:\/\/tr\.test\/bw\/transfer-leg" username="u" password="p">\+15552223333<\/PhoneNumber>/,
    );
    expect(r.bxml).toMatch(/<SipUri transferDisconnectUrl="https:\/\/tr\.test\/bw\/transfer-leg" username="u" password="p">/);
    expect(r.bxml).toMatch(/<Transfer transferCompleteUrl="[^"]+" username="u" password="p">/);
  });

  it("does not stamp it when the Dial has no action (nothing to report to)", () => {
    const r = translateTwiml(`<Response><Dial>+15552223333</Dial></Response>`, {
      transferLegUrl: "https://tr.test/bw/transfer-leg",
    });
    expect(r.bxml).not.toContain("transferDisconnectUrl");
  });

  it("does not stamp it when no transferLegUrl is provided (standalone BXML generation)", () => {
    const r = translateTwiml(dial);
    expect(r.bxml).not.toContain("transferDisconnectUrl");
    expect(r.bxml).toContain(`<PhoneNumber>+15552223333</PhoneNumber>`);
  });

  it("describes the Dial action mapping and the caller-hangup case in a warning", () => {
    const r = translateTwiml(dial);
    const w = r.findings.find((f) => f.verb === "Dial" && /DialCallStatus/.test(f.message));
    expect(w?.severity).toBe("warning");
    expect(w?.message).toMatch(/caller hangup/);
  });
});
