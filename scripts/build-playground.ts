// Builds the self-contained Migration Preflight artifact: web/ sources + the
// real translation engine + DM Sans fonts, all inlined into a single
// dist/playground.html a salesperson can double-click. No server, no network.

import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = join(root, "web");
const fontsDir = join(webDir, "fonts");
const outDir = join(root, "dist");
const outFile = join(outDir, "playground.html");

// DM Sans (Bandwidth brand face), inlined as base64 woff2 so the file is offline-safe.
const FONT_FACES: Array<{ file: string; weight: string; style: string }> = [
  { file: "dm-sans-latin-400-normal.woff2", weight: "400 500", style: "normal" },
  { file: "dm-sans-latin-700-normal.woff2", weight: "600 700", style: "normal" },
  { file: "dm-sans-latin-800-normal.woff2", weight: "800", style: "normal" },
  { file: "dm-sans-latin-400-italic.woff2", weight: "400 700", style: "italic" },
];

async function fontCss(): Promise<string> {
  const faces = await Promise.all(
    FONT_FACES.map(async ({ file, weight, style }) => {
      const b64 = (await readFile(join(fontsDir, file))).toString("base64");
      return `@font-face{font-family:"DM Sans";font-style:${style};font-weight:${weight};font-display:swap;src:url("data:font/woff2;base64,${b64}") format("woff2");}`;
    }),
  );
  return faces.join("\n");
}

async function main(): Promise<void> {
  const [html, css, fonts, bundle] = await Promise.all([
    readFile(join(webDir, "index.html"), "utf8"),
    readFile(join(webDir, "styles.css"), "utf8"),
    fontCss(),
    build({
      entryPoints: [join(webDir, "app.ts")],
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2020",
      minify: true,
      write: false,
      legalComments: "none",
    }).then((r) => r.outputFiles[0].text),
  ]);

  const styleBlock = `<style>\n${fonts}\n${css}\n</style>`;
  const scriptBlock = `<script>\n${bundle}</script>`;

  // split/join, not replace(): the minified bundle contains "$" sequences that
  // String.replace would interpret as special replacement patterns.
  const out = html
    .split("<!-- build injects <style> (fonts + styles.css) here -->")
    .join(styleBlock)
    .split("<!-- build injects bundled <script> here -->")
    .join(scriptBlock);

  if (out.includes("build injects")) {
    throw new Error("Injection markers not replaced — index.html markers may have changed.");
  }

  // Self-contained check: no external *resource loads* (script/link/img src/href,
  // CSS url(http…), @import). Anchor links to docs (https://…) are fine.
  const offenders = [
    /<script[^>]+src\s*=\s*["']https?:/i,
    /<link[^>]+href\s*=\s*["']https?:/i,
    /<img[^>]+src\s*=\s*["']https?:/i,
    /url\(\s*["']?https?:/i,
    /@import\s+["']?https?:/i,
  ].filter((re) => re.test(out));
  if (offenders.length) {
    throw new Error(`Output is not self-contained — external resource reference(s): ${offenders}`);
  }

  await mkdir(outDir, { recursive: true });
  await writeFile(outFile, out, "utf8");
  console.log(`Wrote ${outFile} (${(Buffer.byteLength(out) / 1024).toFixed(0)} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
