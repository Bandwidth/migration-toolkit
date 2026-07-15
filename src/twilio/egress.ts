import { twilioSignature } from "./signature.js";
import { assertPublicUrl } from "./egress-guard.js";
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

/**
 * Twilio recording status callback params. This is a leaner payload than the
 * voice webhooks (no geo block) — it carries the recording identity plus the
 * call it belongs to. RecordingUrl points back at the adapter's own recording
 * facade so the customer's existing fetch-by-URL code resolves through us.
 */
export function recordingStatusParams(
  call: CallRecord,
  accountSid: string,
  rec: {
    recordingSid: string;
    recordingUrl: string;
    durationSec: number;
    channels?: number;
    status?: string;
    startTime?: string;
  },
): Record<string, string> {
  return {
    AccountSid: accountSid,
    CallSid: call.sid,
    RecordingSid: rec.recordingSid,
    RecordingUrl: rec.recordingUrl,
    RecordingStatus: rec.status ?? "completed",
    RecordingDuration: String(rec.durationSec),
    RecordingChannels: String(rec.channels ?? 1),
    RecordingSource: "RecordVerb",
    ...(rec.startTime ? { RecordingStartTime: rec.startTime } : {}),
  };
}

export async function postToCustomer(opts: {
  url: string;
  params: Record<string, string>;
  authToken: string;
  fetchImpl?: typeof fetch;
  allowPrivate?: boolean;
  allowHosts?: string[];
  lookup?: (host: string) => Promise<string[]>;
  timeoutMs?: number;
}): Promise<string> {
  const doFetch = opts.fetchImpl ?? fetch;
  // Validate + resolve BEFORE any network call. Throws EgressBlockedError on a
  // disallowed destination.
  await assertPublicUrl(opts.url, { allowPrivate: opts.allowPrivate, allowHosts: opts.allowHosts, lookup: opts.lookup });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await doFetch(opts.url, {
      method: "POST",
      redirect: "manual", // a public URL 302-ing to an internal one is the classic bypass
      signal: ac.signal,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": twilioSignature(opts.authToken, opts.url, opts.params),
      },
      body: new URLSearchParams(opts.params).toString(),
    });
    if (res.status >= 300 && res.status < 400)
      throw new Error(`Customer webhook ${opts.url} attempted a redirect (${res.status})`);
    if (!res.ok) throw new Error(`Customer webhook ${opts.url} returned ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}
