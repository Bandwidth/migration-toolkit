import type { FileAnalysis } from "./analyze.js";

export function complexityScore(analyses: FileAnalysis[]): number {
  const all = analyses.flatMap((a) => a.findings);
  const warnings = all.filter((f) => f.severity === "warning").length;
  const errors = all.filter((f) => f.severity === "error").length;
  return Math.min(10, Math.max(1, 1 + warnings + errors * 3));
}

export function renderReport(analyses: FileAnalysis[]): string {
  const relevant = analyses.filter((a) => a.verbs.length > 0);
  const score = complexityScore(relevant);
  const lines: string[] = [
    "# Twilio → Bandwidth migration pre-flight report",
    "",
    `**Migration complexity: ${score}/10** (1 + warnings + 3×blockers, capped at 10)`,
    "",
    `Files with Twilio voice usage: ${relevant.length}`,
    "",
  ];
  for (const a of relevant) {
    lines.push(`## \`${a.file}\``, "", `Verbs found: ${a.verbs.join(", ")}`, "");
    const errors = a.findings.filter((f) => f.severity === "error");
    const warnings = a.findings.filter((f) => f.severity === "warning");
    if (errors.length === 0 && warnings.length === 0)
      lines.push("✅ Runs through the adapter as-is.", "");
    if (errors.length) {
      lines.push("### 🛑 Blockers", "");
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
  }
  return lines.join("\n");
}
