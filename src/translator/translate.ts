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

// Full BW SpeakSentence voice allowlist sourced from:
// https://dev.bandwidth.com/docs/voice/programmable-voice/bxml/speakSentence
// Voices marked _enh use neural TTS (additional cost). "samuel" and "emily"
// are legacy names kept for backward compatibility; prefer the main list.
const BW_VOICES = new Set([
  // Original set
  "susan", "julie", "kate", "bridget", "dave", "paul", "jorge", "samuel", "emily",
  // Additional documented voices
  "simon",
  "katrin", "stefan",
  "esperanza", "violeta", "rosa",
  "jolie", "bernard",
  "paola", "luca",
  "masako", "kenji",
  "nadiya", "anatoli",
  "zeina",
  "zhiyu",
  "ruth", "stephen",
  "lupe", "pedro",
  "gabrielle", "liam",
  "salli", "salli_enh",
  "chantal",
  "miguel",
  "joey", "joey_enh",
  "penelope",
  "russell",
  "emma", "emma_enh",
  "nicole",
  "raveena",
  "mads", "naja",
  "justin",
  "ivy", "ivy_enh",
  "carmen",
  "ruben",
  "geraint",
]);

// Maps Twilio/Amazon Polly voice names → nearest valid BW voice.
// Polly.* names are stripped of the "Polly." prefix and checked first
// (e.g. Polly.Salli → "salli" which is a real BW voice); unrecognized ones
// fall back to the explicit map below, then to null (drop + warn).
const TWILIO_TO_BW_VOICE: Record<string, string> = {
  // Twilio generic aliases
  alice: "julie",
  woman: "susan",
  man: "dave",
  // Amazon Polly voices — US English females
  "polly.joanna": "salli",    // closest en_US female
  "polly.kendra": "kate",
  "polly.kimberly": "kate",
  "polly.salli": "salli",
  "polly.ivy": "ivy",
  "polly.ruth": "ruth",
  // Amazon Polly voices — US English males
  "polly.matthew": "joey",
  "polly.justin": "justin",
  "polly.kevin": "joey",
  "polly.stephen": "stephen",
  // Amazon Polly — UK English
  "polly.emma": "emma",
  "polly.amy": "emma",
  "polly.brian": "simon",
  // Amazon Polly — Spanish
  "polly.lupe": "lupe",
  "polly.penelope": "penelope",
  "polly.miguel": "miguel",
  // Amazon Polly — French
  "polly.lea": "jolie",
  "polly.celine": "jolie",
  "polly.mathieu": "bernard",
  "polly.gabrielle": "gabrielle",
  "polly.liam": "liam",
  // Amazon Polly — German
  "polly.marlene": "katrin",
  "polly.vicki": "katrin",
  "polly.hans": "stefan",
  "polly.daniel": "stefan",
  // Amazon Polly — Italian
  "polly.bianca": "paola",
  "polly.carla": "paola",
  "polly.giorgio": "luca",
  // Amazon Polly — Japanese
  "polly.mizuki": "masako",
  "polly.takumi": "kenji",
  "polly.kazuha": "masako",
  "polly.tomoko": "masako",
  // Amazon Polly — Russian
  "polly.tatyana": "nadiya",
  "polly.maxim": "anatoli",
  // Amazon Polly — Chinese
  "polly.zhiyu": "zhiyu",
  // Amazon Polly — Arabic
  "polly.zeina": "zeina",
  "polly.hala": "zeina",
  "polly.zayd": "zeina",
  // Amazon Polly — Australian English
  "polly.nicole": "nicole",
  "polly.olivia": "nicole",
  "polly.russell": "russell",
  // Amazon Polly — Welsh
  "polly.gwyneth": "geraint",
  "polly.geraint": "geraint",
  // Amazon Polly — Danish
  "polly.naja": "naja",
  "polly.mads": "mads",
  // Amazon Polly — Dutch
  "polly.lotte": "ruben",
  "polly.ruben": "ruben",
  "polly.laura": "ruben",
  // Amazon Polly — Romanian
  "polly.carmen": "carmen",
  // Amazon Polly — Indian English
  "polly.aditi": "raveena",
  "polly.raveena": "raveena",
  "polly.kajal": "raveena",
  // Amazon Polly — Portuguese (route to closest Spanish equivalents)
  "polly.ines": "paola",
  "polly.cristiano": "luca",
  "polly.vitoria": "rosa",
  "polly.camila": "rosa",
  "polly.thiago": "miguel",
};

