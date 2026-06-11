import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { analyzeSource, type FileAnalysis } from "./analyze.js";
import { renderReport } from "./report.js";

const EXTENSIONS = new Set([".js", ".ts", ".mjs", ".cjs", ".xml"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(full, out);
    } else if (EXTENSIONS.has(extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

const target = process.argv[2];
if (!target) {
  console.error("Usage: npm run preflight -- <path-to-repo-or-file>");
  process.exit(2);
}

const files = statSync(target).isDirectory() ? walk(target) : [target];
const analyses: FileAnalysis[] = files.map((f) => analyzeSource(f, readFileSync(f, "utf8")));
console.log(renderReport(analyses));
