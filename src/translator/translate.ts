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

/** Extra facts about the verb a URL belongs to, for rewriters that need them. */
export interface RewriteContext {
  /** 1-based position of this <Gather> among all Gathers in the document. */
  gatherIndex?: number;
  /** Twilio actionOnEmptyResult="true": request the action even with no input. */
  actionOnEmptyResult?: boolean;
  /** 1-based position of this <Dial> among the Dials with an action in the document. */
  dialIndex?: number;
  /** How many targets (Number/Sip) this <Dial> rings, i.e. how many legs to expect. */
  dialTargets?: number;
  /** This URL was generated because the verb had no action attribute and the
   *  server fell back to the document's own URL (see TranslateOptions.documentUrl),
   *  not because the customer wrote this URL themselves. Lets the server tell
   *  "re-request the customer's real action" apart from "re-request myself",
   *  which matters when there is no cached document to resume after a Gather
   *  with no input: re-requesting a real action is a reasonable fallback, but
   *  re-requesting the document that produced this same Gather would just
   *  replay the same prompt forever. */
  selfReference?: boolean;
}

export type RewriteUrl = (url: string, kind: UrlKind, ctx?: RewriteContext) => string;

export interface TranslateOptions {
  rewriteUrl?: RewriteUrl;
  /** Basic-auth credentials to stamp onto emitted BXML callback verbs so Bandwidth
   *  authenticates its continuation callbacks (e.g. /bw/continue). */
  callbackAuth?: { username: string; password: string };
  /** Absolute URL that receives Bandwidth's transferDisconnect event for every
   *  leg of the Nth Dial (the translator's /bw/transfer-leg). Set by the server so
   *  a Dial action can report DialCallSid/DialCallDuration/DialBridged, which
   *  Bandwidth's transferComplete event does not carry. The index matches the
   *  dialIndex the rewriter sees for that Dial's action, so the server can tie
   *  each leg to its own Dial. Standalone BXML generation leaves it unset. */
  transferLegUrl?: (dialIndex: number) => string;
  /** Emit only the verbs after the Nth <Gather> (1-based, document order). Used
   *  to resume a document when a Gather ends with no input: Twilio continues
   *  with the following verbs, Bandwidth expects fresh BXML from the gatherUrl. */
  resumeAfterGather?: number;
  /** Absolute URL of the TwiML document being translated. A <Gather>/<Record>
   *  with no action re-requests this same URL on Twilio; the translator
   *  replicates that by rewriting it as the action, which only the server can
   *  usefully resolve (it knows the URL it just fetched and can fetch it
   *  again). Standalone BXML generation leaves this unset, so a missing
   *  action keeps producing a warning instead of a URL nothing will serve. */
  documentUrl?: string;
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

// Attrs that carry a rewritten translator callback URL (Bandwidth will hit these
// endpoints directly, so they need Basic-auth creds matching the app's CallbackCreds).
const CALLBACK_URL_ATTRS = [
  "gatherUrl",
  "redirectUrl",
  "recordCompleteUrl",
  "recordingAvailableUrl",
  "transferCompleteUrl",
  "transferDisconnectUrl",
  "referCompleteUrl",
] as const;

/** Walks the built element tree and stamps username/password onto any element
 *  carrying a rewritten translator callback URL, so Bandwidth Basic-auths the
 *  continuation request instead of hitting it unauthenticated. A StartStream's
 *  destination is the translator's own /bw/stream WebSocket after rewriting, so
 *  it gets the same credentials as destinationUsername/destinationPassword,
 *  which Bandwidth presents as the Authorization header on the upgrade. */
function stampCallbackAuth(els: XmlEl[], auth: { username: string; password: string }): void {
  for (const el of els) {
    if (el.attrs && CALLBACK_URL_ATTRS.some((a) => el.attrs![a] !== undefined)) {
      el.attrs.username = auth.username;
      el.attrs.password = auth.password;
    }
    // INVARIANT: callbackAuth is only passed together with the server's rewriter,
    // which points every "stream" URL at the translator's own /bw/stream. These
    // are the translator's webhook credentials; a rewriter that ever left the
    // customer's bot URL in place would hand them to a third party.
    if (el.name === "StartStream" && el.attrs?.destination !== undefined) {
      el.attrs.destinationUsername = auth.username;
      el.attrs.destinationPassword = auth.password;
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
  bxmlByteBudget = MAX_TOTAL_BXML_BYTES;
  connectStreamSeq = 0;
  gatherSeq = 0;
  dialSeq = 0;
  currentTransferLegUrl = opts.transferLegUrl;
  currentDocumentUrl = opts.documentUrl;
  const root = parseTwiml(twiml);
  const findings: Finding[] = [];
  const rewrite: RewriteUrl = opts.rewriteUrl ?? ((u: string) => u);
  const els: XmlEl[] = [];
  // Resuming after a Gather: skip everything through the Nth Gather. Skipped
  // Gathers still advance gatherSeq so the ones we do emit keep their document
  // positions, and a later resume lands in the right place.
  let skipThroughGather = opts.resumeAfterGather ?? 0;
  for (const node of root.children) {
    if (skipThroughGather > 0) {
      if (node.name === "Gather" && ++gatherSeq === skipThroughGather) skipThroughGather = 0;
      continue;
    }
    const el = translateVerb(node, findings, rewrite);
    if (el) els.push(...el);
  }
  if (opts.callbackAuth) stampCallbackAuth(els, opts.callbackAuth);
  return {
    bxml: bxmlDocument(els),
    findings: dedupeFindings(findings),
    hasErrors: findings.some((f) => f.severity === "error"),
  };
}

/**
 * Collapses findings that repeat the exact same severity+verb+message to a
 * single occurrence. A generic finding (e.g. "Record's playBeep defaults to
 * true...") says nothing new the second time it's reported for the same
 * verb, and a document with many instances of one verb (e.g. 50 bare
 * <Record>s) would otherwise bury any findings that differ — like the
 * out-of-range warnings, which embed the offending value and so remain
 * distinct per occurrence. Order is preserved; only later duplicates drop.
 * Exported so compatibility-check's analyzeSource can apply the same rule
 * across the several <Response> blocks one file may contain, instead of
 * keeping its own separate dedup logic that could drift from this one.
 */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.severity}\u0000${f.verb}\u0000${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unsupported(node: TwimlNode, findings: Finding[], detail?: string): null {
  const m = matrix.verbs[node.name];
  findings.push({
    severity: "error",
    verb: node.name,
    message: detail ?? m?.notes ?? `TwiML <${node.name}> has no Bandwidth equivalent in the translator.`,
    docsUrl: m?.docsUrl,
  });
  return null;
}

function warn(verb: string, message: string, findings: Finding[]): void {
  findings.push({ severity: "warning", verb, message, docsUrl: matrix.verbs[verb]?.docsUrl });
}

/** True for an attribute that's absent or holds only whitespace — e.g. a
 *  template variable that rendered empty. Treated the same as "not set" for
 *  numeric attributes: JavaScript's Number() reads whitespace-only text as 0
 *  (Number(" ") === 0), which would otherwise look like a real, in-range zero
 *  rather than a value nobody actually set. */
function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

/** `value`, or `fallback` when `value` is blank (see isBlank). */
function orDefault(value: string | undefined, fallback: string): string {
  return isBlank(value) ? fallback : (value as string);
}

/**
 * Formats a finite number as plain decimal text. `String(n)` switches to
 * scientific notation for very small magnitudes (`String(0.0000001)` is
 * `"1e-7"`), which Bandwidth's BXML parser almost certainly doesn't expect
 * for a duration or count; this always returns a plain decimal string.
 */
function toPlainDecimal(n: number): string {
  const s = String(n);
  if (!/e/i.test(s)) return s;
  return n.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Resolves a TwiML attribute to a plain, finite decimal number, warning once
 * and falling back to `fallback` when it isn't a usable number at all (empty,
 * "abc", "Infinity") rather than being passed through — Bandwidth's BXML
 * parser expects a plain decimal number here, and silently forwarding "abc"
 * would just move today's rejected-call problem from "out of range" to "not
 * a number in the first place". A value that IS a number (including forms
 * Bandwidth almost certainly doesn't accept, like "0x3C" or "1e1") is
 * normalized to its plain decimal form. Blank input (see isBlank) should be
 * resolved to a default by the caller before this runs, so this only ever
 * warns about a value that's actually present but unusable.
 */
function resolveNumeric(verb: string, twilioAttr: string, value: string, fallback: string, findings: Finding[]): string {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    warn(verb, `${twilioAttr}="${value}" isn't a plain number Bandwidth can use; using ${fallback} instead.`, findings);
    return fallback;
  }
  return toPlainDecimal(n);
}

/**
 * Rounds an already-numeric value (see resolveNumeric) to the nearest whole
 * number, warning if it wasn't one. For a *count* — Gather's numDigits is the
 * only one of these attributes — a fraction has no real meaning (there's no
 * such thing as collecting 2.5 digits), unlike the duration attributes
 * (timeout, maxLength), where Bandwidth's own docs allow decimal values and a
 * fraction is a normal, real concept (a 2.5-second pause), so those are left
 * as whatever plain decimal the customer wrote.
 */
function roundToInteger(verb: string, twilioAttr: string, value: string, findings: Finding[]): string {
  const n = Number(value);
  const rounded = Math.round(n);
  if (rounded !== n) warn(verb, `${twilioAttr}="${value}" isn't a whole number; using ${rounded} instead.`, findings);
  return String(rounded);
}

/**
 * Keeps an already-numeric value (see resolveNumeric) within the range
 * Bandwidth documents for the BXML attribute it maps to, warning when it had
 * to change. Warnings name the Twilio attribute the customer actually wrote
 * (not Bandwidth's name for it) while still saying which BXML attribute is
 * affected, so the warning can be found by searching the customer's own
 * TwiML and still makes sense next to the generated BXML.
 */
function clampToRange(
  verb: string,
  twilioAttr: string,
  bxmlAttr: string,
  value: string,
  min: number,
  max: number,
  findings: Finding[],
): string {
  const n = Number(value);
  if (n < min) {
    warn(verb, `${twilioAttr}="${value}" is below Bandwidth's minimum for ${bxmlAttr} (${min}); using ${min} instead.`, findings);
    return String(min);
  }
  if (n > max) {
    warn(verb, `${twilioAttr}="${value}" is above Bandwidth's maximum for ${bxmlAttr} (${max}); using ${max} instead.`, findings);
    return String(max);
  }
  return value;
}

/**
 * Resolves a Gather/Record's `action` to the URL it should actually request:
 * the explicit `action` if given, or — when the server knows the URL of the
 * document being translated — that same URL, matching Twilio's "no action
 * re-requests the current document" behavior. Returns undefined, and warns,
 * when there is neither (standalone BXML generation has no server to send a
 * request back to). Shared by translateGather and translateRecord, which
 * otherwise had identical branching here.
 */
function resolveActionUrl(
  verb: string,
  action: string | undefined,
  kind: UrlKind,
  rewrite: RewriteUrl,
  findings: Finding[],
  ctx?: RewriteContext,
): string | undefined {
  if (action) return rewrite(action, kind, ctx);
  if (currentDocumentUrl !== undefined) return rewrite(currentDocumentUrl, kind, { ...ctx, selfReference: true });
  warn(
    verb,
    `${verb} without an action attribute re-requests the current document URL on Twilio; set an explicit action for identical behavior through the translator.`,
    findings,
  );
  return undefined;
}

// Twilio's documented ceiling for Say/Play loop counts; also our hard bound on
// a single verb's expansion so one attribute cannot force unbounded allocation.
const MAX_LOOP = 1000;

// Document-wide ceiling on total loop-expanded OUTPUT BYTES. The per-verb
// MAX_LOOP bounds one verb's repeat count, but that alone doesn't bound size:
// a single <Say loop="1000"> with a large text body is only 1000 elements yet
// serializes to hundreds of MB. Budgeting serialized bytes bounds both the
// many-verbs and the one-huge-verb amplifications. 2 MiB is far above any real
// call flow, far below anything that stresses memory.
const MAX_TOTAL_BXML_BYTES = 2 * 1024 * 1024;
// Remaining byte budget for the current translateTwiml call. Reset at the start
// of each call; safe as module state because translateTwiml runs synchronously
// with no await. (The one caveat: a caller-supplied rewriteUrl must not itself
// call translateTwiml re-entrantly — ours is a pure URL builder that doesn't.)
let bxmlByteBudget = MAX_TOTAL_BXML_BYTES;

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
  // Bound the expansion. Twilio's documented maximum for Say/Play loop is 1000;
  // without a cap, a value like loop="999999999" (or loop="9e9") would allocate
  // billions of elements and a multi-gigabyte string on the event loop from a
  // single attacker-controlled document. Clamp to the max and warn.
  const count = Math.min(n, MAX_LOOP);
  if (n > MAX_LOOP)
    warn(verb, `loop="${loop}" exceeds the maximum of ${MAX_LOOP}; content will repeat ${MAX_LOOP} times.`, findings);
  // Enforce the document-wide byte budget BEFORE expanding, so a document
  // cannot amplify to a giant serialized string. Serialize one un-looped copy
  // to size the unit (bounded by input size), then project the repeated cost.
  const unitBytes = bxmlDocument(els).length;
  const projected = count * unitBytes;
  if (projected > bxmlByteBudget) {
    findings.push({
      severity: "error",
      verb,
      message: `Total output exceeds the ${MAX_TOTAL_BXML_BYTES}-byte document budget; document rejected.`,
      docsUrl: matrix.verbs[verb]?.docsUrl,
    });
    return els;
  }
  bxmlByteBudget -= projected;
  const out: XmlEl[] = [];
  for (let i = 0; i < count; i++) out.push(...els);
  return out;
}

function translateVerb(
  node: TwimlNode,
  findings: Finding[],
  rewrite: RewriteUrl,
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
  rewrite: RewriteUrl,
): XmlEl[] | null {
  // Twilio's timeout (default 5) governs both the pause before the first digit
  // and the gap between digits; Bandwidth splits these into two attributes.
  // Bandwidth happens to default both to 5s on its own, so an omitted timeout
  // is a no-op either way — the real fix is that an EXPLICIT timeout used to
  // only reach firstDigitTimeout, leaving interDigitTimeout at Bandwidth's
  // default regardless of what the customer set. A blank timeout (empty or
  // all whitespace) is treated the same as omitted: Twilio doesn't accept a
  // blank duration either. Validated as a number once, not once per BXML
  // attribute it maps to, so a non-numeric value doesn't produce two
  // near-identical warnings.
  const timeout = resolveNumeric("Gather", "timeout", orDefault(node.attrs.timeout, "5"), "5", findings);
  const attrs: Record<string, string | undefined> = {
    maxDigits: isBlank(node.attrs.numDigits)
      ? undefined
      : clampToRange(
          "Gather",
          "numDigits",
          "maxDigits",
          roundToInteger("Gather", "numDigits", resolveNumeric("Gather", "numDigits", node.attrs.numDigits as string, "50", findings), findings),
          1,
          50,
          findings,
        ),
    firstDigitTimeout: clampToRange("Gather", "timeout", "firstDigitTimeout", timeout, 0, 60, findings),
    interDigitTimeout: clampToRange("Gather", "timeout", "interDigitTimeout", timeout, 1, 60, findings),
    terminatingDigits: gatherTerminatingDigits(node.attrs.finishOnKey, findings),
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
  // Document position and the empty-result policy travel with the URL so the
  // server can resume after this Gather when Bandwidth reports no input
  // (Twilio continues with the next verb unless actionOnEmptyResult="true").
  const gatherIndex = ++gatherSeq;
  const gatherCtx = { gatherIndex, actionOnEmptyResult: node.attrs.actionOnEmptyResult === "true" };
  attrs.gatherUrl = resolveActionUrl("Gather", node.attrs.action, "action", rewrite, findings, gatherCtx);
  const children: XmlEl[] = [];
  for (const child of node.children) {
    const el = translateVerb(child, findings, rewrite);
    if (el) children.push(...el);
  }
  return [{ name: "Gather", attrs, children }];
}

// Per-document counter of <Gather> verbs in document order; reset per
// translateTwiml call (same module-state caveat as bxmlByteBudget).
let gatherSeq = 0;
// Per-document counter of <Dial> verbs with an action; same caveat.
let dialSeq = 0;
// The server's transferDisconnect endpoint for the current translation, if any.
let currentTransferLegUrl: ((dialIndex: number) => string) | undefined;
// The absolute URL of the document being translated, if the caller knows it
// (the server does; standalone BXML generation does not). See documentUrl.
//
// This makes six pieces of module state reset per translateTwiml call and
// subject to the same reentrancy caveat as bxmlByteBudget above. Multiple
// reviews have suggested threading one mutable context object through every
// verb-translating function instead, which would remove the caveat entirely.
// That's a real improvement, deliberately deferred rather than done inline
// here: it touches the signature of every translateX function and its
// recursive call sites, which is a larger, separate refactor than this fix
// warrants risking right before merge. Worth doing as its own follow-up.
let currentDocumentUrl: string | undefined;

// The only characters Bandwidth recognizes as a key in either verb's
// terminatingDigits: Gather's set, or the one character Record takes.
const VALID_TERMINATING_KEYS = new Set([..."0123456789*#"]);

/** True for a non-empty string that holds only whitespace — almost certainly
 *  a template artifact, not a deliberate value. Used to treat a
 *  whitespace-only finishOnKey the same as omitted (Twilio's own default),
 *  not as the deliberate "turn the stop-key feature off" value that an exact
 *  empty string is, the same way a blank numeric attribute falls back to its
 *  default rather than being read as a real zero (see isBlank). */
function isWhitespaceOnly(value: string): boolean {
  return value !== "" && value.trim() === "";
}

/**
 * Keeps only the characters Bandwidth recognizes as keys in a Gather's
 * finishOnKey — a set, like Twilio's: any of these ends the Gather. A
 * character outside 0-9/*\/# would never match a real key press, silently
 * disabling the feature the same way an entirely invalid value would, so
 * each invalid character is dropped — with a warning — rather than passed
 * through for Bandwidth to silently ignore. Twilio's default ("#") is exactly
 * matched by Bandwidth's explicit "#" (unlike Record's default, which only
 * partially matches — see recordTerminatingDigits), so the not-set case
 * doesn't need a warning.
 */
function gatherTerminatingDigits(finishOnKey: string | undefined, findings: Finding[]): string {
  if (finishOnKey === "") return ""; // both systems treat this as "disabled"
  if (finishOnKey === undefined || isWhitespaceOnly(finishOnKey)) return "#";
  const valid = [...finishOnKey].filter((c) => VALID_TERMINATING_KEYS.has(c)).join("");
  if (valid !== finishOnKey)
    warn(
      "Gather",
      `finishOnKey="${finishOnKey}" has a character Bandwidth doesn't recognize as a key (only 0-9, "*", and "#" work); using "${valid}" instead.`,
      findings,
    );
  return valid;
}

/**
 * Bandwidth's Record terminatingDigits takes a single character from
 * `VALID_TERMINATING_KEYS`, unlike Gather's set of acceptable characters and
 * Twilio's own default of "any key" (1234567890*#). Twilio's default and
 * Bandwidth's own default ("#") happen to agree on "#" stopping the
 * recording, so the not-set case is a partial match: only "#" stops it here,
 * not the other nine keys. An explicit multi-character finishOnKey is
 * narrowed the same way, preferring "#" then "*" then the first valid
 * character present, since Bandwidth cannot represent a set — but a value
 * made up of nothing but repeats of one single valid character (e.g. "##")
 * isn't actually narrowed to anything different, so that doesn't warn either.
 * A value with no valid character at all (e.g. "a") can't be narrowed to
 * anything; on Twilio that value would never match a real key either, so
 * nothing should stop the recording early — emitting Bandwidth's own default
 * ("#") instead would introduce a stop key the customer never asked for, so
 * this disables the feature ("") rather than falling back to it.
 */
function recordTerminatingDigits(finishOnKey: string | undefined, findings: Finding[]): string {
  if (finishOnKey === "") return ""; // both systems treat this as "disabled"
  if (finishOnKey === undefined || isWhitespaceOnly(finishOnKey)) {
    warn(
      "Record",
      `finishOnKey defaults to "1234567890*#" (any key stops the recording) on Twilio; Bandwidth's Record only supports one terminating digit, so only "#" will stop it here.`,
      findings,
    );
    return "#";
  }
  const valid = [...finishOnKey].filter((c) => VALID_TERMINATING_KEYS.has(c));
  if (valid.length === 0) {
    warn(
      "Record",
      `finishOnKey="${finishOnKey}" has no digit, "*", or "#" for Bandwidth's Record to use as a terminating key; no key will stop the recording early (the way none of "${finishOnKey}" would stop it on Twilio either).`,
      findings,
    );
    return "";
  }
  // A value made entirely of repeats of the one valid character (e.g. "##")
  // narrows to exactly that character with nothing lost, so it's an exact
  // match in every way that matters, not something worth warning about.
  if (new Set(valid).size === 1 && valid.length === finishOnKey.length) return valid[0]!;
  const chosen = valid.includes("#") ? "#" : valid.includes("*") ? "*" : valid[0]!;
  warn(
    "Record",
    `finishOnKey="${finishOnKey}" has more than one character; Bandwidth's Record only supports one terminating digit, so only "${chosen}" will stop it here.`,
    findings,
  );
  return chosen;
}

function translateRecord(
  node: TwimlNode,
  findings: Finding[],
  rewrite: RewriteUrl,
): XmlEl[] | null {
  // Twilio's maxLength defaults to 3600s; Bandwidth's own maxDuration default
  // is 60s, so the omitted case must be explicit to avoid recordings cut
  // short at a minute. Twilio's timeout (silence ends the recording) has no
  // BXML attribute at all today; silenceTimeout fills that gap. Twilio's
  // timeout="0" (disable) and Bandwidth's silenceTimeout="0" (no timeout)
  // agree, so no special-casing is needed for that value. A blank value
  // (empty or all whitespace) is treated the same as omitted: Twilio doesn't
  // accept a blank duration either.
  const maxLength = resolveNumeric("Record", "maxLength", orDefault(node.attrs.maxLength, "3600"), "3600", findings);
  const timeout = resolveNumeric("Record", "timeout", orDefault(node.attrs.timeout, "5"), "5", findings);
  const attrs: Record<string, string | undefined> = {
    maxDuration: clampToRange("Record", "maxLength", "maxDuration", maxLength, 1, 10800, findings),
    silenceTimeout: clampToRange("Record", "timeout", "silenceTimeout", timeout, 0, 10800, findings),
    terminatingDigits: recordTerminatingDigits(node.attrs.finishOnKey, findings),
    recordCompleteUrl: resolveActionUrl("Record", node.attrs.action, "record", rewrite, findings),
  };
  // Twilio's async "recording is ready" webhook (recordingStatusCallback) maps to
  // Bandwidth's recordingAvailableUrl. The translator receives the BW event, reshapes
  // it into Twilio recording-callback params, and forwards it to the customer.
  if (node.attrs.recordingStatusCallback)
    attrs.recordingAvailableUrl = rewrite(node.attrs.recordingStatusCallback, "recordingStatus");
  if (
    node.attrs.recordingStatusCallbackMethod &&
    node.attrs.recordingStatusCallbackMethod.toUpperCase() === "GET"
  )
    warn(
      "Record",
      "recordingStatusCallbackMethod=GET is not honored; the translator forwards recording events via POST.",
      findings,
    );
  if (node.attrs.transcribe === "true")
    warn(
      "Record",
      "Transcription engines and callback payloads differ between Twilio and Bandwidth.",
      findings,
    );
  // Twilio's playBeep defaults to true; warn unless it's explicitly disabled,
  // since that's the only value where Bandwidth's "never beeps" matches.
  if (node.attrs.playBeep !== "false")
    warn(
      "Record",
      "playBeep defaults to true (plays a beep) on Twilio; Bandwidth has no equivalent, so no beep will play before recording.",
      findings,
    );
  // Twilio's trim defaults to "trim-silence"; warn unless it's explicitly
  // "do-not-trim", the only value where Bandwidth's "never trims" matches.
  if (node.attrs.trim !== "do-not-trim")
    warn(
      "Record",
      "Twilio trims leading/trailing silence by default (trim-silence); Bandwidth never trims recordings, so no equivalent exists.",
      findings,
    );
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
  rewrite: RewriteUrl,
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
      return unsupported(child, findings, `Dial noun <${child.name}> is not supported by the translator.`);
  }
  if (targets.length === 0 && node.text) targets.push({ name: "PhoneNumber", children: [node.text] });
  if (targets.length === 0) return unsupported(node, findings, "Dial with no target.");

  warn(
    "Dial",
    "Dial action receives DialCallStatus/DialBridged mapped from Bandwidth's transfer result; " +
      "DialCallSid and DialCallDuration come from the dialed leg's disconnect event and are omitted " +
      "if it has not arrived when the action fires. As on Twilio, a caller hangup during the " +
      "transfer ends the session without requesting the action.",
    findings,
  );
  // Twilio Dial attributes the translator cannot map to BXML Transfer. Surfacing
  // each one explicitly (rather than dropping it silently) is the product's
  // no-silent-degradation contract — the customer learns exactly what won't carry over.
  for (const [attr, message] of Object.entries(UNSUPPORTED_DIAL_ATTRS)) {
    if (node.attrs[attr] !== undefined) warn("Dial", message, findings);
  }
  const attrs: Record<string, string | undefined> = {
    transferCallerId: node.attrs.callerId,
    callTimeout: node.attrs.timeout,
  };
  if (node.attrs.action) {
    const dialIndex = ++dialSeq;
    attrs.transferCompleteUrl = rewrite(node.attrs.action, "transfer", {
      dialIndex,
      dialTargets: targets.length,
    });
    // Bandwidth's transferComplete names only the original call. The dialed
    // leg's id, answer time, and end time arrive on its own transferDisconnect
    // event, which the server joins to the action callback for DialCallSid,
    // DialCallDuration, and DialBridged.
    if (currentTransferLegUrl) {
      const legUrl = currentTransferLegUrl(dialIndex);
      for (const t of targets) t.attrs = { ...t.attrs, transferDisconnectUrl: legUrl };
    }
  }

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

// Bandwidth's documented limits on <StreamParam/> under <StartStream>: at most
// 12 elements, name up to 256 chars, value up to 2048 chars. Exceeding any of
// them makes Bandwidth reject the whole BXML document, not just the one param,
// so offending <Parameter>s are dropped with a warning instead. Twilio's only
// limit is 500 chars for name+value combined, which does bound value well under
// 2048 but leaves name free to exceed 256 in perfectly valid TwiML.
const MAX_STREAM_PARAMS = 12;
const MAX_STREAM_PARAM_NAME = 256;
const MAX_STREAM_PARAM_VALUE = 2048;

/** Twilio <Stream><Parameter name value/> children → BW <StreamParam name value/>.
 *  Bandwidth copies these into the WebSocket "start" event as a `streamParams`
 *  map, which the stream bridge forwards to the bot as Twilio `customParameters`
 *  (see customParametersFromBwStart in streams/bridge.ts). Order is preserved. */
function streamParams(stream: TwimlNode, findings: Finding[]): XmlEl[] {
  const out: XmlEl[] = [];
  const seen = new Set<string>();
  let beyondCap = 0;
  // Names can be arbitrarily long in TwiML; never echo more than this into a finding.
  const brief = (s: string | undefined) => (s === undefined ? "" : s.length > 32 ? s.slice(0, 32) + "…" : s);
  for (const child of stream.children) {
    if (child.name !== "Parameter") {
      warn("Stream", `Stream child <${child.name}> has no Bandwidth equivalent and was dropped.`, findings);
      continue;
    }
    // Cap first, so every <Parameter> past the 12 accepted ones is tallied here
    // regardless of whatever else might be wrong with it.
    if (out.length >= MAX_STREAM_PARAMS) {
      beyondCap++;
      continue;
    }
    const { name, value } = child.attrs;
    if (name === undefined || value === undefined) {
      warn(
        "Stream",
        `Stream <Parameter> requires both name and value; dropped <Parameter name="${brief(name)}">.`,
        findings,
      );
      continue;
    }
    if (name.length > MAX_STREAM_PARAM_NAME) {
      warn(
        "Stream",
        `StreamParam name exceeds Bandwidth's ${MAX_STREAM_PARAM_NAME}-character limit ` +
          `(${name.length}); dropped <Parameter name="${brief(name)}">.`,
        findings,
      );
      continue;
    }
    if (value.length > MAX_STREAM_PARAM_VALUE) {
      warn(
        "Stream",
        `StreamParam value exceeds Bandwidth's ${MAX_STREAM_PARAM_VALUE}-character limit ` +
          `(${value.length}); dropped <Parameter name="${name}">.`,
        findings,
      );
      continue;
    }
    // Bandwidth delivers streamParams as a flat map (as does Twilio's
    // customParameters), so a repeated name can carry only one value and which
    // one wins is undocumented. Keep the first, drop the rest, and say so.
    if (seen.has(name)) {
      warn(
        "Stream",
        `Duplicate Stream <Parameter name="${name}">: streamParams is a flat map, so only the ` +
          "first value was kept.",
        findings,
      );
      continue;
    }
    seen.add(name);
    out.push({ name: "StreamParam", attrs: { name, value } });
  }
  if (beyondCap > 0)
    warn(
      "Stream",
      `Bandwidth allows at most ${MAX_STREAM_PARAMS} StreamParam per StartStream; ` +
        `${beyondCap} Stream <Parameter> element(s) beyond that were dropped.`,
      findings,
    );
  return out;
}

/** Twilio <Stream> noun → BW <StartStream>. mode is bidirectional under
 *  <Connect> (audio flows both ways) and unidirectional under <Start> (a fork).
 *  <Parameter> children become nested <StreamParam/> elements. */
function streamToStartStream(
  stream: TwimlNode,
  mode: "bidirectional" | "unidirectional",
  findings: Finding[],
  rewrite: RewriteUrl,
): XmlEl[] | null {
  if (!stream.attrs.url) return unsupported(stream, findings, "Stream requires a url attribute.");
  warn("Stream", matrix.verbs.Stream.notes, findings);
  const attrs: Record<string, string | undefined> = {
    name: stream.attrs.name,
    destination: rewrite(stream.attrs.url, "stream"),
    mode,
    tracks: stream.attrs.track ? TWILIO_STREAM_TRACK_TO_BW[stream.attrs.track] ?? "inbound" : "inbound",
  };
  // An empty children array still serializes as a self-closing <StartStream/>.
  return [{ name: "StartStream", attrs, children: streamParams(stream, findings) }];
}

// Per-document counter for generated Connect/Stream names. Twilio's <Stream name>
// is optional, but Bandwidth's <StopStream> needs a name that matches the
// <StartStream> it stops. Reset at the start of each translateTwiml call
// (same module-state caveat as bxmlByteBudget).
let connectStreamSeq = 0;

/** Twilio <Connect><Stream> → BW <StartStream mode="bidirectional"/> followed by
 *  <StopStream wait="true"/>.
 *
 *  Bandwidth ends the call as soon as BXML execution runs out of verbs, so a bare
 *  <StartStream> hangs up on answer (verified on real calls, VAPI-3985). The
 *  StartStream docs' recommended fix for bidirectional streams is a StopStream
 *  with wait="true" right after it: BXML execution blocks there until the bot
 *  closes the WebSocket. That also reproduces Twilio's <Connect> semantics, where
 *  any verbs after <Connect> run only once the stream has ended. */
function translateConnect(
  node: TwimlNode,
  findings: Finding[],
  rewrite: RewriteUrl,
): XmlEl[] | null {
  const stream = node.children.find((c) => c.name === "Stream");
  if (!stream)
    return unsupported(
      node,
      findings,
      `Connect noun <${node.children[0]?.name ?? "?"}> is not supported (ConversationRelay/VirtualAgent are out of translator scope).`,
    );

  const name = stream.attrs.name ?? `connect-stream-${++connectStreamSeq}`;
  const named: TwimlNode = { ...stream, attrs: { ...stream.attrs, name } };
  const els = streamToStartStream(named, "bidirectional", findings, rewrite);
  if (!els) return null;

  warn(
    "Connect",
    'Inserted <StopStream wait="true"> after StartStream. Bandwidth ends the call when BXML runs out ' +
      "of verbs, so a bare StartStream hangs up on answer. With it, the call stays up until the bot " +
      "closes the WebSocket, and any verbs after <Connect> run after the stream ends, matching " +
      "Twilio's blocking semantics.",
    findings,
  );
  return [...els, { name: "StopStream", attrs: { name, wait: "true" } }];
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
    `Stop noun <${node.children[0]?.name ?? "?"}> is not supported by the translator.`,
  );
}

// Twilio <Refer><Sip> → BW <Refer><SipUri>. SIP REFER only; Bandwidth supports
// this solely on inbound SIP URI calls (a PSTN leg cannot be REFER'd).
function translateRefer(
  node: TwimlNode,
  findings: Finding[],
  rewrite: RewriteUrl,
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
  rewrite: RewriteUrl,
): XmlEl[] | null {
  // <Start><Stream> is a unidirectional fork (audio out to the bot only).
  const startStream = node.children.find((c) => c.name === "Stream");
  if (startStream) return streamToStartStream(startStream, "unidirectional", findings, rewrite);

  const tx = node.children.find((c) => c.name === "Transcription");
  if (!tx)
    return unsupported(
      node,
      findings,
      `Start noun <${node.children[0]?.name ?? "?"}> is not supported by the translator.`,
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
