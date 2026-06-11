import { buildApp } from "./app.js";
import { createBwClient } from "../bw/client.js";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

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
      username: env("BW_USERNAME"),
      password: env("BW_PASSWORD"),
      applicationId: env("BW_APPLICATION_ID"),
    }),
  },
);

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: "0.0.0.0" }).then(() => console.log(`adapter listening on :${port}`));
