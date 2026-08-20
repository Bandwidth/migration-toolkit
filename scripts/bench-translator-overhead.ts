// Differential latency harness: the cost of putting the translator in the path,
// vs. talking to the customer app directly (the "raw BXML" baseline).
//
// Both measurements hit the SAME local stub customer app over real localhost
// HTTP, so the customer-app cost cancels out and what's left is the translator's
// own tax — its extra hop + the TwiML→BXML translation:
//
//   A  = POST straight to the stub, get a document back.        (native-equivalent baseline)
//   B  = POST to the translator's /bw/initiate, which internally   (translator in the path)
//        hits that same stub and translates the result.
//   B − A  = what inserting the translator costs per IVR turn.
//
// Loopback only — this measures the component we own (one extra hop + CPU),
// not internet RTT. A real-call number (geographic distance to BW's edge) needs
// the live setup in docs/demo.md §3 with TRANSLATOR_LOG=1 (`fetchMs`).
//
//   npm run bench:overhead            # default 1000 iterations per doc
//   npm run bench:overhead -- 5000    # custom iteration count
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/server/app.js";
import type { BwClient } from "../src/bw/client.js";

// Representative IVR turns the translator translates per call.
const CORPUS: Record<string, string> = {
  "say-simple": `<Response><Say voice="alice">Thanks for calling. Goodbye.</Say><Hangup/></Response>`,
  "gather-menu": `<Response><Gather numDigits="1" action="/menu" method="POST"><Say>For sales press 1. For support press 2.</Say></Gather><Redirect>/welcome</Redirect></Response>`,
  "dial-transfer": `<Response><Say>Connecting you now.</Say><Dial callerId="+15550000000" timeout="20"><Number>+15551112222</Number></Dial></Response>`,
  composite: `<Response><Say voice="alice">Welcome.</Say><Pause length="1"/><Play>https://cdn.example/intro.mp3</Play><Gather numDigits="1" action="/menu"><Say>Press 1 to transfer, 2 to leave a message.</Say></Gather><Dial><Number>+15551112222</Number></Dial><Record action="/vm" maxLength="30"/><Hangup/></Response>`,
};

const iterations = Number(process.argv[2]) || 1000;
const WARMUP = Math.min(200, Math.floor(iterations / 5));

const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const fmt = (n: number) => (n < 1 ? `${(n * 1000).toFixed(0)}µs` : `${n.toFixed(3)}ms`);
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

// ─── stub "customer" Twilio app: returns the corpus TwiML named in the path ──
const stub = createServer((req, res) => {
  req.resume(); // drain the request body
  req.on("end", () => {
    const doc = (req.url ?? "/").replace(/^\//, "").split("?")[0];
    const twiml = CORPUS[doc];
    if (!twiml) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "application/xml" }).end(twiml);
  });
});

// ─── the translator under test (its /bw/initiate path never touches bwClient) ───
const webhookUser = "bench-user";
const webhookPassword = "bench-pass";
const app = buildApp(
  {
    accountSid: "ACbench",
    authToken: "benchtoken",
    publicBaseUrl: "http://127.0.0.1",
    voiceUrl: "http://127.0.0.1/unused",
    webhookUser,
    webhookPassword,
  },
  { fetchImpl: fetch, bwClient: {} as unknown as BwClient },
);

await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
await app.listen({ port: 0, host: "127.0.0.1" });
const stubPort = (stub.address() as AddressInfo).port;
const translatorPort = (app.server.address() as AddressInfo).port;
const stubBase = `http://127.0.0.1:${stubPort}`;
const translatorBase = `http://127.0.0.1:${translatorPort}`;

const formBody = "CallSid=CAbench&CallStatus=ringing&From=%2B15550001111&To=%2B15552223333";

async function timeDirect(doc: string): Promise<number> {
  const t = performance.now();
  const r = await fetch(`${stubBase}/${doc}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody,
  });
  await r.text();
  return performance.now() - t;
}

async function timeTranslator(doc: string, i: number): Promise<number> {
  const voiceUrl = encodeURIComponent(`${stubBase}/${doc}`);
  const t = performance.now();
  const r = await fetch(`${translatorBase}/bw/initiate?voiceUrl=${voiceUrl}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Basic " + Buffer.from(`${webhookUser}:${webhookPassword}`).toString("base64"),
    },
    // Unique callId per iteration so the query voiceUrl wins over a stored record.
    body: JSON.stringify({
      eventType: "initiate",
      callId: `bench-${doc}-${i}`,
      from: "+15550001111",
      to: "+15552223333",
      direction: "inbound",
    }),
  });
  await r.text();
  return performance.now() - t;
}

console.log(
  `[bench-translator-overhead] ${iterations} iterations/doc (after ${WARMUP} warmup)\n` +
    `A = direct-to-customer (baseline)   B = through-translator   overhead = B − A\n`,
);

const pad = (s: string, n: number) => s.padEnd(n);
const padL = (s: string, n: number) => s.padStart(n);
console.log(
  `${pad("doc", 15)}${padL("A p50", 10)}${padL("A p99", 10)}${padL("B p50", 10)}${padL("B p99", 10)}${padL("ovh p50", 10)}${padL("ovh p99", 10)}`,
);
console.log("─".repeat(75));

const allOverhead: number[] = [];
for (const doc of Object.keys(CORPUS)) {
  for (let i = 0; i < WARMUP; i++) {
    await timeDirect(doc);
    await timeTranslator(doc, -i - 1);
  }

  const aTimes: number[] = [];
  const bTimes: number[] = [];
  const overhead: number[] = [];
  for (let i = 0; i < iterations; i++) {
    // Interleave A and B each iteration so machine jitter hits both equally.
    const a = await timeDirect(doc);
    const b = await timeTranslator(doc, i);
    aTimes.push(a);
    bTimes.push(b);
    overhead.push(b - a);
  }
  allOverhead.push(...overhead);

  const aS = [...aTimes].sort((x, y) => x - y);
  const bS = [...bTimes].sort((x, y) => x - y);
  const oS = [...overhead].sort((x, y) => x - y);
  console.log(
    `${pad(doc, 15)}${padL(fmt(pct(aS, 0.5)), 10)}${padL(fmt(pct(aS, 0.99)), 10)}${padL(fmt(pct(bS, 0.5)), 10)}${padL(fmt(pct(bS, 0.99)), 10)}${padL(fmt(pct(oS, 0.5)), 10)}${padL(fmt(pct(oS, 0.99)), 10)}`,
  );
}

const oS = [...allOverhead].sort((x, y) => x - y);
console.log("─".repeat(75));
console.log(
  `\nTranslator overhead (B − A) across all turns: ` +
    `mean ${fmt(mean(allOverhead))}, p50 ${fmt(pct(oS, 0.5))}, p99 ${fmt(pct(oS, 0.99))}`,
);
console.log(
  `That is one extra localhost hop + translation — the cost of inserting the\n` +
    `translator. In production the extra hop carries real network distance to BW's\n` +
    `voice edge; measure that on a live call (docs/demo.md §3, TRANSLATOR_LOG=1).`,
);

await app.close();
await new Promise<void>((resolve) => stub.close(() => resolve()));
