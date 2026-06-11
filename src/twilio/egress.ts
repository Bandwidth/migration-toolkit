import { twilioSignature } from "./signature.js";
import type { CallRecord } from "../server/call-store.js";

// Twilio's real voice webhooks (verified by live capture, see
// test/fixtures/twilio/webhooks.json) always include From/To plus the Called/
// Caller aliases and a full geo block. Twilio emits "" for geo it can't
// resolve, so unmodified apps reading e.g. req.body.FromState get "" rather
// than undefined. We mirror that: emit every field, best-effort from BW data,
// empty otherwise. Trust fields (StirVerstat/CallToken) are intentionally
// omitted — BW has its own trust model and we will not fabricate them.
const GEO_FIELDS = [
  "FromCity",
  "FromState",
  "FromZip",
  "FromCountry",
  "ToCity",
  "ToState",
  "ToZip",
  "ToCountry",
  "CallerCity",
  "CallerState",
  "CallerZip",
  "CallerCountry",
  "CalledCity",
  "CalledState",
  "CalledZip",
  "CalledCountry",
] as const;

function baseParams(call: CallRecord, accountSid: string): Record<string, string> {
  const geo: Record<string, string> = {};
  for (const f of GEO_FIELDS) geo[f] = "";
  return {
    CallSid: call.sid,
    AccountSid: accountSid,
    From: call.from,
    To: call.to,
    // Caller/Called are Twilio aliases for From/To; apps read both interchangeably.
    Caller: call.from,
    Called: call.to,
    Direction: call.direction,
    ApiVersion: "2010-04-01",
    ...geo,
  };
}

export function initiateParams(call: CallRecord, accountSid: string): Record<string, string> {
  return { ...baseParams(call, accountSid), CallStatus: "ringing" };
}

export function gatherParams(
  call: CallRecord,
  accountSid: string,
  result: { digits?: string; speech?: string },
): Record<string, string> {
  const p: Record<string, string> = { ...baseParams(call, accountSid), CallStatus: "in-progress" };
  // Twilio sends Digits for DTMF and SpeechResult for speech recognition.
  if (result.digits !== undefined) p.Digits = result.digits;
  if (result.speech !== undefined) p.SpeechResult = result.speech;
  return p;
}

export function statusParams(
  call: CallRecord,
  accountSid: string,
  durationSec: number,
): Record<string, string> {
  // Live capture shows status callbacks carry both Duration and CallDuration.
  return {
    ...baseParams(call, accountSid),
    CallStatus: "completed",
    CallDuration: String(durationSec),
    Duration: String(Math.ceil(durationSec / 60)),
    CallbackSource: "call-progress-events",
    SequenceNumber: "0",
  };
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
