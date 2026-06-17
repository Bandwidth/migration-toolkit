import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, extname, relative, dirname, basename } from "node:path";
import { ingest } from "./ingest.js";
import { generateDocs, bxmlFileName } from "./generate.js";
import { renderMigration, buildCoverage } from "./report.js";

const EXTENSIONS = new Set([".js", ".ts", ".mjs", ".cjs", ".xml", ".twiml", ".json"]);
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

const input = process.argv[2];
const outdir = process.argv[3];
if (!input || !outdir) {
  console.error("Usage: npm run generate -- <path-to-repo-or-file> <outdir>");
  process.exit(2);
}

const isDir = statSync(input).isDirectory();
const paths = isDir ? walk(input) : [input];
// Label files by their path relative to the input root, so reports and BXML
// filenames read cleanly (menu.xml → menu.bxml, not the full absolute path).
const base = isDir ? input : dirname(input);
const files = paths.map((p) => ({
  file: isDir ? relative(base, p) : basename(p),
  content: readFileSync(p, "utf8"),
}));

const { docs, dynamicSources } = ingest(files);
const generated = generateDocs(docs);
const result = { docs: generated, dynamicSources };

const bxmlDir = join(outdir, "bxml");
mkdirSync(bxmlDir, { recursive: true });
for (const d of generated) {
  writeFileSync(join(bxmlDir, bxmlFileName(d.label)), `${d.bxml}\n`);
}
writeFileSync(join(outdir, "MIGRATION.md"), renderMigration(result));
writeFileSync(join(outdir, "coverage.json"), `${JSON.stringify(buildCoverage(result), null, 2)}\n`);

console.log(
  `Generated ${generated.length} BXML doc(s) → ${bxmlDir}\n` +
    `Report → ${join(outdir, "MIGRATION.md")}\n` +
    (dynamicSources.length
      ? `${dynamicSources.length} dynamic source file(s) need capture or a human (see report).`
      : ""),
);
