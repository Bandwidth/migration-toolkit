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
  /** The most recent TwiML document fetched for this call and the URL it came
   *  from. Kept so a <Gather> that ends with no input can resume the document
   *  after that Gather, as Twilio does, instead of requesting the action. */
  lastTwiml?: string;
  lastTwimlUrl?: string;
}

/** Resolves a Twilio recording SID back to the BW call + recording it maps to. */
export interface RecordingRef {
  bwCallId: string;
  bwRecordingId: string;
}

/** What Bandwidth's transferDisconnect event said about one dialed (B) leg. */
export interface TransferLegOutcome {
  /** Bandwidth call id of the dialed leg. */
  bwCallId: string;
  cause: string;
  startTime?: string;
  answerTime?: string;
  endTime?: string;
  transferTo?: string;
}

export class CallStore {
  private byBwId = new Map<string, CallRecord>();
  private bySid = new Map<string, CallRecord>();
  private recordingsBySid = new Map<string, RecordingRef>();
  /** Dialed-leg outcomes waiting for their parent's transferComplete, by parent call id. */
  private transferLegsByParent = new Map<string, TransferLegOutcome[]>();
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
  putTransferLeg(parentBwCallId: string, leg: TransferLegOutcome): void {
    const legs = this.transferLegsByParent.get(parentBwCallId) ?? [];
    legs.push(leg);
    this.transferLegsByParent.set(parentBwCallId, legs);
  }
  /** Remove and return the oldest pending dialed-leg outcome for a parent call. */
  takeTransferLeg(parentBwCallId: string): TransferLegOutcome | undefined {
    const legs = this.transferLegsByParent.get(parentBwCallId);
    if (!legs || legs.length === 0) return undefined;
    const leg = legs.shift();
    if (legs.length === 0) this.transferLegsByParent.delete(parentBwCallId);
    return leg;
  }
}
