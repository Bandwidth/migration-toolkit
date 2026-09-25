import { mkdirSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

/** Media frames kept per stream capture; start and stop are always written. */
const MAX_CAPTURED_MEDIA_FRAMES = 10;
const capturedMedia = new Map<string, number>();

/**
 * Append one raw Bandwidth StartStream WebSocket frame to
 * `<dir>/streams/<hash>.jsonl`, one JSON frame per line, so a live call yields
 * checked-in fixtures for the bridge tests (see test/fixtures/bandwidth/).
 *
 * `streamKey` is a per-connection identifier chosen by the server (never
 * Bandwidth-supplied), hashed like captureTwiml so nothing untrusted reaches the
 * filesystem path. Only the first MAX_CAPTURED_MEDIA_FRAMES media frames are
 * kept; a call is 50 frames a second and the shapes are identical. Same
 * private-by-default modes and synchronous I/O as captureTwiml.
 *
 * Returns the path written, or undefined when the frame was skipped by the cap.
 */
export function captureStreamFrame(dir: string, streamKey: string, rawFrame: string): string | undefined {
  const streamsDir = join(dir, "streams");
  const file = join(streamsDir, `${createHash("sha256").update(streamKey).digest("hex").slice(0, 16)}.jsonl`);
  if (/"eventType"\s*:\s*"media"/.test(rawFrame)) {
    const n = capturedMedia.get(file) ?? 0;
    if (n >= MAX_CAPTURED_MEDIA_FRAMES) return undefined;
    capturedMedia.set(file, n + 1);
  }
  mkdirSync(streamsDir, { recursive: true, mode: 0o700 });
  appendFileSync(file, rawFrame.replace(/\r?\n/g, " ") + "\n", { mode: 0o600 });
  return file;
}

/**
 * Persist a raw TwiML response the translator fetched from the customer app, so a
 * later `npm run bxml-generator` over the capture dir can turn the paths a test call
 * actually exercised into standalone BXML.
 *
 * The filename is a content hash — never request input — so identical responses
 * dedupe to one file and untrusted input never participates in filesystem
 * addressing (same guardrail as scripts/capture-server.mjs). We store the raw
 * TwiML verbatim (customer URLs intact, no proxy rewrite), which is exactly what
 * the BXML Generator ingests.
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
