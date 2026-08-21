// test/server-readyz.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { buildApp, type ServerConfig, type ServerDeps } from "../src/server/app.js";
import { REQUIRED_ENV } from "../src/server/readiness.js";

const config: ServerConfig = {
  accountSid: "AC123",
  authToken: "tok",
  publicBaseUrl: "https://translator.test",
  voiceUrl: "https://customer.test/voice",
  webhookUser: "u",
  webhookPassword: "p",
};

const deps = (over: Partial<ServerDeps> = {}): ServerDeps => ({
  fetchImpl: fetch,
  // minimal bwClient stub; /readyz never calls it (no outbound work at all)
  bwClient: {} as ServerDeps["bwClient"],
  ...over,
});

// Hermetic env: stub every required var, restore after each test. Do NOT mutate
// process.env globally at module scope (leaks into other test files).
function stubReadyEnv() {
  for (const n of REQUIRED_ENV) vi.stubEnv(n, "test-value");
}
afterEach(() => vi.unstubAllEnvs());

describe("GET /readyz", () => {
  it("returns 200 and a config-only report when configured", async () => {
    stubReadyEnv();
    const app = buildApp(config, deps());
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ready).toBe(true);
    // No outbound token probe over HTTP — the endpoint is side-effect-free.
    expect(body.bwToken.probed).toBe(false);
  });

  it("returns 503 and lists missing env when unconfigured", async () => {
    // no stubbing: required vars are absent
    const app = buildApp(config, deps());
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json().missingEnv.length).toBeGreaterThan(0);
  });

  it("never probes the token, even with ?deep=1 (no anonymous OAuth trigger)", async () => {
    stubReadyEnv();
    const app = buildApp(config, deps());
    const res = await app.inject({ method: "GET", url: "/readyz?deep=1" });
    expect(res.statusCode).toBe(200);
    // ?deep=1 is inert: the live probe lives only in `npm run doctor`.
    expect(res.json().bwToken.probed).toBe(false);
  });
});
