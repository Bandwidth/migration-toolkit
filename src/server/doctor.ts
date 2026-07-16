import { checkReadiness } from "./readiness.js";
import { TokenManager } from "../bw/token.js";

/** Build a token-probe closure iff BW credentials are present in `env`. */
export function buildDoctorProbe(
  env: Record<string, string | undefined>,
): (() => Promise<{ ok: boolean; error?: string }>) | undefined {
  const clientId = env.BW_CLIENT_ID;
  const clientSecret = env.BW_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;
  const apiHost =
    env.BW_ENVIRONMENT === "test" ? "https://test.api.bandwidth.com" : "https://api.bandwidth.com";
  return async () => {
    try {
      const tm = new TokenManager({ clientId, clientSecret, apiHost, fetchImpl: fetch });
      await tm.getToken();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
}

async function main() {
  const report = await checkReadiness({ env: process.env, probeToken: buildDoctorProbe(process.env) });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ready ? 0 : 1);
}

// Run only when executed directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith("doctor.ts")) {
  void main();
}
