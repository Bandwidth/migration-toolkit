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
  answerTime?: string;
  endTime?: string;
}

export class CallStore {
  private byBwId = new Map<string, CallRecord>();
  private bySid = new Map<string, CallRecord>();
  private recordingsBySid = new Map<string, RecordingRef>();
  /** Dialed-leg outcomes waiting for their Dial's transferComplete, by parent
   *  call id, then by the Dial they belong to. Keying by Dial keeps a late leg
   *  from one Dial out of the next Dial's action. */
  private transferLegsByParent = new Map<string, Map<string, TransferLegOutcome[]>>();
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
  /** A redelivered event for the same leg replaces the earlier one, so it can't
   *  count twice toward the Dial's expected legs. */
  putTransferLeg(parentBwCallId: string, dialKey: string, leg: TransferLegOutcome): void {
    const byDial = this.transferLegsByParent.get(parentBwCallId) ?? new Map<string, TransferLegOutcome[]>();
    const others = (byDial.get(dialKey) ?? []).filter((l) => l.bwCallId !== leg.bwCallId);
    byDial.set(dialKey, [...others, leg]);
    this.transferLegsByParent.set(parentBwCallId, byDial);
  }
  /** The dialed-leg outcomes received so far for one Dial, in arrival order. */
  peekTransferLegs(parentBwCallId: string, dialKey: string): readonly TransferLegOutcome[] {
    return this.transferLegsByParent.get(parentBwCallId)?.get(dialKey) ?? [];
  }
  /** Forget one Dial's legs once its action has been answered. */
  dropTransferLegs(parentBwCallId: string, dialKey: string): void {
    const byDial = this.transferLegsByParent.get(parentBwCallId);
    byDial?.delete(dialKey);
    if (byDial?.size === 0) this.transferLegsByParent.delete(parentBwCallId);
  }
  /** Forget every pending leg of a call, e.g. ones that arrived after their Dial's wait. */
  clearTransferLegs(parentBwCallId: string): void {
    this.transferLegsByParent.delete(parentBwCallId);
  }
}
