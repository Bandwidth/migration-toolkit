// DOM wiring for the Migration Preflight page. Keeps no logic of its own beyond
// presentation — it calls buildView() (which runs the real engine) and paints
// the result. See view-model.ts for the honesty invariant.

import { buildView, type PreflightView, type VerbCard } from "./view-model.js";
import { EXAMPLES, DEFAULT_EXAMPLE } from "./examples.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// The engine emits compact single-line BXML; indent it for readable display.
// Leaf elements with text (<SpeakSentence>hi</SpeakSentence>) stay on one line;
// self-closing tags don't nest. Operates on raw XML — esc() is applied after.
function formatXml(xml: string): string {
  const withBreaks = xml.replace(/>\s*</g, ">\n<");
  let pad = 0;
  return withBreaks
    .split("\n")
    .map((node) => {
      let indent = 0;
      if (/^<\/\w/.test(node)) {
        pad = Math.max(0, pad - 1); // closing tag: dedent before printing
      } else if (/^<\w[^>]*[^/]>.*$/.test(node) && !/.+<\/\w[^>]*>\s*$/.test(node)) {
        indent = 1; // opening tag with no matching close on this line: indent after
      }
      const line = "  ".repeat(pad) + node;
      pad += indent;
      return line;
    })
    .join("\n");
}

// ---- SVG icons (inline so the artifact stays self-contained) ----
const ICON = {
  clean: `<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="var(--color-clean)"/><path d="M7 12.5l3.2 3.2L17 8.8" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  warn: `<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 22 20.5 2 20.5Z" fill="var(--color-warn)" stroke="var(--color-warn)" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4.2" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17.6" r="1.15" fill="#fff"/></svg>`,
  block: `<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.2 3h7.6L21 8.2v7.6L15.8 21H8.2L3 15.8V8.2Z" fill="var(--color-block)" stroke="var(--color-block)" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 7.4v5.3" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="16.4" r="1.15" fill="#fff"/></svg>`,
  docs: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7"/><path d="M8 7h9v9"/></svg>`,
};
const smallIcon = (name: keyof typeof ICON) =>
  ICON[name].replace('width="20" height="20"', 'width="15" height="15"');

// ---- Verdict ----
function gaugeColor(score: number): string {
  if (score <= 3) return "var(--color-clean)";
  if (score <= 6) return "var(--color-warn)";
  return "var(--color-block)";
}

function renderVerdict(v: PreflightView): string {
  const C = 2 * Math.PI * 72; // gauge circumference
  const offset = C * (1 - v.score / 10);
  const color = gaugeColor(v.score);
  const labelColor =
    v.score <= 3 ? "var(--color-clean-text)" : v.score <= 6 ? "var(--color-warn-text)" : "var(--color-block-text)";

  return `
    <section class="verdict-panel avoid-break card-shadow">
      <div class="pf-gauge-wrap">
        <div class="pf-gauge">
          <svg width="168" height="168" viewBox="0 0 168 168">
            <circle cx="84" cy="84" r="72" fill="none" stroke="#ecebec" stroke-width="14"/>
            <circle cx="84" cy="84" r="72" fill="none" stroke="${color}" stroke-width="14"
              stroke-linecap="round" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"/>
          </svg>
          <div class="pf-gauge-center">
            <div class="pf-gauge-score"><span class="n">${v.score}</span><span class="d">/10</span></div>
            <div class="pf-gauge-label" style="color:${labelColor}">${esc(v.scoreLabel)}</div>
          </div>
        </div>
        <div class="pf-gauge-caption">Migration complexity score</div>
      </div>
      <div class="pf-verdict-body">
        <h2 class="pf-verdict-headline">${esc(v.headline)}</h2>
        <p class="pf-verdict-sub">${verdictSub(v)}</p>
        <div class="pf-tiles">
          ${tile("clean", v.counts.clean, "Clean")}
          ${tile("warn", v.counts.headsUp, "Heads-up")}
          ${tile("block", v.counts.blocker, "Blocker")}
        </div>
      </div>
    </section>`;
}

function verdictSub(v: PreflightView): string {
  const total = v.counts.clean + v.counts.headsUp + v.counts.blocker;
  const parts = [`${v.counts.clean} of ${total} verbs translate cleanly`];
  if (v.counts.headsUp) parts.push(`${v.counts.headsUp} need${v.counts.headsUp === 1 ? "s" : ""} a quick review`);
  if (v.counts.blocker)
    parts.push(`${v.counts.blocker} ha${v.counts.blocker === 1 ? "s" : "ve"} no direct equivalent`);
  return esc(parts.join("; ") + ".");
}

function tile(kind: "clean" | "warn" | "block", n: number, label: string): string {
  const icon = kind === "clean" ? ICON.clean : kind === "warn" ? ICON.warn : ICON.block;
  return `
    <div class="pf-tile pf-tile--${kind}">
      <div class="pf-tile-top">${icon}<span class="pf-tile-n">${n}</span></div>
      <div class="pf-tile-label">${label}</div>
    </div>`;
}

