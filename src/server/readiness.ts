/** Env vars the translator server requires to start and serve calls. */
export const REQUIRED_ENV = [
  "TRANSLATOR_ACCOUNT_SID",
  "TRANSLATOR_AUTH_TOKEN",
  "PUBLIC_BASE_URL",
  "CUSTOMER_VOICE_URL",
  "BW_ACCOUNT_ID",
  "BW_CLIENT_ID",
  "BW_CLIENT_SECRET",
  "BW_APPLICATION_ID",
  "WEBHOOK_USER",
  "WEBHOOK_PASSWORD",
];

export interface ReadinessReport {
  ready: boolean;
  missingEnv: string[];
  env: { name: string; present: boolean }[];
  bwToken: { probed: boolean; ok: boolean; error?: string };
}

/**
 * Report whether the translator is configured to serve calls. Pure over its
 * inputs: pass `env` (usually process.env) and an optional `probeToken` that
 * attempts a live Bandwidth OAuth2 token exchange.
 */
export async function checkReadiness(opts: {
  env: Record<string, string | undefined>;
  probeToken?: () => Promise<{ ok: boolean; error?: string }>;
}): Promise<ReadinessReport> {
  const env = REQUIRED_ENV.map((name) => ({ name, present: Boolean(opts.env[name]) }));
  const missingEnv = env.filter((e) => !e.present).map((e) => e.name);

  let bwToken: ReadinessReport["bwToken"];
  if (opts.probeToken) {
    try {
      const res = await opts.probeToken();
      bwToken = { probed: true, ok: res.ok, ...(res.error ? { error: res.error } : {}) };
    } catch (e) {
      // A probe that throws is a failed readiness check, not a 500.
      bwToken = { probed: true, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  } else {
    bwToken = { probed: false, ok: true };
  }

  return { ready: missingEnv.length === 0 && bwToken.ok, missingEnv, env, bwToken };
}
