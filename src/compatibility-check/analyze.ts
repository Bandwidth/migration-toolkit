import { loadMatrix } from "../matrix/load.js";
import { translateTwiml, type Finding } from "../translator/translate.js";

const matrix = loadMatrix();

export interface FileAnalysis {
  file: string;
  verbs: string[];
  findings: Finding[];
  sdkDetected: boolean;
}

const SDK_METHOD_TO_VERB: Record<string, string> = {
  say: "Say",
  play: "Play",
  gather: "Gather",
  dial: "Dial",
  record: "Record",
  hangup: "Hangup",
  redirect: "Redirect",
  reject: "Reject",
  pause: "Pause",
  enqueue: "Enqueue",
  leave: "Leave",
  pay: "Pay",
  refer: "Refer",
  connect: "Connect",
  conference: "Conference",
  number: "Number",
  sip: "Sip",
  queue: "Queue",
  client: "Client",
};

export function analyzeSource(file: string, source: string): FileAnalysis {
  const verbs = new Set<string>();
  const findings: Finding[] = [];
  const sdkDetected = /require\(["']twilio["']\)|from ["']twilio["']/.test(source);

  for (const twimlMatch of source.match(/<Response[\s\S]*?<\/Response>/g) ?? []) {
    try {
      const r = translateTwiml(twimlMatch);
      findings.push(...r.findings);
      for (const m of twimlMatch.matchAll(/<([A-Z][A-Za-z]+)[\s/>]/g)) {
        if (m[1] !== "Response" && matrix.verbs[m[1]]) verbs.add(m[1]);
      }
    } catch {
      // unparseable fragment — skip
    }
  }

  if (sdkDetected) {
    for (const m of source.matchAll(
      /\.\s*(say|play|gather|dial|record|hangup|redirect|reject|pause|enqueue|leave|pay|refer|connect|conference|number|sip|queue|client)\s*\(/g,
    )) {
      const verb = SDK_METHOD_TO_VERB[m[1]];
      if (!verb) continue;
      verbs.add(verb);
      const entry = matrix.verbs[verb];
      if (entry && entry.status !== "supported") {
        findings.push({
          severity: entry.status === "unsupported" ? "error" : "warning",
          verb,
          message: entry.notes,
          docsUrl: entry.docsUrl,
        });
      }
    }
  }

  const dedup = new Map(findings.map((f) => [`${f.severity}:${f.verb}:${f.message}`, f]));
  return { file, verbs: [...verbs], findings: [...dedup.values()], sdkDetected };
}
