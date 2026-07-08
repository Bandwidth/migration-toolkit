# Migration Preflight playground

A single, self-contained HTML file a sales engineer can **double-click** and present to a prospect. Paste a customer's TwiML (or pick a curated example) and it shows — live — how much of that Twilio voice app runs on Bandwidth unchanged: a works-as-is / heads-up / blocker verdict, a migration-complexity score, the translated BXML, and a forwardable report.

No server, no install, no network. It works offline on a plane.

## Why it's trustworthy

The page runs the **real translation engine** (`src/translator`, `src/preflight`) and the real compatibility matrix (`src/matrix/twilio-voice.json`) in the browser — the exact same code the live adapter uses. It does not reimplement any translation or scoring logic. Because the same matrix drives the adapter and this page, the verdict shown here provably matches what happens in production. That invariant is the point; don't break it by hand-coding results into the UI.

## Build & run

```bash
npm run playground:build      # writes dist/playground.html
open dist/playground.html     # macOS — or just double-click the file
```

`dist/` is git-ignored (it's a build product); rebuild it whenever the engine, matrix, or UI changes.

## Layout

| File | Purpose |
|---|---|
| `view-model.ts` | The only new logic: `buildView(twiml)` calls the engine and shapes the result. Pure, DOM-free, unit-tested (`test/playground-view.test.ts`). |
| `app.ts` | DOM rendering + interactions (chips, BXML toggle, print, copy). Calls `buildView`. |
| `index.html` | Static shell (header, input, caveats, actions) with injection markers for the build. |
| `styles.css` | All styling. Brand tokens live in `:root` — swap them there to re-theme. |
| `examples.ts` | Curated TwiML examples. Verdicts are computed live, never hardcoded. |
| `fonts/` | DM Sans (Bandwidth brand face), woff2. Inlined as base64 at build time. |

The build (`scripts/build-playground.ts`, esbuild) bundles `app.ts` + the engine, inlines the CSS and fonts into `index.html`, and asserts the output has no external resource references before writing it.

## Design

The visual design comes from a Bandwidth design-system mockup (DM Sans, primary `#076ea8`). To re-theme, edit the `:root` custom properties in `styles.css` in one place.

## Scope

Intentionally narrow: one screen, TwiML-document input only. It does **not** scan source code (that's the CLI `npm run preflight`), place live calls, or talk to Bandwidth. Those need a server and are out of scope for this demo tool.
