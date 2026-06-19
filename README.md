# bw-voice-adapter

**Run an existing Twilio phone-app on Bandwidth's network without rewriting it.** Change one setting, and a voice application built for Twilio keeps working — its calls now run on Bandwidth.

---

## What this is (plain English)

A phone call on Twilio or Bandwidth is driven by a little script the phone network reads out loud, step by step — *"say a greeting → wait for a key press → if they press 1, transfer to sales."*

- **Twilio** writes that script in its own language (called **TwiML**).
- **Bandwidth** uses a different language for the same ideas (called **BXML**).

They're the same concepts in different words — like British vs. American English. This adapter is a **live translator** that sits in the middle: when a call comes in, Bandwidth asks the adapter "what do I do?", the adapter asks the customer's *unchanged* Twilio app the same question, gets the Twilio-language answer back, translates it to Bandwidth-language on the spot, and hands it over. The customer's code never changes — they just point it at the adapter.

> **Why it matters:** moving a voice application from Twilio to Bandwidth normally means rewriting it against a different API. This adapter turns that rewrite into a one-line configuration change — the app keeps running unchanged while its calls flow over Bandwidth.

The translation is a fixed rulebook, not an AI guessing — for live phone calls, "mostly right" isn't good enough.

---

## What works today

Validated with **250 automated tests**, checked against Bandwidth's own tooling, and proven on **real Twilio and real Bandwidth phone calls**:

- Speaking text (including SSML touches like emphasis and "read this as a phone number")
- Playing audio, collecting key presses **and spoken input**, sending touch-tones
- Recording calls and real-time transcription (start and stop)
- Transferring to phone numbers and SIP destinations
- Conferences (with mute and event callbacks)
- Real-time audio streaming to AI voice bots (start, stop, one-way fork, and two-way)
- **Controlling calls from your backend** the way Twilio apps do — hang up or redirect a live call, look up its status, and list/download recordings — through a Twilio-shaped REST API
- **Calling your app back** the way Twilio does — a call-completion status callback when a call ends, and a recording-ready callback when a `<Record>`'s audio is available — delivered in Twilio's shape with a valid `X-Twilio-Signature`
- **Searching for phone numbers** through a Twilio-shaped REST API over Bandwidth OAuth2 — verified live against real Bandwidth inventory. Buying and releasing numbers are scaffolded behind the same facade but **experimental / not yet verified** (see below)

When a customer uses something the adapter *can't* do yet, it **says so clearly and stops** rather than breaking the call silently — the behavior that earns trust during a migration.

## What it can't do yet

- **Call queues** ("you're caller number 3, please hold") — Bandwidth has no queue primitive to translate to. This is the most significant current limitation.
- **Conference hold music** — no Bandwidth equivalent.
- **Speech recognition** — the adapter translates it correctly, but it must be enabled on the Bandwidth account.
- **Stopping a recording via REST** — Bandwidth pauses/resumes recordings over REST (supported), but has no REST *stop* (its `StopRecording` is a BXML verb), so `Status=stopped` fails loudly rather than silently.

---

## Try it in 30 seconds (no accounts needed)

See what a migration would look like for a Twilio app — this scans code and prints a plain-English report:

```bash
npm install
npm run preflight -- examples/full-pv-app
```

You'll get a migration-complexity score and a per-feature "works as-is / heads-up / blocker" breakdown.

---

## For developers

**Run the adapter** (Node 20+):

| Env var | Meaning |
|---|---|
| `ADAPTER_ACCOUNT_SID` / `ADAPTER_AUTH_TOKEN` | What the customer's Twilio SDK + webhook-signature validation use |
| `PUBLIC_BASE_URL` | Public HTTPS base of this adapter |
| `CUSTOMER_VOICE_URL` | The customer's Twilio voice webhook (inbound calls) |
| `BW_ACCOUNT_ID` / `BW_CLIENT_ID` / `BW_CLIENT_SECRET` / `BW_APPLICATION_ID` | Bandwidth credentials (OAuth2 client-credentials) — shared by the Voice API and the number-lifecycle facade |
| `BW_SITE_ID` / `BW_PEER_ID` | Optional — enable number **ordering** (search/release use the shared `BW_CLIENT_*` creds). `BW_PEER_ID` is optional |
| `BW_NUMBERS_BASE_URL` | Optional — override the Numbers API v2 base (tests/staging) |
| `BW_ENVIRONMENT` | Optional — `test` targets BW's test hosts; defaults to `prod` |
| `ADAPTER_LOG=1` | Optional — enable request logging |

