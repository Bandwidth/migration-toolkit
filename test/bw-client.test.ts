import { describe, it, expect, vi } from "vitest";
import { createBwClient } from "../src/bw/client.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// A fetch that returns a token from the OAuth endpoint and call data elsewhere.
function fetchWithToken(callResponse: unknown, status = 200) {
  return vi.fn(async (url: string) => {
    if (String(url).endsWith("/api/v1/oauth2/token"))
      return jsonResponse({ access_token: "tok-abc", expires_in: 3600 });
    return jsonResponse(callResponse, status);
  }) as unknown as typeof fetch;
}

const base = {
  accountId: "9900",
  clientId: "CLI-1",
  clientSecret: "sec",
  applicationId: "app-1",
  environment: "prod" as const,
};

describe("createBwClient (OAuth2 Bearer against the Voice API)", () => {
  it("createCall authenticates with a Bearer token against voice.bandwidth.com", async () => {
    const fetchImpl = fetchWithToken({ callId: "c-1" }, 201);
    const client = createBwClient({ ...base, fetchImpl });

    const { callId } = await client.createCall({
      to: "+15552223333",
      from: "+15550001111",
      answerUrl: "https://translator.test/bw/initiate",
    });

    expect(callId).toBe("c-1");
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const callReq = calls.find(([u]) => String(u).includes("/calls"))!;
    expect(callReq[0]).toBe("https://voice.bandwidth.com/api/v2/accounts/9900/calls");
    expect(callReq[1].headers.Authorization).toBe("Bearer tok-abc");
  });

  it("modifyCall sends the Bearer token to the per-call endpoint", async () => {
    const fetchImpl = fetchWithToken({}, 200);
    const client = createBwClient({ ...base, fetchImpl });

    await client.modifyCall("c-1", { state: "completed" });

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const modReq = calls.find(([u]) => String(u).endsWith("/calls/c-1"))!;
    expect(modReq[1].headers.Authorization).toBe("Bearer tok-abc");
    expect(modReq[1].method).toBe("POST");
  });

  it("targets BW test hosts when environment is 'test'", async () => {
    const fetchImpl = fetchWithToken({ callId: "c-2" }, 201);
    const client = createBwClient({ ...base, environment: "test", fetchImpl });

    await client.createCall({ to: "+1", from: "+2", answerUrl: "https://translator.test/x" });

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([u]) => String(u) === "https://test.api.bandwidth.com/api/v1/oauth2/token")).toBe(true);
    expect(calls.some(([u]) => String(u).startsWith("https://test.voice.bandwidth.com"))).toBe(true);
  });
});
