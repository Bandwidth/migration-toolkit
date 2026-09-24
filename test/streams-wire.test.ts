/**
 * Wire-compatibility tests for TwilioStreamBridge.
 *
 * Validates every message shape against Twilio's Media Streams WebSocket
 * protocol (https://www.twilio.com/docs/voice/media-streams/websocket-messages).
 *
 * Pattern: local WebSocketServer acts as "the bot", FakeBwSource acts as
 * the Bandwidth network side. Tests verify exact JSON shapes.
 */
import { describe, it, expect } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { EventEmitter } from "node:events";
import {
  TwilioStreamBridge,
  customParametersFromBwStart,
  mulawPayloadDurationMs,
  type BwStreamSource,
} from "../src/streams/bridge.js";

/** Base64 mulaw silence of the given duration at 8 kHz (8 bytes per ms). */
const mulawMs = (ms: number) => Buffer.alloc(ms * 8, 0xff).toString("base64");

// ─── helpers ────────────────────────────────────────────────────────────────

/** FakeBwSource that records outbound payloads and exposes flush tracking. */
class FakeBwSource extends EventEmitter implements BwStreamSource {
  sent: string[] = [];
  flushed = 0;

  sendMedia(payloadB64: string): void {
    this.sent.push(payloadB64);
  }
  flush(): void {
    this.flushed++;
  }
  close(): void {}
}

let portCounter = 8200;
function nextPort(): number {
  return portCounter++;
}

/** Spin up a bot WebSocket server on a free port. Returns collected messages
 *  and a promise that resolves to the first connected WebSocket. */
function botServer(port: number): Promise<{
  messages: unknown[];
  socket: Promise<WebSocket>;
  close: () => void;
}> {
  return new Promise((resolve) => {
    const messages: unknown[] = [];
    const wss = new WebSocketServer({ port });
    let socketResolver: ((ws: WebSocket) => void) | undefined;
    const socket = new Promise<WebSocket>((res) => {
      socketResolver = res;
    });
    wss.on("connection", (ws) => {
      ws.on("message", (d) => messages.push(JSON.parse(String(d))));
      socketResolver?.(ws);
    });
    wss.on("listening", () =>
      resolve({ messages, socket, close: () => wss.close() })
    );
  });
}

/** Poll until check() returns true or deadline passes. */
async function waitFor(check: () => boolean, ms = 400): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ─── start message ──────────────────────────────────────────────────────────

