import { XMLParser } from "fast-xml-parser";

export interface TwimlNode {
  name: string;
  attrs: Record<string, string>;
  text: string;
  children: TwimlNode[];
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: true,
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
    out.push({ name, attrs, text, children: normalize(body) });
  }
  return out;
}
