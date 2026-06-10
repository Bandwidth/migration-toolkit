/** A pre-formatted, already-escaped inner string emitted verbatim (e.g. SSML). */
export interface RawXml {
  raw: string;
}

export type XmlChild = XmlEl | string | RawXml;

export interface XmlEl {
  name: string;
  attrs?: Record<string, string | undefined>;
  children?: XmlChild[];
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function serialize(el: XmlEl): string {
  const attrs = Object.entries(el.attrs ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${esc(String(v))}"`)
    .join("");
  const kids = (el.children ?? [])
    .map((c) => (typeof c === "string" ? esc(c) : "raw" in c ? c.raw : serialize(c)))
    .join("");
  return kids ? `<${el.name}${attrs}>${kids}</${el.name}>` : `<${el.name}${attrs}/>`;
}

export function bxmlDocument(children: (XmlEl | string)[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>` + serialize({ name: "Response", children });
}