describe("start message", () => {
  it("carries all required fields including customParameters", async () => {
    const port = nextPort();
    const { messages, close } = await botServer(port);
    const source = new FakeBwSource();
    const bridge = new TwilioStreamBridge({
      botUrl: `ws://127.0.0.1:${port}`,
      callSid: "CA111",
      accountSid: "AC222",
      customParameters: { greeting: "hello", lang: "en" },
      source,
    });
    await bridge.ready();
    // Wait for both connected + start to arrive
    await waitFor(() => messages.length >= 2);
    bridge.close();
    close();

    const startMsg = messages.find((m: any) => m.event === "start") as any;
    expect(startMsg).toBeDefined();
    // top-level fields
    expect(startMsg.streamSid).toMatch(/^MZ/);
    expect(startMsg.sequenceNumber).toBe("1");
    // nested start object
    expect(startMsg.start.streamSid).toBe(startMsg.streamSid);
    expect(startMsg.start.accountSid).toBe("AC222");
    expect(startMsg.start.callSid).toBe("CA111");
    expect(startMsg.start.tracks).toEqual(["inbound"]);
    expect(startMsg.start.mediaFormat).toEqual({
      encoding: "audio/x-mulaw",
      sampleRate: 8000,
      channels: 1,
    });
    expect(startMsg.start.customParameters).toEqual({
      greeting: "hello",
      lang: "en",
    });
  });

  // VAPI-3989: Bandwidth echoes <StreamParam/> values in its "start" event as a
  // flat `streamParams` map; the bot must see them as Twilio customParameters.
  it("forwards Bandwidth streamParams to the bot as customParameters", async () => {
    // Shape per the StartStream docs' start-event example.
    const bwStart = {
      eventType: "start",
      metadata: { accountId: "9900778", callId: "c-abc", to: "+15550001111", from: "+15550002222" },
      streamParams: { callSid: "CA123", tenant: "acme" },
    };
    const port = nextPort();
    const { messages, close } = await botServer(port);
    const source = new FakeBwSource();
    const bridge = new TwilioStreamBridge({
      botUrl: `ws://127.0.0.1:${port}`,
      callSid: "CA123",
      accountSid: "AC222",
      customParameters: customParametersFromBwStart(bwStart),
      source,
    });
    await bridge.ready();
    await waitFor(() => messages.length >= 2);
    bridge.close();
    close();

    const startMsg = messages.find((m: any) => m.event === "start") as any;
    expect(startMsg.start.customParameters).toEqual({ callSid: "CA123", tenant: "acme" });
  });

  it("customParametersFromBwStart tolerates missing or malformed streamParams", () => {
    expect(customParametersFromBwStart({ eventType: "start" })).toEqual({});
    expect(customParametersFromBwStart({ streamParams: null })).toEqual({});
    expect(customParametersFromBwStart({ streamParams: [1, 2] })).toEqual({});
    expect(customParametersFromBwStart(undefined)).toEqual({});
    expect(customParametersFromBwStart("start")).toEqual({});
    // Values are always strings on the Twilio side, even if Bandwidth ever sent a number.
    expect(customParametersFromBwStart({ streamParams: { n: 42, b: true, s: "x", nil: null } })).toEqual({
      n: "42",
      b: "true",
      s: "x",
    });
    // The documented shape is flat; nested values are skipped, not forwarded as "[object Object]".
    expect(customParametersFromBwStart({ streamParams: { o: { a: 1 }, arr: [1], s: "x" } })).toEqual({ s: "x" });
  });

  it("customParametersFromBwStart keeps a parameter literally named __proto__", () => {
    // JSON.parse yields an own "__proto__" key; a plain {} target would route the
    // assignment to the Object.prototype setter and silently lose the pair.
    const evt = JSON.parse('{"streamParams":{"__proto__":"p","a":"1"}}');
    const out = customParametersFromBwStart(evt);
    expect(Object.keys(out).sort()).toEqual(["__proto__", "a"]);
    expect(Object.getOwnPropertyDescriptor(out, "__proto__")?.value).toBe("p");
    // Survives the wire: the bot sees both keys.
    expect(JSON.stringify(out)).toBe('{"__proto__":"p","a":"1"}');
    // And nothing leaked onto the global prototype.
    expect(({} as any).p).toBeUndefined();
  });

  it("customParameters defaults to empty object when omitted", async () => {
    const port = nextPort();
    const { messages, close } = await botServer(port);
    const source = new FakeBwSource();
    const bridge = new TwilioStreamBridge({
      botUrl: `ws://127.0.0.1:${port}`,
      callSid: "CA333",
      accountSid: "AC444",
      source,
    });
    await bridge.ready();
    await waitFor(() => messages.length >= 2);
    bridge.close();
    close();

    const startMsg = messages.find((m: any) => m.event === "start") as any;
    expect(startMsg.start.customParameters).toEqual({});
  });
});

// ─── stop message ───────────────────────────────────────────────────────────

describe("stop message", () => {
  it("carries accountSid and callSid in nested stop object", async () => {
    const port = nextPort();
    const { messages, socket, close } = await botServer(port);
    const source = new FakeBwSource();
    const bridge = new TwilioStreamBridge({
      botUrl: `ws://127.0.0.1:${port}`,
      callSid: "CA555",
      accountSid: "AC666",
      source,
    });
    await bridge.ready();
    await socket; // ensure connected

    source.emit("stop");
    await waitFor(() => messages.some((m: any) => m.event === "stop"));
    close();

    const stopMsg = messages.find((m: any) => m.event === "stop") as any;
    expect(stopMsg.streamSid).toMatch(/^MZ/);
    expect(typeof stopMsg.sequenceNumber).toBe("string");
    expect(stopMsg.stop).toEqual({
      accountSid: "AC666",
      callSid: "CA555",
    });
  });
});

// ─── media framing ──────────────────────────────────────────────────────────

