import { XMLParser } from "fast-xml-parser";

export interface TwimlNode {
  name: string;
  attrs: Record<string, string>;
  text: string;
  children: TwimlNode[];
  /**
   * Inner content reconstructed as a string: real text is XML-escaped, but
   * child elements (e.g. SSML <say-as>/<emphasis>/<break>) are emitted as raw
   * markup. Lets verbs like <Say> carry SSML through to <SpeakSentence> intact.
   */
  inner: string;
}

const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => escText(s).replace(/"/g, "&quot;");

/** Reconstruct a node body (ordered text + element children) as raw inner XML. */
function rawInner(body: Record<string, unknown>[]): string {
  let out = "";
  for (const item of body) {
    if (item["#text"] !== undefined) {
      out += escText(String(item["#text"]));
      continue;
    }
    const name = Object.keys(item).find((k) => k !== ":@");
    if (!name) continue;
    const childBody = (item[name] as Record<string, unknown>[]) ?? [];
    const attrsRaw = (item[":@"] ?? {}) as Record<string, unknown>;
    const attrs = Object.entries(attrsRaw)
      .map(([k, v]) => ` ${k}="${escAttr(String(v))}"`)
      .join("");
    const inner = rawInner(childBody);
    out += inner ? `<${name}${attrs}>${inner}</${name}>` : `<${name}${attrs}/>`;
  }
  return out;
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  // Phone numbers like "+15552223333" must stay strings — never coerce to number.
  parseTagValue: false,
  parseAttributeValue: false,
  // Preserve whitespace: spaces around SSML elements and inside spoken text are
  // significant for TTS, so we must not trim text nodes.
  trimValues: false,
});

export function parseTwiml(xml: string): TwimlNode {
  const nodes = normalize(parser.parse(xml));
  const response = nodes.find((n) => n.name === "Response");
  if (!response) throw new Error("TwiML document has no <Response> root");
  return response;
}

function normalize(raw: unknown[]): TwimlNode[] {
  const out: TwimlNode[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    const name = Object.keys(item).find((k) => k !== ":@");
    if (!name || name === "#text") continue;
    const body = item[name] as Record<string, unknown>[];
    const attrsRaw = (item[":@"] ?? {}) as Record<string, unknown>;
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(attrsRaw)) attrs[k] = String(v);
    const text = body
      .filter((c) => c["#text"] !== undefined)
      .map((c) => String(c["#text"]))
      .join("");
    out.push({ name, attrs, text, children: normalize(body), inner: rawInner(body) });
  }
  return out;
}
