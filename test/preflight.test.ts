import { describe, it, expect } from "vitest";
import { analyzeSource } from "../src/preflight/analyze.js";
import { renderReport, complexityScore } from "../src/preflight/report.js";

describe("analyzeSource", () => {
  it("detects verbs in embedded TwiML strings", () => {
    const a = analyzeSource(
      "app.js",
      `const x = \`<Response><Say>hi</Say><Enqueue>q</Enqueue></Response>\`;`,
    );
    expect(a.verbs).toContain("Say");
    expect(a.verbs).toContain("Enqueue");
    expect(a.findings.some((f) => f.severity === "error" && f.verb === "Enqueue")).toBe(true);
  });
  it("detects twilio SDK verb method calls", () => {
    const src = `const { twiml } = require("twilio");
const vr = new twiml.VoiceResponse();
vr.say("hello");
vr.dial("+15551");
vr.enqueue("support");`;
    const a = analyzeSource("ivr.js", src);
    expect(a.sdkDetected).toBe(true);
    expect(a.verbs).toEqual(expect.arrayContaining(["Say", "Dial", "Enqueue"]));
  });
  it("ignores files without twilio markers", () => {
    const a = analyzeSource("other.js", `console.log("nothing here")`);
    expect(a.verbs).toEqual([]);
  });
});

describe("report", () => {
  it("scores: clean file low, unsupported-heavy file high", () => {
    const clean = analyzeSource("a.xml", `<Response><Say>hi</Say></Response>`);
    const dirty = analyzeSource("b.xml", `<Response><Enqueue>q</Enqueue><Pay/></Response>`);
    expect(complexityScore([clean])).toBeLessThan(complexityScore([dirty]));
    expect(complexityScore([dirty])).toBeLessThanOrEqual(10);
  });
  it("renders markdown with status sections", () => {
    const a = analyzeSource(
      "a.xml",
      `<Response><Say voice="alice">hi</Say><Enqueue>q</Enqueue></Response>`,
    );
    const md = renderReport([a]);
    expect(md).toContain("# Twilio → Bandwidth migration pre-flight report");
    expect(md).toContain("Enqueue");
    expect(md).toMatch(/complexity/i);
  });
});
