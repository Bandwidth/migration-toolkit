// Micro-benchmark for the TwiML→BXML translation tax — the latency the translator
// itself adds per IVR turn, with the customer-webhook network hop factored out.
//
// The live path (src/server/app.ts `fetchAndTranslate`) is `postToCustomer()`
// (network, not ours) followed by `translateTwiml()` + XML build (pure CPU,
// ours). This measures only the second part, over a corpus of representative
// TwiML documents, and reports p50/p99/max per doc and overall — the same
// shape as the Media Streams latency harness in test/streams-wire.test.ts.
//
//   npm run bench           # default 5000 iterations per doc
//   npm run bench -- 20000  # custom iteration count
import { translateTwiml } from "../src/translator/translate.js";

const rewriteUrl = (u: string) =>
  `https://translator.example/bw/continue?next=${encodeURIComponent(u)}`;

// Representative TwiML spanning the verb surface the translator translates, from a
// trivial greeting to a composite document exercising several verbs at once.
const CORPUS: { name: string; twiml: string }[] = [
  {
    name: "say-simple",
    twiml: `<Response><Say voice="alice">Thanks for calling. Goodbye.</Say><Hangup/></Response>`,
  },
  {
    name: "say-ssml",
    twiml: `<Response><Say voice="alice">You owe <say-as interpret-as="currency">$5</say-as> by <emphasis>Friday</emphasis>.<break time="500ms"/><prosody rate="slow">Please pay soon.</prosody></Say></Response>`,
  },
  {
    name: "gather-menu",
    twiml: `<Response><Gather numDigits="1" action="/menu" method="POST"><Say>For sales press 1. For support press 2. To hear this again press 9.</Say></Gather><Say>We did not get your input.</Say><Redirect>/welcome</Redirect></Response>`,
  },
  {
    name: "dial-transfer",
    twiml: `<Response><Say>Connecting you now.</Say><Dial callerId="+15550000000" timeout="20"><Number>+15551112222</Number></Dial></Response>`,
  },
  {
    name: "record",
    twiml: `<Response><Say>Please leave a message after the tone.</Say><Record action="/done" maxLength="60" playBeep="true" transcribe="true"/></Response>`,
  },
  {
    name: "stream-connect",
    twiml: `<Response><Connect><Stream url="wss://bot.example/audio" track="both_tracks"><Parameter name="callerId" value="+15550000000"/></Stream></Connect></Response>`,
  },
  {
    name: "composite",
    twiml: `<Response><Say voice="alice">Welcome to the demo line.</Say><Pause length="1"/><Play>https://cdn.example/intro.mp3</Play><Gather numDigits="1" action="/menu"><Say>Press 1 to be transferred, 2 to leave a message.</Say></Gather><Dial><Number>+15551112222</Number></Dial><Record action="/vm" maxLength="30"/><Hangup/></Response>`,
  },
];

const iterations = Number(process.argv[2]) || 5000;
const WARMUP = Math.min(500, Math.floor(iterations / 10));

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function fmt(n: number): string {
  return n < 1 ? `${(n * 1000).toFixed(1)}µs` : `${n.toFixed(3)}ms`;
}

console.log(
  `[bench-translate] ${iterations} iterations/doc (after ${WARMUP} warmup), ${CORPUS.length} docs\n`,
);

const allDurations: number[] = [];
const rows: { name: string; bytes: number; mean: number; p50: number; p99: number; max: number }[] =
  [];

for (const { name, twiml } of CORPUS) {
  // Warm up JIT / matrix caches before timing this doc.
  for (let i = 0; i < WARMUP; i++) translateTwiml(twiml, { rewriteUrl });

  const durations: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t = performance.now();
    translateTwiml(twiml, { rewriteUrl });
    durations.push(performance.now() - t);
  }
  allDurations.push(...durations);

  durations.sort((a, b) => a - b);
  const mean = durations.reduce((s, d) => s + d, 0) / durations.length;
  rows.push({
    name,
    bytes: Buffer.byteLength(twiml),
    mean,
    p50: pct(durations, 0.5),
    p99: pct(durations, 0.99),
    max: durations[durations.length - 1],
  });
}

const pad = (s: string, n: number) => s.padEnd(n);
const padL = (s: string, n: number) => s.padStart(n);
console.log(
  `${pad("doc", 16)}${padL("bytes", 7)}${padL("mean", 11)}${padL("p50", 11)}${padL("p99", 11)}${padL("max", 11)}`,
);
console.log("─".repeat(67));
for (const r of rows) {
  console.log(
    `${pad(r.name, 16)}${padL(String(r.bytes), 7)}${padL(fmt(r.mean), 11)}${padL(fmt(r.p50), 11)}${padL(fmt(r.p99), 11)}${padL(fmt(r.max), 11)}`,
  );
}

allDurations.sort((a, b) => a - b);
const overallMean = allDurations.reduce((s, d) => s + d, 0) / allDurations.length;
console.log("─".repeat(67));
console.log(
  `${pad("ALL", 16)}${padL("", 7)}${padL(fmt(overallMean), 11)}${padL(fmt(pct(allDurations, 0.5)), 11)}${padL(fmt(pct(allDurations, 0.99)), 11)}${padL(fmt(allDurations[allDurations.length - 1]), 11)}`,
);
console.log(
  `\nThis is the translator's per-turn translation tax (CPU only). The customer ` +
    `webhook round-trip is separate and not measured here.`,
);
