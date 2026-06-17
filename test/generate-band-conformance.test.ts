import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ingest } from "../src/generate/ingest.js";
import { generateDocs } from "../src/generate/generate.js";

// Conformance: generated standalone BXML must be accepted by Bandwidth's own
// CLI (`band bxml raw`). Skips (does not fail) when `band` is not on PATH, so
// CI without the binary stays green — same convention as scripts/validate-bxml.sh.
function bandAvailable(): boolean {
  try {
    execFileSync("band", ["bxml", "speak", "probe"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const FIXTURES = fileURLToPath(new URL("./fixtures/twiml", import.meta.url));

const files = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".xml"))
  .map((f) => ({ file: f, content: readFileSync(join(FIXTURES, f), "utf8") }));

const docs = generateDocs(ingest(files).docs);
const hasBand = bandAvailable();

describe("generate → band BXML conformance", () => {
  it("produces a BXML doc for every fixture", () => {
    expect(docs.length).toBe(files.length);
    expect(docs.length).toBeGreaterThan(0);
  });

  if (!hasBand) {
    it.skip("band CLI not on PATH — skipping conformance validation", () => {});
  }

  for (const doc of docs) {
    it.skipIf(!hasBand)(`band accepts generated BXML for ${doc.label}`, () => {
      expect(() =>
        execFileSync("band", ["bxml", "raw", doc.bxml], { stdio: "ignore" }),
      ).not.toThrow();
    });
  }
});
