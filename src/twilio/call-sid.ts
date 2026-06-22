import { createHash } from "node:crypto";

export function toCallSid(bwCallId: string): string {
  return "CA" + createHash("md5").update(bwCallId).digest("hex");
}

export function toRecordingSid(bwRecordingId: string): string {
  return "RE" + createHash("md5").update(bwRecordingId).digest("hex");
}

/**
 * Twilio IncomingPhoneNumber SID (PN...). Derived deterministically from the
 * E.164 number so the same provisioned number always maps to the same SID.
 */
export function toIncomingPhoneNumberSid(phoneNumber: string): string {
  return "PN" + createHash("md5").update(phoneNumber).digest("hex");
}