describe("media framing", () => {
  it("sequenceNumber is monotonically increasing and chunk is independently 1-indexed", async () => {
    const port = nextPort();
    const { messages, close } = await botServer(port);
    const source = new FakeBwSource();
    const bridge = new TwilioStreamBridge({
      botUrl: `ws://127.0.0.1:${port}`,
      callSid: "CAaaa",
      accountSid: "ACbbb",
      source,
    });
    await bridge.ready();

    source.emit("media", "FRAME1");
    source.emit("media", "FRAME2");
    source.emit("media", "FRAME3");

    await waitFor(
      () => (messages.filter((m: any) => m.event === "media") as any[]).length >= 3
    );
    bridge.close();
    close();

    const mediaMessages = messages.filter((m: any) => m.event === "media") as any[];
    expect(mediaMessages).toHaveLength(3);

    // sequenceNumber must be strings of strictly increasing integers
    const seqNums = mediaMessages.map((m) => Number(m.sequenceNumber));
    expect(seqNums[0]).toBeGreaterThan(0);
    expect(seqNums[1]).toBeGreaterThan(seqNums[0]);
    expect(seqNums[2]).toBeGreaterThan(seqNums[1]);

    // chunk is 1-indexed from first media frame, independent of sequenceNumber
    const chunks = mediaMessages.map((m) => Number(m.media.chunk));
    expect(chunks[0]).toBe(1);
    expect(chunks[1]).toBe(2);
    expect(chunks[2]).toBe(3);

    // required media subfields
    for (const m of mediaMessages) {
      expect(m.media.track).toBe("inbound");
      expect(typeof m.media.timestamp).toBe("string");
      expect(typeof m.media.payload).toBe("string");
    }
  });

  it("payloads match what BwStreamSource emits", async () => {
    const port = nextPort();
    const { messages, close } = await botServer(port);
    const source = new FakeBwSource();
    const bridge = new TwilioStreamBridge({
      botUrl: `ws://127.0.0.1:${port}`,
      callSid: "CAccc",
      accountSid: "ACddd",
      source,
    });
    await bridge.ready();

    source.emit("media", "AABB");
    source.emit("media", "CCDD");

    await waitFor(
      () => (messages.filter((m: any) => m.event === "media") as any[]).length >= 2
    );
    bridge.close();
    close();

    const payloads = (messages.filter((m: any) => m.event === "media") as any[]).map(
      (m) => m.media.payload
    );
    expect(payloads).toEqual(["AABB", "CCDD"]);
  });
});

// ─── dtmf ───────────────────────────────────────────────────────────────────

describe("dtmf", () => {
  it("forwards a dtmf digit from the BW source TO the bot (network → bot)", async () => {
    const port = nextPort();
    const { messages, close } = await botServer(port);
    const source = new FakeBwSource();

    const bridge = new TwilioStreamBridge({
      botUrl: `ws://127.0.0.1:${port}`,
      callSid: "CAeee",
      accountSid: "ACfff",
      source,
    });
    await bridge.ready();

    // Caller pressed a digit: the BW network side emits "dtmf".
    source.emit("dtmf", { track: "inbound_track", digit: "7" });

    await waitFor(() => messages.some((m: any) => m.event === "dtmf"));
    bridge.close();
    close();

    const dtmfMsg = messages.find((m: any) => m.event === "dtmf") as any;
    expect(dtmfMsg.streamSid).toBe(bridge.streamSid);
    expect(dtmfMsg.dtmf).toEqual({ track: "inbound_track", digit: "7" });
    expect(dtmfMsg.sequenceNumber).toBeDefined();
  });
});

// ─── mark ───────────────────────────────────────────────────────────────────
//
// VAPI-3990: the bridge used to echo a mark the instant it arrived, so a
// mark-gated bot was told its utterance had finished while the audio was still
// queued. Bandwidth sends no playback signal, so playout is tracked by duration.

