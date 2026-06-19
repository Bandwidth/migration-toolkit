export interface CallRecord {
  sid: string;
  /** The underlying Bandwidth call ID this Twilio CallSid maps to. */
  bwCallId: string;
  from: string;
  to: string;
  direction: "inbound" | "outbound-api";
  voiceUrl: string;
  /** Customer URL to POST a Twilio-shaped status callback to when the call ends. */
  statusCallback?: string;
  /** HTTP method the customer requested for the status callback (default POST). */
  statusCallbackMethod?: string;
}

/** Resolves a Twilio recording SID back to the BW call + recording it maps to. */
export interface RecordingRef {
  bwCallId: string;
  bwRecordingId: string;
}

export class CallStore {
  private byBwId = new Map<string, CallRecord>();
  private bySid = new Map<string, CallRecord>();
  private recordingsBySid = new Map<string, RecordingRef>();
  put(bwCallId: string, record: CallRecord): void {
    this.byBwId.set(bwCallId, record);
    this.bySid.set(record.sid, record);
  }
  get(bwCallId: string): CallRecord | undefined {
    return this.byBwId.get(bwCallId);
  }
  getBySid(sid: string): CallRecord | undefined {
    return this.bySid.get(sid);
  }
  putRecording(recordingSid: string, ref: RecordingRef): void {
    this.recordingsBySid.set(recordingSid, ref);
  }
  getRecording(recordingSid: string): RecordingRef | undefined {
    return this.recordingsBySid.get(recordingSid);
  }
}
