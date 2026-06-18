import { describe, it, expect } from "vitest";
import { translateTwiml } from "../src/translator/translate.js";

// Regression guard on the TwiML→BXML translation tax. This is NOT a precise
// benchmark (use `npm run bench` for the real distribution, ~6µs/turn) — it's a
// generous ceiling that trips only if translation regresses by orders of
// magnitude, e.g. someone introduces sync I/O or an O(n²) into the hot path and
// per-turn cost jumps from microseconds into milliseconds. Mirrors the loopback
// p99 gate in streams-wire.test.ts. The bound is deliberately loose (5 ms vs an
// observed ~20 µs p99) so shared/noisy CI runners never flake on it.
describe("latency: TwiML→BXML translation tax", () => {
  it("p99 stays under 5 ms per turn across the verb surface", () => {
    const rewriteUrl = (u: string) =>
      `https://adapter.example/bw/continue?next=${encodeURIComponent(u)}`;
    const corpus = [
      `<Response><Say voice="alice">Thanks for calling. Goodbye.</Say><Hangup/></Response>`,
      `<Response><Gather numDigits="1" action="/menu" method="POST"><Say>For sales press 1. For support press 2.</Say></Gather><Redirect>/welcome</Redirect></Response>`,
      `<Response><Say>Connecting you now.</Say><Dial callerId="+15550000000" timeout="20"><Number>+15551112222</Number></Dial></Response>`,
      `<Response><Connect><Stream url="wss://bot.example/audio" track="both_tracks"><Parameter name="callerId" value="+15550000000"/></Stream></Connect></Response>`,
      `<Response><Say voice="alice">Welcome.</Say><Pause length="1"/><Play>https://cdn.example/intro.mp3</Play><Gather numDigits="1" action="/menu"><Say>Press 1 to transfer, 2 to leave a message.</Say></Gather><Dial><Number>+15551112222</Number></Dial><Record action="/vm" maxLength="30"/><Hangup/></Response>`,
    ];

    const ITERATIONS = 2000;
    // Warm up the JIT and the matrix cache before timing.
    for (let i = 0; i < 200; i++) translateTwiml(corpus[i % corpus.length], { rewriteUrl });

    const durations: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const twiml = corpus[i % corpus.length];
      const t = performance.now();
      translateTwiml(twiml, { rewriteUrl });
      durations.push(performance.now() - t);
    }

    durations.sort((a, b) => a - b);
    const p99 = durations[Math.floor(durations.length * 0.99)];
    expect(durations.length).toBe(ITERATIONS);
    expect(p99).toBeLessThan(5);
  });
});
