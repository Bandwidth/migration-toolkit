export interface XmlEl {
  name: string;
  attrs?: Record<string, string | undefined>;
  children?: (XmlEl | string)[];
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function serialize(el: XmlEl): string {
  const attrs = Object.entries(el.attrs ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${esc(String(v))}"`)
    .join("");
  const kids = (el.children ?? [])
    .map((c) => (typeof c === "string" ? esc(c) : serialize(c)))
    .join("");
  return kids ? `<${el.name}${attrs}>${kids}</${el.name}>` : `<${el.name}${attrs}/>`;
}

export function bxmlDocument(children: (XmlEl | string)[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>` + serialize({ name: "Response", children });
}
