// Turns a live adapter's ADAPTER_LOG=1 output into a latency report: the
// per-turn split between the customer webhook round-trip (fetchMs, network —
// not ours) and the TwiML→BXML translation (translateMs, CPU — ours), as
// p50/p99/max, same shape as the benches.
//
// This is how you get the PRODUCTION number the loopback benches can't: run a
// real call (docs/demo.md §3) and the `fetchMs` here carries the true network
// distance to Bandwidth's voice edge.
//
// Live pipe (logs stream through to your terminal, report prints on Ctrl-C):
//   ADAPTER_LOG=1 npm start 2>&1 | tsx scripts/latency-report.ts
//
// Or analyze a captured log file:
//   ADAPTER_LOG=1 npm start > adapter.log 2>&1     # ...place call, then Ctrl-C
//   npm run latency:report -- adapter.log
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";

const pct = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : NaN;
const fmt = (n: number) =>
  Number.isNaN(n) ? "—" : n < 1 ? `${(n * 1000).toFixed(0)}µs` : `${n.toFixed(3)}ms`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

const fetchMs: number[] = [];
const translateMs: number[] = [];
const responseMs: number[] = []; // Fastify's own per-request "request completed" responseTime

function consume(line: string) {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line);
  } catch {
    return; // not a JSON log line (e.g. the "adapter listening on :3000" banner)
  }
  if (rec.msg === "fetchAndTranslate timing") {
    if (typeof rec.fetchMs === "number") fetchMs.push(rec.fetchMs);
    if (typeof rec.translateMs === "number") translateMs.push(rec.translateMs);
  } else if (rec.msg === "request completed" && typeof rec.responseTime === "number") {
    responseMs.push(rec.responseTime);
  }
}

function statRow(label: string, xs: number[]): string {
  const s = [...xs].sort((a, b) => a - b);
  const pad = (v: string, n: number) => v.padStart(n);
  return `${label.padEnd(16)}${pad(String(xs.length), 7)}${pad(fmt(mean(xs)), 11)}${pad(fmt(pct(s, 0.5)), 11)}${pad(fmt(pct(s, 0.99)), 11)}${pad(fmt(s[s.length - 1] ?? NaN), 11)}`;
}

function report() {
  if (!fetchMs.length && !translateMs.length && !responseMs.length) {
    process.stderr.write(
      "\n[latency-report] No timing lines found. Did you run with ADAPTER_LOG=1 " +
        "and exercise /bw/initiate or /bw/continue?\n",
    );
    return;
  }
  const out = process.stderr;
  out.write("\n[latency-report] per-IVR-turn latency\n\n");
  out.write(`${"".padEnd(16)}${"n".padStart(7)}${"mean".padStart(11)}${"p50".padStart(11)}${"p99".padStart(11)}${"max".padStart(11)}\n`);
  out.write("─".repeat(67) + "\n");
  out.write(statRow("fetchMs", fetchMs) + "   ← customer webhook RTT (network)\n");
  out.write(statRow("translateMs", translateMs) + "   ← TwiML→BXML (the adapter's tax)\n");

  if (fetchMs.length && translateMs.length) {
    const totMean = mean(fetchMs) + mean(translateMs);
    const share = (mean(translateMs) / totMean) * 100;
    out.write("─".repeat(67) + "\n");
    out.write(
      `Translation is ${share.toFixed(share < 1 ? 2 : 1)}% of the ${fmt(totMean)} mean per-turn cost; ` +
        `the rest is the customer round-trip.\n`,
    );
  }
  if (responseMs.length) {
    out.write("\nWhole-request (all routes, Fastify responseTime):\n");
    out.write(statRow("responseTime", responseMs) + "\n");
  }
}

const file = process.argv[2];
const input = file ? createReadStream(file) : process.stdin;
const rl = createInterface({ input, crlfDelay: Infinity });

rl.on("line", (line) => {
  if (!file) process.stdout.write(line + "\n"); // live pipe: pass logs through
  consume(line);
});
rl.on("close", report);
// Ctrl-C on a live pipe: emit the report before exiting.
process.on("SIGINT", () => {
  report();
  process.exit(0);
});
