import { TokenManager } from "./token.js";

export interface CreateCallOpts {
  to: string;
  from: string;
  answerUrl: string;
}

export interface BwClient {
  createCall(opts: CreateCallOpts): Promise<{ callId: string }>;
}

const HOSTS = {
  prod: { api: "https://api.bandwidth.com", voice: "https://voice.bandwidth.com" },
  test: { api: "https://test.api.bandwidth.com", voice: "https://test.voice.bandwidth.com" },
} as const;

export function createBwClient(cfg: {
  accountId: string;
  clientId: string;
  clientSecret: string;
  applicationId: string;
  environment?: "prod" | "test";
  /** Overrides for tests/staging; default to the environment's standard hosts. */
  voiceBaseUrl?: string;
  apiHost?: string;
  fetchImpl?: typeof fetch;
}): BwClient {
  const hosts = HOSTS[cfg.environment ?? "prod"];
  const base = cfg.voiceBaseUrl ?? `${hosts.voice}/api/v2`;
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const tokens = new TokenManager({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    apiHost: cfg.apiHost ?? hosts.api,
    fetchImpl,
  });
  return {
    async createCall({ to, from, answerUrl }) {
      const res = await fetchImpl(`${base}/accounts/${cfg.accountId}/calls`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await tokens.getToken()}`,
        },
        body: JSON.stringify({ to, from, answerUrl, applicationId: cfg.applicationId }),
      });
      if (!res.ok)
        throw new Error(`Bandwidth createCall failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { callId: string };
      return { callId: json.callId };
    },
  };
}