// ---- Findings ----
function renderFindings(v: PreflightView): string {
  const groups: Array<[string, "block" | "warn" | "clean", VerbCard[]]> = [
    ["Blockers", "block", v.blockers],
    ["Heads-up", "warn", v.headsUp],
    ["Clean", "clean", v.clean],
  ];
  const textColor = { block: "var(--color-block-text)", warn: "var(--color-warn-text)", clean: "var(--color-clean-text)" };
  const iconName = { block: "block", warn: "warn", clean: "clean" } as const;

  const sections = groups
    .filter(([, , cards]) => cards.length > 0)
    .map(
      ([label, kind, cards]) => `
      <div class="pf-group-head">
        ${smallIcon(iconName[kind])}
        <span class="pf-group-label" style="color:${textColor[kind]}">${label}</span>
        <span class="pf-group-rule"></span>
      </div>
      <div class="pf-stack">${cards.map((c) => card(c, kind)).join("")}</div>`,
    )
    .join("");

  return `
    <section class="pf-findings">
      <h3 class="pf-findings-title">Findings</h3>
      <p class="pf-findings-sub">Every verb we saw, and what happens to it on Bandwidth.</p>
      ${sections}
    </section>`;
}

function card(c: VerbCard, kind: "block" | "warn" | "clean"): string {
  const verbLabel = c.target ? `&lt;${esc(c.verb)}&gt; &rarr; &lt;${esc(c.target)}&gt;` : `&lt;${esc(c.verb)}&gt;`;
  const messages = c.messages.map((m) => `<p class="pf-card-msg">${esc(m)}</p>`).join("");
  const docs = c.docsUrl
    ? `<a href="${esc(c.docsUrl)}" target="_blank" rel="noopener" class="pf-docs np">Docs ${ICON.docs}</a>`
    : "";
  return `
    <div class="pf-card pf-card--${kind} avoid-break">
      <div class="pf-card-main">
        <div class="pf-card-head">
          <code class="pf-verb">${verbLabel}</code>
          <span class="pf-pill pf-pill--${kind}">${esc(c.pill)}</span>
        </div>
        ${messages}
      </div>
      ${docs}
    </div>`;
}

// ---- BXML disclosure ----
function renderBxml(v: PreflightView): string {
  return `
    <section class="pf-section">
      <button class="pf-disclosure" id="pf-bxml-toggle" aria-expanded="false">
        <span class="pf-caret">&#9656;</span>
        Show translated BXML
        <span class="pf-disclosure-note np">for the engineer in the room</span>
      </button>
      <div class="pf-bxml-body" id="pf-bxml-body" style="display:none">
        <pre class="pf-bxml">${esc(formatXml(v.bxml))}</pre>
      </div>
    </section>`;
}

// ---- Orchestration ----
let current: PreflightView | null = null;

function render(twiml: string): void {
  const v = buildView(twiml);
  current = v;
  const verdict = $("pf-verdict");
  const findings = $("pf-findings");
  const bxml = $("pf-bxml");
  const error = $("pf-error");

  if (!v.ok) {
    verdict.innerHTML = "";
    findings.innerHTML = "";
    bxml.innerHTML = "";
    error.innerHTML = `<div class="pf-error np">${esc(v.error ?? "Something went wrong.")}</div>`;
    return;
  }

  error.innerHTML = "";
  verdict.innerHTML = renderVerdict(v);
  findings.innerHTML = renderFindings(v);
  bxml.innerHTML = renderBxml(v);

  const toggle = $("pf-bxml-toggle");
  const body = $("pf-bxml-body");
  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!open));
    body.style.display = open ? "none" : "block";
  });
}

function renderChips(active: string): void {
  const chips = $("pf-chips");
  chips.innerHTML = EXAMPLES.map(
    (e) => `<button class="pf-chip${e.id === active ? " is-active" : ""}" data-id="${e.id}">${esc(e.label)}</button>`,
  ).join("");
  for (const btn of Array.from(chips.querySelectorAll<HTMLButtonElement>(".pf-chip"))) {
    btn.addEventListener("click", () => {
      const ex = EXAMPLES.find((e) => e.id === btn.dataset.id)!;
      ($("twiml-input") as HTMLTextAreaElement).value = ex.twiml;
      renderChips(ex.id);
      render(ex.twiml);
    });
  }
}

function init(): void {
  const ta = $("twiml-input") as HTMLTextAreaElement;
  ta.value = DEFAULT_EXAMPLE.twiml;
  renderChips(DEFAULT_EXAMPLE.id);
  render(DEFAULT_EXAMPLE.twiml);

  // Re-analyze as the SE edits or pastes; clear the active chip.
  ta.addEventListener("input", () => {
    renderChips("");
    render(ta.value);
  });

  $("pf-print").addEventListener("click", () => window.print());

  const copyBtn = $("pf-copy");
  const copyLabel = $("pf-copy-label");
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  copyBtn.addEventListener("click", async () => {
    const text = current?.ok ? current.reportMarkdown : "";
    try {
      await navigator.clipboard.writeText(text);
      copyLabel.textContent = "Copied";
    } catch {
      copyLabel.textContent = "Press Ctrl/Cmd-C";
    }
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => (copyLabel.textContent = "Copy report"), 2000);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
