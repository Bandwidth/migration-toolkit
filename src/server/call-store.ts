export interface CallRecord {
  sid: string;
  from: string;
  to: string;
  direction: "inbound" | "outbound-api";
  voiceUrl: string;
}

export class CallStore {
  private byBwId = new Map<string, CallRecord>();
  put(bwCallId: string, record: CallRecord): void {
    this.byBwId.set(bwCallId, record);
  }
  get(bwCallId: string): CallRecord | undefined {
    return this.byBwId.get(bwCallId);
  }
}
