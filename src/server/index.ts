import { buildApp } from "./app.js";
import { createBwClient } from "../bw/client.js";
import { TokenManager } from "../bw/token.js";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

const bwEnv = process.env.BW_ENVIRONMENT === "test" ? "test" : "prod";

const app = buildApp(
  {
    accountSid: env("ADAPTER_ACCOUNT_SID"),
    authToken: env("ADAPTER_AUTH_TOKEN"),
    publicBaseUrl: env("PUBLIC_BASE_URL"),
    voiceUrl: env("CUSTOMER_VOICE_URL"),
  },
  {
    fetchImpl: fetch,
    bwClient: createBwClient({
      accountId: env("BW_ACCOUNT_ID"),
      clientId: env("BW_CLIENT_ID"),
      clientSecret: env("BW_CLIENT_SECRET"),
      applicationId: env("BW_APPLICATION_ID"),
      environment: bwEnv,
    }),
    probeToken: async () => {
      try {
        const tm = new TokenManager({
          clientId: env("BW_CLIENT_ID"),
          clientSecret: env("BW_CLIENT_SECRET"),
          apiHost: bwEnv === "test" ? "https://test.api.bandwidth.com" : "https://api.bandwidth.com",
          fetchImpl: fetch,
        });
        await tm.getToken();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  },
);

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: "0.0.0.0" }).then(() => console.log(`adapter listening on :${port}`));
