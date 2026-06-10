# bw-voice-adapter

**Run an unmodified Twilio voice app on Bandwidth infrastructure.** The adapter
receives Bandwidth voice webhooks, calls your existing Twilio webhook with
Twilio-shaped, `X-Twilio-Signature`-signed form-encoded params, and translates
the TwiML reply to BXML on the way back. A Twilio-compatible REST endpoint
(`/2010-04-01/Accounts/{sid}/Calls.json`) handles outbound calls, and a
pre-flight CLI generates a migration compatibility report.

Everything is driven by one declarative compatibility matrix
(`src/matrix/twilio-voice.json`): the runtime adapter and the pre-flight report
consume the same data, so the report is truthful by construction — it describes
exactly what the adapter actually supports.

## Quick start

```bash
npm install
npm test                                          # 45 tests
npm run preflight -- examples/sample-twilio-app   # migration report demo
```

## Run the adapter

| Env var | Meaning |
|---|---|
| `ADAPTER_ACCOUNT_SID` / `ADAPTER_AUTH_TOKEN` | What the customer's Twilio SDK + webhook signature validation use |
| `PUBLIC_BASE_URL` | Public HTTPS base of this adapter (webhook continuations are rewritten through it) |
| `CUSTOMER_VOICE_URL` | The customer's Twilio voice webhook (for inbound calls) |
| `BW_ACCOUNT_ID` / `BW_USERNAME` / `BW_PASSWORD` / `BW_APPLICATION_ID` | Bandwidth Voice API credentials |

```bash
npm start
```

Point your **Bandwidth Voice application** webhook at `$PUBLIC_BASE_URL/bw/initiate`.
Point your **Twilio SDK** at the adapter instead of Twilio — the code stays the same.

## Loud-failure policy

Unsupported TwiML (`<Enqueue>`, `<Pay>`, conference `waitUrl`, speech
`<Gather>`, …) never degrades silently: at runtime the call speaks an explicit
error and hangs up; in the pre-flight report it shows as a 🛑 blocker card with
a docs link. The support surface lives in `src/matrix/twilio-voice.json`.

## P0 known gaps

- No Queue/Enqueue (Bandwidth platform gap — blocks contact-center flows)
- Conference `waitUrl` hold music unsupported; speech Gather unsupported
- Media Streams bridge speaks Twilio's wire schema (`connected`/`start`/`media`/
  `mark`), but the live Bandwidth StartStream binding awaits fixture capture
  against a real account (`BwStreamSource` interface in `src/streams/bridge.ts`)
- Call state is in-memory; status callbacks are logged, not yet delivered

See `docs/demo.md` for the end-to-end walkthrough and
`docs/superpowers/plans/` for the implementation plan.