/** Returns a valid BW voice, or null if the Twilio voice has no safe equivalent. */
function mapVoice(twilioVoice: string): string | null {
  const v = twilioVoice.toLowerCase();
  // Check explicit map first (covers generic aliases + Polly.* keys stored lowercase)
  if (TWILIO_TO_BW_VOICE[v]) return TWILIO_TO_BW_VOICE[v];
  // Polly.* shortcut: strip prefix and see if the bare name is a valid BW voice
  if (v.startsWith("polly.")) {
    const bare = v.slice(6); // "polly.salli" → "salli"
    if (BW_VOICES.has(bare)) return bare;
  }
  // Already a valid BW voice?
  if (BW_VOICES.has(v)) return v;
  return null; // unrecognized — drop rather than break the call
}

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
        const bw = mapVoice(node.attrs.voice);
        if (bw) {
          attrs.voice = bw;
          if (bw !== node.attrs.voice.toLowerCase())
            warn("Say", `Twilio voice "${node.attrs.voice}" mapped to Bandwidth voice "${bw}".`, findings);
        } else {
          warn(
            "Say",
            `Twilio voice "${node.attrs.voice}" has no Bandwidth equivalent; using BW's default voice (susan) to avoid a call failure.`,
            findings,
          );
        }
      }
      if (node.attrs.loop && node.attrs.loop !== "1")
        warn("Say", "loop attribute is not supported by BXML; content will play once.", findings);
      // Use inner (SSML preserved as raw markup) rather than flattened text.
      return [{ name: "SpeakSentence", attrs, children: [{ raw: node.inner }] }];
    }
    case "Play": {
      if (node.attrs.loop && node.attrs.loop !== "1")
        warn("Play", "loop attribute is not supported by BXML; audio will play once.", findings);
      const result: XmlEl[] = [];
      // If there's a src URL, emit PlayAudio first
      if (node.text) result.push({ name: "PlayAudio", children: [node.text] });
      // If there are digits, emit SendDtmf (after any audio)
      if (node.attrs.digits) result.push({ name: "SendDtmf", children: [node.attrs.digits] });
      // Play with neither src nor digits is a no-op — emit nothing (malformed TwiML)
      return result.length > 0 ? result : null;
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
    case "Start":
      return translateStart(node, findings, rewrite);
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
  const attrs: Record<string, string | undefined> = {
    maxDigits: node.attrs.numDigits,
    firstDigitTimeout: node.attrs.timeout,
    terminatingDigits: node.attrs.finishOnKey,
  };
  // Twilio input: "dtmf" | "speech" | "dtmf speech". BW: dtmf | speech | dtmf_speech.
  if (node.attrs.input) {
    const tokens = node.attrs.input.trim().split(/\s+/);
    const hasSpeech = tokens.includes("speech");
    const hasDtmf = tokens.includes("dtmf");
    if (hasSpeech) {
      attrs.input = hasDtmf ? "dtmf_speech" : "speech";
      if (node.attrs.speechModel || node.attrs.hints || node.attrs.language)
        warn(
          "Gather",
          "Speech recognition is supported, but Twilio speech tuning (speechModel/hints/language) has no direct BXML equivalent; BW uses its own recognizer.",
          findings,
        );
    }
  }
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
  const conference = node.children.find((c) => c.name === "Conference");
  if (conference) {
    for (const [attr, mapping] of Object.entries(matrix.verbs.Conference.attributes)) {
      if (conference.attrs[attr] !== undefined && mapping.status === "unsupported")
        findings.push({
          severity: "error",
          verb: "Conference",
          message: `Conference ${attr}: ${mapping.notes}`,
          docsUrl: matrix.verbs.Conference.docsUrl,
        });
      else if (conference.attrs[attr] !== undefined && mapping.status === "partial")
        warn("Conference", `Conference ${attr}: ${mapping.notes}`, findings);
    }
    if (node.attrs.record && node.attrs.record !== "do-not-record")
      warn(
        "Dial",
        "record attribute on Dial is ignored when the noun is Conference; set record on the <Conference> element instead.",
        findings,
      );
    return [{ name: "Conference", children: [conference.text] }];
  }
  const blocked = node.children.find((c) => c.name === "Queue" || c.name === "Client");
  if (blocked) return unsupported(blocked, findings);

  const targets: XmlEl[] = [];
  for (const child of node.children) {
    if (child.name === "Number") targets.push({ name: "PhoneNumber", children: [child.text] });
    else if (child.name === "Sip") targets.push({ name: "SipUri", children: [child.text] });
    else
      return unsupported(child, findings, `Dial noun <${child.name}> is not supported by the adapter.`);
  }
  if (targets.length === 0 && node.text) targets.push({ name: "PhoneNumber", children: [node.text] });
  if (targets.length === 0) return unsupported(node, findings, "Dial with no target.");

  warn(
    "Dial",
    "Deep Dial semantics (answerOnBridge, child-call status propagation) are not replicated in P0; validate call-progress behavior.",
    findings,
  );
  const attrs: Record<string, string | undefined> = {
    transferCallerId: node.attrs.callerId,
    callTimeout: node.attrs.timeout,
  };
  if (node.attrs.action) attrs.transferCompleteUrl = rewrite(node.attrs.action, "transfer");

  // Handle Twilio Dial record attribute → prepend StartRecording before Transfer.
  // Twilio values that trigger recording: record-from-answer, record-from-ringing,
  // record-from-answer-dual, record-from-ringing-dual, and the legacy alias "true".
  // "do-not-record" (and "false") and the absence of record → no recording.
  const record = node.attrs.record;
  const shouldRecord =
    record !== undefined &&
    record !== "do-not-record" &&
    record !== "false" &&
    record !== "";

  const result: XmlEl[] = [];
  if (shouldRecord) {
    const isDual = record === "record-from-answer-dual" || record === "record-from-ringing-dual";
    if (record === "record-from-ringing" || record === "record-from-ringing-dual")
      warn(
        "Dial",
        "record-from-ringing: Bandwidth StartRecording runs at answer-time, so pre-answer ringing audio will not be captured.",
        findings,
      );
    result.push({ name: "StartRecording", attrs: isDual ? { multiChannel: "true" } : undefined });
  }
  result.push({ name: "Transfer", attrs, children: targets });
  return result;
}