describe("mark", () => {
  async function openBridge() {
    const port = nextPort();
    const { messages, socket, close } = await botServer(port);
    const source = new FakeBwSource();
    const bridge = new TwilioStreamBridge({
      botUrl: `ws://127.0.0.1:${port}`,
      callSid: "CAggg",
      accountSid: "AChhh",
      source,
    });
    await bridge.ready();
    const bot = await socket;
    const send = (obj: object) => bot.send(JSON.stringify({ streamSid: bridge.streamSid, ...obj }));
    const marks = () => messages.filter((m: any) => m.event === "mark") as any[];
    return { bridge, source, messages, send, marks, close: () => (bridge.close(), close()) };
  }

  it("mulawPayloadDurationMs: 8 kHz mono mulaw is 8 bytes per millisecond", () => {
    expect(mulawPayloadDurationMs(mulawMs(20))).toBe(20);
    expect(mulawPayloadDurationMs(mulawMs(1000))).toBe(1000);
    expect(mulawPayloadDurationMs("")).toBe(0);
  });

  it("mulawPayloadDurationMs matches a real decode for every base64 padding case", () => {
    // Byte counts 0..9 exercise all three padding shapes (none, "=", "==") without
    // allocating a Buffer on the hot path.
    for (let bytes = 0; bytes <= 9; bytes++) {
      const b64 = Buffer.alloc(bytes, 0x7f).toString("base64");
      expect(mulawPayloadDurationMs(b64)).toBe(Buffer.from(b64, "base64").length / 8);
    }
  });

  it("playoutLatencyPadMs delays marks that have audio ahead of them, not idle ones", async () => {
    const port = nextPort();
    const { messages, socket, close } = await botServer(port);
    const source = new FakeBwSource();
    const bridge = new TwilioStreamBridge({
      botUrl: `ws://127.0.0.1:${port}`,
      callSid: "CApad",
      accountSid: "ACpad",
      source,
      playoutLatencyPadMs: 200,
    });
    await bridge.ready();
    const bot = await socket;
    const send = (obj: object) => bot.send(JSON.stringify({ streamSid: bridge.streamSid, ...obj }));
    const marks = () => messages.filter((m: any) => m.event === "mark") as any[];

    // Idle: no audio queued, so no pad either.
    const idleAt = Date.now();
    send({ event: "mark", mark: { name: "idle" } });
    await waitFor(() => marks().length >= 1);
    expect(Date.now() - idleAt).toBeLessThan(150);

    // 100 ms of audio + 200 ms pad: not before ~300 ms.
    send({ event: "media", media: { payload: mulawMs(100) } });
    const sentAt = Date.now();
    send({ event: "mark", mark: { name: "padded" } });
    await waitFor(() => marks().length >= 2, 1000);
    const ackAfterMs = Date.now() - sentAt;
    bridge.close();
    close();
    expect(ackAfterMs).toBeGreaterThanOrEqual(280);
  });

  it("echoes a mark at once when no audio is queued, preserving streamSid and mark.name", async () => {
    const t = await openBridge();
    t.send({ event: "mark", mark: { name: "playback-done" } });
    await waitFor(() => t.marks().length >= 1);
    t.close();

    const markMsg = t.marks()[0];
    expect(markMsg.streamSid).toBe(t.bridge.streamSid);
    expect(markMsg.mark).toEqual({ name: "playback-done" });
    // Twilio numbers the marks it sends back like every other outbound message.
    expect(markMsg.sequenceNumber).toBeDefined();
  });

  it("holds a mark until the audio queued before it has played out", async () => {
    const t = await openBridge();
    t.send({ event: "media", media: { payload: mulawMs(300) } });
    const sentAt = Date.now();
    t.send({ event: "mark", mark: { name: "turn-1" } });

    // The bytes reach the Bandwidth side immediately, but the mark must not.
    await waitFor(() => t.source.sent.length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(t.marks()).toHaveLength(0);
    expect(t.bridge.pendingPlayoutMs()).toBeGreaterThan(100);

    await waitFor(() => t.marks().length >= 1, 1000);
    const ackAfterMs = Date.now() - sentAt;
    t.close();

    expect(t.marks()[0].mark).toEqual({ name: "turn-1" });
    expect(ackAfterMs).toBeGreaterThanOrEqual(280);
    expect(t.bridge.pendingPlayoutMs()).toBe(0);
  });

  it("pendingPlayoutMs reflects the bytes queued, and frames accumulate", async () => {
    const t = await openBridge();
    t.send({ event: "media", media: { payload: mulawMs(500) } });
    t.send({ event: "media", media: { payload: mulawMs(500) } });
    await waitFor(() => t.source.sent.length === 2);
    const pending = t.bridge.pendingPlayoutMs();
    t.close();
    expect(pending).toBeGreaterThan(900);
    expect(pending).toBeLessThanOrEqual(1000);
  });

  it("returns marks in order, each after its own preceding audio", async () => {
    const t = await openBridge();
    t.send({ event: "media", media: { payload: mulawMs(150) } });
    t.send({ event: "mark", mark: { name: "a" } });
    t.send({ event: "media", media: { payload: mulawMs(150) } });
    t.send({ event: "mark", mark: { name: "b" } });

    const seen: { name: string; at: number }[] = [];
    await waitFor(() => {
      for (const m of t.marks().slice(seen.length)) seen.push({ name: m.mark.name, at: Date.now() });
      return seen.length >= 2;
    }, 1500);
    t.close();

    expect(seen.map((s) => s.name)).toEqual(["a", "b"]);
    expect(seen[1].at - seen[0].at).toBeGreaterThanOrEqual(100);
  });

  it("audio queued after a mark does not delay that mark", async () => {
    const t = await openBridge();
    t.send({ event: "media", media: { payload: mulawMs(100) } });
    const sentAt = Date.now();
    t.send({ event: "mark", mark: { name: "early" } });
    t.send({ event: "media", media: { payload: mulawMs(5000) } });

    await waitFor(() => t.marks().length >= 1, 1000);
    const ackAfterMs = Date.now() - sentAt;
    t.close();

    expect(t.marks()[0].mark).toEqual({ name: "early" });
    expect(ackAfterMs).toBeLessThan(800);
  });

  it("close() drops pending marks and their timer", async () => {
    const t = await openBridge();
    t.send({ event: "media", media: { payload: mulawMs(300) } });
    t.send({ event: "mark", mark: { name: "never" } });
    await waitFor(() => t.source.sent.length === 1);
    expect(t.bridge.pendingPlayoutMs()).toBeGreaterThan(0);

    t.close();
    expect(t.bridge.pendingPlayoutMs()).toBe(0);
    await new Promise((r) => setTimeout(r, 400));
    expect(t.marks()).toHaveLength(0);
  });

  it("drops pending marks when the stream stops", async () => {
    const t = await openBridge();
    t.send({ event: "media", media: { payload: mulawMs(5000) } });
    t.send({ event: "mark", mark: { name: "never" } });
    await waitFor(() => t.source.sent.length === 1);

    t.source.emit("stop");
    await waitFor(() => t.messages.some((m: any) => m.event === "stop"));
    await new Promise((r) => setTimeout(r, 50));
    t.close();

    expect(t.marks()).toHaveLength(0);
    expect(t.bridge.pendingPlayoutMs()).toBe(0);
  });
});

// ─── clear ──────────────────────────────────────────────────────────────────

describe("clear", () => {
  it("empties the playout queue and returns every outstanding mark at once (Twilio semantics)", async () => {
    const port = nextPort();
    const { messages, socket, close } = await botServer(port);
    const source = new FakeBwSource();
    const bridge = new TwilioStreamBridge({
      botUrl: `ws://127.0.0.1:${port}`,
      callSid: "CAiii",
      accountSid: "ACjjj",
      source,
    });
    await bridge.ready();
    const bot = await socket;
    const send = (obj: object) => bot.send(JSON.stringify({ streamSid: bridge.streamSid, ...obj }));

    // Five seconds queued, two marks behind it. Without the clear they would
    // come back after ~5 s; the bot interrupting (barge-in) must not wait that long.
    send({ event: "media", media: { payload: mulawMs(5000) } });
    send({ event: "mark", mark: { name: "m1" } });
    send({ event: "mark", mark: { name: "m2" } });
    await waitFor(() => source.sent.length === 1);
    expect(messages.filter((m: any) => m.event === "mark")).toHaveLength(0);

    const clearedAt = Date.now();
    send({ event: "clear" });
    await waitFor(() => messages.filter((m: any) => m.event === "mark").length >= 2, 1000);
    const elapsed = Date.now() - clearedAt;
    bridge.close();
    close();

    expect(source.flushed).toBe(1);
    expect(elapsed).toBeLessThan(500);
    expect((messages.filter((m: any) => m.event === "mark") as any[]).map((m) => m.mark.name)).toEqual(["m1", "m2"]);
    expect(bridge.pendingPlayoutMs()).toBe(0);
  });

  it("resets the playout clock, so audio queued after a clear is timed from scratch", async () => {
    const port = nextPort();
    const { messages, socket, close } = await botServer(port);
    const source = new FakeBwSource();
    const bridge = new TwilioStreamBridge({
      botUrl: `ws://127.0.0.1:${port}`,
      callSid: "CAreset",
      accountSid: "ACreset",
      source,
    });
    await bridge.ready();
    const bot = await socket;
    const send = (obj: object) => bot.send(JSON.stringify({ streamSid: bridge.streamSid, ...obj }));

    // A stale second of audio, then the bot barges in and speaks 100 ms more.
    send({ event: "media", media: { payload: mulawMs(1000) } });
    send({ event: "clear" });
    await waitFor(() => source.flushed === 1);
    expect(bridge.pendingPlayoutMs()).toBe(0);

    send({ event: "media", media: { payload: mulawMs(100) } });
    const sentAt = Date.now();
    send({ event: "mark", mark: { name: "after-clear" } });
    await waitFor(() => messages.some((m: any) => m.event === "mark"), 1000);
    const ackAfterMs = Date.now() - sentAt;
    bridge.close();
    close();

    // ~100 ms, not ~1100 ms: the cleared second must not count.
    expect(ackAfterMs).toBeGreaterThanOrEqual(80);
    expect(ackAfterMs).toBeLessThan(600);
  });

  it("calls source.flush() when the bot sends a clear event", async () => {
    const port = nextPort();
    const { socket, close } = await botServer(port);
    const source = new FakeBwSource();
    const bridge = new TwilioStreamBridge({
      botUrl: `ws://127.0.0.1:${port}`,
      callSid: "CAiii",
      accountSid: "ACjjj",
      source,
    });
    await bridge.ready();
    const bot = await socket;

    expect(source.flushed).toBe(0);

    bot.send(
      JSON.stringify({
        event: "clear",
        streamSid: bridge.streamSid,
      })
    );

    await waitFor(() => source.flushed >= 1);
    bridge.close();
    close();

    expect(source.flushed).toBe(1);
  });
});

// ─── latency harness ────────────────────────────────────────────────────────

/**
 * Measures round-trip latency of media frame relay through the bridge.
 *
 * Setup: a WebSocketServer acting as "the bot" records receive timestamps.
 * We emit N frames from FakeBwSource, tag each with a send timestamp keyed
 * by chunk index, then compare against receive time on the bot side.
 *
 * This is loopback (in-process WS on 127.0.0.1), so it tests serialization +
 * event loop overhead rather than network RTT — exactly the component we own.
 */
describe("latency: round-trip media relay", () => {
  it("measures p99 < 20 ms for 100 frames through the bridge (loopback)", async () => {
    const FRAMES = 100;
    const port = nextPort();
    const latencies: number[] = [];
    const sentAt = new Map<number, number>();

    // Build bot server that records latency per chunk
    const wss = new WebSocketServer({ port });
    const connPromise = new Promise<void>((resolveConn) => {
      wss.on("connection", (ws) => {
        ws.on("message", (raw) => {
          const msg = JSON.parse(String(raw)) as any;
          if (msg.event === "media") {
            const idx = Number(msg.media.chunk);
            const t = sentAt.get(idx);
            if (t !== undefined) latencies.push(performance.now() - t);
          }
        });
        resolveConn();
      });
    });

    // Start bridge
    const source = new FakeBwSource();
    const bridge = new TwilioStreamBridge({
      botUrl: `ws://127.0.0.1:${port}`,
      callSid: "CAlatency",
      accountSid: "AClatency",
      source,
    });
    await bridge.ready();
    await connPromise;

    // Emit frames, tagging each with a send timestamp keyed by chunk index.
    // Chunk is 1-indexed and increments per media message.
    for (let i = 1; i <= FRAMES; i++) {
      sentAt.set(i, performance.now());
      source.emit("media", `PAYLOAD${i}`);
    }

    await waitFor(() => latencies.length >= FRAMES, 3000);
    bridge.close();
    wss.close();

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];
    const maxLat = latencies[latencies.length - 1];

    console.log(
      `[latency] frames=${latencies.length} p50=${p50.toFixed(2)}ms p99=${p99.toFixed(2)}ms max=${maxLat.toFixed(2)}ms`
    );

    expect(latencies.length).toBe(FRAMES);
    // In-process loopback must be well under 20 ms p99
    expect(p99).toBeLessThan(20);
  });
});
