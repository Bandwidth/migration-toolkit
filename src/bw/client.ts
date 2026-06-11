export interface CreateCallOpts {
  to: string;
  from: string;
  answerUrl: string;
}

export interface ModifyCallOpts {
  /** "active" redirects the call to redirectUrl; "completed" hangs it up. */
  state: "active" | "completed";
  redirectUrl?: string;
  redirectMethod?: "GET" | "POST";
}

export interface GetCallResult {
  callId: string;
  to: string;
  from: string;
  direction: string;
  /** BW call state, e.g. "active" | "disconnected". */
  state: string;
  enqueuedTime?: string;
  startTime?: string;
  answerTime?: string;
  endTime?: string;
}

export interface BwClient {
  createCall(opts: CreateCallOpts): Promise<{ callId: string }>;
  modifyCall(callId: string, opts: ModifyCallOpts): Promise<void>;
  getCall(callId: string): Promise<GetCallResult>;
}

export function createBwClient(cfg: {
  accountId: string;
  username: string;
  password: string;
  applicationId: string;
  baseUrl?: string;
}): BwClient {
  const base = cfg.baseUrl ?? "https://voice.bandwidth.com/api/v2";
  const auth = "Basic " + Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64");
  return {
    async createCall({ to, from, answerUrl }) {
      const res = await fetch(`${base}/accounts/${cfg.accountId}/calls`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify({ to, from, answerUrl, applicationId: cfg.applicationId }),
      });
      if (!res.ok)
        throw new Error(`Bandwidth createCall failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { callId: string };
      return { callId: json.callId };
    },
    async modifyCall(callId, opts) {
      const res = await fetch(`${base}/accounts/${cfg.accountId}/calls/${callId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify(opts),
      });
      if (!res.ok)
        throw new Error(`Bandwidth modifyCall failed: ${res.status} ${await res.text()}`);
    },
    async getCall(callId) {
      const res = await fetch(`${base}/accounts/${cfg.accountId}/calls/${callId}`, {
        headers: { Accept: "application/json", Authorization: auth },
      });
      if (!res.ok)
        throw new Error(`Bandwidth getCall failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as GetCallResult | GetCallResult[];
      // BW has returned both a bare object and a single-element array for this endpoint.
      return Array.isArray(json) ? json[0] : json;
    },
  };
}
