import { createHash } from "node:crypto";

export function toCallSid(bwCallId: string): string {
  return "CA" + createHash("md5").update(bwCallId).digest("hex");
}
