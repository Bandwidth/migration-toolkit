# Security

The adapter authenticates in both directions and constrains where it will send outbound requests.

- **Outbound to Bandwidth** — OAuth2 client credentials (`BW_CLIENT_ID`/`BW_CLIENT_SECRET`).
- **Inbound webhooks (`/bw/*`)** — HTTP Basic auth. Set `WEBHOOK_USER`/`WEBHOOK_PASSWORD`, and configure the **same** credentials as `CallbackCreds` on your Bandwidth Voice-V2 application. The adapter also stamps them onto the BXML callback verbs it emits, so Bandwidth presents them on continuation callbacks. Requests to `/bw/*` without valid credentials are rejected.
- **REST facade (`/2010-04-01/*`)** — HTTP Basic auth using `ADAPTER_ACCOUNT_SID`/`ADAPTER_AUTH_TOKEN` (the Twilio-compat credential). This is a distinct secret from the webhook credential above.
- **Outbound fetches** — the adapter only fetches customer callback URLs over http/https and refuses loopback/link-local/private destinations. For local development against `localhost`, set `EGRESS_ALLOW_PRIVATE=1`.
  For fixed, known customer hosts you may set `EGRESS_ALLOW_HOSTS` (comma-separated) to switch outbound fetches to a strict default-deny allowlist — the tightest posture ("full remediation"). Listed hosts are trusted and bypass the range check, so this also lets you allow `localhost` explicitly in development.

## Deployment

- Serve over HTTPS. Basic-auth credentials are only as safe as the transport.
- The listen host defaults to `127.0.0.1`. To expose the adapter (containers, production), set `HOST=0.0.0.0` deliberately.
- Do not expose the adapter to the internet without the webhook credentials configured.

## Reporting

Report suspected vulnerabilities to security@bandwidth.com.
