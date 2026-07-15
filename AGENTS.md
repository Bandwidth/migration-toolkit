# AGENTS.md — Driving a Twilio→Bandwidth cutover with this adapter

This adapter translates a **live call flow** (Twilio TwiML ⇄ Bandwidth BXML) so a
customer's existing Twilio voice app runs over Bandwidth with a single URL change.
It does **not** provision anything on a Bandwidth account.

## The paired model

Use two tools together:

- **This adapter** — translates the call flow and proxies live calls.
- **The `band` CLI** — executes account-side actions on the user's Bandwidth
  account (numbers, applications, service activation). `band` is agent-native:
  JSON output by default, `--plain` for stable parsing, `--wait` for async ops,
  `--if-not-exists` for idempotency.

An agent runs `band` to provision, then configures and runs this adapter.

## What an agent can and cannot do

**Can do unattended:** preflight analysis, provisioning on an *existing*
Bandwidth account via `band`, adapter configuration, and the readiness check.

**🧍 Human required** (flagged inline below): creating a brand-new Bandwidth
account, enabling the account "HTTP Voice" feature, providing a public HTTPS
host, and final by-ear call verification.

## Runbook

### Phase 1 — Preflight
```bash
npm install
npm run preflight -- <path-to-customer-twilio-app>   # complexity + per-file verdict
npm run generate  -- <in-dir> <out-dir>              # writes out/bxml/*, out/MIGRATION.md, out/coverage.json
```
Read `out/coverage.json` for the machine-readable verdict. If a source file uses
the Twilio SDK to build TwiML at runtime, it is a **dynamic source** — there is no
static markup to transpile. See "Capability boundaries".

### Phase 2 — Provision (via `band`)
```bash
band auth login                       # BW_CLIENT_ID / BW_CLIENT_SECRET; --plain for JSON. Needs a keychain backend on headless hosts.
band subaccount create --name "<name>" --if-not-exists
band location create --site <site-id> --name "<peer-name>" --if-not-exists
band number search --area-code <ac> --quantity 1
band number order <number> --subaccount <site-id> --wait
band app create --name "<app>" --type voice --callback-url "https://<PUBLIC_BASE_URL>/bw/initiate" --if-not-exists
band vcp create --name "<vcp>" --app-id <app-id> --if-not-exists
band vcp assign <vcp-id> <number>
band number activate <number> --voice-inbound --wait
```
🧍 **Human required:** if the account is brand-new, `band account register` needs
email/SMS OTP first. If `band app create` errors that the account lacks the "HTTP
Voice" feature, a human must request it from Bandwidth support — the CLI cannot
enable it.

### Phase 3 — Configure the adapter
Set these env vars (the server reads **these exact names** — note the checked-in
`.env` uses different, non-functional names):

| Var | Who sets it |
|---|---|
| `ADAPTER_ACCOUNT_SID`, `ADAPTER_AUTH_TOKEN` | agent (adapter's own Twilio-compat creds) |
| `CUSTOMER_VOICE_URL` | agent (the customer's unchanged Twilio app URL) |
| `PUBLIC_BASE_URL` | 🧍 **Human required** (public HTTPS host/tunnel) |
| `BW_ACCOUNT_ID`, `BW_CLIENT_ID`, `BW_CLIENT_SECRET`, `BW_APPLICATION_ID` | from Phase 2 |

### Phase 4 — Deploy
🧍 **Human required:** provide a public HTTPS host (or tunnel) for
`PUBLIC_BASE_URL`. The BW Voice Application's callback (set in Phase 2) must point
at `<PUBLIC_BASE_URL>/bw/initiate`.

### Phase 5 — Verify
```bash
npm run doctor        # JSON: which env is set, whether BW token exchange works. Exit 0 = ready.
curl -s localhost:3000/readyz?deep=1 | jq   # same check over HTTP
```
🧍 **Human required:** place a real call to the Bandwidth number and walk the IVR
by ear. There is no scripted end-to-end call check.

## Capability boundaries

Translation is a fixed rulebook (`src/matrix/twilio-voice.json`), not a guess.

- **Supported:** most core voice verbs — Say, Play, Gather, Pause, Hangup,
  Redirect, Record, Number, Sip (translate cleanly to BXML). A few of these
  still drop attributes safely rather than silently: `Say`/`Play`'s
  `loop="0"` (infinite) can't be expressed inline in BXML, so it emits once and
  warns; `Record`'s `transcribe` and `playBeep` attributes have no direct BXML
  equivalent.
- **Lossy / partial (feature loss — needs a human decision):**
  - `Reject` — maps to `Hangup`, but Bandwidth answers before hanging up, so the
    caller may be billed for a short call.
  - `Dial` — `Number`/`Sip` nouns map to `Transfer`, `Conference` noun maps to
    `Conference`; the `Queue` and `Client` nouns are unsupported, and deep Dial
    semantics (`answerOnBridge`, child-call status propagation) are not
    replicated.
  - `Start` — the `Transcription` noun maps to `StartTranscription`; the
    `Siprec` and `VirtualAgent` nouns are unsupported.
  - `Refer` — Bandwidth only honors `Refer` on inbound SIP URI calls, so a PSTN
    call leg cannot be REFER'd (a platform constraint, not a translation gap).
  - `Connect` — the `Stream` noun maps to `StartStream` via the Media Streams
    bridge; `ConversationRelay` and `VirtualAgent` are unsupported (separate
    IoV).
  - `Stream` — Twilio's WS message schema is emulated by the adapter's stream
    bridge; live Bandwidth-side binding requires fixture capture.
  - `Conference` — basic named conferences work, but `waitUrl` hold music has
    no Bandwidth equivalent, `beep` is only partially supported, and
    `startConferenceOnEnter`/`endConferenceOnExit`/`maxParticipants` have no
    verb-level equivalent — those are managed via the Bandwidth Conferences
    **REST API**, not the BXML verb.
- **Unsupported (no BXML equivalent — a business decision to drop/redesign):**
  `Enqueue`, `Leave`, `Queue`, `Client`, `Pay`. Bandwidth has no queue primitive
  (`Enqueue`/`Leave`/`Queue` fail loudly), no WebRTC client endpoint
  (`Client`), and PCI payment capture (`Pay`) is out of scope for the adapter.
- **Dynamic SDK-built TwiML:** if the customer app generates TwiML at runtime,
  capture live responses and re-run `generate`, or port the logic by hand.

## Errors

Operational failures return a Twilio-shaped JSON body: `{ code, message, more_info, status }`.
Adapter-specific codes use a private range and are documented here:

| code | status | meaning |
|---|---|---|
| 90001 | 400 | Missing required request parameter |
| 90002 | 500 | Internal adapter error (detail is in server logs, not the response) |
| 90003 | 4xx | Malformed request rejected before handling |

Twilio-API-compat errors (e.g. `401`/`404` on the `/2010-04-01/...` facade) keep
their Twilio codes and semantics.
