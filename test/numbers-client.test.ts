import { describe, it, expect, vi } from "vitest";
import { createNumbersClient } from "../src/numbers/client.js";

describe("createNumbersClient OAuth2 wiring", () => {
  it("exchanges client credentials for a Bearer token and uses it on API calls", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/api/v1/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "tok-123", expires_in: 3600 }), {
          status: 200,
        });
      }
      // Real live shape (verified 2026-06-19): E.164 strings under phoneNumbers.
      return new Response(JSON.stringify({ phoneNumbers: ["+19195551234"], resultCount: 1 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const client = createNumbersClient({
      accountId: "acct-1",
      clientId: "cid",
      clientSecret: "secret",
      apiHost: "https://api.bandwidth.com",
      baseUrl: "https://api.bandwidth.com/api/v2",
      fetchImpl,
    });

    const result = await client.searchAvailable({ areaCode: "919" });
    expect(result.numbers[0].fullNumber).toBe("+19195551234");

    // Token endpoint hit with Basic client creds + client_credentials grant.
    const tokenCall = calls.find((c) => c.url.endsWith("/api/v1/oauth2/token"));
    expect(tokenCall).toBeTruthy();
    const tokenHeaders = tokenCall!.init!.headers as Record<string, string>;
    expect(tokenHeaders.Authorization).toMatch(/^Basic /);
    expect(tokenCall!.init!.body).toContain("grant_type=client_credentials");

    // The API call carries the Bearer token and the translated query.
    const apiCall = calls.find((c) => c.url.includes("/availableNumbers"));
    expect(apiCall!.url).toContain("/api/v2/accounts/acct-1/availableNumbers");
    expect((apiCall!.init!.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
    expect(apiCall!.url).toContain("areaCode=919");
  });

  it("caches the token across calls instead of re-fetching it", async () => {
    let tokenHits = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/api/v1/oauth2/token")) {
        tokenHits++;
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ orderStatus: "COMPLETE" }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = createNumbersClient({
      accountId: "a",
      clientId: "c",
      clientSecret: "s",
      fetchImpl,
    });
    await client.getOrder("o1");
    await client.getOrder("o2");
    expect(tokenHits).toBe(1);
  });
});
