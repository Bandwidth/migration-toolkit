import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureTwiml } from "../src/server/capture.js";

const TWIML = `<Response><Say>Hello</Say><Hangup/></Response>`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "capture-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("captureTwiml", () => {
  it("writes the raw TwiML to a file under the capture dir", () => {
    const file = captureTwiml(dir, TWIML);
    expect(readFileSync(file, "utf8")).toContain(TWIML);
  });

  it("names the file from the content hash only, never request input", () => {
    const file = captureTwiml(dir, TWIML);
    // A content-addressed hex name — no path, params, or caller-supplied string.
    expect(file.split("/").pop()).toMatch(/^[0-9a-f]{16}\.xml$/);
  });

  it("dedupes identical TwiML to a single file", () => {
    captureTwiml(dir, TWIML);
    captureTwiml(dir, TWIML);
    captureTwiml(dir, TWIML);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("writes distinct files for distinct TwiML", () => {
    captureTwiml(dir, TWIML);
    captureTwiml(dir, `<Response><Say>Goodbye</Say></Response>`);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it("creates the capture dir if it does not exist", () => {
    const nested = join(dir, "does", "not", "exist");
    const file = captureTwiml(nested, TWIML);
    expect(readFileSync(file, "utf8")).toContain(TWIML);
  });
});
