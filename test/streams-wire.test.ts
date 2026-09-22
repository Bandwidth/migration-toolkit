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
  type BwStreamSource,
} from "../src/streams/bridge.js";

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
    expect(customParametersFromBwStart({ streamParams: { n: 42, s: "x", nil: null } })).toEqual({ n: "42", s: "x" });
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

describe("mark", () => {
  it("echoes mark back to the bot preserving streamSid and mark.name", async () => {
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

    bot.send(
      JSON.stringify({
        event: "mark",
        streamSid: bridge.streamSid,
        mark: { name: "playback-done" },
      })
    );

    await waitFor(
      () => (messages.filter((m: any) => m.event === "mark") as any[]).length >= 1
    );
    bridge.close();
    close();

    const markMsg = messages.find((m: any) => m.event === "mark") as any;
    expect(markMsg.event).toBe("mark");
    expect(markMsg.streamSid).toBe(bridge.streamSid);
    expect(markMsg.mark).toEqual({ name: "playback-done" });
  });
});

// ─── clear ──────────────────────────────────────────────────────────────────

describe("clear", () => {
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
