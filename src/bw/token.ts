export interface TokenManagerOpts {
  clientId: string;
  clientSecret: string;
  /** API host that serves the token endpoint, e.g. https://api.bandwidth.com. */
  apiHost: string;
  fetchImpl?: typeof fetch;
  /** Injectable clock (ms since epoch); defaults to Date.now for production. */
  now?: () => number;
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
  token_type?: string;
}

/**
 * Fetches and caches OAuth2 client-credentials Bearer tokens for the Bandwidth
 * API. Mirrors the Bandwidth CLI's flow: POST grant_type=client_credentials to
 * {apiHost}/api/v1/oauth2/token with the client id/secret as HTTP Basic auth.
 */
export class TokenManager {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private token = "";
  private expiresAtMs = 0;

  constructor(private readonly opts: TokenManagerOpts) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** Returns a valid Bearer token, refreshing when within 1 minute of expiry. */
  async getToken(): Promise<string> {
    if (this.token && this.now() + 60_000 < this.expiresAtMs) return this.token;
    return this.fetchToken();
  }

  private async fetchToken(): Promise<string> {
    const basic = "Basic " + Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString("base64");
    const res = await this.fetchImpl(`${this.opts.apiHost}/api/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: basic, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok)
      throw new Error(`Bandwidth token exchange failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as TokenResponse;
    if (!json.access_token) throw new Error("Bandwidth token response missing access_token");
    this.token = json.access_token;
    const lifetimeMs = (json.expires_in && json.expires_in > 0 ? json.expires_in : 3600) * 1000;
    this.expiresAtMs = this.now() + lifetimeMs;
    return this.token;
  }
}
