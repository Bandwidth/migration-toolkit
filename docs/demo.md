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
