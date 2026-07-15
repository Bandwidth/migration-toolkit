import { parseTwiml, type TwimlNode } from "../xml/parse-twiml.js";
import { bxmlDocument, type XmlEl } from "../xml/build-xml.js";
import { loadMatrix, type CompatMatrix } from "../matrix/load.js";

export type Severity = "info" | "warning" | "error";
export type UrlKind = "action" | "redirect" | "record" | "transfer" | "stream" | "recordingStatus";

export interface Finding {
  severity: Severity;
  verb: string;
  message: string;
  docsUrl?: string;
}

export interface TranslateOptions {
  rewriteUrl?: (url: string, kind: UrlKind) => string;
  /** Basic-auth credentials to stamp onto emitted BXML callback verbs so Bandwidth
   *  authenticates its continuation callbacks (e.g. /bw/continue). */
  callbackAuth?: { username: string; password: string };
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

// Attrs that carry a rewritten adapter callback URL (Bandwidth will hit these
// endpoints directly, so they need Basic-auth creds matching the app's CallbackCreds).
const CALLBACK_URL_ATTRS = [
  "gatherUrl",
  "redirectUrl",
  "recordCompleteUrl",
  "recordingAvailableUrl",
  "transferCompleteUrl",
  "referCompleteUrl",
] as const;

/** Walks the built element tree and stamps username/password onto any element
 *  carrying a rewritten adapter callback URL, so Bandwidth Basic-auths the
 *  continuation request instead of hitting it unauthenticated. */
function stampCallbackAuth(els: XmlEl[], auth: { username: string; password: string }): void {
  for (const el of els) {
    if (el.attrs && CALLBACK_URL_ATTRS.some((a) => el.attrs![a] !== undefined)) {
      el.attrs.username = auth.username;
      el.attrs.password = auth.password;
    }
    if (el.children) {
      const childEls = el.children.filter(
        (c): c is XmlEl => typeof c !== "string" && !("raw" in c),
      );
      stampCallbackAuth(childEls, auth);
    }
  }
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
  if (opts.callbackAuth) stampCallbackAuth(els, opts.callbackAuth);
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

/**
 * Twilio's loop="N" repeats a <Say>/<Play>. BXML has no loop attribute, so a
 * finite count is expanded into the verb repeated N times. loop="0" means
 * "repeat until hangup" on Twilio and an invalid count has no meaning — neither
 * can be expressed inline in BXML, so both fall back to a single emission plus a
 * warning rather than silently dropping the intent.
 */
function applyLoop(els: XmlEl[], loop: string | undefined, verb: string, findings: Finding[]): XmlEl[] {
  if (loop === undefined || loop === "1") return els;
  if (loop === "0") {
    warn(verb, 'loop="0" requests infinite repetition, which BXML cannot express inline; content will play once.', findings);
    return els;
  }
  const n = Number(loop);
  if (!Number.isInteger(n) || n < 1) {
    warn(verb, `loop="${loop}" is not a valid repeat count; content will play once.`, findings);
    return els;
  }
  const out: XmlEl[] = [];
  for (let i = 0; i < n; i++) out.push(...els);
  return out;
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
      // Use inner (SSML preserved as raw markup) rather than flattened text.
      const say: XmlEl = { name: "SpeakSentence", attrs, children: [{ raw: node.inner }] };
      return applyLoop([say], node.attrs.loop, "Say", findings);
    }
    case "Play": {
      const result: XmlEl[] = [];
      // If there's a src URL, emit PlayAudio first
      if (node.text) result.push({ name: "PlayAudio", children: [node.text] });
      // If there are digits, emit SendDtmf (after any audio)
      if (node.attrs.digits) result.push({ name: "SendDtmf", children: [node.attrs.digits] });
      // Play with neither src nor digits is a no-op — emit nothing (malformed TwiML)
      if (result.length === 0) return null;
      // loop="N" repeats the whole element (audio + any DTMF) N times.
      return applyLoop(result, node.attrs.loop, "Play", findings);
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
    case "Stop":
      return translateStop(node, findings);
    case "Refer":
      return translateRefer(node, findings, rewrite);
    case "Enqueue":
    case "Leave":
    case "Pay":
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
  // Twilio's async "recording is ready" webhook (recordingStatusCallback) maps to
  // Bandwidth's recordingAvailableUrl. The adapter receives the BW event, reshapes
  // it into Twilio recording-callback params, and forwards it to the customer.
  if (node.attrs.recordingStatusCallback)
    attrs.recordingAvailableUrl = rewrite(node.attrs.recordingStatusCallback, "recordingStatus");
  if (
    node.attrs.recordingStatusCallbackMethod &&
    node.attrs.recordingStatusCallbackMethod.toUpperCase() === "GET"
  )
    warn(
      "Record",
      "recordingStatusCallbackMethod=GET is not honored; the adapter forwards recording events via POST.",
      findings,
    );
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

// Twilio <Dial> attributes with no BXML <Transfer> equivalent. Each present
// attribute produces an explicit warning so the migration report flags it
// instead of the behavior silently disappearing.
const UNSUPPORTED_DIAL_ATTRS: Record<string, string> = {
  timeLimit:
    "Dial timeLimit (maximum call duration) has no BXML Transfer equivalent; the transferred leg will not be automatically terminated.",
  hangupOnStar:
    "Dial hangupOnStar has no BXML equivalent; the caller pressing * will not end the transferred call.",
  ringTone:
    "Dial ringTone has no BXML equivalent; Bandwidth uses its own default ringback tone.",
  answerOnBridge:
    "Dial answerOnBridge is not replicated; Bandwidth answers the inbound leg before bridging, so early-media/ringback behavior may differ.",
};

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
    // Map the Conference attributes BW's verb supports.
    const confAttrs: Record<string, string | undefined> = {};
    if (conference.attrs.muted === "true") confAttrs.mute = "true";
    if (conference.attrs.statusCallback)
      confAttrs.conferenceEventUrl = conference.attrs.statusCallback;
    return [{ name: "Conference", attrs: confAttrs, children: [conference.text] }];
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
    "Child-call status propagation is not fully replicated in P0; validate call-progress behavior.",
    findings,
  );
  // Twilio Dial attributes the adapter cannot map to BXML Transfer. Surfacing
  // each one explicitly (rather than dropping it silently) is the product's
  // no-silent-degradation contract — the customer learns exactly what won't carry over.
  for (const [attr, message] of Object.entries(UNSUPPORTED_DIAL_ATTRS)) {
    if (node.attrs[attr] !== undefined) warn("Dial", message, findings);
  }
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

// Twilio <Stream track>: inbound_track | outbound_track | both_tracks → BW tracks.
const TWILIO_STREAM_TRACK_TO_BW: Record<string, string> = {
  inbound_track: "inbound",
  outbound_track: "outbound",
  both_tracks: "both",
};

/** Twilio <Stream> noun → BW <StartStream>. mode is bidirectional under
 *  <Connect> (audio flows both ways) and unidirectional under <Start> (a fork). */
function streamToStartStream(
  stream: TwimlNode,
  mode: "bidirectional" | "unidirectional",
  findings: Finding[],
  rewrite: (u: string, k: UrlKind) => string,
): XmlEl[] | null {
  if (!stream.attrs.url) return unsupported(stream, findings, "Stream requires a url attribute.");
  warn("Stream", matrix.verbs.Stream.notes, findings);
  const attrs: Record<string, string | undefined> = {
    name: stream.attrs.name,
    destination: rewrite(stream.attrs.url, "stream"),
    mode,
    tracks: stream.attrs.track ? TWILIO_STREAM_TRACK_TO_BW[stream.attrs.track] ?? "inbound" : "inbound",
  };
  return [{ name: "StartStream", attrs }];
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
  return streamToStartStream(stream, "bidirectional", findings, rewrite);
}

// Twilio <Start> with <Transcription> noun → BW <StartTranscription>.
// Twilio track values: "inbound_track" | "outbound_track" | "both_legs"
// BW tracks values:    "inbound"       | "outbound"       | "both"
const TWILIO_TRACK_TO_BW: Record<string, string> = {
  inbound_track: "inbound",
  outbound_track: "outbound",
  both_legs: "both",
};

// Twilio <Stop> with <Stream>/<Transcription> nouns → BW StopStream/StopTranscription.
function translateStop(node: TwimlNode, findings: Finding[]): XmlEl[] | null {
  const stream = node.children.find((c) => c.name === "Stream");
  if (stream) {
    if (!stream.attrs.name)
      warn(
        "Stop",
        "Stop>Stream without a name: Bandwidth StopStream requires a name to identify which stream to stop.",
        findings,
      );
    return [{ name: "StopStream", attrs: { name: stream.attrs.name } }];
  }
  const tx = node.children.find((c) => c.name === "Transcription");
  if (tx) return [{ name: "StopTranscription", attrs: { name: tx.attrs.name } }];
  return unsupported(
    node,
    findings,
    `Stop noun <${node.children[0]?.name ?? "?"}> is not supported by the adapter.`,
  );
}

// Twilio <Refer><Sip> → BW <Refer><SipUri>. SIP REFER only; Bandwidth supports
// this solely on inbound SIP URI calls (a PSTN leg cannot be REFER'd).
function translateRefer(
  node: TwimlNode,
  findings: Finding[],
  rewrite: (u: string, k: UrlKind) => string,
): XmlEl[] | null {
  const sip = node.children.find((c) => c.name === "Sip");
  if (!sip || !sip.text)
    return unsupported(
      node,
      findings,
      "Refer requires a <Sip> child: Bandwidth Refer sends a SIP REFER and only accepts a SIP URI.",
    );
  warn(
    "Refer",
    "Refer is translated, but Bandwidth only honors it on inbound SIP URI calls — a PSTN call leg cannot be REFER'd.",
    findings,
  );
  const attrs: Record<string, string | undefined> = {};
  if (node.attrs.action) attrs.referCompleteUrl = rewrite(node.attrs.action, "action");
  if (node.attrs.method) attrs.referCompleteMethod = node.attrs.method;
  return [{ name: "Refer", attrs, children: [{ name: "SipUri", children: [sip.text] }] }];
}

function translateStart(
  node: TwimlNode,
  findings: Finding[],
  rewrite: (u: string, k: UrlKind) => string,
): XmlEl[] | null {
  // <Start><Stream> is a unidirectional fork (audio out to the bot only).
  const startStream = node.children.find((c) => c.name === "Stream");
  if (startStream) return streamToStartStream(startStream, "unidirectional", findings, rewrite);

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
