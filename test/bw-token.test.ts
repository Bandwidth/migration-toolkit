import { describe, it, expect, vi } from "vitest";
import { TokenManager } from "../src/bw/token.js";

function tokenResponse(access_token: string, expires_in: number) {
  return new Response(JSON.stringify({ access_token, expires_in, token_type: "Bearer" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("TokenManager (OAuth2 client-credentials)", () => {
  it("exchanges client credentials for a Bearer token at the BW token endpoint", async () => {
    const fetchImpl = vi.fn(async () => tokenResponse("tok-abc", 3600)) as unknown as typeof fetch;
    const tm = new TokenManager({
      clientId: "CLI-1",
      clientSecret: "secret",
      apiHost: "https://api.bandwidth.com",
      fetchImpl,
    });

    const token = await tm.getToken();

    expect(token).toBe("tok-abc");
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.bandwidth.com/api/v1/oauth2/token");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(
      "Basic " + Buffer.from("CLI-1:secret").toString("base64"),
    );
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(String(init.body)).toContain("grant_type=client_credentials");
  });

  it("caches the token and does not re-fetch while it is still valid", async () => {
    const fetchImpl = vi.fn(async () => tokenResponse("tok-abc", 3600)) as unknown as typeof fetch;
    const tm = new TokenManager({
      clientId: "CLI-1",
      clientSecret: "secret",
      apiHost: "https://api.bandwidth.com",
      fetchImpl,
    });

    await tm.getToken();
    await tm.getToken();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the cached token is within a minute of expiry", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse("tok-1", 30))
      .mockResolvedValueOnce(tokenResponse("tok-2", 3600)) as unknown as typeof fetch;
    let nowMs = 1_000_000;
    const tm = new TokenManager({
      clientId: "CLI-1",
      clientSecret: "secret",
      apiHost: "https://api.bandwidth.com",
      fetchImpl,
      now: () => nowMs,
    });

    expect(await tm.getToken()).toBe("tok-1");
    nowMs += 30_000; // token had 30s life; now expired
    expect(await tm.getToken()).toBe("tok-2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
