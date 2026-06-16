import { Readable } from "node:stream";
import { TokenManager } from "./token.js";

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

export interface BwRecording {
  recordingId: string;
  callId: string;
  to: string;
  from: string;
  direction: string;
  channels: number;
  /** ISO-8601 duration, e.g. "PT13.67S". */
  duration: string;
  startTime?: string;
  endTime?: string;
  fileFormat?: string;
  /** BW recording status: processing | partial | complete | deleted | error. */
  status: string;
}

/** A recording's media as a stream plus its upstream content type. */
export interface BwMedia {
  body: Readable;
  contentType: string;
}

export interface BwClient {
  createCall(opts: CreateCallOpts): Promise<{ callId: string }>;
  modifyCall(callId: string, opts: ModifyCallOpts): Promise<void>;
  getCall(callId: string): Promise<GetCallResult>;
  listRecordings(callId: string): Promise<BwRecording[]>;
  getRecording(callId: string, recordingId: string): Promise<BwRecording>;
  getRecordingMedia(callId: string, recordingId: string): Promise<BwMedia>;
  /** Pause ("paused") or resume ("recording") the active recording on a call. */
  updateRecording(callId: string, state: "paused" | "recording"): Promise<void>;
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
  const authHeader = async () => `Bearer ${await tokens.getToken()}`;
  return {
    async createCall({ to, from, answerUrl }) {
      const res = await fetchImpl(`${base}/accounts/${cfg.accountId}/calls`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: await authHeader() },
        body: JSON.stringify({ to, from, answerUrl, applicationId: cfg.applicationId }),
      });
      if (!res.ok)
        throw new Error(`Bandwidth createCall failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { callId: string };
      return { callId: json.callId };
    },
    async modifyCall(callId, opts) {
      const res = await fetchImpl(`${base}/accounts/${cfg.accountId}/calls/${callId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: await authHeader() },
        body: JSON.stringify(opts),
      });
      if (!res.ok)
        throw new Error(`Bandwidth modifyCall failed: ${res.status} ${await res.text()}`);
    },
    async getCall(callId) {
      const res = await fetchImpl(`${base}/accounts/${cfg.accountId}/calls/${callId}`, {
        headers: { Accept: "application/json", Authorization: await authHeader() },
      });
      if (!res.ok)
        throw new Error(`Bandwidth getCall failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as GetCallResult | GetCallResult[];
      // BW has returned both a bare object and a single-element array for this endpoint.
      return Array.isArray(json) ? json[0] : json;
    },
    async listRecordings(callId) {
      const res = await fetchImpl(`${base}/accounts/${cfg.accountId}/calls/${callId}/recordings`, {
        headers: { Accept: "application/json", Authorization: await authHeader() },
      });
      if (!res.ok)
        throw new Error(`Bandwidth listRecordings failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as BwRecording[] | null;
      return json ?? [];
    },
    async getRecording(callId, recordingId) {
      const res = await fetchImpl(
        `${base}/accounts/${cfg.accountId}/calls/${callId}/recordings/${recordingId}`,
        { headers: { Accept: "application/json", Authorization: await authHeader() } },
      );
      if (!res.ok)
        throw new Error(`Bandwidth getRecording failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as BwRecording | BwRecording[];
      return Array.isArray(json) ? json[0] : json;
    },
    async getRecordingMedia(callId, recordingId) {
      const res = await fetchImpl(
        `${base}/accounts/${cfg.accountId}/calls/${callId}/recordings/${recordingId}/media`,
        { headers: { Authorization: await authHeader() } },
      );
      if (!res.ok || !res.body)
        throw new Error(`Bandwidth getRecordingMedia failed: ${res.status} ${await res.text()}`);
      // Pipe the upstream body straight through — no full-file buffering.
      return {
        body: Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
        contentType: res.headers.get("content-type") ?? "application/octet-stream",
      };
    },
    async updateRecording(callId, state) {
      const res = await fetchImpl(`${base}/accounts/${cfg.accountId}/calls/${callId}/recording`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: await authHeader() },
        body: JSON.stringify({ state }),
      });
      if (!res.ok)
        throw new Error(`Bandwidth updateRecording failed: ${res.status} ${await res.text()}`);
    },
  };
}
