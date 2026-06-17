import type { BwRecording } from "../bw/client.js";
import { toCallSid, toRecordingSid } from "./call-sid.js";
import { twilioDate } from "./call-resource.js";

/** Parse an ISO-8601 duration like "PT13.67S" to whole seconds (Twilio uses a string). */
export function iso8601DurationToSeconds(iso: string): string {
  const m = /PT(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?/.exec(iso);
  const minutes = m?.[1] ? parseFloat(m[1]) : 0;
  const seconds = m?.[2] ? parseFloat(m[2]) : 0;
  return String(Math.round(minutes * 60 + seconds));
}

/** Map a Bandwidth recording status to the nearest Twilio recording status. */
export function bwRecordingStatus(status: string): string {
  switch (status) {
    case "complete":
    case "completed":
      return "completed";
    case "processing":
      return "processing";
    case "partial":
      return "in-progress";
    case "deleted":
      return "deleted";
    case "error":
      return "failed";
    default:
      return "completed";
  }
}

/**
 * Shape a Bandwidth recording as a Twilio recording resource. Twilio's recording
 * shape is well-documented but not fixture-verified here; `source` defaults to
 * RecordVerb since most recordings originate from a <Record> verb.
 */
export function recordingResource(rec: BwRecording, accountSid: string): Record<string, unknown> {
  const sid = toRecordingSid(rec.recordingId);
  const callSid = toCallSid(rec.callId);
  const date = rec.startTime ? twilioDate(new Date(rec.startTime)) : null;
  return {
    account_sid: accountSid,
    api_version: "2010-04-01",
    call_sid: callSid,
    conference_sid: null,
    channels: rec.channels ?? 1,
    date_created: date,
    date_updated: date,
    start_time: date,
    duration: iso8601DurationToSeconds(rec.duration),
    sid,
    price: null,
    price_unit: "USD",
    status: bwRecordingStatus(rec.status),
    source: "RecordVerb",
    error_code: null,
    encryption_details: null,
    uri: `/2010-04-01/Accounts/${accountSid}/Recordings/${sid}.json`,
    subresource_uris: {
      add_on_results: `/2010-04-01/Accounts/${accountSid}/Recordings/${sid}/AddOnResults.json`,
      transcriptions: `/2010-04-01/Accounts/${accountSid}/Recordings/${sid}/Transcriptions.json`,
    },
  };
}

/** Twilio's paginated list envelope for a call's recordings. */
export function recordingList(
  recs: BwRecording[],
  accountSid: string,
  callSid: string,
): Record<string, unknown> {
  const uri = `/2010-04-01/Accounts/${accountSid}/Calls/${callSid}/Recordings.json`;
  return {
    recordings: recs.map((r) => recordingResource(r, accountSid)),
    end: Math.max(recs.length - 1, 0),
    first_page_uri: uri,
    next_page_uri: null,
    page: 0,
    page_size: recs.length,
    previous_page_uri: null,
    start: 0,
    uri,
  };
}
