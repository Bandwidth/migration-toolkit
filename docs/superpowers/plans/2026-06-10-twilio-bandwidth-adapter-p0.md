# Twilio→Bandwidth Voice API Adapter P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A runtime protocol adapter that lets an unmodified Twilio voice application run on Bandwidth infrastructure (change one base URL), plus a pre-flight compatibility report tool — both driven by a single declarative compatibility matrix.

**Architecture:** A declarative compatibility matrix (JSON + zod) is the single source of truth for every TwiML→BXML mapping and its support status. Two consumers: (1) a Fastify proxy that receives Bandwidth voice webhooks, calls the customer's webhook with Twilio-shaped signed form-encoded params, parses the TwiML reply, and responds with translated BXML — plus a Twilio-shaped REST facade (`/2010-04-01/Accounts/:sid/Calls.json`) for outbound calls and a Media Streams WebSocket bridge speaking Twilio's wire schema; (2) a static-analysis pre-flight CLI that scans a repo and emits a migration report generated from the same matrix. Unsupported features fail loudly (spoken error + hangup at runtime, error cards in the report) — never silent degradation.

**Tech Stack:** TypeScript (Node 20+, ESM), Fastify + @fastify/formbody, fast-xml-parser, zod, ws, vitest. Sample customer app: Express + official `twilio` npm package (unmodified — that's the point).

---

## File Structure

```
bw-voice-adapter/
├── package.json / tsconfig.json / vitest.config.ts
├── src/
│   ├── matrix/
│   │   ├── twilio-voice.json      # THE compatibility matrix (data, not code)
│   │   └── load.ts                # zod schema + loader
│   ├── xml/
│   │   ├── parse-twiml.ts         # TwiML XML → TwimlNode AST
│   │   └── build-xml.ts           # XmlEl → XML string (BXML serializer)
│   ├── translator/
│   │   └── translate.ts           # TwiML AST → BXML + Findings (matrix-driven)
│   ├── twilio/
│   │   ├── signature.ts           # X-Twilio-Signature (HMAC-SHA1)
│   │   ├── call-sid.ts            # bwCallId ↔ CallSid mapping
│   │   └── egress.ts              # Twilio-shaped param builders + signed webhook POST
│   ├── bw/
│   │   └── client.ts              # minimal Bandwidth Voice API client (createCall)
│   ├── server/
│   │   ├── call-store.ts          # in-memory call state (P0)
│   │   ├── app.ts                 # Fastify app: /bw/* webhooks + REST facade
│   │   └── index.ts               # env config + listen
│   ├── streams/
│   │   └── bridge.ts              # Twilio Media Streams wire-schema bridge
│   └── preflight/
│       ├── analyze.ts             # scan files → verbs found → matrix findings
│       ├── report.ts              # findings → markdown report + complexity score
│       └── cli.ts                 # entrypoint
├── test/                          # vitest specs mirroring src/
└── examples/sample-twilio-app/    # unmodified-twilio-SDK demo app
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`

- [ ] **Step 1: Write config files**

`package.json`:
```json
{
  "name": "bw-voice-adapter",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "start": "tsx src/server/index.ts",
    "preflight": "tsx src/preflight/cli.ts"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
```

`.gitignore`:
```
node_modules/
dist/
.env
```

- [ ] **Step 2: Install dependencies**

Run: `npm install fastify @fastify/formbody fast-xml-parser zod ws && npm install -D typescript tsx vitest @types/node @types/ws`
Expected: clean install, lockfile created.

- [ ] **Step 3: Verify toolchain**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc OK; vitest reports "no test files found" (exit code may be 1 — that's fine at this stage).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: scaffold TypeScript project with vitest"
```

---

### Task 2: Compatibility matrix + loader

**Files:**
- Create: `src/matrix/twilio-voice.json`, `src/matrix/load.ts`
- Test: `test/matrix.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { loadMatrix } from "../src/matrix/load.js";

describe("compatibility matrix", () => {
  it("loads and validates", () => {
    const m = loadMatrix();
    expect(m.provider).toBe("twilio");
    expect(m.verbs.Say.bxml).toBe("SpeakSentence");
    expect(m.verbs.Say.status).toBe("supported");
  });
  it("marks Enqueue unsupported with notes", () => {
    const m = loadMatrix();
    expect(m.verbs.Enqueue.status).toBe("unsupported");
    expect(m.verbs.Enqueue.notes.length).toBeGreaterThan(0);
  });
  it("every verb entry has notes when not fully supported", () => {
    const m = loadMatrix();
    for (const [name, v] of Object.entries(m.verbs)) {
      if (v.status !== "supported") expect(v.notes, name).not.toBe("");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run test/matrix.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write the matrix data**

`src/matrix/twilio-voice.json` (the load-bearing artifact — statuses per PRD gap analysis + dev.bandwidth.com BXML verb list):
```json
{
  "provider": "twilio",
  "target": "bandwidth",
  "verbs": {
    "Say":      { "bxml": "SpeakSentence", "status": "supported", "notes": "Voice names and SSML dialects differ; adapter passes voice through with a warning.", "docsUrl": "https://dev.bandwidth.com/docs/voice/bxml/speakSentence", "attributes": { "voice": { "bxml": "voice", "status": "partial", "notes": "No 1:1 voice-name mapping." }, "language": { "bxml": "locale", "status": "partial", "notes": "Locale formats differ." }, "loop": { "bxml": null, "status": "partial", "notes": "Emitted once; BXML has no loop attribute." } } },
    "Play":     { "bxml": "PlayAudio", "status": "supported", "notes": "", "docsUrl": "https://dev.bandwidth.com/docs/voice/bxml/playAudio", "attributes": { "loop": { "bxml": null, "status": "partial", "notes": "Emitted once; BXML has no loop attribute." } } },
    "Gather":   { "bxml": "Gather", "status": "supported", "notes": "DTMF only in P0; speech input is not yet translated.", "docsUrl": "https://dev.bandwidth.com/docs/voice/bxml/gather", "attributes": { "action": { "bxml": "gatherUrl", "status": "supported" }, "numDigits": { "bxml": "maxDigits", "status": "supported" }, "timeout": { "bxml": "firstDigitTimeout", "status": "supported" }, "finishOnKey": { "bxml": "terminatingDigits", "status": "supported" }, "input": { "bxml": null, "status": "partial", "notes": "Only input=\"dtmf\" supported in P0; speech is unsupported." } } },
    "Pause":    { "bxml": "Pause", "status": "supported", "notes": "", "docsUrl": "https://dev.bandwidth.com/docs/voice/bxml/pause", "attributes": { "length": { "bxml": "duration", "status": "supported" } } },
    "Hangup":   { "bxml": "Hangup", "status": "supported", "notes": "", "docsUrl": "https://dev.bandwidth.com/docs/voice/bxml/hangup", "attributes": {} },
    "Redirect": { "bxml": "Redirect", "status": "supported", "notes": "URL moves from element text to redirectUrl attribute.", "docsUrl": "https://dev.bandwidth.com/docs/voice/bxml/redirect", "attributes": {} },
    "Reject":   { "bxml": "Hangup", "status": "partial", "notes": "Mapped to Hangup; Bandwidth answers before hanging up, so the caller may be billed for a short call.", "docsUrl": "https://dev.bandwidth.com/docs/voice/bxml/hangup", "attributes": {} },
    "Record":   { "bxml": "Record", "status": "supported", "notes": "Recording callback payloads differ; adapter normalizes.", "docsUrl": "https://dev.bandwidth.com/docs/voice/bxml/record", "attributes": { "action": { "bxml": "recordCompleteUrl", "status": "supported" }, "maxLength": { "bxml": "maxDuration", "status": "supported" }, "finishOnKey": { "bxml": "terminatingDigits", "status": "supported" }, "transcribe": { "bxml": "transcribe", "status": "partial", "notes": "Engine and callback shape differ." }, "playBeep": { "bxml": null, "status": "partial", "notes": "No direct equivalent; adapter can prepend a beep PlayAudio later." } } },
    "Dial":     { "bxml": "Transfer", "status": "partial", "notes": "Number/Sip nouns map to Transfer; Conference noun maps to Conference; Queue and Client nouns are unsupported. Deep Dial semantics (answerOnBridge, child-call status propagation) are not replicated in P0.", "docsUrl": "https://dev.bandwidth.com/docs/voice/bxml/transfer", "attributes": { "callerId": { "bxml": "transferCallerId", "status": "supported" }, "timeout": { "bxml": "callTimeout", "status": "supported" }, "action": { "bxml": "transferCompleteUrl", "status": "supported" } } },
    "Enqueue":  { "bxml": null, "status": "unsupported", "notes": "Bandwidth has no queue primitive (P0 gap per PRD). Contact-center queue flows cannot migrate yet.", "docsUrl": "https://dev.bandwidth.com/docs/voice/bxml/", "attributes": {} },
    "Leave":    { "bxml": null, "status": "unsupported", "notes": "No queue primitive.", "docsUrl": "https://dev.bandwidth.com/docs/voice/bxml/", "attributes": {} },
    "Pay":      { "bxml": null, "status": "unsupported", "notes": "PCI payment capture is out of scope (deferred per PRD).", "attributes": {} },
    "Refer":    { "bxml": null, "status": "unsupported", "notes": "SIP REFER not translated in P0.", "attributes": {} },
    "Connect":  { "bxml": "StartStream", "status": "partial", "notes": "Stream noun maps to StartStream via the Media Streams bridge; ConversationRelay and VirtualAgent are unsupported (separate IoV).", "docsUrl": "https://dev.bandwidth.com/docs/voice/bxml/startStream", "attributes": {} },
    "Stream":   { "bxml": "StartStream", "status": "partial", "notes": "Twilio WS message schema is emulated by the adapter's stream bridge; live Bandwidth-side binding requires fixture capture.", "docsUrl": "https://dev.bandwidth.com/docs/voice/bxml/startStream", "attributes": {} },
    "Conference": { "bxml": "Conference", "status": "partial", "notes": "Basic named conferences work. waitUrl hold music is NOT supported by Bandwidth; beep cues are partial.", "docsUrl": "https://dev.bandwidth.com/docs/voice/bxml/conference", "attributes": { "waitUrl": { "bxml": null, "status": "unsupported", "notes": "No conference hold-music equivalent (P1 gap per PRD)." }, "beep": { "bxml": null, "status": "partial", "notes": "No direct beep attribute." } } },
    "Number":   { "bxml": "PhoneNumber", "status": "supported", "notes": "", "docsUrl": "https://dev.bandwidth.com/docs/voice/bxml/transfer", "attributes": {} },
    "Sip":      { "bxml": "SipUri", "status": "supported", "notes": "", "docsUrl": "https://dev.bandwidth.com/docs/voice/bxml/transfer", "attributes": {} },
    "Queue":    { "bxml": null, "status": "unsupported", "notes": "No queue primitive.", "attributes": {} },
    "Client":   { "bxml": null, "status": "unsupported", "notes": "Twilio Client (WebRTC) endpoints have no adapter mapping in P0.", "attributes": {} }
  }
}
```

`src/matrix/load.ts`:
```ts
import { z } from "zod";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const Status = z.enum(["supported", "partial", "unsupported"]);

const AttrMapping = z.object({
  bxml: z.string().nullable(),
  status: Status,
  notes: z.string().optional().default(""),
});

const VerbMapping = z.object({
  bxml: z.string().nullable(),
  status: Status,
  notes: z.string().optional().default(""),
  docsUrl: z.string().optional(),
  attributes: z.record(z.string(), AttrMapping).default({}),
});

const Matrix = z.object({
  provider: z.literal("twilio"),
  target: z.literal("bandwidth"),
  verbs: z.record(z.string(), VerbMapping),
});

export type CompatStatus = z.infer<typeof Status>;
export type VerbMapping = z.infer<typeof VerbMapping>;
export type CompatMatrix = z.infer<typeof Matrix>;

export function loadMatrix(): CompatMatrix {
  return Matrix.parse(require("./twilio-voice.json"));
}
```

- [ ] **Step 4: Run test to verify it passes** — `npx vitest run test/matrix.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: compatibility matrix with zod-validated loader"`

---

### Task 3: XML utilities (TwiML parser + BXML serializer)

**Files:**
- Create: `src/xml/parse-twiml.ts`, `src/xml/build-xml.ts`
- Test: `test/xml.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { parseTwiml } from "../src/xml/parse-twiml.js";
import { serialize, bxmlDocument } from "../src/xml/build-xml.js";

describe("parseTwiml", () => {
  it("parses verbs in order with attrs, text, and children", () => {
    const node = parseTwiml(
      `<?xml version="1.0"?><Response><Say voice="alice">Hello</Say><Gather numDigits="1" action="/menu"><Play>https://x.test/a.mp3</Play></Gather></Response>`,
    );
    expect(node.name).toBe("Response");
    expect(node.children.map((c) => c.name)).toEqual(["Say", "Gather"]);
    expect(node.children[0].attrs.voice).toBe("alice");
    expect(node.children[0].text).toBe("Hello");
    expect(node.children[1].children[0].text).toBe("https://x.test/a.mp3");
  });
  it("throws on missing Response root", () => {
    expect(() => parseTwiml("<Nope/>")).toThrow(/Response/);
  });
});

describe("serialize", () => {
  it("builds escaped XML, self-closing when empty", () => {
    expect(serialize({ name: "Hangup" })).toBe("<Hangup/>");
    expect(
      serialize({ name: "SpeakSentence", attrs: { voice: "julie" }, children: ["a < b"] }),
    ).toBe(`<SpeakSentence voice="julie">a &lt; b</SpeakSentence>`);
  });
  it("wraps a BXML document", () => {
    expect(bxmlDocument([{ name: "Hangup" }])).toBe(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
    );
  });
});
```

- [ ] **Step 2: Run to verify FAIL** — `npx vitest run test/xml.test.ts`

- [ ] **Step 3: Implement**

`src/xml/parse-twiml.ts`:
```ts
import { XMLParser } from "fast-xml-parser";

export interface TwimlNode {
  name: string;
  attrs: Record<string, string>;
  text: string;
  children: TwimlNode[];
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: true,
});

export function parseTwiml(xml: string): TwimlNode {
  const nodes = normalize(parser.parse(xml));
  const response = nodes.find((n) => n.name === "Response");
  if (!response) throw new Error("TwiML document has no <Response> root");
  return response;
}

function normalize(raw: unknown[]): TwimlNode[] {
  const out: TwimlNode[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    const name = Object.keys(item).find((k) => k !== ":@");
    if (!name || name === "#text") continue;
    const body = item[name] as Record<string, unknown>[];
    const attrsRaw = (item[":@"] ?? {}) as Record<string, unknown>;
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(attrsRaw)) attrs[k] = String(v);
    const text = body
      .filter((c) => c["#text"] !== undefined)
      .map((c) => String(c["#text"]))
      .join("");
    out.push({ name, attrs, text, children: normalize(body) });
  }
  return out;
}
```

`src/xml/build-xml.ts`:
```ts
export interface XmlEl {
  name: string;
  attrs?: Record<string, string | undefined>;
  children?: (XmlEl | string)[];
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function serialize(el: XmlEl): string {
  const attrs = Object.entries(el.attrs ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${esc(String(v))}"`)
    .join("");
  const kids = (el.children ?? [])
    .map((c) => (typeof c === "string" ? esc(c) : serialize(c)))
    .join("");
  return kids ? `<${el.name}${attrs}>${kids}</${el.name}>` : `<${el.name}${attrs}/>`;
}

export function bxmlDocument(children: (XmlEl | string)[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>` + serialize({ name: "Response", children });
}
```

- [ ] **Step 4: Run to verify PASS** — `npx vitest run test/xml.test.ts`

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: TwiML parser and BXML serializer"`

---

### Task 4: Translator — core verbs (Say, Play, Pause, Hangup, Redirect, Reject)

**Files:**
- Create: `src/translator/translate.ts`
- Test: `test/translate-core.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { translateTwiml } from "../src/translator/translate.js";

describe("core verb translation", () => {
  it("Say → SpeakSentence with voice warning", () => {
    const r = translateTwiml(`<Response><Say voice="alice">Hi there</Say></Response>`);
    expect(r.bxml).toContain(`<SpeakSentence voice="alice">Hi there</SpeakSentence>`);
    expect(r.findings.some((f) => f.severity === "warning" && /voice/i.test(f.message))).toBe(true);
  });
  it("Play → PlayAudio", () => {
    const r = translateTwiml(`<Response><Play>https://x.test/a.mp3</Play></Response>`);
    expect(r.bxml).toContain(`<PlayAudio>https://x.test/a.mp3</PlayAudio>`);
  });
  it("Pause length → duration", () => {
    const r = translateTwiml(`<Response><Pause length="3"/></Response>`);
    expect(r.bxml).toContain(`<Pause duration="3"/>`);
  });
  it("Hangup passes through; Reject becomes Hangup with warning", () => {
    const r = translateTwiml(`<Response><Reject/></Response>`);
    expect(r.bxml).toContain(`<Hangup/>`);
    expect(r.findings.some((f) => f.verb === "Reject" && f.severity === "warning")).toBe(true);
  });
  it("Redirect text URL → redirectUrl attr, rewritten via option", () => {
    const r = translateTwiml(`<Response><Redirect>/next</Redirect></Response>`, {
      rewriteUrl: (url) => `https://adapter.test/bw/continue?next=${encodeURIComponent(url)}`,
    });
    expect(r.bxml).toContain(
      `<Redirect redirectUrl="https://adapter.test/bw/continue?next=%2Fnext"/>`,
    );
  });
  it("unknown verb yields error finding and no output element", () => {
    const r = translateTwiml(`<Response><Autopilot/></Response>`);
    expect(r.findings.some((f) => f.severity === "error")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify FAIL** — `npx vitest run test/translate-core.test.ts`

- [ ] **Step 3: Implement** — `src/translator/translate.ts`:

```ts
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
  return { bxml: bxmlDocument(els), findings, hasErrors: findings.some((f) => f.severity === "error") };
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
        warn("Say", `Twilio voice "${node.attrs.voice}" has no exact Bandwidth equivalent; verify the rendered voice.`, findings);
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

// Gather / Record / Dial / Connect are implemented in Tasks 5–6. Until then,
// declare stubs that report unsupported so the module compiles:
function translateGather(node: TwimlNode, findings: Finding[], rewrite: (u: string, k: UrlKind) => string): XmlEl[] | null {
  return unsupported(node, findings);
}
function translateRecord(node: TwimlNode, findings: Finding[], rewrite: (u: string, k: UrlKind) => string): XmlEl[] | null {
  return unsupported(node, findings);
}
function translateDial(node: TwimlNode, findings: Finding[], rewrite: (u: string, k: UrlKind) => string): XmlEl[] | null {
  return unsupported(node, findings);
}
function translateConnect(node: TwimlNode, findings: Finding[], rewrite: (u: string, k: UrlKind) => string): XmlEl[] | null {
  return unsupported(node, findings);
}
```

- [ ] **Step 4: Run to verify PASS** — `npx vitest run test/translate-core.test.ts`

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: translator core verbs (Say/Play/Pause/Hangup/Redirect/Reject)"`

---

### Task 5: Translator — Gather and Record

**Files:**
- Modify: `src/translator/translate.ts` (replace the `translateGather`/`translateRecord` stubs)
- Test: `test/translate-gather-record.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { translateTwiml } from "../src/translator/translate.js";

const rw = (url: string) => `https://adapter.test/bw/continue?next=${encodeURIComponent(url)}`;

describe("Gather", () => {
  it("maps attributes and nested prompts", () => {
    const r = translateTwiml(
      `<Response><Gather numDigits="1" timeout="7" finishOnKey="#" action="/menu"><Say>Press 1</Say></Gather></Response>`,
      { rewriteUrl: rw },
    );
    expect(r.bxml).toContain(`maxDigits="1"`);
    expect(r.bxml).toContain(`firstDigitTimeout="7"`);
    expect(r.bxml).toContain(`terminatingDigits="#"`);
    expect(r.bxml).toContain(`gatherUrl="https://adapter.test/bw/continue?next=%2Fmenu"`);
    expect(r.bxml).toContain(`<SpeakSentence>Press 1</SpeakSentence>`);
    expect(r.hasErrors).toBe(false);
  });
  it("rejects speech input as error", () => {
    const r = translateTwiml(`<Response><Gather input="speech" action="/a"/></Response>`);
    expect(r.hasErrors).toBe(true);
  });
  it("warns when action is missing (Twilio re-requests current URL)", () => {
    const r = translateTwiml(`<Response><Gather numDigits="1"/></Response>`);
    expect(r.findings.some((f) => f.severity === "warning" && /action/.test(f.message))).toBe(true);
  });
});

describe("Record", () => {
  it("maps attributes", () => {
    const r = translateTwiml(
      `<Response><Record maxLength="30" finishOnKey="#" action="/done"/></Response>`,
      { rewriteUrl: rw },
    );
    expect(r.bxml).toContain(`maxDuration="30"`);
    expect(r.bxml).toContain(`terminatingDigits="#"`);
    expect(r.bxml).toContain(`recordCompleteUrl="https://adapter.test/bw/continue?next=%2Fdone"`);
  });
});
```

- [ ] **Step 2: Run to verify FAIL** — `npx vitest run test/translate-gather-record.test.ts`

- [ ] **Step 3: Implement** — replace stubs in `src/translator/translate.ts`:

```ts
function translateGather(
  node: TwimlNode,
  findings: Finding[],
  rewrite: (u: string, k: UrlKind) => string,
): XmlEl[] | null {
  if (node.attrs.input && node.attrs.input !== "dtmf")
    return unsupported(node, findings, `Gather input="${node.attrs.input}" is not supported in P0 (DTMF only).`);
  const attrs: Record<string, string | undefined> = {
    maxDigits: node.attrs.numDigits,
    firstDigitTimeout: node.attrs.timeout,
    terminatingDigits: node.attrs.finishOnKey,
  };
  if (node.attrs.action) attrs.gatherUrl = rewrite(node.attrs.action, "action");
  else
    warn("Gather", "Gather without an action attribute re-requests the current document URL on Twilio; set an explicit action for identical behavior through the adapter.", findings);
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
    warn("Record", "Transcription engines and callback payloads differ between Twilio and Bandwidth.", findings);
  if (node.attrs.playBeep && node.attrs.playBeep !== "false")
    warn("Record", "playBeep has no BXML equivalent; no beep will play before recording.", findings);
  return [{ name: "Record", attrs }];
}
```

- [ ] **Step 4: Run to verify PASS** — `npx vitest run test/translate-gather-record.test.ts` (and `npx vitest run` to confirm no regression).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: translate Gather and Record with attribute mapping"`

---

### Task 6: Translator — Dial (Number/Sip/Conference) and Connect/Stream

**Files:**
- Modify: `src/translator/translate.ts` (replace `translateDial`/`translateConnect` stubs)
- Test: `test/translate-dial.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { translateTwiml } from "../src/translator/translate.js";

describe("Dial", () => {
  it("plain number text → Transfer/PhoneNumber", () => {
    const r = translateTwiml(`<Response><Dial callerId="+15550001111">+15552223333</Dial></Response>`);
    expect(r.bxml).toContain(`<Transfer transferCallerId="+15550001111">`);
    expect(r.bxml).toContain(`<PhoneNumber>+15552223333</PhoneNumber>`);
  });
  it("multiple Number nouns ring simultaneously", () => {
    const r = translateTwiml(`<Response><Dial><Number>+15551</Number><Number>+15552</Number></Dial></Response>`);
    expect(r.bxml.match(/<PhoneNumber>/g)?.length).toBe(2);
  });
  it("Sip noun → SipUri", () => {
    const r = translateTwiml(`<Response><Dial><Sip>sip:agent@pbx.test</Sip></Dial></Response>`);
    expect(r.bxml).toContain(`<SipUri>sip:agent@pbx.test</SipUri>`);
  });
  it("Conference noun → Conference; waitUrl is an error-level finding", () => {
    const r = translateTwiml(`<Response><Dial><Conference waitUrl="/hold">support</Conference></Dial></Response>`);
    expect(r.bxml).toContain(`<Conference>support</Conference>`);
    expect(r.findings.some((f) => f.severity === "error" && /waitUrl/.test(f.message))).toBe(true);
  });
  it("Queue noun is unsupported", () => {
    const r = translateTwiml(`<Response><Dial><Queue>q1</Queue></Dial></Response>`);
    expect(r.hasErrors).toBe(true);
  });
});

describe("Connect/Stream", () => {
  it("maps to StartStream with destination and partial warning", () => {
    const r = translateTwiml(
      `<Response><Connect><Stream url="wss://bot.test/audio"/></Connect></Response>`,
      { rewriteUrl: (u, k) => (k === "stream" ? `wss://adapter.test/streams?dest=${encodeURIComponent(u)}` : u) },
    );
    expect(r.bxml).toContain(`<StartStream destination="wss://adapter.test/streams?dest=wss%3A%2F%2Fbot.test%2Faudio"`);
    expect(r.findings.some((f) => f.severity === "warning" && f.verb === "Stream")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify FAIL** — `npx vitest run test/translate-dial.test.ts`

- [ ] **Step 3: Implement** — replace stubs in `src/translator/translate.ts`:

```ts
function translateDial(
  node: TwimlNode,
  findings: Finding[],
  rewrite: (u: string, k: UrlKind) => string,
): XmlEl[] | null {
  const conference = node.children.find((c) => c.name === "Conference");
  if (conference) {
    for (const [attr, mapping] of Object.entries(matrix.verbs.Conference.attributes)) {
      if (conference.attrs[attr] !== undefined && mapping.status === "unsupported")
        findings.push({ severity: "error", verb: "Conference", message: `Conference ${attr}: ${mapping.notes}`, docsUrl: matrix.verbs.Conference.docsUrl });
      else if (conference.attrs[attr] !== undefined && mapping.status === "partial")
        warn("Conference", `Conference ${attr}: ${mapping.notes}`, findings);
    }
    return [{ name: "Conference", children: [conference.text] }];
  }
  const blocked = node.children.find((c) => c.name === "Queue" || c.name === "Client");
  if (blocked) return unsupported(blocked, findings);

  const targets: XmlEl[] = [];
  for (const child of node.children) {
    if (child.name === "Number") targets.push({ name: "PhoneNumber", children: [child.text] });
    else if (child.name === "Sip") targets.push({ name: "SipUri", children: [child.text] });
    else return unsupported(child, findings, `Dial noun <${child.name}> is not supported by the adapter.`);
  }
  if (targets.length === 0 && node.text) targets.push({ name: "PhoneNumber", children: [node.text] });
  if (targets.length === 0) return unsupported(node, findings, "Dial with no target.");

  warn("Dial", "Deep Dial semantics (answerOnBridge, child-call status propagation) are not replicated in P0; validate call-progress behavior.", findings);
  const attrs: Record<string, string | undefined> = {
    transferCallerId: node.attrs.callerId,
    callTimeout: node.attrs.timeout,
  };
  if (node.attrs.action) attrs.transferCompleteUrl = rewrite(node.attrs.action, "transfer");
  return [{ name: "Transfer", attrs, children: targets }];
}

function translateConnect(
  node: TwimlNode,
  findings: Finding[],
  rewrite: (u: string, k: UrlKind) => string,
): XmlEl[] | null {
  const stream = node.children.find((c) => c.name === "Stream");
  if (!stream)
    return unsupported(node, findings, `Connect noun <${node.children[0]?.name ?? "?"}> is not supported (ConversationRelay/VirtualAgent are out of adapter scope).`);
  if (!stream.attrs.url) return unsupported(stream, findings, "Stream requires a url attribute.");
  warn("Stream", matrix.verbs.Stream.notes, findings);
  return [
    {
      name: "StartStream",
      attrs: { destination: rewrite(stream.attrs.url, "stream"), tracks: "inbound" },
    },
  ];
}
```

- [ ] **Step 4: Run full suite** — `npx vitest run` → all PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: translate Dial (Transfer/Conference/SipUri) and Connect Stream"`

---

### Task 7: Twilio identity — CallSid mapping, call store, X-Twilio-Signature

**Files:**
- Create: `src/twilio/call-sid.ts`, `src/twilio/signature.ts`, `src/server/call-store.ts`
- Test: `test/twilio-identity.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { toCallSid } from "../src/twilio/call-sid.js";
import { twilioSignature } from "../src/twilio/signature.js";
import { CallStore } from "../src/server/call-store.js";

describe("toCallSid", () => {
  it("is deterministic, CA-prefixed, 34 chars", () => {
    const sid = toCallSid("c-abc-123");
    expect(sid).toMatch(/^CA[0-9a-f]{32}$/);
    expect(toCallSid("c-abc-123")).toBe(sid);
    expect(toCallSid("c-other")).not.toBe(sid);
  });
});

describe("twilioSignature", () => {
  // Canonical example from Twilio's security docs. If this fails, verify the
  // expected value against https://www.twilio.com/docs/usage/security before
  // changing the implementation.
  it("matches Twilio's documented example", () => {
    const sig = twilioSignature("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", {
      CallSid: "CA1234567890ABCDE",
      Caller: "+12349013030",
      Digits: "1234",
      From: "+12349013030",
      To: "+18005551212",
    });
    expect(sig).toBe("RSOYDt4T1cUTdK1PDd93/VVr8B8=");
  });
});

describe("CallStore", () => {
  it("stores and retrieves by bwCallId", () => {
    const store = new CallStore();
    store.put("c-1", { sid: toCallSid("c-1"), from: "+1", to: "+2", direction: "inbound", voiceUrl: "https://x.test/voice" });
    expect(store.get("c-1")?.to).toBe("+2");
    expect(store.get("missing")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify FAIL** — `npx vitest run test/twilio-identity.test.ts`

- [ ] **Step 3: Implement**

`src/twilio/call-sid.ts`:
```ts
import { createHash } from "node:crypto";

export function toCallSid(bwCallId: string): string {
  return "CA" + createHash("md5").update(bwCallId).digest("hex");
}
```

`src/twilio/signature.ts`:
```ts
import { createHmac } from "node:crypto";

/** Twilio request signing: HMAC-SHA1(authToken, url + sorted(paramName+value)), base64. */
export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  return createHmac("sha1", authToken).update(data).digest("base64");
}
```

`src/server/call-store.ts`:
```ts
export interface CallRecord {
  sid: string;
  from: string;
  to: string;
  direction: "inbound" | "outbound-api";
  voiceUrl: string;
}

export class CallStore {
  private byBwId = new Map<string, CallRecord>();
  put(bwCallId: string, record: CallRecord): void {
    this.byBwId.set(bwCallId, record);
  }
  get(bwCallId: string): CallRecord | undefined {
    return this.byBwId.get(bwCallId);
  }
}
```

- [ ] **Step 4: Run to verify PASS** — `npx vitest run test/twilio-identity.test.ts`

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: CallSid mapping, call store, X-Twilio-Signature signing"`

---

### Task 8: Egress — Twilio-shaped params + signed webhook POST

**Files:**
- Create: `src/twilio/egress.ts`
- Test: `test/egress.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { initiateParams, gatherParams, statusParams, postToCustomer } from "../src/twilio/egress.js";
import { twilioSignature } from "../src/twilio/signature.js";

const call = { sid: "CAdeadbeef", from: "+15550001111", to: "+15552223333", direction: "inbound" as const, voiceUrl: "https://x.test/voice" };

describe("param builders", () => {
  it("initiate → ringing", () => {
    const p = initiateParams(call, "AC123");
    expect(p).toMatchObject({ CallSid: "CAdeadbeef", AccountSid: "AC123", From: "+15550001111", To: "+15552223333", CallStatus: "ringing", Direction: "inbound", ApiVersion: "2010-04-01" });
  });
  it("gather adds Digits and in-progress status", () => {
    const p = gatherParams(call, "AC123", "42");
    expect(p.Digits).toBe("42");
    expect(p.CallStatus).toBe("in-progress");
  });
  it("status → completed with duration", () => {
    const p = statusParams(call, "AC123", 17);
    expect(p.CallStatus).toBe("completed");
    expect(p.CallDuration).toBe("17");
  });
});

describe("postToCustomer", () => {
  it("sends signed form-encoded POST and returns body text", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("<Response><Hangup/></Response>", { status: 200 }),
    ) as unknown as typeof fetch;
    const params = initiateParams(call, "AC123");
    const body = await postToCustomer({ url: "https://x.test/voice", params, authToken: "tok", fetchImpl });
    expect(body).toContain("<Hangup/>");
    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe("https://x.test/voice");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(init.headers["X-Twilio-Signature"]).toBe(twilioSignature("tok", "https://x.test/voice", params));
    expect(init.body).toContain("CallSid=CAdeadbeef");
  });
  it("throws on non-2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(
      postToCustomer({ url: "https://x.test/voice", params: {}, authToken: "tok", fetchImpl }),
    ).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 2: Run to verify FAIL** — `npx vitest run test/egress.test.ts`

- [ ] **Step 3: Implement** — `src/twilio/egress.ts`:

```ts
import { twilioSignature } from "./signature.js";
import type { CallRecord } from "../server/call-store.js";

function baseParams(call: CallRecord, accountSid: string): Record<string, string> {
  return {
    CallSid: call.sid,
    AccountSid: accountSid,
    From: call.from,
    To: call.to,
    Direction: call.direction,
    ApiVersion: "2010-04-01",
  };
}

export function initiateParams(call: CallRecord, accountSid: string): Record<string, string> {
  return { ...baseParams(call, accountSid), CallStatus: "ringing" };
}

export function gatherParams(call: CallRecord, accountSid: string, digits: string): Record<string, string> {
  return { ...baseParams(call, accountSid), CallStatus: "in-progress", Digits: digits };
}

export function statusParams(call: CallRecord, accountSid: string, durationSec: number): Record<string, string> {
  return { ...baseParams(call, accountSid), CallStatus: "completed", CallDuration: String(durationSec) };
}

export async function postToCustomer(opts: {
  url: string;
  params: Record<string, string>;
  authToken: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(opts.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": twilioSignature(opts.authToken, opts.url, opts.params),
    },
    body: new URLSearchParams(opts.params).toString(),
  });
  if (!res.ok) throw new Error(`Customer webhook ${opts.url} returned ${res.status}`);
  return await res.text();
}
```

- [ ] **Step 4: Run to verify PASS** — `npx vitest run test/egress.test.ts`

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: Twilio-shaped egress params and signed webhook POST"`

---

### Task 9: Server — inbound webhook path (initiate, continue, disconnect)

**Files:**
- Create: `src/server/app.ts`
- Test: `test/server-inbound.test.ts`

Design notes for the engineer:
- Bandwidth POSTs JSON voice events to us. On `initiate` we call the customer's Twilio webhook, translate the TwiML reply, and respond with BXML (`Content-Type: application/xml`).
- Customer action URLs (Gather action, Redirect target, Record action, Dial action) are rewritten to `/bw/continue?next=<absolute customer URL>` so subsequent BXML callbacks flow back through us. Relative customer URLs are resolved against the URL that produced the TwiML.
- If translation produces error findings, we respond with a spoken error + Hangup (loud failure policy) and log the findings.
- `voiceUrl` comes from `?voiceUrl=` on the initiate URL (set by the REST facade for outbound calls) or from config (inbound calls to a BW number).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { buildApp } from "../src/server/app.js";

const config = {
  accountSid: "AC123",
  authToken: "tok",
  publicBaseUrl: "https://adapter.test",
  voiceUrl: "https://customer.test/voice",
};

function appWithTwiml(twimlByUrl: Record<string, string>) {
  const fetchImpl = vi.fn(async (url: any) => {
    const u = String(url);
    const twiml = twimlByUrl[u];
    if (!twiml) return new Response("not found", { status: 404 });
    return new Response(twiml, { status: 200 });
  }) as unknown as typeof fetch;
  const bwClient = { createCall: vi.fn() };
  return { app: buildApp(config, { fetchImpl, bwClient }), fetchImpl };
}

describe("POST /bw/initiate", () => {
  it("calls customer voiceUrl and returns translated BXML", async () => {
    const { app, fetchImpl } = appWithTwiml({
      "https://customer.test/voice": `<Response><Say>Hello</Say><Hangup/></Response>`,
    });
    const res = await app.inject({
      method: "POST",
      url: "/bw/initiate",
      payload: { eventType: "initiate", callId: "c-1", from: "+15550001111", to: "+15552223333", direction: "inbound" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/xml");
    expect(res.body).toContain("<SpeakSentence>Hello</SpeakSentence>");
    const [, init] = (fetchImpl as any).mock.calls[0];
    expect(init.headers["X-Twilio-Signature"]).toBeTruthy();
    expect(init.body).toContain("CallStatus=ringing");
  });

  it("rewrites Gather action through /bw/continue", async () => {
    const { app } = appWithTwiml({
      "https://customer.test/voice": `<Response><Gather numDigits="1" action="/menu"><Say>Press 1</Say></Gather></Response>`,
    });
    const res = await app.inject({
      method: "POST",
      url: "/bw/initiate",
      payload: { eventType: "initiate", callId: "c-2", from: "+1", to: "+2", direction: "inbound" },
    });
    expect(res.body).toContain(
      `gatherUrl="https://adapter.test/bw/continue?next=${encodeURIComponent("https://customer.test/menu")}"`,
    );
  });

  it("speaks a loud error on unsupported TwiML", async () => {
    const { app } = appWithTwiml({
      "https://customer.test/voice": `<Response><Enqueue>support</Enqueue></Response>`,
    });
    const res = await app.inject({
      method: "POST",
      url: "/bw/initiate",
      payload: { eventType: "initiate", callId: "c-3", from: "+1", to: "+2", direction: "inbound" },
    });
    expect(res.body).toContain("not yet supported");
    expect(res.body).toContain("<Hangup/>");
  });
});

describe("POST /bw/continue", () => {
  it("forwards Digits to the customer action URL and translates the reply", async () => {
    const { app, fetchImpl } = appWithTwiml({
      "https://customer.test/voice": `<Response><Gather numDigits="1" action="/menu"><Say>Press 1</Say></Gather></Response>`,
      "https://customer.test/menu": `<Response><Say>You pressed one</Say></Response>`,
    });
    await app.inject({
      method: "POST",
      url: "/bw/initiate",
      payload: { eventType: "initiate", callId: "c-4", from: "+1", to: "+2", direction: "inbound" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/bw/continue?next=${encodeURIComponent("https://customer.test/menu")}`,
      payload: { eventType: "gather", callId: "c-4", digits: "1" },
    });
    expect(res.body).toContain("You pressed one");
    const [, init] = (fetchImpl as any).mock.calls[1];
    expect(init.body).toContain("Digits=1");
  });
});

describe("POST /bw/disconnect", () => {
  it("returns 204", async () => {
    const { app } = appWithTwiml({});
    const res = await app.inject({
      method: "POST",
      url: "/bw/disconnect",
      payload: { eventType: "disconnect", callId: "c-9" },
    });
    expect(res.statusCode).toBe(204);
  });
});
```

- [ ] **Step 2: Run to verify FAIL** — `npx vitest run test/server-inbound.test.ts`

- [ ] **Step 3: Implement** — `src/server/app.ts`:

```ts
import Fastify, { type FastifyInstance } from "fastify";
import formbody from "@fastify/formbody";
import { translateTwiml, type UrlKind } from "../translator/translate.js";
import { bxmlDocument } from "../xml/build-xml.js";
import { initiateParams, gatherParams, statusParams, postToCustomer } from "../twilio/egress.js";
import { toCallSid } from "../twilio/call-sid.js";
import { CallStore, type CallRecord } from "./call-store.js";
import type { BwClient } from "../bw/client.js";

export interface AdapterConfig {
  accountSid: string;
  authToken: string;
  publicBaseUrl: string;
  voiceUrl: string;
}

export interface AdapterDeps {
  fetchImpl: typeof fetch;
  bwClient: BwClient;
}

interface BwEvent {
  eventType: string;
  callId: string;
  from?: string;
  to?: string;
  direction?: string;
  digits?: string;
}

export function buildApp(config: AdapterConfig, deps: AdapterDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(formbody);
  const store = new CallStore();

  const rewriter = (base: string) => (url: string, _kind: UrlKind) => {
    const absolute = new URL(url, base).toString();
    return `${config.publicBaseUrl}/bw/continue?next=${encodeURIComponent(absolute)}`;
  };

  function errorBxml(verbs: string[]): string {
    return bxmlDocument([
      {
        name: "SpeakSentence",
        children: [
          `This application uses a Twilio feature not yet supported by the adapter: ${verbs.join(", ")}. The call will now end.`,
        ],
      },
      { name: "Hangup" },
    ]);
  }

  async function fetchAndTranslate(customerUrl: string, params: Record<string, string>, reply: any) {
    const twiml = await postToCustomer({
      url: customerUrl,
      params,
      authToken: config.authToken,
      fetchImpl: deps.fetchImpl,
    });
    const result = translateTwiml(twiml, { rewriteUrl: rewriter(customerUrl) });
    if (result.hasErrors) {
      const verbs = [...new Set(result.findings.filter((f) => f.severity === "error").map((f) => f.verb))];
      app.log.error({ findings: result.findings }, "unsupported TwiML");
      return reply.type("application/xml").send(errorBxml(verbs));
    }
    return reply.type("application/xml").send(result.bxml);
  }

  app.post("/bw/initiate", async (req, reply) => {
    const event = req.body as BwEvent;
    const query = req.query as { voiceUrl?: string };
    const existing = store.get(event.callId);
    const voiceUrl = query.voiceUrl ?? existing?.voiceUrl ?? config.voiceUrl;
    const record: CallRecord = existing ?? {
      sid: toCallSid(event.callId),
      from: event.from ?? "",
      to: event.to ?? "",
      direction: "inbound",
      voiceUrl,
    };
    store.put(event.callId, record);
    return fetchAndTranslate(voiceUrl, initiateParams(record, config.accountSid), reply);
  });

  app.post("/bw/continue", async (req, reply) => {
    const event = req.body as BwEvent;
    const query = req.query as { next?: string };
    if (!query.next) return reply.code(400).send({ error: "missing next" });
    const record =
      store.get(event.callId) ??
      ({ sid: toCallSid(event.callId), from: event.from ?? "", to: event.to ?? "", direction: "inbound", voiceUrl: config.voiceUrl } satisfies CallRecord);
    const params =
      event.eventType === "gather" && event.digits !== undefined
        ? gatherParams(record, config.accountSid, event.digits)
        : { ...initiateParams(record, config.accountSid), CallStatus: "in-progress" };
    return fetchAndTranslate(query.next, params, reply);
  });

  app.post("/bw/disconnect", async (req, reply) => {
    const event = req.body as BwEvent;
    const record = store.get(event.callId);
    if (record) {
      // Fire-and-forget Twilio-style status callback; P0 sends it to voiceUrl host /status if configured later.
      app.log.info({ callId: event.callId, params: statusParams(record, config.accountSid, 0) }, "call completed");
    }
    return reply.code(204).send();
  });

  app.decorate("callStore", store);
  return app;
}
```

Note: `BwClient` import requires Task 10's `src/bw/client.ts`. To keep this task self-contained, create the interface file now (implementation comes in Task 10):

`src/bw/client.ts`:
```ts
export interface CreateCallOpts {
  to: string;
  from: string;
  answerUrl: string;
}

export interface BwClient {
  createCall(opts: CreateCallOpts): Promise<{ callId: string }>;
}
```

- [ ] **Step 4: Run to verify PASS** — `npx vitest run test/server-inbound.test.ts` then full suite.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: inbound webhook path with continuation rewriting and loud-failure policy"`

---

### Task 10: REST facade + Bandwidth client + entrypoint

**Files:**
- Modify: `src/bw/client.ts` (add real implementation), `src/server/app.ts` (add route)
- Create: `src/server/index.ts`
- Test: `test/server-rest.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { buildApp } from "../src/server/app.js";

const config = {
  accountSid: "AC123",
  authToken: "tok",
  publicBaseUrl: "https://adapter.test",
  voiceUrl: "https://customer.test/voice",
};

describe("POST /2010-04-01/Accounts/:sid/Calls.json", () => {
  function makeApp() {
    const bwClient = { createCall: vi.fn(async () => ({ callId: "c-out-1" })) };
    const app = buildApp(config, { fetchImpl: fetch, bwClient });
    return { app, bwClient };
  }
  const auth = "Basic " + Buffer.from("AC123:tok").toString("base64");

  it("creates a BW call with adapter answerUrl and returns Twilio-shaped JSON", async () => {
    const { app, bwClient } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/2010-04-01/Accounts/AC123/Calls.json",
      headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" },
      payload: "To=%2B15552223333&From=%2B15550001111&Url=https%3A%2F%2Fcustomer.test%2Foutbound",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.sid).toMatch(/^CA[0-9a-f]{32}$/);
    expect(body.status).toBe("queued");
    expect(body.direction).toBe("outbound-api");
    const callArgs = bwClient.createCall.mock.calls[0][0];
    expect(callArgs.to).toBe("+15552223333");
    expect(callArgs.answerUrl).toBe(
      `https://adapter.test/bw/initiate?voiceUrl=${encodeURIComponent("https://customer.test/outbound")}`,
    );
  });

  it("rejects bad credentials with Twilio-shaped 401", async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/2010-04-01/Accounts/AC123/Calls.json",
      headers: { authorization: "Basic " + Buffer.from("AC123:wrong").toString("base64") },
      payload: { To: "+1", From: "+2", Url: "https://x.test" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe(20003);
  });

  it("rejects missing params with Twilio-shaped 400", async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/2010-04-01/Accounts/AC123/Calls.json",
      headers: { authorization: auth },
      payload: { To: "+1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe(21201);
  });
});
```

- [ ] **Step 2: Run to verify FAIL** — `npx vitest run test/server-rest.test.ts`

- [ ] **Step 3: Implement**

Append the real client to `src/bw/client.ts`:
```ts
export function createBwClient(cfg: {
  accountId: string;
  username: string;
  password: string;
  applicationId: string;
  baseUrl?: string;
}): BwClient {
  const base = cfg.baseUrl ?? "https://voice.bandwidth.com/api/v2";
  const auth = "Basic " + Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64");
  return {
    async createCall({ to, from, answerUrl }) {
      const res = await fetch(`${base}/accounts/${cfg.accountId}/calls`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify({ to, from, answerUrl, applicationId: cfg.applicationId }),
      });
      if (!res.ok) throw new Error(`Bandwidth createCall failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { callId: string };
      return { callId: json.callId };
    },
  };
}
```

Add to `buildApp` in `src/server/app.ts` (before `return app`):
```ts
app.post("/2010-04-01/Accounts/:accountSid/Calls.json", async (req, reply) => {
  const header = req.headers.authorization ?? "";
  const expected = "Basic " + Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");
  if (header !== expected)
    return reply.code(401).send({ code: 20003, message: "Authentication Error - invalid username or password", status: 401 });
  const body = req.body as Record<string, string>;
  const { To, From, Url } = body;
  if (!To || !From || !Url)
    return reply.code(400).send({ code: 21201, message: "To, From, and Url are required", status: 400 });
  const answerUrl = `${config.publicBaseUrl}/bw/initiate?voiceUrl=${encodeURIComponent(Url)}`;
  const { callId } = await deps.bwClient.createCall({ to: To, from: From, answerUrl });
  const sid = toCallSid(callId);
  store.put(callId, { sid, from: From, to: To, direction: "outbound-api", voiceUrl: Url });
  return reply.code(201).send({
    sid,
    account_sid: config.accountSid,
    to: To,
    from: From,
    status: "queued",
    direction: "outbound-api",
    api_version: "2010-04-01",
  });
});
```

`src/server/index.ts`:
```ts
import { buildApp } from "./app.js";
import { createBwClient } from "../bw/client.js";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

const app = buildApp(
  {
    accountSid: env("ADAPTER_ACCOUNT_SID"),
    authToken: env("ADAPTER_AUTH_TOKEN"),
    publicBaseUrl: env("PUBLIC_BASE_URL"),
    voiceUrl: env("CUSTOMER_VOICE_URL"),
  },
  {
    fetchImpl: fetch,
    bwClient: createBwClient({
      accountId: env("BW_ACCOUNT_ID"),
      username: env("BW_USERNAME"),
      password: env("BW_PASSWORD"),
      applicationId: env("BW_APPLICATION_ID"),
    }),
  },
);

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: "0.0.0.0" }).then(() => console.log(`adapter listening on :${port}`));
```

- [ ] **Step 4: Run full suite + typecheck** — `npx vitest run && npx tsc --noEmit`

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: Twilio REST facade for outbound calls and Bandwidth client"`

---

### Task 11: Pre-flight compatibility report CLI

**Files:**
- Create: `src/preflight/analyze.ts`, `src/preflight/report.ts`, `src/preflight/cli.ts`
- Test: `test/preflight.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { analyzeSource } from "../src/preflight/analyze.js";
import { renderReport, complexityScore } from "../src/preflight/report.js";

describe("analyzeSource", () => {
  it("detects verbs in embedded TwiML strings", () => {
    const a = analyzeSource("app.js", `const x = \`<Response><Say>hi</Say><Enqueue>q</Enqueue></Response>\`;`);
    expect(a.verbs).toContain("Say");
    expect(a.verbs).toContain("Enqueue");
    expect(a.findings.some((f) => f.severity === "error" && f.verb === "Enqueue")).toBe(true);
  });
  it("detects twilio SDK verb method calls", () => {
    const src = `const { twiml } = require("twilio");
const vr = new twiml.VoiceResponse();
vr.say("hello");
vr.dial("+15551");
vr.enqueue("support");`;
    const a = analyzeSource("ivr.js", src);
    expect(a.sdkDetected).toBe(true);
    expect(a.verbs).toEqual(expect.arrayContaining(["Say", "Dial", "Enqueue"]));
  });
  it("ignores files without twilio markers", () => {
    const a = analyzeSource("other.js", `console.log("nothing here")`);
    expect(a.verbs).toEqual([]);
  });
});

describe("report", () => {
  it("scores: clean file low, unsupported-heavy file high", () => {
    const clean = analyzeSource("a.xml", `<Response><Say>hi</Say></Response>`);
    const dirty = analyzeSource("b.xml", `<Response><Enqueue>q</Enqueue><Pay/></Response>`);
    expect(complexityScore([clean])).toBeLessThan(complexityScore([dirty]));
    expect(complexityScore([dirty])).toBeLessThanOrEqual(10);
  });
  it("renders markdown with status sections", () => {
    const a = analyzeSource("a.xml", `<Response><Say voice="alice">hi</Say><Enqueue>q</Enqueue></Response>`);
    const md = renderReport([a]);
    expect(md).toContain("# Twilio → Bandwidth migration pre-flight report");
    expect(md).toContain("Enqueue");
    expect(md).toMatch(/complexity/i);
  });
});
```

- [ ] **Step 2: Run to verify FAIL** — `npx vitest run test/preflight.test.ts`

- [ ] **Step 3: Implement**

`src/preflight/analyze.ts`:
```ts
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
  say: "Say", play: "Play", gather: "Gather", dial: "Dial", record: "Record",
  hangup: "Hangup", redirect: "Redirect", reject: "Reject", pause: "Pause",
  enqueue: "Enqueue", leave: "Leave", pay: "Pay", refer: "Refer", connect: "Connect",
  conference: "Conference", number: "Number", sip: "Sip", queue: "Queue", client: "Client",
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
    for (const m of source.matchAll(/\.\s*(say|play|gather|dial|record|hangup|redirect|reject|pause|enqueue|leave|pay|refer|connect|conference|number|sip|queue|client)\s*\(/g)) {
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
```

`src/preflight/report.ts`:
```ts
import type { FileAnalysis } from "./analyze.js";

export function complexityScore(analyses: FileAnalysis[]): number {
  const all = analyses.flatMap((a) => a.findings);
  const warnings = all.filter((f) => f.severity === "warning").length;
  const errors = all.filter((f) => f.severity === "error").length;
  return Math.min(10, Math.max(1, 1 + warnings + errors * 3));
}

export function renderReport(analyses: FileAnalysis[]): string {
  const relevant = analyses.filter((a) => a.verbs.length > 0);
  const score = complexityScore(relevant);
  const lines: string[] = [
    "# Twilio → Bandwidth migration pre-flight report",
    "",
    `**Migration complexity: ${score}/10** (1 + warnings + 3×blockers, capped at 10)`,
    "",
    `Files with Twilio voice usage: ${relevant.length}`,
    "",
  ];
  for (const a of relevant) {
    lines.push(`## \`${a.file}\``, "", `Verbs found: ${a.verbs.join(", ")}`, "");
    const errors = a.findings.filter((f) => f.severity === "error");
    const warnings = a.findings.filter((f) => f.severity === "warning");
    if (errors.length === 0 && warnings.length === 0) lines.push("✅ Runs through the adapter as-is.", "");
    if (errors.length) {
      lines.push("### 🛑 Blockers", "");
      for (const f of errors) lines.push(`- **${f.verb}** — ${f.message}${f.docsUrl ? ` ([docs](${f.docsUrl}))` : ""}`);
      lines.push("");
    }
    if (warnings.length) {
      lines.push("### ⚠️ Heads up", "");
      for (const f of warnings) lines.push(`- **${f.verb}** — ${f.message}${f.docsUrl ? ` ([docs](${f.docsUrl}))` : ""}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}
```

`src/preflight/cli.ts`:
```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { analyzeSource, type FileAnalysis } from "./analyze.js";
import { renderReport } from "./report.js";

const EXTENSIONS = new Set([".js", ".ts", ".mjs", ".cjs", ".xml"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(full, out);
    } else if (EXTENSIONS.has(extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

const target = process.argv[2];
if (!target) {
  console.error("Usage: npm run preflight -- <path-to-repo-or-file>");
  process.exit(2);
}

const files = statSync(target).isDirectory() ? walk(target) : [target];
const analyses: FileAnalysis[] = files.map((f) => analyzeSource(f, readFileSync(f, "utf8")));
console.log(renderReport(analyses));
```

- [ ] **Step 4: Run to verify PASS** — `npx vitest run test/preflight.test.ts`

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: pre-flight compatibility report CLI driven by the matrix"`

---

### Task 12: Media Streams bridge (Twilio wire schema, pluggable BW source)

**Files:**
- Create: `src/streams/bridge.ts`
- Test: `test/streams.test.ts`

Design note: in Twilio, *Twilio* connects out to the customer's bot WebSocket and speaks the documented Media Streams schema (`connected`/`start`/`media`/`stop`, with `media`/`mark`/`clear` coming back). The bridge replicates that: it dials out to the bot URL, emits the Twilio-schema handshake, and shuttles audio between the bot and a `BwStreamSource`. The live Bandwidth-side binding (BW's own StartStream WS schema) is intentionally behind the `BwStreamSource` interface — final field mapping requires fixture capture against a real BW account (P0 exit criterion: measure added latency here).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { EventEmitter } from "node:events";
import { TwilioStreamBridge, type BwStreamSource } from "../src/streams/bridge.js";

class FakeBwSource extends EventEmitter implements BwStreamSource {
  sent: string[] = [];
  sendMedia(payloadB64: string): void {
    this.sent.push(payloadB64);
  }
  close(): void {}
}

function collectBot(port: number): Promise<{ messages: any[]; socket: Promise<WebSocket> }> {
  return new Promise((resolve) => {
    const messages: any[] = [];
    const wss = new WebSocketServer({ port });
    const socket = new Promise<WebSocket>((res) => {
      wss.on("connection", (ws) => {
        ws.on("message", (d) => messages.push(JSON.parse(String(d))));
        res(ws);
      });
    });
    wss.on("listening", () => resolve({ messages, socket }));
  });
}

describe("TwilioStreamBridge", () => {
  it("performs connected/start handshake and forwards media both ways", async () => {
    const { messages, socket } = await collectBot(8089);
    const source = new FakeBwSource();
    const bridge = new TwilioStreamBridge({
      botUrl: "ws://127.0.0.1:8089",
      callSid: "CAabc",
      accountSid: "AC123",
      source,
    });
    await bridge.ready();

    source.emit("media", "AAAA");
    const bot = await socket;
    await new Promise((r) => setTimeout(r, 100));

    expect(messages[0]).toMatchObject({ event: "connected", protocol: "Call" });
    expect(messages[1].event).toBe("start");
    expect(messages[1].start.callSid).toBe("CAabc");
    expect(messages[1].start.mediaFormat).toMatchObject({ encoding: "audio/x-mulaw", sampleRate: 8000 });
    expect(messages[1].streamSid).toMatch(/^MZ/);
    expect(messages[2]).toMatchObject({ event: "media", media: { payload: "AAAA" } });

    bot.send(JSON.stringify({ event: "media", media: { payload: "BBBB" } }));
    await new Promise((r) => setTimeout(r, 100));
    expect(source.sent).toEqual(["BBBB"]);

    bridge.close();
  });
});
```

- [ ] **Step 2: Run to verify FAIL** — `npx vitest run test/streams.test.ts`

- [ ] **Step 3: Implement** — `src/streams/bridge.ts`:

```ts
import { WebSocket } from "ws";
import { randomBytes } from "node:crypto";
import type { EventEmitter } from "node:events";

/**
 * Abstraction over the Bandwidth side of a media stream. The live StartStream
 * WS schema binding lands once fixtures are captured against a real account;
 * tests use a fake. Emits "media" (base64 mulaw payload) and "stop".
 */
export interface BwStreamSource extends EventEmitter {
  sendMedia(payloadB64: string): void;
  close(): void;
}

export interface BridgeOpts {
  botUrl: string;
  callSid: string;
  accountSid: string;
  source: BwStreamSource;
}

export class TwilioStreamBridge {
  readonly streamSid: string;
  private ws: WebSocket;
  private seq = 0;
  private readyPromise: Promise<void>;

  constructor(private opts: BridgeOpts) {
    this.streamSid = "MZ" + randomBytes(16).toString("hex");
    this.ws = new WebSocket(opts.botUrl);
    this.readyPromise = new Promise((resolve, reject) => {
      this.ws.on("open", () => {
        this.send({ event: "connected", protocol: "Call", version: "1.0.0" });
        this.send({
          event: "start",
          sequenceNumber: String(++this.seq),
          streamSid: this.streamSid,
          start: {
            streamSid: this.streamSid,
            accountSid: opts.accountSid,
            callSid: opts.callSid,
            tracks: ["inbound"],
            mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
          },
        });
        resolve();
      });
      this.ws.on("error", reject);
    });

    opts.source.on("media", (payloadB64: string) => {
      this.send({
        event: "media",
        sequenceNumber: String(++this.seq),
        streamSid: this.streamSid,
        media: { track: "inbound", chunk: String(this.seq), timestamp: String(Date.now()), payload: payloadB64 },
      });
    });
    opts.source.on("stop", () => {
      this.send({ event: "stop", sequenceNumber: String(++this.seq), streamSid: this.streamSid });
      this.ws.close();
    });

    this.ws.on("message", (data) => {
      const msg = JSON.parse(String(data));
      if (msg.event === "media" && msg.media?.payload) this.opts.source.sendMedia(msg.media.payload);
      else if (msg.event === "mark")
        // P0: echo the mark immediately; real playout tracking comes with the live BW binding.
        this.send({ event: "mark", streamSid: this.streamSid, mark: msg.mark });
      // "clear" is accepted and dropped in P0 — the BW source has no buffered playout yet.
    });
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  close(): void {
    this.opts.source.close();
    this.ws.close();
  }

  private send(obj: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }
}
```

- [ ] **Step 4: Run to verify PASS** — `npx vitest run test/streams.test.ts`

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: Media Streams bridge speaking Twilio wire schema with pluggable BW source"`

---

### Task 13: Sample customer app, README, demo script

**Files:**
- Create: `examples/sample-twilio-app/package.json`, `examples/sample-twilio-app/server.js`, `README.md`, `docs/demo.md`

- [ ] **Step 1: Write the sample app** (unmodified `twilio` SDK — the demo's whole point)

`examples/sample-twilio-app/package.json`:
```json
{
  "name": "sample-twilio-app",
  "private": true,
  "scripts": { "start": "node server.js" },
  "dependencies": { "express": "^4.19.0", "twilio": "^5.0.0" }
}
```

`examples/sample-twilio-app/server.js`:
```js
const express = require("express");
const { twiml } = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

app.post("/voice", (req, res) => {
  const vr = new twiml.VoiceResponse();
  const gather = vr.gather({ numDigits: 1, action: "/menu", method: "POST" });
  gather.say("Welcome to the Bandwidth adapter demo. Press 1 for sales. Press 2 to leave a message.");
  vr.say("We did not receive input. Goodbye.");
  res.type("text/xml").send(vr.toString());
});

app.post("/menu", (req, res) => {
  const vr = new twiml.VoiceResponse();
  if (req.body.Digits === "1") {
    vr.say("Connecting you to sales.");
    vr.dial("+19195550100");
  } else if (req.body.Digits === "2") {
    vr.say("Leave a message after the tone.");
    vr.record({ maxLength: 30, action: "/voice" });
  } else {
    vr.say("That was not a valid choice.");
    vr.redirect("/voice");
  }
  res.type("text/xml").send(vr.toString());
});

app.listen(4000, () => console.log("Sample Twilio app listening on :4000"));
```

- [ ] **Step 2: Verify the sample app serves TwiML**

Run: `cd examples/sample-twilio-app && npm install && node server.js &` then `curl -s -X POST http://localhost:4000/voice -d ""`
Expected: a `<Response>` document containing `<Gather ... action="/menu">`. Kill the background server afterward.

- [ ] **Step 3: Verify preflight against the sample app**

Run: `npm run preflight -- examples/sample-twilio-app/server.js`
Expected: markdown report listing Say/Gather/Dial/Record/Redirect, complexity score ≥1, a Dial heads-up warning, no blockers.

- [ ] **Step 4: Write README.md**

```markdown
# bw-voice-adapter

Twilio→Bandwidth Voice API adapter (P0). Run an unmodified Twilio voice app on
Bandwidth infrastructure: the adapter receives Bandwidth voice webhooks, calls
your Twilio webhook with Twilio-shaped signed params, and translates the TwiML
reply to BXML. A Twilio-compatible REST endpoint handles outbound calls, and a
pre-flight CLI reports migration compatibility — all driven by one declarative
compatibility matrix (`src/matrix/twilio-voice.json`).

## Quick start

```bash
npm install
npm test
npm run preflight -- examples/sample-twilio-app   # migration report demo
```

## Run the adapter

Env vars: `ADAPTER_ACCOUNT_SID`, `ADAPTER_AUTH_TOKEN` (what the customer's
Twilio SDK/webhook validation uses), `PUBLIC_BASE_URL`, `CUSTOMER_VOICE_URL`,
`BW_ACCOUNT_ID`, `BW_USERNAME`, `BW_PASSWORD`, `BW_APPLICATION_ID`.

```bash
npm start
```

Point your Bandwidth Voice application's webhook at
`$PUBLIC_BASE_URL/bw/initiate`. Point your Twilio SDK at the adapter:

```js
const client = require("twilio")(ACCOUNT_SID, AUTH_TOKEN, { region: undefined, edge: undefined });
// twilio-node supports overriding the base URL per-request via client.api.baseUrl
```

See `docs/demo.md` for the end-to-end walkthrough and current limitations
(P0 known gaps: Queue/Enqueue, conference waitUrl, speech Gather, live
Bandwidth Media Streams binding pending fixture capture).
```

- [ ] **Step 5: Write docs/demo.md**

```markdown
# Demo walkthrough

## 1. Pre-flight report (no credentials needed)
`npm run preflight -- examples/sample-twilio-app` — shows the matrix-driven
migration report for an unmodified Twilio app.

## 2. Webhook translation loop (no credentials needed)
Terminal A: `cd examples/sample-twilio-app && npm start`
Terminal B: env vars per README with `CUSTOMER_VOICE_URL=http://localhost:4000/voice`,
`PUBLIC_BASE_URL=http://localhost:3000`, then `npm start`
Terminal C: simulate a Bandwidth initiate webhook:

    curl -s -X POST http://localhost:3000/bw/initiate \
      -H 'Content-Type: application/json' \
      -d '{"eventType":"initiate","callId":"demo-1","from":"+15550001111","to":"+15552223333","direction":"inbound"}'

Expected: BXML with `<SpeakSentence>` + `<Gather gatherUrl="http://localhost:3000/bw/continue?...">`.
Then simulate the caller pressing 1:

    curl -s -X POST 'http://localhost:3000/bw/continue?next=http%3A%2F%2Flocalhost%3A4000%2Fmenu' \
      -H 'Content-Type: application/json' \
      -d '{"eventType":"gather","callId":"demo-1","digits":"1"}'

Expected: BXML containing `<Transfer>` to the sales number.

## 3. Live call (requires BW account + numbers — see provisioning checklist)
Point a BW Voice application at the public adapter URL, call the BW number,
and walk the IVR. Then exercise outbound via the REST facade with the real
`twilio` SDK pointed at the adapter base URL.
```

- [ ] **Step 6: Final verification + commit**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass, no type errors.

```bash
git add -A && git commit -m "docs: sample Twilio app, README, and demo walkthrough"
```

---

## Self-Review Notes

- **Spec coverage:** matrix (Task 2), runtime proxy webhook path (Tasks 3–9), REST facade (Task 10), pre-flight report (Task 11), Media Streams compat (Task 12), demo assets (Task 13). Known P0 exclusions are deliberate and documented: live BW stream schema binding (fixture-dependent), status callbacks beyond logging, recording callback normalization, speech Gather.
- **Signature test vector** is from Twilio's security docs from memory — if it fails at execution, verify against https://www.twilio.com/docs/usage/security and fix the *expected value*, not the algorithm, unless the docs disagree.
- **Type consistency:** `Finding`, `TranslateResult`, `UrlKind` defined once in `translate.ts`; `CallRecord` in `call-store.ts`; `BwClient` in `bw/client.ts` (interface created in Task 9, implementation added in Task 10).
