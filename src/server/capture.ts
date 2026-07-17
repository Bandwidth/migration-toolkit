import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * Persist a raw TwiML response the adapter fetched from the customer app, so a
 * later `npm run generate` over the capture dir can turn the paths a test call
 * actually exercised into standalone BXML.
 *
 * The filename is a content hash — never request input — so identical responses
 * dedupe to one file and untrusted input never participates in filesystem
 * addressing (same guardrail as scripts/capture-server.mjs). We store the raw
 * TwiML verbatim (customer URLs intact, no proxy rewrite), which is exactly what
 * `generate` ingests.
 *
 * Written private-by-default (dir 0700, file 0600): raw TwiML can carry callback
 * URLs with embedded tokens, so captures are not world-readable. Synchronous I/O
 * is deliberate — this is an opt-in, test-call-volume eval feature on local disk,
 * and serial writes keep the dedup check (existsSync → writeFileSync) race-free
 * within the process; we accept the event-loop cost over async write races.
 *
 * Returns the path written, or the existing path if this TwiML was already seen.
 */
export function captureTwiml(dir: string, twiml: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const hash = createHash("sha256").update(twiml).digest("hex").slice(0, 16);
  const file = join(dir, `${hash}.xml`);
  if (!existsSync(file)) writeFileSync(file, twiml, { mode: 0o600 });
  return file;
}
