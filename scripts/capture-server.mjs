// Dev-only Twilio webhook capture server. Logs each request (method, path,
// query, the X-Twilio-Signature header, and the form body) to capture/ as JSON,
// and returns TwiML so the call flow proceeds. Not part of the shipped adapter.
import { createServer } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), "capture");
mkdirSync(OUT, { recursive: true });

const TWIML = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Capture test in progress. Goodbye.</Say><Hangup/></Response>`;

let n = 0;
createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url, "http://localhost");
    const record = {
      seq: ++n,
      at: new Date().toISOString(),
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      twilioSignature: req.headers["x-twilio-signature"] ?? null,
      contentType: req.headers["content-type"] ?? null,
      bodyRaw: raw,
      bodyParams: Object.fromEntries(new URLSearchParams(raw)),
    };
    const file = join(OUT, `req-${String(n).padStart(2, "0")}-${url.searchParams.get("leg") ?? "x"}.json`);
    writeFileSync(file, JSON.stringify(record, null, 2));
    console.log(`captured #${n} ${req.method} ${url.pathname}?${url.search.slice(1)} sig=${record.twilioSignature ? "yes" : "no"}`);
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(TWIML);
  });
}).listen(4100, () => console.log("capture server on :4100"));
