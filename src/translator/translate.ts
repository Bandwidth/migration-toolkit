import { parseTwiml, type TwimlNode } from "../xml/parse-twiml.js";
import { bxmlDocument, type XmlEl } from "../xml/build-xml.js";
import { loadMatrix, type CompatMatrix } from "../matrix/load.js";

export type Severity = "info" | "warning" | "error";
export type UrlKind = "action" | "redirect" | "record" | "transfer" | "stream";

export interface Finding {
  severity: Severity;
  verb: string;
  message: string;
  docsUrl?: string;
}

export interface TranslateOptions {
  rewriteUrl?: (url: string, kind: UrlKind) => string;
}

export interface TranslateResult {
  bxml: string;
  findings: Finding[];
  hasErrors: boolean;
}

const matrix: CompatMatrix = loadMatrix();

export function translateTwiml(twiml: string, opts: TranslateOptions = {}): TranslateResult {
  const root = parseTwiml(twiml);
  const findings: Finding[] = [];
  const rewrite = opts.rewriteUrl ?? ((u: string) => u);
  const els: XmlEl[] = [];
  for (const node of root.children) {
    const el = translateVerb(node, findings, rewrite);
    if (el) els.push(...el);
  }
  return {
    bxml: bxmlDocument(els),
    findings,
    hasErrors: findings.some((f) => f.severity === "error"),
  };
}

function unsupported(node: TwimlNode, findings: Finding[], detail?: string): null {
  const m = matrix.verbs[node.name];
  findings.push({
    severity: "error",
    verb: node.name,
    message: detail ?? m?.notes ?? `TwiML <${node.name}> has no Bandwidth equivalent in the adapter.`,
    docsUrl: m?.docsUrl,
  });
  return null;
}

function warn(verb: string, message: string, findings: Finding[]): void {
  findings.push({ severity: "warning", verb, message, docsUrl: matrix.verbs[verb]?.docsUrl });
}

function translateVerb(
  node: TwimlNode,
  findings: Finding[],
  rewrite: (url: string, kind: UrlKind) => string,
): XmlEl[] | null {
  switch (node.name) {
    case "Say": {
      const attrs: Record<string, string | undefined> = {};
      if (node.attrs.voice) {
        attrs.voice = node.attrs.voice;
        warn(
          "Say",
          `Twilio voice "${node.attrs.voice}" has no exact Bandwidth equivalent; verify the rendered voice.`,
          findings,
        );
      }
      if (node.attrs.loop && node.attrs.loop !== "1")
        warn("Say", "loop attribute is not supported by BXML; content will play once.", findings);
      return [{ name: "SpeakSentence", attrs, children: [node.text] }];
    }
    case "Play": {
      if (node.attrs.loop && node.attrs.loop !== "1")
        warn("Play", "loop attribute is not supported by BXML; audio will play once.", findings);
      return [{ name: "PlayAudio", children: [node.text] }];
    }
    case "Pause":
      return [{ name: "Pause", attrs: { duration: node.attrs.length ?? "1" } }];
    case "Hangup":
      return [{ name: "Hangup" }];
    case "Reject":
      warn("Reject", matrix.verbs.Reject.notes, findings);
      return [{ name: "Hangup" }];
    case "Redirect":
      return [{ name: "Redirect", attrs: { redirectUrl: rewrite(node.text, "redirect") } }];
    case "Gather":
      return translateGather(node, findings, rewrite);
    case "Record":
      return translateRecord(node, findings, rewrite);
    case "Dial":
      return translateDial(node, findings, rewrite);
    case "Connect":
      return translateConnect(node, findings, rewrite);
    case "Enqueue":
    case "Leave":
    case "Pay":
    case "Refer":
    case "Queue":
      return unsupported(node, findings);
    default:
      return unsupported(node, findings);
  }
}

function translateGather(
  node: TwimlNode,
  findings: Finding[],
  rewrite: (u: string, k: UrlKind) => string,
): XmlEl[] | null {
  if (node.attrs.input && node.attrs.input !== "dtmf")
    return unsupported(
      node,
      findings,
      `Gather input="${node.attrs.input}" is not supported in P0 (DTMF only).`,
    );
  const attrs: Record<string, string | undefined> = {
    maxDigits: node.attrs.numDigits,
    firstDigitTimeout: node.attrs.timeout,
    terminatingDigits: node.attrs.finishOnKey,
  };
  if (node.attrs.action) attrs.gatherUrl = rewrite(node.attrs.action, "action");
  else
    warn(
      "Gather",
      "Gather without an action attribute re-requests the current document URL on Twilio; set an explicit action for identical behavior through the adapter.",
      findings,
    );
  const children: XmlEl[] = [];
  for (const child of node.children) {
    const el = translateVerb(child, findings, rewrite);
    if (el) children.push(...el);
  }
  return [{ name: "Gather", attrs, children }];
}

function translateRecord(
  node: TwimlNode,
  findings: Finding[],
  rewrite: (u: string, k: UrlKind) => string,
): XmlEl[] | null {
  const attrs: Record<string, string | undefined> = {
    maxDuration: node.attrs.maxLength,
    terminatingDigits: node.attrs.finishOnKey,
  };
  if (node.attrs.action) attrs.recordCompleteUrl = rewrite(node.attrs.action, "record");
  if (node.attrs.transcribe === "true")
    warn(
      "Record",
      "Transcription engines and callback payloads differ between Twilio and Bandwidth.",
      findings,
    );
  if (node.attrs.playBeep && node.attrs.playBeep !== "false")
    warn("Record", "playBeep has no BXML equivalent; no beep will play before recording.", findings);
  return [{ name: "Record", attrs }];
}
function translateDial(
  node: TwimlNode,
  findings: Finding[],
  rewrite: (u: string, k: UrlKind) => string,
): XmlEl[] | null {
  return unsupported(node, findings);
}
function translateConnect(
  node: TwimlNode,
  findings: Finding[],
  rewrite: (u: string, k: UrlKind) => string,
): XmlEl[] | null {
  return unsupported(node, findings);
}
