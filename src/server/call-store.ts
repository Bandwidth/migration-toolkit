export interface CallRecord {
  sid: string;
  /** The underlying Bandwidth call ID this Twilio CallSid maps to. */
  bwCallId: string;
  from: string;
  to: string;
  direction: "inbound" | "outbound-api";
  voiceUrl: string;
}

export class CallStore {
  private byBwId = new Map<string, CallRecord>();
  private bySid = new Map<string, CallRecord>();
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
}
