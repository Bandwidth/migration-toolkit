# bw-voice-adapter

**Run an existing Twilio voice app on Bandwidth's network — without rewriting it.** Point your app at the adapter, change one URL, and its calls now run on Bandwidth. The code never changes.

> **Status:** Inbound/outbound calls, call control, recordings, and the two key webhooks are working and proven on real calls, with an automated test suite and clean typecheck. This adapter does not order or manage Bandwidth numbers itself — pair it with the [`band` CLI](#pairs-with-the-band-cli) for account-side provisioning.

---

## What this is (plain English)

A phone call on Twilio or Bandwidth is driven by a little script the network reads out loud, step by step — *"say a greeting → wait for a key press → if they press 1, transfer to sales."*

- **Twilio** writes that script in its language, **TwiML**.
- **Bandwidth** uses **BXML** for the same ideas.

Same concepts, different words — like British vs. American English. This adapter is a **live translator** in the middle: a call comes in, Bandwidth asks the adapter "what do I do?", the adapter asks the customer's *unchanged* Twilio app the same question, gets TwiML back, translates it to BXML on the spot, and hands it over. The customer points one URL at the adapter; nothing else changes.

> Moving a voice app from Twilio to Bandwidth normally means rewriting it against a different API. This turns that rewrite into a one-line config change — the app keeps running while its calls (and economics) move to Bandwidth.

The translation is a fixed rulebook driven by a single [compatibility matrix](src/matrix/twilio-voice.json), not an AI guessing — for live calls, "mostly right" isn't good enough. When a customer uses something the adapter *can't* do yet, it **says so and stops**, rather than breaking the call silently.

### Pairs with the `band` CLI

This adapter only translates the **call flow** — it does not touch a customer's
Bandwidth account. Account-side actions (buying a number, creating a Voice
Application, activating voice on a number) are a separate concern, handled by
the [`band` CLI](https://dev.bandwidth.com/tools/cli/). The two pair naturally: an
agent runs `band` to provision the account, then configures and runs this
adapter to carry the calls. If you're an agent driving an end-to-end cutover,
start with **[`AGENTS.md`](AGENTS.md)** — it's the phased runbook with the
exact `band` commands, the env vars this adapter reads, and every step that
still needs a human.

---

## Capabilities

**Verified:** `Live` = proven against real Twilio↔Bandwidth calls · `Unit` = automated tests · `—` = not yet / not supported.

### TwiML verbs
| Verb | Status | Verified |
|---|:--:|:--:|
| Say, Play, Pause, Hangup, Redirect | ✅ | Live |
| Gather (DTMF + speech) | ✅ | Live |
| Record (+ `recordingStatusCallback`) | ✅ | Live |
| Dial → Number / SIP | ✅ | Live |
| Dial → Conference (mute + events; no hold music / lifecycle) | ⚠️ | Live |
| Connect/Start/Stop Stream, Start/Stop Transcription | ✅ | Unit |
| Reject, Refer (SIP) | ⚠️ | Unit |
| Queue, Client, Enqueue, Leave, Pay | ❌ | — (no BW primitive — fail loudly) |

### REST facade & callbacks
| Capability | Status | Verified |
|---|:--:|:--:|
| Originate / hang up / redirect / fetch call | ✅ | Live |
| List / fetch / download recordings; pause-resume | ✅ | Live/Unit |
| Status callback (call completion) | ✅ | Unit |
| Recording callback (`recordingStatusCallback`) | ✅ | Unit |
| Media Streams bridge (AI-voice path) | ✅ | Unit |

Number provisioning (search/order/activate) isn't part of this adapter — it's
handled by the [`band` CLI](#pairs-with-the-band-cli); see the Phase 2 runbook
in [`AGENTS.md`](AGENTS.md).

---

## Quickstart

**Migration Preflight playground (for demos — a double-click HTML file):**
```bash
npm install
npm run playground:build      # writes dist/playground.html
open dist/playground.html     # (macOS) or just double-click it
```
A single self-contained page — no server, no network, works offline. Paste a customer's TwiML (or pick a curated example) and see the live *works-as-is / heads-up / blocker* verdict, a migration-complexity score, the translated BXML, and a forwardable report. It runs the **real** translation engine in the browser, so the verdict matches what the adapter does in production. Built for sales engineers to drive live on a screen-share; see [`web/README.md`](web/README.md).

**See a migration report (30s, no accounts):**
```bash
npm install
npm run preflight -- examples/full-pv-app
```
Prints a migration-complexity score and a per-feature *works-as-is / heads-up / blocker* breakdown.

**Run the translation loop locally (no credentials):** see [`docs/demo.md`](docs/demo.md) §1–§2 — the customer's sample app + the adapter + simulated Bandwidth webhooks, all on localhost. §4 covers the recording/status callbacks.

**Run the adapter** (Node 20+):
```bash
npm start          # adapter on :3000
npm test           # run the test suite
npm run typecheck
npm run doctor     # readiness check — see AGENTS.md Phase 5
```

| Env var | Meaning |
|---|---|
| `ADAPTER_ACCOUNT_SID` / `ADAPTER_AUTH_TOKEN` | What the customer's Twilio SDK + webhook-signature validation use |
| `WEBHOOK_USER` / `WEBHOOK_PASSWORD` | Basic-auth creds Bandwidth presents on inbound `/bw/*` webhooks; set the same as your Voice app's `CallbackCreds` |
| `HOST` | Listen interface (default `127.0.0.1`); set `0.0.0.0` for containers/exposed deployments |
| `EGRESS_ALLOW_PRIVATE` | Set `1` to allow outbound fetches to private/loopback ranges (local dev only) |
| `EGRESS_ALLOW_HOSTS` | Optional comma-separated host allowlist; when set, outbound fetches are restricted to exactly these hosts (default-deny) |
| `PUBLIC_BASE_URL` | Public HTTPS base of this adapter |
| `CUSTOMER_VOICE_URL` | The customer's Twilio voice webhook (inbound calls) |
| `BW_ACCOUNT_ID` / `BW_CLIENT_ID` / `BW_CLIENT_SECRET` / `BW_APPLICATION_ID` | Bandwidth credentials (OAuth2 client-credentials), provisioned via `band` — see [`AGENTS.md`](AGENTS.md) |
| `BW_ENVIRONMENT` | Optional — `test` targets BW's test hosts; defaults to `prod` |
| `ADAPTER_LOG=1` | Optional — enable request logging |

Run `npm run doctor` (or `GET /readyz?deep=1` once the server is up) to confirm
this env is set and the Bandwidth OAuth2 token exchange works before routing
real calls.

---

## REST facade

Backend calls the Twilio SDK makes are served in Twilio's shape (under `/2010-04-01/Accounts/{accountSid}`) and translated to Bandwidth over OAuth2 Bearer:

| Method & path | Twilio SDK call | Maps to |
|---|---|---|
| `POST /Calls.json` | `calls.create()` | originate a call |
| `POST /Calls/{sid}.json` | `calls(sid).update()` | hang up (`Status=completed`) / redirect (`Url`) |
| `GET /Calls/{sid}.json` | `calls(sid).fetch()` | call state → Twilio status + timing |
| `GET /Calls/{sid}/Recordings.json` | `calls(sid).recordings.list()` | list a call's recordings |
| `GET /Recordings/{sid}.json` | `recordings(sid).fetch()` | recording metadata |
| `GET /Recordings/{sid}.{mp3,wav}` | recording media URL | audio, stream-proxied from Bandwidth |
| `POST /Calls/{sid}/Recordings/{recSid}.json` | `recordings(sid).update({status})` | pause / resume (`stopped` fails loudly — no BW REST stop) |

Unknown calls/recordings return Twilio's `20404`; bad credentials return `20003`. Call/recording state is in-memory (single-instance): a recording must be listed before it can be fetched by SID on a fresh instance. Adapter-specific operational failures (missing params, internal errors) use a separate private code range — see [`AGENTS.md#errors`](AGENTS.md#errors).

This facade does **not** include number search/order/release — those routes
were removed in favor of the `band` CLI (see [`AGENTS.md`](AGENTS.md) Phase 2).

### Callbacks to your app (egress)

The adapter also calls *you* back in Twilio's shape, mapped from Bandwidth's events and signed with `X-Twilio-Signature`:

- **Status callback** — when a call ends, the `StatusCallback` set on `calls.create()` gets a Twilio-shaped `completed` callback (`CallSid`, `CallStatus`, `CallDuration`), mapped from Bandwidth's disconnect event.
- **Recording callback** — a `<Record recordingStatusCallback="…">` maps to Bandwidth's `recordingAvailableUrl`; when the recording is ready the adapter forwards a Twilio `recordingStatusCallback`, with `RecordingUrl` pointing back at this facade so a later fetch resolves through the adapter.

---

## What it can't do yet

- **Call queues** ("you're caller number 3, please hold") — Bandwidth has no queue primitive to translate to. The most significant current limitation.
- **Conference hold music** — no Bandwidth equivalent.
- **Speech recognition** — translated correctly, but must be enabled on the Bandwidth account.
- **Stopping a recording via REST** — Bandwidth pauses/resumes over REST but has no REST *stop* (`StopRecording` is a BXML verb), so `Status=stopped` fails loudly rather than silently.
- **Number provisioning** — this adapter doesn't order, activate, or otherwise manage Bandwidth numbers; use the `band` CLI (see [`AGENTS.md`](AGENTS.md) Phase 2).

See [`AGENTS.md`](AGENTS.md) for the full unsupported/lossy verb breakdown and
the private error codes this adapter raises.

---

## How it's built

All translation is driven by one declarative compatibility matrix (`src/matrix/twilio-voice.json`) — the runtime adapter, the pre-flight report, and the Migration Preflight playground all read the same data, so they can't disagree.

```
src/translator   TwiML → BXML translation
src/twilio       Twilio-shaped REST facade + signed webhooks (egress)
src/streams      Media Streams bridge
src/server       the proxy (Fastify) wiring it together, readiness check (/readyz, npm run doctor)
src/preflight    static migration-complexity report
src/generate     batch BXML generation + coverage report (see AGENTS.md Phase 1)
web              Migration Preflight playground (double-click HTML demo)
scripts          build-playground.ts + benches
```

Tests live in `test/` (Vitest); CI gates `npm run typecheck` + `npm test`.

For driving an end-to-end cutover (including the account-side `band` steps and
every point a human still needs to be in the loop), see [`AGENTS.md`](AGENTS.md).
