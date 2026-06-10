export interface CreateCallOpts {
  to: string;
  from: string;
  answerUrl: string;
}

export interface BwClient {
  createCall(opts: CreateCallOpts): Promise<{ callId: string }>;
}
