import { describe, it, expect } from "vitest";
import { checkReadiness, REQUIRED_ENV } from "../src/server/readiness.js";

const fullEnv = Object.fromEntries(REQUIRED_ENV.map((n) => [n, "x"]));

describe("checkReadiness", () => {
  it("reports ready when all env present and no probe requested", async () => {
    const r = await checkReadiness({ env: fullEnv });
    expect(r.ready).toBe(true);
    expect(r.missingEnv).toEqual([]);
    expect(r.bwToken).toEqual({ probed: false, ok: true });
  });

  it("lists missing env and is not ready", async () => {
    const env = { ...fullEnv };
    delete env.BW_CLIENT_ID;
    const r = await checkReadiness({ env });
    expect(r.ready).toBe(false);
    expect(r.missingEnv).toContain("BW_CLIENT_ID");
    expect(r.env.find((e) => e.name === "BW_CLIENT_ID")?.present).toBe(false);
  });

  it("probes the token when a probe is supplied", async () => {
    const r = await checkReadiness({ env: fullEnv, probeToken: async () => ({ ok: false, error: "401" }) });
    expect(r.ready).toBe(false);
    expect(r.bwToken).toEqual({ probed: true, ok: false, error: "401" });
  });

  it("is ready when env complete and token probe succeeds", async () => {
    const r = await checkReadiness({ env: fullEnv, probeToken: async () => ({ ok: true }) });
    expect(r.ready).toBe(true);
    expect(r.bwToken).toEqual({ probed: true, ok: true });
  });

  it("treats a rejecting probe as a failed (not thrown) token check", async () => {
    const r = await checkReadiness({
      env: fullEnv,
      probeToken: async () => { throw new Error("network down"); },
    });
    expect(r.ready).toBe(false);
    expect(r.bwToken).toEqual({ probed: true, ok: false, error: "network down" });
  });
});
