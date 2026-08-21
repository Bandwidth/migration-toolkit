# Migration Toolkit

**Developer tools that cut the effort of migrating a voice app from Twilio to Bandwidth — in three steps.** Check what's compatible, prove it on a real call, and generate the BXML you'll ship. Steps 1 and 2 need no code changes at all; step 3 hands you usable BXML.

> **Status:** The everyday call-flow building blocks — inbound/outbound calls, call control, recordings, and the two key webhooks — are proven on real Twilio↔Bandwidth calls, with an automated test suite and clean typecheck. This toolkit does not order or manage Bandwidth numbers itself — pair it with the [`band` CLI](#pairs-with-the-band-cli) for account-side provisioning.

---

## What this is (plain English)

A phone call on Twilio or Bandwidth is driven by a little script the network reads out loud, step by step — *"say a greeting → wait for a key press → if they press 1, transfer to sales."*

- **Twilio** writes that script in its language, **TwiML**.
- **Bandwidth** uses **BXML** for the same ideas.

Same concepts, different words — like British vs. American English. Roughly 80% maps one-to-one. Moving a voice app from Twilio to Bandwidth normally means rewriting it against a different API; this toolkit turns most of that rewrite into a config change and a copy/paste, and tells you — deterministically, never by guessing — exactly where the real work is.

---

## The three steps

### 1. Compatibility Check

**What it does:** Scans a customer's existing codebase and checks how their TwiML and Twilio SDK usage maps to Bandwidth's BXML.

**Outcome:** Size the migration effort and identify blockers **without writing a line of code**. You get a migration-complexity score and a per-feature *works-as-is / heads-up / blocker* breakdown.

```bash
npm install
npm run compatibility-check -- examples/full-pv-app     # or a path to your own app
```

### 2. Real-Time Translator

**What it does:** Completes a *real* Bandwidth call on the customer's unchanged Twilio application, translating between TwiML and BXML live, step by step. Any feature that can't be translated is surfaced **audibly in the call and in the error logs** — it fails loudly, never silently.

**Outcome:** See how well the Twilio app actually works on Bandwidth today by placing a test call and getting deterministic results — no rewrite, one URL change. As it runs, the raw TwiML the call flow exercised is captured and turned into standalone TwiML, ready to feed step 3.

```bash
npm start          # translator listens on :3000 — point your app's one URL at it
```

The translation is a fixed rulebook driven by a single [compatibility matrix](src/matrix/twilio-voice.json), not an AI guessing — for live calls, "mostly right" isn't good enough.

### 3. BXML Generator

**What it does:** Copy/paste the raw TwiML from step 2 (or any TwiML you have) and it generates the BXML for your Bandwidth migration.

**Outcome:** Cut dev work in half with usable BXML that's ready to integrate with your application.

```bash
npm run bxml-generator -- <in-dir> <out-dir>     # writes out/bxml/*, out/MIGRATION.md, out/coverage.json
```

---

## Try the Compatibility Check in your browser — no command needed

The **Migration Compatibility Check** is a single, self-contained HTML file a sales engineer can double-click and present to a prospect. Paste a customer's TwiML (or pick a curated example) and it shows — live — a migration-complexity score, a *works-as-is / heads-up / blocker* verdict, the translated BXML, and a forwardable report.

```bash
npm install
npm run playground:build      # writes dist/playground.html
open dist/playground.html     # (macOS) or just double-click it
```

No server, no network, works offline. It runs the **real** translation engine in the browser, so the verdict matches what the Real-Time Translator does in production. See [`web/README.md`](web/README.md).

Don't want to build it? Every push to `main` republishes the file to a rolling release:
[`playground.html`](https://github.com/Bandwidth/migration-toolkit/releases/download/playground-latest/playground.html)

> **This release asset is public-facing.** That `playground-latest` download link is used as a marketing asset on Bandwidth's website, so treat the tag and the `playground.html` filename as a stable contract — renaming or deleting either one breaks a live link. And remember that anything merged to `main` is what a prospect downloads next.

---

## Quickstart

**Run the translation loop locally (no credentials):** see [`docs/demo.md`](docs/demo.md) §1–§2 — the customer's sample app + the Real-Time Translator + simulated Bandwidth webhooks, all on localhost. §4 covers the recording/status callbacks.

**Run the Real-Time Translator** (Node 20+):
```bash
npm start          # translator on :3000
npm test           # run the test suite
npm run typecheck
npm run doctor     # readiness check — see AGENTS.md Phase 5
```

| Env var | Meaning |
|---|---|
| `TRANSLATOR_ACCOUNT_SID` / `TRANSLATOR_AUTH_TOKEN` | What the customer's Twilio SDK + webhook-signature validation use |
| `WEBHOOK_USER` / `WEBHOOK_PASSWORD` | Basic-auth creds Bandwidth presents on inbound `/bw/*` webhooks; set the same as your Voice app's `CallbackCreds` |
| `HOST` | Listen interface (default `127.0.0.1`); set `0.0.0.0` for containers/exposed deployments |
| `EGRESS_ALLOW_PRIVATE` | Set `1` to allow outbound fetches to private/loopback ranges (local dev only) |
| `EGRESS_ALLOW_HOSTS` | Optional comma-separated host allowlist; when set, outbound fetches are restricted to exactly these hosts (default-deny) |
| `PUBLIC_BASE_URL` | Public HTTPS base of the translator |
| `CUSTOMER_VOICE_URL` | The customer's Twilio voice webhook (inbound calls) |
| `BW_ACCOUNT_ID` / `BW_CLIENT_ID` / `BW_CLIENT_SECRET` / `BW_APPLICATION_ID` | Bandwidth credentials (OAuth2 client-credentials), provisioned via `band` — see [`AGENTS.md`](AGENTS.md) |
| `BW_ENVIRONMENT` | Optional — `test` targets BW's test hosts; defaults to `prod` |
| `TRANSLATOR_CAPTURE_DIR` | Optional — dir to persist each customer TwiML response (verbatim, content-addressed) so the BXML Generator can turn the paths a test call exercised into standalone BXML. Essential for SDK-built apps with no static TwiML to transpile. Off by default |
| `TRANSLATOR_LOG=1` | Optional — enable request logging |

Run `npm run doctor` (or `GET /readyz?deep=1` once the server is up) to confirm
this env is set and the Bandwidth OAuth2 token exchange works before routing
real calls.

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

Number provisioning (search/order/activate) isn't part of this toolkit — it's
handled by the [`band` CLI](#pairs-with-the-band-cli); see the Phase 2 runbook
in [`AGENTS.md`](AGENTS.md).

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

Unknown calls/recordings return Twilio's `20404`; bad credentials return `20003`. Call/recording state is in-memory (single-instance): a recording must be listed before it can be fetched by SID on a fresh instance. Toolkit-specific operational failures (missing params, internal errors) use a separate private code range — see [`AGENTS.md#errors`](AGENTS.md#errors).

This facade does **not** include number search/order/release — those routes
were removed in favor of the `band` CLI (see [`AGENTS.md`](AGENTS.md) Phase 2).

### Callbacks to your app (egress)

The Real-Time Translator also calls *you* back in Twilio's shape, mapped from Bandwidth's events and signed with `X-Twilio-Signature`:

- **Status callback** — when a call ends, the `StatusCallback` set on `calls.create()` gets a Twilio-shaped `completed` callback (`CallSid`, `CallStatus`, `CallDuration`), mapped from Bandwidth's disconnect event.
- **Recording callback** — a `<Record recordingStatusCallback="…">` maps to Bandwidth's `recordingAvailableUrl`; when the recording is ready the translator forwards a Twilio `recordingStatusCallback`, with `RecordingUrl` pointing back at this facade so a later fetch resolves through it.

---

## What it can't do yet

- **Call queues** ("you're caller number 3, please hold") — Bandwidth has no queue primitive to translate to. The most significant current limitation.
- **Conference hold music** — no Bandwidth equivalent.
- **Speech recognition** — translated correctly, but must be enabled on the Bandwidth account.
- **Stopping a recording via REST** — Bandwidth pauses/resumes over REST but has no REST *stop* (`StopRecording` is a BXML verb), so `Status=stopped` fails loudly rather than silently.
- **Number provisioning** — this toolkit doesn't order, activate, or otherwise manage Bandwidth numbers; use the `band` CLI (see [`AGENTS.md`](AGENTS.md) Phase 2).

See [`AGENTS.md`](AGENTS.md) for the full unsupported/lossy verb breakdown and
the private error codes the translator raises.

---

## Pairs with the `band` CLI

The Real-Time Translator only handles the **call flow** — it does not touch a
customer's Bandwidth account. Account-side actions (buying a number, creating a
Voice Application, activating voice on a number) are a separate concern, handled
by the [`band` CLI](https://dev.bandwidth.com/tools/cli/). The two pair
naturally: an agent runs `band` to provision the account, then configures and
runs the translator to carry the calls. If you're an agent driving an
end-to-end cutover, start with **[`AGENTS.md`](AGENTS.md)** — it's the phased
runbook with the exact `band` commands, the env vars the translator reads, and
every step that still needs a human.

---

## How it's built

All translation is driven by one declarative compatibility matrix (`src/matrix/twilio-voice.json`) — the Real-Time Translator, the Compatibility Check report, and the Migration Compatibility Check webpage all read the same data, so they can't disagree.

```
src/translator          TwiML → BXML translation
src/twilio              Twilio-shaped REST facade + signed webhooks (egress)
src/streams             Media Streams bridge
src/server              the proxy (Fastify) wiring it together, readiness check (/readyz, npm run doctor)
src/compatibility-check static migration-complexity report (npm run compatibility-check)
src/bxml-generator      batch BXML generation + coverage report (npm run bxml-generator; see AGENTS.md Phase 1)
web                     Migration Compatibility Check webpage (double-click HTML demo)
scripts                 build-playground.ts + benches
```

Tests live in `test/` (Vitest); CI gates `npm run typecheck` + `npm test`.

For driving an end-to-end cutover (including the account-side `band` steps and
every point a human still needs to be in the loop), see [`AGENTS.md`](AGENTS.md).
