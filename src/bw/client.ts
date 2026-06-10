export interface CreateCallOpts {
  to: string;
  from: string;
  answerUrl: string;
}

export interface BwClient {
  createCall(opts: CreateCallOpts): Promise<{ callId: string }>;
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
  };
}
