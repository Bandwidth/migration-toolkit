import { buildApp } from "./app.js";
import { createBwClient } from "../bw/client.js";
import { createNumbersClient } from "../numbers/client.js";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function optEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

// The number-lifecycle facade shares the platform OAuth2 client-credentials with
// the Voice API (one token, account roles decide what it can do). Search/release
// work whenever the credential carries the Numbers role; ordering additionally
// needs a site (BW_SITE_ID), enforced by the route.
const bwEnv = process.env.BW_ENVIRONMENT === "test" ? "test" : "prod";
const numbersApiHost = bwEnv === "test" ? "https://test.api.bandwidth.com" : "https://api.bandwidth.com";
const siteId = optEnv("BW_SITE_ID");
const numbersClient = createNumbersClient({
  accountId: env("BW_ACCOUNT_ID"),
  clientId: env("BW_CLIENT_ID"),
  clientSecret: env("BW_CLIENT_SECRET"),
  apiHost: numbersApiHost,
  baseUrl: optEnv("BW_NUMBERS_BASE_URL") ?? `${numbersApiHost}/api/v2`,
});

const app = buildApp(
  {
    accountSid: env("ADAPTER_ACCOUNT_SID"),
    authToken: env("ADAPTER_AUTH_TOKEN"),
    publicBaseUrl: env("PUBLIC_BASE_URL"),
    voiceUrl: env("CUSTOMER_VOICE_URL"),
    webhookUser: env("WEBHOOK_USER"),
    webhookPassword: env("WEBHOOK_PASSWORD"),
    allowPrivateEgress: process.env.EGRESS_ALLOW_PRIVATE === "1",
    ...(siteId ? { numbers: { siteId, peerId: optEnv("BW_PEER_ID") } } : {}),
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
    numbersClient,
  },
);

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
app.listen({ port, host }).then(() => console.log(`adapter listening on ${host}:${port}`));
