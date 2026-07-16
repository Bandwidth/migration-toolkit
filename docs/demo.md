# Demo walkthrough

## 1. Pre-flight report (no credentials needed)

```bash
npm run preflight -- examples/sample-twilio-app
```

Matrix-driven migration report for an unmodified Twilio app: complexity score,
verbs found, heads-up cards with Bandwidth docs links.

## 2. Webhook translation loop (no credentials needed)

Terminal A — the "customer's" untouched Twilio app:

```bash
cd examples/sample-twilio-app && npm install && npm start
```

Terminal B — the adapter:

```bash
ADAPTER_ACCOUNT_SID=AC123 ADAPTER_AUTH_TOKEN=demo \
PUBLIC_BASE_URL=http://localhost:3000 \
CUSTOMER_VOICE_URL=http://localhost:4000/voice \
BW_ACCOUNT_ID=x BW_CLIENT_ID=x BW_CLIENT_SECRET=x BW_APPLICATION_ID=x \
WEBHOOK_USER=demo WEBHOOK_PASSWORD=demo \
EGRESS_ALLOW_PRIVATE=1 \
npm start
```

> `WEBHOOK_USER`/`WEBHOOK_PASSWORD` gate the inbound `/bw/*` webhooks (the curls
> below pass them with `-u demo:demo`). `EGRESS_ALLOW_PRIVATE=1` is needed only
> because this demo's customer app runs on `localhost` — the egress guard blocks
> loopback/private targets by default.

Terminal C — simulate a Bandwidth `initiate` webhook (a real inbound call):

```bash
curl -s -u demo:demo -X POST http://localhost:3000/bw/initiate \
  -H 'Content-Type: application/json' \
  -d '{"eventType":"initiate","callId":"demo-1","from":"+15550001111","to":"+15552223333","direction":"inbound"}'
```

Expected: BXML with `<SpeakSentence>` + `<Gather gatherUrl="http://localhost:3000/bw/continue?...">`.

Simulate the caller pressing 1:

```bash
curl -s -u demo:demo -X POST 'http://localhost:3000/bw/continue?next=http%3A%2F%2Flocalhost%3A4000%2Fmenu' \
  -H 'Content-Type: application/json' \
  -d '{"eventType":"gather","callId":"demo-1","digits":"1"}'
```

Expected: BXML containing `<Transfer>` to the sales number.

## 3. Live call (requires BW account + numbers)

Provisioning checklist: BW test account with Voice API enabled, a sub-account/
site, 2–3 voice-enabled numbers, a Voice application pointed at the public
adapter URL (`/bw/initiate`), and a public HTTPS tunnel (ngrok) or small host.
(A SIP peer is only needed on the legacy platform; the default Universal
Platform path uses a VCP instead — see `AGENTS.md` Phase 2.) Call the BW number,
walk the IVR by ear. Then exercise outbound via the REST facade with the real
`twilio` SDK pointed at the adapter base URL.

P0 exit criteria for the live milestone:
1. Inbound IVR (Say/Gather/Transfer) works on a real phone call.
2. Round-trip audio latency through the Media Streams bridge measured vs
   native StartStream (the AI-voice segment is latency-sensitive — this number
   decides whether the compat mode is demo-grade or product-grade).

## 4. Callbacks

These layer on top of the loop above and can be shown with no credentials.
Number provisioning is not part of this adapter — it's handled by the `band`
CLI; see the Phase 2 runbook in [`AGENTS.md`](../AGENTS.md).

Add a stand-in for the customer's callback receiver:

```bash
# Terminal D — prints whatever the adapter posts back
node -e "require('http').createServer((q,s)=>{let b='';q.on('data',d=>b+=d);q.on('end',()=>{console.log('\n['+q.url+'] '+b);s.end('ok')})}).listen(4001,()=>console.log('catcher :4001'))"
```

### 4a. Recording callback

Seed a call record via `initiate` (Terminal A from §2 makes it return 200), then
fire Bandwidth's "recording available" event:

```bash
curl -s -u demo:demo -X POST http://localhost:3000/bw/initiate -H 'Content-Type: application/json' \
  -d '{"eventType":"initiate","callId":"demo-1","from":"+15550001111","to":"+15552223333","direction":"inbound"}' >/dev/null

curl -s -u demo:demo -X POST 'http://localhost:3000/bw/recording-status?cb=http%3A%2F%2Flocalhost%3A4001%2Frec-ready' \
  -H 'Content-Type: application/json' \
  -d '{"eventType":"recordingAvailable","callId":"demo-1","recordingId":"r-abc","duration":"PT12S","status":"complete"}'
```

Expected (Terminal D): a Twilio `recordingStatusCallback` payload —
`RecordingSid=RE…`, `RecordingStatus=completed`, `RecordingDuration=12`,
`CallSid=CA…`, and `RecordingUrl=http://localhost:3000/2010-04-01/Accounts/AC123/Recordings/RE…`
(pointing back at this facade), with an `X-Twilio-Signature` header.

### 4b. Status callback (live call)

The `StatusCallback` URL is captured on the outbound `calls.create` path, so this
is shown on a live call rather than locally. Point the `twilio` SDK at the adapter:

```js
client.calls.create({
  to: '+1…', from: '+1…', url: 'https://your-app/voice',
  statusCallback: 'https://your-catcher/status',   // ← the new bit
});
```

Hang up the call; when Bandwidth posts the disconnect to `/bw/disconnect`, the
adapter fires a signed Twilio `completed` callback (`CallStatus=completed`,
`CallDuration`, `CallSid`) to that URL. No-telephony proof:
`npx vitest run test/server-status-callback.test.ts`.

### 4c. Number provisioning — now via `band`

Number search/order/activate used to be served through this adapter's own
REST facade; that surface has been removed in favor of the `band` CLI, which
is the account-side tool of record. To demo provisioning, run the Phase 2
commands from [`AGENTS.md`](../AGENTS.md) (`band number search`, `band number
order --wait`, `band number activate --voice-inbound --wait`, etc.) against a
real Bandwidth account instead.
