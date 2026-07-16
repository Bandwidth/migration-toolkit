import { buildApp } from "./app.js";
import { createBwClient } from "../bw/client.js";

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
    webhookUser: env("WEBHOOK_USER"),
    webhookPassword: env("WEBHOOK_PASSWORD"),
    allowPrivateEgress: process.env.EGRESS_ALLOW_PRIVATE === "1",
    egressAllowHosts: process.env.EGRESS_ALLOW_HOSTS?.split(",").map((s) => s.trim()).filter(Boolean),
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
  },
);

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
app.listen({ port, host }).then(() => console.log(`adapter listening on ${host}:${port}`));
