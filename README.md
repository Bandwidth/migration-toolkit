# bw-voice-adapter

**Run an existing Twilio phone-app on Bandwidth's network without rewriting it.** Change one setting, and a voice application built for Twilio keeps working — its calls now run on Bandwidth.

---

## What this is (plain English)

A phone call on Twilio or Bandwidth is driven by a little script the phone network reads out loud, step by step — *"say a greeting → wait for a key press → if they press 1, transfer to sales."*

- **Twilio** writes that script in its own language (called **TwiML**).
- **Bandwidth** uses a different language for the same ideas (called **BXML**).

They're the same concepts in different words — like British vs. American English. This adapter is a **live translator** that sits in the middle: when a call comes in, Bandwidth asks the adapter "what do I do?", the adapter asks the customer's *unchanged* Twilio app the same question, gets the Twilio-language answer back, translates it to Bandwidth-language on the spot, and hands it over. The customer's code never changes — they just point it at the adapter.

> **Why it matters:** moving a phone app from Twilio to Bandwidth normally means an expensive rewrite, which kills deals. This turns that rewrite into a one-line config change — so customers can move their traffic (and cost) to Bandwidth's network without touching their app.

The translation is a fixed rulebook, not an AI guessing — for live phone calls, "mostly right" isn't good enough.

---

## What works today

Validated with **194 automated tests**, checked against Bandwidth's own tooling, and proven on **real Twilio and real Bandwidth phone calls**:

- Speaking text (including SSML touches like emphasis and "read this as a phone number")
- Playing audio, collecting key presses **and spoken input**, sending touch-tones
- Recording calls and real-time transcription (start and stop)
- Transferring to phone numbers and SIP destinations
- Conferences (with mute and event callbacks)
- Real-time audio streaming to AI voice bots (start, stop, one-way fork, and two-way)
- An early scaffold for buying/searching phone numbers via API

When a customer uses something the adapter *can't* do yet, it **says so clearly and stops** rather than breaking the call silently — the behavior that earns trust during a migration.

## What it can't do yet

- **Call queues** ("you're caller number 3, please hold") — Bandwidth has no queue feature to translate to. This is the biggest gap and the top thing for Bandwidth to build.
- **Conference hold music** — no Bandwidth equivalent.
- **Speech recognition** — the adapter translates it correctly, but it needs to be enabled on the Bandwidth account (it was rejected on our test account).
- **Pausing/resuming a recording mid-call** — handled differently on Bandwidth (a later item).

The strategic write-ups (what to build next, and why queues are #1) live in the team knowledge base under *Voice API Adapter*.

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
| `BW_ACCOUNT_ID` / `BW_USERNAME` / `BW_PASSWORD` / `BW_APPLICATION_ID` | Bandwidth Voice API credentials |
| `ADAPTER_LOG=1` | Optional — enable request logging |

```bash
npm start          # starts the adapter on :3000
npm test           # 194 tests
npm run typecheck
```

Point your Bandwidth Voice application's callback at `$PUBLIC_BASE_URL/bw/initiate`, and point your Twilio app/SDK at the adapter. See [`docs/demo.md`](docs/demo.md) for the full runnable walkthrough (a no-credentials local loop, plus the live-call demo).

**How it's built:** all translation is driven by one declarative compatibility matrix (`src/matrix/twilio-voice.json`) — the runtime adapter and the pre-flight report read the same data, so they can't disagree. Layout: `src/translator` (TwiML→BXML), `src/twilio` (Twilio-shaped REST facade + signed webhooks), `src/streams` (Media Streams bridge), `src/numbers` (number-lifecycle scaffold), `src/server` (the proxy).
