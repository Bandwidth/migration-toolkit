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
npm start
```

Terminal C — simulate a Bandwidth `initiate` webhook (a real inbound call):

```bash
curl -s -X POST http://localhost:3000/bw/initiate \
  -H 'Content-Type: application/json' \
  -d '{"eventType":"initiate","callId":"demo-1","from":"+15550001111","to":"+15552223333","direction":"inbound"}'
```

Expected: BXML with `<SpeakSentence>` + `<Gather gatherUrl="http://localhost:3000/bw/continue?...">`.

Simulate the caller pressing 1:

```bash
curl -s -X POST 'http://localhost:3000/bw/continue?next=http%3A%2F%2Flocalhost%3A4000%2Fmenu' \
  -H 'Content-Type: application/json' \
  -d '{"eventType":"gather","callId":"demo-1","digits":"1"}'
```

Expected: BXML containing `<Transfer>` to the sales number.

## 3. Live call (requires BW account + numbers)

Provisioning checklist: BW test account with Voice API enabled, a sub-account/
site + SIP peer, 2–3 voice-enabled numbers, a Voice application pointed at the
public adapter URL (`/bw/initiate`), and a public HTTPS tunnel (ngrok) or small
host. Call the BW number, walk the IVR by ear. Then exercise outbound via the
REST facade with the real `twilio` SDK pointed at the adapter base URL.

P0 exit criteria for the live milestone:
1. Inbound IVR (Say/Gather/Transfer) works on a real phone call.
2. Round-trip audio latency through the Media Streams bridge measured vs
   native StartStream (the AI-voice segment is latency-sensitive — this number
   decides whether the compat mode is demo-grade or product-grade).

## 4. Callbacks & number lifecycle

These layer on top of the loop above. The webhook callbacks can be shown with
no credentials; live number ordering is gated on the Numbers-role / OAuth2
credential (see `src/numbers/client.ts`).

Add a stand-in for the customer's callback receiver:

```bash
# Terminal D — prints whatever the adapter posts back
node -e "require('http').createServer((q,s)=>{let b='';q.on('data',d=>b+=d);q.on('end',()=>{console.log('\n['+q.url+'] '+b);s.end('ok')})}).listen(4001,()=>console.log('catcher :4001'))"
```

### 4a. Recording callback (no credentials needed)

Seed a call record via `initiate` (Terminal A from §2 makes it return 200), then
fire Bandwidth's "recording available" event:

```bash
curl -s -X POST http://localhost:3000/bw/initiate -H 'Content-Type: application/json' \
  -d '{"eventType":"initiate","callId":"demo-1","from":"+15550001111","to":"+15552223333","direction":"inbound"}' >/dev/null

curl -s -X POST 'http://localhost:3000/bw/recording-status?cb=http%3A%2F%2Flocalhost%3A4001%2Frec-ready' \
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

### 4c. Number search & order

Enable the facade by setting `BW_NUMBERS_USERNAME` / `BW_NUMBERS_PASSWORD` /
`BW_SITE_ID`. Search is a read and safe to run live; ordering is gated (see
above). The deterministic, no-auth demonstration of both is the test suite,
which runs the real translation + response-shaping against a mock Bandwidth:

```bash
npx vitest run test/server-numbers.test.ts
```

It exercises `AreaCode=919 → BW areaCode/quantity` translation, the Twilio
`available_phone_numbers` JSON, and the full purchase → order → `IncomingPhoneNumber`
resource (including order polling and the FAILED path).
