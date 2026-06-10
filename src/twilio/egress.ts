import { twilioSignature } from "./signature.js";
import type { CallRecord } from "../server/call-store.js";

function baseParams(call: CallRecord, accountSid: string): Record<string, string> {
  return {
    CallSid: call.sid,
    AccountSid: accountSid,
    From: call.from,
    To: call.to,
    Direction: call.direction,
    ApiVersion: "2010-04-01",
  };
}

export function initiateParams(call: CallRecord, accountSid: string): Record<string, string> {
  return { ...baseParams(call, accountSid), CallStatus: "ringing" };
}

export function gatherParams(
  call: CallRecord,
  accountSid: string,
  digits: string,
): Record<string, string> {
  return { ...baseParams(call, accountSid), CallStatus: "in-progress", Digits: digits };
}

export function statusParams(
  call: CallRecord,
  accountSid: string,
  durationSec: number,
): Record<string, string> {
  return { ...baseParams(call, accountSid), CallStatus: "completed", CallDuration: String(durationSec) };
}

export async function postToCustomer(opts: {
  url: string;
  params: Record<string, string>;
  authToken: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(opts.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": twilioSignature(opts.authToken, opts.url, opts.params),
    },
    body: new URLSearchParams(opts.params).toString(),
  });
  if (!res.ok) throw new Error(`Customer webhook ${opts.url} returned ${res.status}`);
  return await res.text();
}
