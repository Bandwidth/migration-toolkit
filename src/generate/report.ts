import type { GeneratedDoc, PreservedUrl } from "./generate.js";
import type { DynamicSource } from "./ingest.js";
import { bxmlFileName } from "./generate.js";

export interface GenerateResult {
  docs: GeneratedDoc[];
  dynamicSources: DynamicSource[];
}

function uniqueUrls(urls: PreservedUrl[]): PreservedUrl[] {
  const seen = new Map<string, PreservedUrl>();
  for (const u of urls) seen.set(`${u.kind}:${u.url}`, u);
  return [...seen.values()];
}

/** Plain-English migration report, mirroring the pre-flight report's tone. */
export function renderMigration(result: GenerateResult): string {
  const { docs, dynamicSources } = result;
  const clean = docs.filter((d) => d.findings.length === 0).length;
  const withBlockers = docs.filter((d) => d.hasErrors).length;
  const lines: string[] = [
    "# Twilio → Bandwidth migration — generated BXML",
    "",
    `Translated **${docs.length}** TwiML document${docs.length === 1 ? "" : "s"} to native BXML` +
      ` (${clean} clean, ${withBlockers} with blockers).`,
    "",
    "Generated BXML is written under `bxml/`. Action/redirect URLs are preserved",
    "exactly as your Twilio app used them — point those endpoints at your migrated",
    "backend (now returning BXML) and the call flow keeps working.",
    "",
  ];

  for (const d of docs) {
    lines.push(`## \`${d.label}\` → \`bxml/${bxmlFileName(d.label)}\``, "");
    const errors = d.findings.filter((f) => f.severity === "error");
    const warnings = d.findings.filter((f) => f.severity === "warning");
    if (errors.length === 0 && warnings.length === 0)
      lines.push("✅ Translated cleanly.", "");
    if (errors.length) {
      lines.push("### 🛑 Blockers — need a human", "");
      for (const f of errors)
        lines.push(`- **${f.verb}** — ${f.message}${f.docsUrl ? ` ([docs](${f.docsUrl}))` : ""}`);
      lines.push("");
    }
    if (warnings.length) {
      lines.push("### ⚠️ Heads up", "");
      for (const f of warnings)
        lines.push(`- **${f.verb}** — ${f.message}${f.docsUrl ? ` ([docs](${f.docsUrl}))` : ""}`);
      lines.push("");
    }
    const urls = uniqueUrls(d.preservedUrls);
    if (urls.length) {
      lines.push("### 🔗 Callback URLs you must keep serving (now in BXML)", "");
      for (const u of urls) lines.push(`- \`${u.url}\` (${u.kind})`);
      lines.push("");
    }
  }

  if (dynamicSources.length) {
    lines.push(
      "## ⏳ Dynamic source files — generate from captured traffic or migrate by hand",
      "",
      "These files build TwiML at runtime through the Twilio SDK, so there is no",
      "static markup to transpile. Capture their live responses and re-run, or port",
      "the logic by hand.",
      "",
    );
    for (const s of dynamicSources)
      lines.push(`- \`${s.file}\`${s.verbs.length ? ` — verbs seen: ${s.verbs.join(", ")}` : ""}`);
    lines.push("");
  }

  return lines.join("\n");
}

/** Machine-readable counterpart to the markdown report. */
export function buildCoverage(result: GenerateResult): object {
  const { docs, dynamicSources } = result;
  return {
    summary: {
      docs: docs.length,
      clean: docs.filter((d) => d.findings.length === 0).length,
      withBlockers: docs.filter((d) => d.hasErrors).length,
      dynamicSources: dynamicSources.length,
    },
    docs: docs.map((d) => ({
      label: d.label,
      source: d.source,
      bxmlFile: `bxml/${bxmlFileName(d.label)}`,
      hasErrors: d.hasErrors,
      blockers: d.findings.filter((f) => f.severity === "error").map((f) => ({ verb: f.verb, message: f.message })),
      headsUp: d.findings.filter((f) => f.severity === "warning").map((f) => ({ verb: f.verb, message: f.message })),
      preservedUrls: uniqueUrls(d.preservedUrls),
    })),
    dynamicSources,
  };
}
