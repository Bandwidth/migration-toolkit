import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison. Length is guarded first because
 * timingSafeEqual throws on buffers of differing length.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