```bash
npm start          # starts the adapter on :3000
npm test           # 250 tests
npm run typecheck
```

Point your Bandwidth Voice application's callback at `$PUBLIC_BASE_URL/bw/initiate`, and point your Twilio app/SDK at the adapter. See [`docs/demo.md`](docs/demo.md) for the full runnable walkthrough (a no-credentials local loop, plus the live-call demo).

**Twilio REST facade.** Backend calls the Twilio SDK makes are served in Twilio's shape (under `/2010-04-01/Accounts/{accountSid}`) and translated to the Bandwidth Voice API over OAuth2 Bearer:

| Method & path | Twilio SDK call | Maps to |
|---|---|---|
| `POST /Calls.json` | `calls.create()` | originate a call |
| `POST /Calls/{sid}.json` | `calls(sid).update()` | hang up (`Status=completed`) or redirect (`Url`) |
| `GET /Calls/{sid}.json` | `calls(sid).fetch()` | call state → Twilio status + timing |
| `GET /Calls/{sid}/Recordings.json` | `calls(sid).recordings.list()` | list a call's recordings |
| `GET /Recordings/{sid}.json` | `recordings(sid).fetch()` | recording metadata |
| `GET /Recordings/{sid}.{mp3,wav}` | recording media URL | audio, stream-proxied from Bandwidth |
| `POST /Calls/{sid}/Recordings/{recSid}.json` | `recordings(sid).update({status})` | pause (`paused`) / resume (`in-progress`); `stopped` fails loudly (no BW REST stop) |
| `GET /AvailablePhoneNumbers/{Country}/Local.json` | `availablePhoneNumbers(c).local.list()` | search Bandwidth inventory — **verified live** |
| `POST /IncomingPhoneNumbers.json` | `incomingPhoneNumbers.create()` | order a number — ⚠️ **experimental, not verified** |
| `DELETE /IncomingPhoneNumbers/{sid}.json` | `incomingPhoneNumbers(sid).remove()` | release a number — ⚠️ **experimental, not verified** |

Unknown calls/recordings return Twilio's `20404` body; bad credentials return its `20003`. Call/recording state is in-memory (single-instance); a recording must be listed before it can be fetched by SID on a fresh instance.

**Callbacks to your app (egress).** The adapter also calls *you* back in Twilio's shape, mapped from Bandwidth's events and signed with `X-Twilio-Signature`:

- **Status callback** — when a call ends, the `StatusCallback` URL set on `calls.create()` receives a Twilio-shaped `completed` callback (`CallSid`, `CallStatus`, `CallDuration`), mapped from Bandwidth's disconnect event.
- **Recording callback** — a `<Record recordingStatusCallback="…">` maps to Bandwidth's `recordingAvailableUrl`; when the recording is ready the adapter forwards a Twilio `recordingStatusCallback` (`RecordingSid`, `RecordingStatus`, `RecordingDuration`), with `RecordingUrl` pointing back at this facade so a later fetch resolves through the adapter.

The number-lifecycle facade shares the platform OAuth2 client-credentials with the Voice API (one token; the account's roles decide what it can do). **Status of each operation, from live testing (2026-06-19):**

- **Search** — ✅ verified live. OAuth2 token exchange and `GET /accounts/{id}/availableNumbers` both confirmed against real Bandwidth.
- **Order** (`POST /IncomingPhoneNumbers.json`) — ⚠️ experimental. The v2 JSON order endpoint rejects the current request body; the real order schema still needs to be captured (e.g. from the `band` CLI) before this works. Needs `BW_SITE_ID`.
- **Release** (`DELETE`) — ⚠️ experimental. The real disconnect endpoint returns XML, not JSON; the client needs an XML path. Number state is in-memory, so a number can only be released by SID on the instance that provisioned it.

**How it's built:** all translation is driven by one declarative compatibility matrix (`src/matrix/twilio-voice.json`) — the runtime adapter and the pre-flight report read the same data, so they can't disagree. Layout: `src/translator` (TwiML→BXML), `src/twilio` (Twilio-shaped REST facade + signed webhooks), `src/streams` (Media Streams bridge), `src/numbers` (number-lifecycle facade), `src/server` (the proxy).
