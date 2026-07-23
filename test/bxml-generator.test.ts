import { describe, it, expect } from "vitest";
import { ingest, extractTwimlBlocks } from "../src/bxml-generator/ingest.js";
import { generateDoc, generateDocs, bxmlFileName } from "../src/bxml-generator/generate.js";
import { renderMigration, buildCoverage, type GenerateResult } from "../src/bxml-generator/report.js";

describe("ingest", () => {
  it("treats a standalone .xml TwiML file as one doc", () => {
    const r = ingest([{ file: "menu.xml", content: `<Response><Say>hi</Say></Response>` }]);
    expect(r.docs).toHaveLength(1);
    expect(r.docs[0]).toMatchObject({ label: "menu.xml", source: "menu.xml" });
    expect(r.dynamicSources).toHaveLength(0);
  });

  it("splits multiple <Response> blocks in one file and labels them", () => {
    const content = `<Response><Say>a</Say></Response>\n<Response><Hangup/></Response>`;
    const r = ingest([{ file: "flows.xml", content }]);
    expect(r.docs.map((d) => d.label)).toEqual(["flows.xml#1", "flows.xml#2"]);
  });

  it("flags an SDK-built file as a dynamic source, not a translatable doc", () => {
    const src = `const { twiml } = require("twilio");
const vr = new twiml.VoiceResponse();
vr.say("hello");
vr.dial("+15551");`;
    const r = ingest([{ file: "ivr.js", content: src }]);
    expect(r.docs).toHaveLength(0);
    expect(r.dynamicSources).toHaveLength(1);
    expect(r.dynamicSources[0].verbs).toEqual(expect.arrayContaining(["Say", "Dial"]));
  });

  it("pulls TwiML responses out of a capture JSON, ignoring request-only captures", () => {
    const response = JSON.stringify({ bodyRaw: `<Response><Say>captured</Say></Response>` });
    const request = JSON.stringify({ bodyParams: { CallSid: "CA123", From: "+1555" } });
    const r = ingest([
      { file: "capture/resp.json", content: response },
      { file: "capture/req.json", content: request },
    ]);
    expect(r.docs).toHaveLength(1);
    expect(r.docs[0].twiml).toContain("captured");
  });

  it("extractTwimlBlocks finds zero blocks in non-TwiML text", () => {
    expect(extractTwimlBlocks(`console.log("nothing")`)).toEqual([]);
  });
});

describe("generateDoc", () => {
  it("preserves action URLs verbatim and records them as hops", () => {
    const doc = {
      label: "menu.xml",
      source: "menu.xml",
      twiml: `<Response><Gather action="/route" numDigits="1"><Say>Press 1</Say></Gather></Response>`,
    };
    const g = generateDoc(doc);
    expect(g.bxml).toContain(`gatherUrl="/route"`); // preserved, not rewritten to a proxy URL
    expect(g.bxml).not.toContain("/bw/continue");
    expect(g.preservedUrls).toContainEqual({ url: "/route", kind: "action" });
  });

  it("surfaces blockers from unsupported verbs", () => {
    const g = generateDoc({
      label: "q.xml",
      source: "q.xml",
      twiml: `<Response><Enqueue>support</Enqueue></Response>`,
    });
    expect(g.hasErrors).toBe(true);
    expect(g.findings.some((f) => f.severity === "error" && f.verb === "Enqueue")).toBe(true);
  });

  it("emits valid standalone BXML for a clean flow", () => {
    const g = generateDoc({
      label: "greet.xml",
      source: "greet.xml",
      twiml: `<Response><Say>Welcome</Say><Hangup/></Response>`,
    });
    expect(g.bxml).toContain("<SpeakSentence>Welcome</SpeakSentence>");
    expect(g.bxml).toContain("<Hangup");
    expect(g.findings).toHaveLength(0);
  });
});

describe("bxmlFileName", () => {
  it("slugifies labels into .bxml names", () => {
    expect(bxmlFileName("menu.xml")).toBe("menu.bxml");
    expect(bxmlFileName("flows.xml#2")).toBe("flows-2.bxml");
    expect(bxmlFileName("capture/resp.json")).toBe("capture-resp.bxml");
  });
});

describe("report", () => {
  const result: GenerateResult = {
    docs: generateDocs([
      { label: "menu.xml", source: "menu.xml", twiml: `<Response><Gather action="/route"><Say>hi</Say></Gather></Response>` },
      { label: "q.xml", source: "q.xml", twiml: `<Response><Enqueue>support</Enqueue></Response>` },
    ]),
    dynamicSources: [{ file: "ivr.js", verbs: ["Say", "Dial"] }],
  };

  it("renders markdown with translated docs, blockers, preserved URLs and dynamic sources", () => {
    const md = renderMigration(result);
    expect(md).toContain("# Twilio → Bandwidth migration — generated BXML");
    expect(md).toContain("`/route` (action)");
    expect(md).toContain("Enqueue");
    expect(md).toContain("ivr.js");
    expect(md).toMatch(/Dynamic source files/);
  });

  it("builds coverage json with a summary and per-doc detail", () => {
    const cov = buildCoverage(result) as any;
    expect(cov.summary).toMatchObject({ docs: 2, dynamicSources: 1 });
    expect(cov.docs.find((d: any) => d.label === "menu.xml").preservedUrls).toContainEqual({
      url: "/route",
      kind: "action",
    });
    expect(cov.docs.find((d: any) => d.label === "q.xml").blockers[0].verb).toBe("Enqueue");
  });
});
