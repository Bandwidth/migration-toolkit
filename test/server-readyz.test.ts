// test/server-readyz.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { buildApp, type AdapterConfig, type AdapterDeps } from "../src/server/app.js";
import { REQUIRED_ENV } from "../src/server/readiness.js";

const config: AdapterConfig = {
  accountSid: "AC123",
  authToken: "tok",
  publicBaseUrl: "https://adapter.test",
  voiceUrl: "https://customer.test/voice",
};

const deps = (over: Partial<AdapterDeps> = {}): AdapterDeps => ({
  fetchImpl: fetch,
  // minimal bwClient stub; /readyz never calls it
  bwClient: {} as AdapterDeps["bwClient"],
  ...over,
});

// Hermetic env: stub every required var, restore after each test. Do NOT mutate
// process.env globally at module scope (leaks into other test files).
function stubReadyEnv() {
  for (const n of REQUIRED_ENV) vi.stubEnv(n, "test-value");
}
afterEach(() => vi.unstubAllEnvs());

describe("GET /readyz", () => {
  it("returns 200 and a shallow report when configured", async () => {
    stubReadyEnv();
    const app = buildApp(config, deps());
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ready).toBe(true);
    expect(body.bwToken.probed).toBe(false);
  });

  it("returns 503 and lists missing env when unconfigured", async () => {
    // no stubbing: required vars are absent
    const app = buildApp(config, deps());
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json().missingEnv.length).toBeGreaterThan(0);
  });

  it("probes the token on ?deep=1 and returns 503 when it fails", async () => {
    stubReadyEnv();
    const app = buildApp(config, deps({ probeToken: async () => ({ ok: false, error: "bad creds" }) }));
    const res = await app.inject({ method: "GET", url: "/readyz?deep=1" });
    expect(res.statusCode).toBe(503);
    expect(res.json().bwToken).toEqual({ probed: true, ok: false, error: "bad creds" });
  });

  it("returns 503 on ?deep=1 when no probe is wired (does not silently pass)", async () => {
    stubReadyEnv();
    const app = buildApp(config, deps()); // no probeToken in deps
    const res = await app.inject({ method: "GET", url: "/readyz?deep=1" });
    expect(res.statusCode).toBe(503);
    expect(res.json().bwToken.ok).toBe(false);
  });
});
