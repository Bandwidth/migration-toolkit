# bw-voice-adapter

**Run an existing Twilio voice app on Bandwidth's network — without rewriting it.** Point your app at the adapter, change one URL, and its calls now run on Bandwidth. The code never changes.

> **Status:** Inbound/outbound calls, call control, recordings, and the two key webhooks are working and proven on real calls. Number **search** is live-verified; number **ordering/release** are experimental (see [Number lifecycle](#number-lifecycle)). 265 automated tests, typecheck clean.

---

## What this is (plain English)

A phone call on Twilio or Bandwidth is driven by a little script the network reads out loud, step by step — *"say a greeting → wait for a key press → if they press 1, transfer to sales."*

- **Twilio** writes that script in its language, **TwiML**.
- **Bandwidth** uses **BXML** for the same ideas.

Same concepts, different words — like British vs. American English. This adapter is a **live translator** in the middle: a call comes in, Bandwidth asks the adapter "what do I do?", the adapter asks the customer's *unchanged* Twilio app the same question, gets TwiML back, translates it to BXML on the spot, and hands it over. The customer points one URL at the adapter; nothing else changes.

> Moving a voice app from Twilio to Bandwidth normally means rewriting it against a different API. This turns that rewrite into a one-line config change — the app keeps running while its calls (and economics) move to Bandwidth.

The translation is a fixed rulebook driven by a single [compatibility matrix](src/matrix/twilio-voice.json), not an AI guessing — for live calls, "mostly right" isn't good enough. When a customer uses something the adapter *can't* do yet, it **says so and stops**, rather than breaking the call silently.

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

### Number lifecycle
| Operation | Status | Verified |
|---|:--:|:--:|
| OAuth2 auth · **Search** | ✅ | **Live** |
| Order · Release | ⚠️ | Experimental — not verified ([details](#number-lifecycle)) |
| Activate (route a bought number) · Update | ❌ | — not built |

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

**Run the translation loop locally (no credentials):** see [`docs/demo.md`](docs/demo.md) §1–§2 — the customer's sample app + the adapter + simulated Bandwidth webhooks, all on localhost. §4 covers the recording/status callbacks and number search.

**Run the adapter** (Node 20+):
```bash
npm start          # adapter on :3000
npm test           # 265 tests
npm run typecheck
```

| Env var | Meaning |
|---|---|
| `ADAPTER_ACCOUNT_SID` / `ADAPTER_AUTH_TOKEN` | What the customer's Twilio SDK + webhook-signature validation use |
| `WEBHOOK_USER` / `WEBHOOK_PASSWORD` | Basic-auth creds Bandwidth presents on inbound `/bw/*` webhooks; set the same as your Voice app's `CallbackCreds` |
| `HOST` | Listen interface (default `127.0.0.1`); set `0.0.0.0` for containers/exposed deployments |
| `EGRESS_ALLOW_PRIVATE` | Set `1` to allow outbound fetches to private/loopback ranges (local dev only) |
| `PUBLIC_BASE_URL` | Public HTTPS base of this adapter |
| `CUSTOMER_VOICE_URL` | The customer's Twilio voice webhook (inbound calls) |
| `BW_ACCOUNT_ID` / `BW_CLIENT_ID` / `BW_CLIENT_SECRET` / `BW_APPLICATION_ID` | Bandwidth credentials (OAuth2 client-credentials) — shared by Voice and the number facade |
| `BW_SITE_ID` / `BW_PEER_ID` | Optional — enable number ordering (search/release use the shared `BW_CLIENT_*` creds) |
| `BW_NUMBERS_BASE_URL` | Optional — override the Numbers API v2 base (tests/staging) |
| `BW_ENVIRONMENT` | Optional — `test` targets BW's test hosts; defaults to `prod` |
| `ADAPTER_LOG=1` | Optional — enable request logging |

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
| `GET /AvailablePhoneNumbers/{Country}/Local.json` | `availablePhoneNumbers(c).local.list()` | search inventory — **verified live** |
| `POST /IncomingPhoneNumbers.json` | `incomingPhoneNumbers.create()` | order — ⚠️ **experimental, not verified** |
| `DELETE /IncomingPhoneNumbers/{sid}.json` | `incomingPhoneNumbers(sid).remove()` | release — ⚠️ **experimental, not verified** |

Unknown calls/recordings return Twilio's `20404`; bad credentials return `20003`. Call/recording state is in-memory (single-instance): a recording must be listed before it can be fetched by SID on a fresh instance.

### Callbacks to your app (egress)

The adapter also calls *you* back in Twilio's shape, mapped from Bandwidth's events and signed with `X-Twilio-Signature`:

- **Status callback** — when a call ends, the `StatusCallback` set on `calls.create()` gets a Twilio-shaped `completed` callback (`CallSid`, `CallStatus`, `CallDuration`), mapped from Bandwidth's disconnect event.
- **Recording callback** — a `<Record recordingStatusCallback="…">` maps to Bandwidth's `recordingAvailableUrl`; when the recording is ready the adapter forwards a Twilio `recordingStatusCallback`, with `RecordingUrl` pointing back at this facade so a later fetch resolves through the adapter.

### Number lifecycle

Shares the platform OAuth2 client-credentials with the Voice API (one token; the account's roles decide what it can do). **Verified live (2026-06-19):**

- **Search** — ✅ verified. OAuth2 token exchange and `GET /accounts/{id}/availableNumbers` both confirmed against real Bandwidth, returning real inventory.
- **Order** (`POST /IncomingPhoneNumbers.json`) — ⚠️ experimental. The v2 JSON order endpoint rejects the current request body; the real order schema must be captured (e.g. from the `band` CLI) before this works. Needs `BW_SITE_ID`.
- **Release** (`DELETE`) — ⚠️ experimental. The real disconnect endpoint returns XML, not JSON; the client needs an XML path.

Reproduce the live check (read-only by default) with [`scripts/verify-numbers-live.ts`](scripts/verify-numbers-live.ts).

---

## What it can't do yet

- **Call queues** ("you're caller number 3, please hold") — Bandwidth has no queue primitive to translate to. The most significant current limitation.
- **Conference hold music** — no Bandwidth equivalent.
- **Speech recognition** — translated correctly, but must be enabled on the Bandwidth account.
- **Stopping a recording via REST** — Bandwidth pauses/resumes over REST but has no REST *stop* (`StopRecording` is a BXML verb), so `Status=stopped` fails loudly rather than silently.
- **Number ordering / release / activate** — see [Number lifecycle](#number-lifecycle).

---

## How it's built

All translation is driven by one declarative compatibility matrix (`src/matrix/twilio-voice.json`) — the runtime adapter, the pre-flight report, and the Migration Preflight playground all read the same data, so they can't disagree.

```
src/translator   TwiML → BXML translation
src/twilio       Twilio-shaped REST facade + signed webhooks (egress)
src/streams      Media Streams bridge
src/numbers      number-lifecycle facade (search/order/release)
src/server       the proxy (Fastify) wiring it together
src/preflight    static migration-complexity report
web              Migration Preflight playground (double-click HTML demo)
scripts          build-playground.ts + benches / live-verify helpers
```

Tests live in `test/` (Vitest); CI gates `npm run typecheck` + `npm test`.
