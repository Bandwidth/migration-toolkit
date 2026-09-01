// Reads TwiML on stdin, prints the translator's BXML + findings as JSON.
// Lets us see runtime translation behavior for any endpoint's actual output.
import { translateTwiml } from "../src/translator/translate.js";

let data = "";
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  const r = translateTwiml(data, {
    rewriteUrl: (u) => `https://translator.example/bw/continue?next=${encodeURIComponent(u)}`,
  });
  console.log(
    JSON.stringify(
      {
        hasErrors: r.hasErrors,
        bxml: r.bxml,
        findings: r.findings.map((f) => `[${f.severity}] ${f.verb}: ${f.message}`),
      },
      null,
      2,
    ),
  );
});
