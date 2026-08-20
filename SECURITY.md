# Security

The translator authenticates in both directions and constrains where it will send outbound requests.

- **Outbound to Bandwidth** — OAuth2 client credentials (`BW_CLIENT_ID`/`BW_CLIENT_SECRET`).
- **Inbound webhooks (`/bw/*`)** — HTTP Basic auth. Set `WEBHOOK_USER`/`WEBHOOK_PASSWORD`, and configure the **same** credentials as `CallbackCreds` on your Bandwidth Voice-V2 application. The translator also stamps them onto the BXML callback verbs it emits, so Bandwidth presents them on continuation callbacks. Requests to `/bw/*` without valid credentials are rejected.
- **REST facade (`/2010-04-01/*`)** — HTTP Basic auth using `TRANSLATOR_ACCOUNT_SID`/`TRANSLATOR_AUTH_TOKEN` (the Twilio-compat credential). This is a distinct secret from the webhook credential above.
- **Outbound fetches** — the translator only fetches customer callback URLs over http/https and refuses loopback/link-local/private destinations. For local development against `localhost`, set `EGRESS_ALLOW_PRIVATE=1`.
  For fixed, known customer hosts you may set `EGRESS_ALLOW_HOSTS` (comma-separated) to switch outbound fetches to a strict default-deny allowlist — the tightest posture ("full remediation"). Listed hosts are trusted and bypass the range check, so this also lets you allow `localhost` explicitly in development.
  Note: the range check above resolves the hostname and validates the resulting IPs before the fetch, but it does not pin the connection to those IPs — the fetch itself re-resolves the hostname. That means it's defense-in-depth (the inbound Basic auth on `/bw/*` is the primary control) and does not defend against DNS rebinding, where a low-TTL hostname answers with a public IP at check time and an internal one at connect time. Deployments serving untrusted tenants should use `EGRESS_ALLOW_HOSTS` or pin the resolved IP at connect time.

## Deployment

- Serve over HTTPS. Basic-auth credentials are only as safe as the transport.
- The listen host defaults to `127.0.0.1`. To expose the translator (containers, production), set `HOST=0.0.0.0` deliberately.
- Do not expose the translator to the internet without the webhook credentials configured.

## Reporting

Report suspected vulnerabilities to security@bandwidth.com.
