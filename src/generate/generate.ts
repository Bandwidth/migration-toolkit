import { translateTwiml, type Finding, type UrlKind } from "../translator/translate.js";
import type { TwimlDoc } from "./ingest.js";

// A callback URL preserved verbatim in the generated BXML — a hop the customer
// must keep serving (now in BXML) after migrating.
export interface PreservedUrl {
  url: string;
  kind: UrlKind;
}

export interface GeneratedDoc {
  label: string;
  source: string;
  bxml: string;
  findings: Finding[];
  preservedUrls: PreservedUrl[];
  hasErrors: boolean;
}

/**
 * Translate one TwiML doc to standalone BXML the customer owns. "Standalone"
 * means action/redirect URLs are preserved verbatim (no proxy rewrite) — we use
 * the translator's rewriteUrl hook purely to *record* those hops, returning each
 * URL unchanged.
 */
export function generateDoc(doc: TwimlDoc): GeneratedDoc {
  const preservedUrls: PreservedUrl[] = [];
  const result = translateTwiml(doc.twiml, {
    rewriteUrl: (url, kind) => {
      preservedUrls.push({ url, kind });
      return url;
    },
  });
  return {
    label: doc.label,
    source: doc.source,
    bxml: result.bxml,
    findings: result.findings,
    preservedUrls,
    hasErrors: result.hasErrors,
  };
}

export function generateDocs(docs: TwimlDoc[]): GeneratedDoc[] {
  return docs.map(generateDoc);
}

/** A filesystem-safe `.bxml` name derived from a doc label. */
export function bxmlFileName(label: string): string {
  const slug = label
    .replace(/\.(xml|twiml|js|ts|mjs|cjs|json)\b/gi, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `${slug || "doc"}.bxml`;
}