function translateConnect(
  node: TwimlNode,
  findings: Finding[],
  rewrite: (u: string, k: UrlKind) => string,
): XmlEl[] | null {
  const stream = node.children.find((c) => c.name === "Stream");
  if (!stream)
    return unsupported(
      node,
      findings,
      `Connect noun <${node.children[0]?.name ?? "?"}> is not supported (ConversationRelay/VirtualAgent are out of adapter scope).`,
    );
  if (!stream.attrs.url) return unsupported(stream, findings, "Stream requires a url attribute.");
  warn("Stream", matrix.verbs.Stream.notes, findings);
  return [
    {
      name: "StartStream",
      attrs: { destination: rewrite(stream.attrs.url, "stream"), tracks: "inbound" },
    },
  ];
}

// Twilio <Start> with <Transcription> noun → BW <StartTranscription>.
// Twilio track values: "inbound_track" | "outbound_track" | "both_legs"
// BW tracks values:    "inbound"       | "outbound"       | "both"
const TWILIO_TRACK_TO_BW: Record<string, string> = {
  inbound_track: "inbound",
  outbound_track: "outbound",
  both_legs: "both",
};

function translateStart(
  node: TwimlNode,
  findings: Finding[],
  rewrite: (u: string, k: UrlKind) => string,
): XmlEl[] | null {
  const tx = node.children.find((c) => c.name === "Transcription");
  if (!tx)
    return unsupported(
      node,
      findings,
      `Start noun <${node.children[0]?.name ?? "?"}> is not supported by the adapter.`,
    );

  warn(
    "Start",
    "Transcription event payloads differ between Twilio and Bandwidth; adapt your callback handler accordingly.",
    findings,
  );

  const attrs: Record<string, string | undefined> = {};
  if (tx.attrs.name) attrs.name = tx.attrs.name;
  if (tx.attrs.track) {
    const bwTrack = TWILIO_TRACK_TO_BW[tx.attrs.track];
    if (bwTrack) attrs.tracks = bwTrack;
    else
      warn(
        "Start",
        `Transcription track value "${tx.attrs.track}" is not recognized; BW will default to "inbound".`,
        findings,
      );
  }
  if (tx.attrs.statusCallbackUrl) {
    attrs.transcriptionEventUrl = tx.attrs.statusCallbackUrl;
  }

  return [{ name: "StartTranscription", attrs }];
}
