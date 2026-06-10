import { describe, it, expect } from "vitest";
import { parseTwiml } from "../src/xml/parse-twiml.js";
import { serialize, bxmlDocument } from "../src/xml/build-xml.js";

describe("parseTwiml", () => {
  it("parses verbs in order with attrs, text, and children", () => {
    const node = parseTwiml(
      `<?xml version="1.0"?><Response><Say voice="alice">Hello</Say><Gather numDigits="1" action="/menu"><Play>https://x.test/a.mp3</Play></Gather></Response>`,
    );
    expect(node.name).toBe("Response");
    expect(node.children.map((c) => c.name)).toEqual(["Say", "Gather"]);
    expect(node.children[0].attrs.voice).toBe("alice");
    expect(node.children[0].text).toBe("Hello");
    expect(node.children[1].children[0].text).toBe("https://x.test/a.mp3");
  });
  it("throws on missing Response root", () => {
    expect(() => parseTwiml("<Nope/>")).toThrow(/Response/);
  });

  it("preserves inner SSML markup as raw, escaping only real text", () => {
    const node = parseTwiml(
      `<Response><Say>You owe <say-as interpret-as="currency">$5</say-as> &amp; tax by <emphasis>Friday</emphasis>.</Say></Response>`,
    );
    const say = node.children[0];
    expect(say.inner).toBe(
      `You owe <say-as interpret-as="currency">$5</say-as> &amp; tax by <emphasis>Friday</emphasis>.`,
    );
  });
});

describe("serialize", () => {
  it("builds escaped XML, self-closing when empty", () => {
    expect(serialize({ name: "Hangup" })).toBe("<Hangup/>");
    expect(
      serialize({ name: "SpeakSentence", attrs: { voice: "julie" }, children: ["a < b"] }),
    ).toBe(`<SpeakSentence voice="julie">a &lt; b</SpeakSentence>`);
  });
  it("wraps a BXML document", () => {
    expect(bxmlDocument([{ name: "Hangup" }])).toBe(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
    );
  });
  it("emits raw children verbatim (no escaping), strings escaped", () => {
    expect(
      serialize({ name: "SpeakSentence", children: [{ raw: `a <emphasis>b</emphasis>` }] }),
    ).toBe(`<SpeakSentence>a <emphasis>b</emphasis></SpeakSentence>`);
    expect(serialize({ name: "SpeakSentence", children: ["a <b>"] })).toBe(
      `<SpeakSentence>a &lt;b&gt;</SpeakSentence>`,
    );
  });
});
