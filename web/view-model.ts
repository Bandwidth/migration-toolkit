// Pure view model for the Migration Compatibility Check page.
//
// This is the ONLY new logic in the web tool, and it is deliberately thin: it
// calls the real engine (analyzeSource / complexityScore / translateTwiml) and
// the real compatibility matrix, then shapes the result for rendering. It does
// NOT reimplement any translation, scoring, or compatibility rules — that is the
// honesty invariant: because the same matrix drives the live adapter and this
// page, the verdict shown here provably matches what the adapter does in
// production. Keep this file DOM-free so it stays unit-testable.

import { analyzeSource } from "../src/compatibility-check/analyze.js";
import { complexityScore, renderReport } from "../src/compatibility-check/report.js";
import { translateTwiml } from "../src/translator/translate.js";
import { loadMatrix } from "../src/matrix/load.js";

const matrix = loadMatrix();

export type Bucket = "clean" | "headsUp" | "blocker";

export interface VerbCard {
  /** Twilio verb name, e.g. "Say" (rendered as <Say>). */
  verb: string;
  /** Bandwidth BXML target from the matrix, e.g. "SpeakSentence"; null when unsupported. */
  target: string | null;
  bucket: Bucket;
  /** Short status label: "Maps 1:1" | "Review needed" | "No equivalent". */
  pill: string;
  /** For heads-up/blocker: the engine's finding messages. For clean: one matrix-sourced note. */
  messages: string[];
  docsUrl?: string;
}

export interface PreflightView {
  ok: boolean;
  /** Present when the input could not be analyzed. */
  error?: string;
  score: number;
  scoreLabel: string;
  headline: string;
  counts: { clean: number; headsUp: number; blocker: number };
  blockers: VerbCard[];
  headsUp: VerbCard[];
  clean: VerbCard[];
  bxml: string;
  /** The same markdown migration report the CLI Compatibility Check produces (for "Copy report"). */
  reportMarkdown: string;
}

// A verb is a confident 1:1 mapping only when the matrix marks it "supported"
// and it has a single BXML target. Context-dependent verbs (Dial, Connect,
// Conference, …) are "partial": they translate, but the exact target depends on
// their children/attributes, so we don't claim "Maps 1:1" or show a → arrow.
function isOneToOne(verb: string): boolean {
  const e = matrix.verbs[verb];
  return !!e && e.status === "supported" && !!e.bxml && !e.bxml.includes("/");
}

function scoreLabel(score: number): string {
  if (score <= 3) return "Low effort";
  if (score <= 6) return "Moderate effort";
  if (score <= 8) return "Significant effort";
  return "Heavy lift";
}

function headlineFor(counts: { clean: number; headsUp: number; blocker: number }): string {
  const total = counts.clean + counts.headsUp + counts.blocker;
  if (total === 0) return "No Twilio voice verbs detected.";
  if (counts.blocker === 0 && counts.headsUp === 0) return "Everything in this flow moves cleanly.";
  if (counts.blocker === 0) return "Most of this flow moves cleanly.";
  if (counts.clean >= counts.blocker) return "Most of this flow moves — a few parts need a plan.";
  return "Several parts of this flow need a migration plan.";
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** Analyze one TwiML document and shape it for the page. Never throws. */
export function buildView(twiml: string): PreflightView {
  const empty: PreflightView = {
    ok: false,
    score: 1,
    scoreLabel: scoreLabel(1),
    headline: "",
    counts: { clean: 0, headsUp: 0, blocker: 0 },
    blockers: [],
    headsUp: [],
    clean: [],
    bxml: "",
    reportMarkdown: "",
  };

  if (!twiml.trim()) {
    return { ...empty, error: "Paste some TwiML, or pick an example above." };
  }
  if (!/<Response[\s>]/.test(twiml)) {
    return {
      ...empty,
      error: "That doesn't look like TwiML — it should be wrapped in <Response>…</Response>.",
    };
  }

  let analysis;
  let bxml = "";
  try {
    analysis = analyzeSource("pasted.twiml", twiml);
    bxml = translateTwiml(twiml).bxml;
  } catch {
    return { ...empty, error: "Couldn't parse that TwiML. Check for malformed XML and try again." };
  }

  const { verbs, findings } = analysis;
  const score = complexityScore([analysis]);

  // One card per verb, driven by the engine's findings. A verb with any error is
  // a blocker; any warning (and no error) is a heads-up; otherwise it's clean.
  // Union of detected verbs and finding-verbs so nothing the engine flags is dropped.
  const verbOrder = uniq([...verbs, ...findings.map((f) => f.verb)]);
  const blockers: VerbCard[] = [];
  const headsUp: VerbCard[] = [];
  const clean: VerbCard[] = [];

  for (const verb of verbOrder) {
    const own = findings.filter((f) => f.verb === verb);
    const entry = matrix.verbs[verb];
    const bucket: Bucket = own.some((f) => f.severity === "error")
      ? "blocker"
      : own.some((f) => f.severity === "warning" || f.severity === "info")
        ? "headsUp"
        : "clean";

    const oneToOne = isOneToOne(verb);
    const messages =
      bucket === "clean"
        ? [entry?.notes?.trim() || `Translates to <${entry?.bxml}> on Bandwidth.`]
        : uniq(own.map((f) => f.message));

    const pill =
      bucket === "blocker"
        ? "No equivalent"
        : bucket === "headsUp"
          ? "Review needed"
          : oneToOne
            ? "Maps 1:1"
            : "Translates";

    const card: VerbCard = {
      verb,
      target: oneToOne ? entry!.bxml : null,
      bucket,
      pill,
      messages,
      docsUrl: own.find((f) => f.docsUrl)?.docsUrl ?? entry?.docsUrl,
    };

    (bucket === "blocker" ? blockers : bucket === "headsUp" ? headsUp : clean).push(card);
  }

  const counts = { clean: clean.length, headsUp: headsUp.length, blocker: blockers.length };

  return {
    ok: true,
    score,
    scoreLabel: scoreLabel(score),
    headline: headlineFor(counts),
    counts,
    blockers,
    headsUp,
    clean,
    bxml,
    reportMarkdown: renderReport([analysis]),
  };
}
