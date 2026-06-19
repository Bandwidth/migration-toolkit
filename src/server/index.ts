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

// The number-lifecycle facade is opt-in: only wired when Numbers credentials and
// a Bandwidth site are configured. Note (per src/numbers/client.ts): the v2 JSON
// order endpoints expect OAuth2 Bearer auth and a Numbers-role credential — the
// Basic-auth wiring here is a placeholder and live ordering is not yet verified.
const numbersUser = optEnv("BW_NUMBERS_USERNAME");
const numbersPass = optEnv("BW_NUMBERS_PASSWORD");
const siteId = optEnv("BW_SITE_ID");
const numbersClient =
  numbersUser && numbersPass
    ? createNumbersClient({
        accountId: env("BW_ACCOUNT_ID"),
        username: numbersUser,
        password: numbersPass,
        baseUrl: optEnv("BW_NUMBERS_BASE_URL"),
      })
    : undefined;

const app = buildApp(
  {
    accountSid: env("ADAPTER_ACCOUNT_SID"),
    authToken: env("ADAPTER_AUTH_TOKEN"),
    publicBaseUrl: env("PUBLIC_BASE_URL"),
    voiceUrl: env("CUSTOMER_VOICE_URL"),
    ...(siteId ? { numbers: { siteId, peerId: optEnv("BW_PEER_ID") } } : {}),
  },
  {
    fetchImpl: fetch,
    bwClient: createBwClient({
      accountId: env("BW_ACCOUNT_ID"),
      clientId: env("BW_CLIENT_ID"),
      clientSecret: env("BW_CLIENT_SECRET"),
      applicationId: env("BW_APPLICATION_ID"),
      environment: process.env.BW_ENVIRONMENT === "test" ? "test" : "prod",
    }),
    numbersClient,
  },
);

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: "0.0.0.0" }).then(() => console.log(`adapter listening on :${port}`));
