/**
 * /bw/stream: the translator's StartStream destination (VAPI-3991).
 *
 * Bandwidth (played by a ws client) connects to the running Fastify server with
 * the fixture frames; a local WebSocketServer plays the customer's Twilio bot.
 * Everything runs on 127.0.0.1 with allowPrivateEgress so ports are ephemeral.
 */
import { describe, it, expect, vi } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { readFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server/app.js";
import { toCallSid } from "../src/twilio/call-sid.js";

const frames = JSON.parse(
  readFileSync(new URL("./fixtures/bandwidth/stream-frames.json", import.meta.url), "utf8"),
);
const webhookAuth = "Basic " + Buffer.from("u:p").toString("base64");

function config(extra: Record<string, unknown> = {}) {
  return {
    accountSid: "AC123",
    authToken: "tok",
    publicBaseUrl: "https://translator.test",
    voiceUrl: "https://customer.test/voice",
    allowPrivateEgress: true,
    webhookUser: "u",
    webhookPassword: "p",
    streamStartTimeoutMs: 300,
    ...extra,
  };
}

function makeApp(cfg = config(), twimlByUrl: Record<string, string> = {}) {
  const fetchImpl = vi.fn(async (url: any) => {
    const twiml = twimlByUrl[String(url)];
    return twiml ? new Response(twiml, { status: 200 }) : new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const bwClient = {
    createCall: vi.fn(), modifyCall: vi.fn(), getCall: vi.fn(), listRecordings: vi.fn(),
    getRecording: vi.fn(), getRecordingMedia: vi.fn(), updateRecording: vi.fn(),
  };
  return buildApp(cfg, { fetchImpl, bwClient });
}

async function listen(app: ReturnType<typeof makeApp>): Promise<number> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  return (app.server.address() as AddressInfo).port;
}

/** The customer's bot, speaking Twilio Media Streams. */
async function fakeBot() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  const port = (wss.address() as AddressInfo).port;
  const messages: any[] = [];
  const socket = new Promise<WebSocket>((res) =>
    wss.on("connection", (ws) => {
      ws.on("message", (d) => messages.push(JSON.parse(String(d))));
      res(ws);
    }),
  );
  return { url: `ws://127.0.0.1:${port}/bot`, messages, socket, close: () => wss.close() };
}

/** Connect as Bandwidth would: the rewritten destination plus destination creds. */
function bandwidthClient(port: number, dest: string, headers: Record<string, string> = { authorization: webhookAuth }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bw/stream?dest=${encodeURIComponent(dest)}`, { headers });
  const received: any[] = [];
  ws.on("message", (d) => received.push(JSON.parse(String(d))));
  return { ws, received, send: (obj: unknown) => ws.send(JSON.stringify(obj)) };
}

/** 101 on a completed upgrade, otherwise the HTTP status the server rejected with. */
function upgradeStatus(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(101));
    ws.once("unexpected-response", (_req, res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    ws.once("error", reject);
  });
}

async function waitFor(check: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("/bw/stream end to end", () => {
  it("bridges a Bandwidth stream to the bot in Twilio's protocol, both directions, then stops", async () => {
    const app = makeApp();
    const port = await listen(app);
    const bot = await fakeBot();
    const bw = bandwidthClient(port, bot.url);
    expect(await upgradeStatus(bw.ws)).toBe(101);

    // Bandwidth → bot: start becomes connected + start with our ids and customParameters.
    bw.send(frames.start);
    const botWs = await bot.socket;
    await waitFor(() => bot.messages.length >= 2);
    expect(bot.messages[0]).toMatchObject({ event: "connected", protocol: "Call" });
    expect(bot.messages[1].event).toBe("start");
    expect(bot.messages[1].start.callSid).toBe(toCallSid(frames.start.metadata.callId));
    expect(bot.messages[1].start.accountSid).toBe("AC123");
    expect(bot.messages[1].start.customParameters).toEqual({ callSid: "CA123", tenant: "acme" });
    expect(bot.messages[1].start.mediaFormat).toEqual({ encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 });

    // Caller audio reaches the bot as a Twilio media frame.
    bw.send(frames.media);
    await waitFor(() => bot.messages.some((m) => m.event === "media"));
    expect(bot.messages.find((m) => m.event === "media").media).toMatchObject({
      track: "inbound",
      payload: frames.media.payload,
    });

    // Bot → Bandwidth: media becomes playAudio, clear becomes clear.
    const streamSid = bot.messages[1].streamSid;
    botWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: "QUJD" } }));
    botWs.send(JSON.stringify({ event: "clear", streamSid }));
    await waitFor(() => bw.received.length >= 2);
    expect(bw.received[0]).toEqual({ eventType: "playAudio", media: { contentType: "audio/pcmu", payload: "QUJD" } });
    expect(bw.received[1]).toEqual({ eventType: "clear" });

    // Bandwidth ends the stream: the bot gets stop and its socket is closed.
    const botClosed = new Promise((r) => botWs.once("close", r));
    bw.send(frames.stop);
    await botClosed;
    expect(bot.messages.at(-1)).toMatchObject({ event: "stop", stop: { accountSid: "AC123" } });

    bw.ws.close();
    bot.close();
    await app.close();
  });

  it("holds caller audio sent before the bot's socket is open and delivers it in order", async () => {
    const app = makeApp();
    const port = await listen(app);
    const bot = await fakeBot();
    const bw = bandwidthClient(port, bot.url);
    await upgradeStatus(bw.ws);

    bw.send(frames.start);
    for (const p of ["AAAA", "BBBB", "CCCC"]) bw.send({ ...frames.media, payload: p });

    await waitFor(() => bot.messages.filter((m) => m.event === "media").length === 3);
    expect(bot.messages.filter((m) => m.event === "media").map((m) => m.media.payload)).toEqual(["AAAA", "BBBB", "CCCC"]);
    // And they arrive after connected/start, never before.
    expect(bot.messages.findIndex((m) => m.event === "media")).toBeGreaterThan(1);

    bw.ws.close();
    bot.close();
    await app.close();
  });

  it("ends the Bandwidth stream when the bot closes its socket", async () => {
    const app = makeApp();
    const port = await listen(app);
    const bot = await fakeBot();
    const bw = bandwidthClient(port, bot.url);
    await upgradeStatus(bw.ws);
    bw.send(frames.start);
    const botWs = await bot.socket;
    await waitFor(() => bot.messages.length >= 2);

    const bwClosed = new Promise((r) => bw.ws.once("close", r));
    botWs.close();
    await bwClosed;

    bot.close();
    await app.close();
  });

  it("ends the Bandwidth stream when the bot cannot be reached", async () => {
    const app = makeApp();
    const port = await listen(app);
    // Nothing listens on this port; the bridge's connect fails.
    const bw = bandwidthClient(port, "ws://127.0.0.1:1/bot");
    await upgradeStatus(bw.ws);
    const bwClosed = new Promise((r) => bw.ws.once("close", r));
    bw.send(frames.start);
    await bwClosed;
    await app.close();
  });

  it("closes a socket that sends no start event within the timeout", async () => {
    const app = makeApp();
    const port = await listen(app);
    const bot = await fakeBot();
    const bw = bandwidthClient(port, bot.url);
    await upgradeStatus(bw.ws);
    const openedAt = Date.now();
    await new Promise((r) => bw.ws.once("close", r));
    expect(Date.now() - openedAt).toBeGreaterThanOrEqual(250);
    expect(Date.now() - openedAt).toBeLessThan(2000);
    bot.close();
    await app.close();
  });
});

describe("/bw/stream upgrade gate", () => {
  it("rejects an upgrade without the webhook credentials (401)", async () => {
    const app = makeApp();
    const port = await listen(app);
    const bw = bandwidthClient(port, "ws://127.0.0.1:9/bot", {});
    expect(await upgradeStatus(bw.ws)).toBe(401);
    const wrong = bandwidthClient(port, "ws://127.0.0.1:9/bot", {
      authorization: "Basic " + Buffer.from("u:wrong").toString("base64"),
    });
    expect(await upgradeStatus(wrong.ws)).toBe(401);
    await app.close();
  });

  it("rejects a missing dest (400)", async () => {
    const app = makeApp();
    const port = await listen(app);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bw/stream`, { headers: { authorization: webhookAuth } });
    expect(await upgradeStatus(ws)).toBe(400);
    await app.close();
  });

  it("rejects a dest that is not a WebSocket URL (400)", async () => {
    const app = makeApp();
    const port = await listen(app);
    const bw = bandwidthClient(port, "https://bot.example/audio");
    expect(await upgradeStatus(bw.ws)).toBe(400);
    await app.close();
  });

  it("rejects a private-network dest when private egress is not allowed (400)", async () => {
    const app = makeApp(config({ allowPrivateEgress: false }));
    const port = await listen(app);
    const bw = bandwidthClient(port, "ws://127.0.0.1:9/bot");
    expect(await upgradeStatus(bw.ws)).toBe(400);
    await app.close();
  });

  it("rejects an upgrade on any other path (404)", async () => {
    const app = makeApp();
    const port = await listen(app);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bw/other?dest=ws%3A%2F%2Fx`, { headers: { authorization: webhookAuth } });
    expect(await upgradeStatus(ws)).toBe(404);
    await app.close();
  });
});

describe("translator side of the stream route", () => {
  it("rewrites a Connect/Stream destination to wss://<public>/bw/stream?dest=<bot> and stamps destination creds", async () => {
    const app = makeApp(config(), {
      "https://customer.test/voice": `<Response><Connect><Stream url="wss://bot.example/audio"><Parameter name="k" value="v"/></Stream></Connect></Response>`,
    });
    const res = await app.inject({
      method: "POST",
      url: "/bw/initiate",
      headers: { authorization: webhookAuth },
      payload: { eventType: "initiate", callId: "c-stream-1", from: "+1", to: "+2", direction: "inbound" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`destination="wss://translator.test/bw/stream?dest=wss%3A%2F%2Fbot.example%2Faudio"`);
    expect(res.body).toContain(`destinationUsername="u"`);
    expect(res.body).toContain(`destinationPassword="p"`);
    expect(res.body).toContain(`<StreamParam name="k" value="v"/>`);
    expect(res.body).toContain(`<StopStream name="connect-stream-1" wait="true"/>`);
  });

  it("uses ws:// when PUBLIC_BASE_URL is plain http (local dev)", async () => {
    const app = makeApp(config({ publicBaseUrl: "http://localhost:3000" }), {
      "https://customer.test/voice": `<Response><Connect><Stream url="wss://bot.example/audio"/></Connect></Response>`,
    });
    const res = await app.inject({
      method: "POST",
      url: "/bw/initiate",
      headers: { authorization: webhookAuth },
      payload: { eventType: "initiate", callId: "c-stream-2", from: "+1", to: "+2", direction: "inbound" },
    });
    expect(res.body).toContain(`destination="ws://localhost:3000/bw/stream?dest=`);
  });
});

describe("stream frame capture", () => {
  it("writes start, media, and stop frames to <captureDir>/streams/*.jsonl when captureDir is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stream-capture-"));
    try {
      const app = makeApp(config({ captureDir: dir }));
      const port = await listen(app);
      const bot = await fakeBot();
      const bw = bandwidthClient(port, bot.url);
      await upgradeStatus(bw.ws);
      bw.send(frames.start);
      const botWs = await bot.socket;
      bw.send(frames.media);
      const botClosed = new Promise((r) => botWs.once("close", r));
      bw.send(frames.stop);
      await botClosed;
      bw.ws.close();
      bot.close();
      await app.close();

      const files = readdirSync(join(dir, "streams"));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^[0-9a-f]{16}\.jsonl$/);
      const lines = readFileSync(join(dir, "streams", files[0]), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(lines.map((l) => l.eventType)).toEqual(["start", "media", "stop"]);
      expect(lines[0].metadata.streamId).toBe(frames.start.metadata.streamId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
