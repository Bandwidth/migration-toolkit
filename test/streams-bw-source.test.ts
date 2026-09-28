/**
 * BwWebSocketSource: the Bandwidth side of the Media Streams bridge (VAPI-3991).
 *
 * Pattern: a local WebSocketServer stands in for the translator's /bw/stream
 * endpoint and a ws client plays "Bandwidth", sending the frames in
 * test/fixtures/bandwidth/stream-frames.json.
 */
import { describe, it, expect } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { BwWebSocketSource, type BwWebSocketSourceOpts } from "../src/streams/bw-source.js";
import { customParametersFromBwStart } from "../src/streams/bridge.js";

const frames = JSON.parse(
  readFileSync(new URL("./fixtures/bandwidth/stream-frames.json", import.meta.url), "utf8"),
);

async function pair(opts?: BwWebSocketSourceOpts) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  const port = (wss.address() as AddressInfo).port;
  const sourceP = new Promise<BwWebSocketSource>((res) =>
    wss.once("connection", (ws) => res(new BwWebSocketSource(ws, opts))),
  );
  const bandwidth = new WebSocket(`ws://127.0.0.1:${port}/bw/stream`);
  const received: any[] = [];
  bandwidth.on("message", (d) => received.push(JSON.parse(String(d))));
  await new Promise((r) => bandwidth.once("open", r));
  const source = await sourceP;
  const send = (obj: unknown) => bandwidth.send(typeof obj === "string" ? obj : JSON.stringify(obj));
  return {
    source,
    bandwidth,
    received,
    send,
    close: () => {
      bandwidth.close();
      wss.close();
    },
  };
}

async function waitFor(check: () => boolean, ms = 500): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("BwWebSocketSource: start", () => {
  it("parses the recorded start event: ids, tracks, and streamParams", async () => {
    const t = await pair();
    t.send(frames.start);
    const start = await t.source.waitForStart(1000);
    t.close();

    expect(start.accountId).toBe(frames.start.metadata.accountId);
    expect(start.callId).toBe(frames.start.metadata.callId);
    expect(start.streamId).toBe(frames.start.metadata.streamId);
    expect(start.streamName).toBe("connect-stream-1");
    expect(start.tracks).toEqual([{ name: "inbound", mediaFormat: { encoding: "PCMU", sampleRate: 8000 } }]);
    expect(start.streamParams).toEqual({ callSid: "CA123", tenant: "acme" });
    // The raw event feeds the bridge's customParameters mapper unchanged.
    expect(customParametersFromBwStart(start.raw)).toEqual({ callSid: "CA123", tenant: "acme" });
    expect(t.source.start).toBe(start);
  });

  it("tolerates a start event with no metadata or streamParams", async () => {
    const t = await pair();
    t.send({ eventType: "start" });
    const start = await t.source.waitForStart(1000);
    t.close();
    expect(start).toMatchObject({ accountId: "", callId: "", streamId: "", streamName: "", tracks: [] });
    expect(start.streamParams).toEqual({});
  });

  it("waitForStart resolves immediately if start already arrived", async () => {
    const t = await pair();
    t.send(frames.start);
    await waitFor(() => t.source.start !== undefined);
    const start = await t.source.waitForStart(1);
    t.close();
    expect(start.callId).toBe(frames.start.metadata.callId);
  });

  it("waitForStart rejects when no start arrives in time", async () => {
    const t = await pair();
    await expect(t.source.waitForStart(50)).rejects.toThrow(/no start event within 50 ms/);
    t.close();
  });

  it("waitForStart rejects when Bandwidth closes first", async () => {
    const t = await pair();
    const p = t.source.waitForStart(1000);
    t.bandwidth.close();
    await expect(p).rejects.toThrow(/closed before start/);
    t.close();
  });
});

describe("BwWebSocketSource: media (Bandwidth → bot)", () => {
  it("buffers inbound frames until release(), then emits them in order and streams the rest live", async () => {
    const t = await pair();
    const got: string[] = [];
    t.source.on("media", (p: string) => got.push(p));

    t.send({ ...frames.media, payload: "AAAA", sequenceNumber: "1" });
    t.send({ ...frames.media, payload: "BBBB", sequenceNumber: "2" });
    t.send({ ...frames.media, payload: "CCCC", sequenceNumber: "3" });
    await waitFor(() => t.source.bufferedFrames() === 3);
    expect(got).toEqual([]);

    t.source.release();
    expect(got).toEqual(["AAAA", "BBBB", "CCCC"]);
    expect(t.source.bufferedFrames()).toBe(0);

    t.send({ ...frames.media, payload: "DDDD", sequenceNumber: "4" });
    await waitFor(() => got.length === 4);
    t.close();
    expect(got[3]).toBe("DDDD");
  });

  it("relays the recorded media frame's payload verbatim", async () => {
    const t = await pair();
    const got: string[] = [];
    t.source.on("media", (p: string) => got.push(p));
    t.source.release();
    t.send(frames.media);
    await waitFor(() => got.length === 1);
    t.close();
    expect(got[0]).toBe(frames.media.payload);
    expect(Buffer.from(got[0], "base64")).toHaveLength(160); // 20 ms of PCMU
  });

  it("ignores outbound-track frames and frames without a string payload", async () => {
    const t = await pair();
    const got: string[] = [];
    t.source.on("media", (p: string) => got.push(p));
    t.source.release();
    t.send(frames.mediaOutbound);
    t.send({ eventType: "media", track: "inbound", payload: 123 });
    t.send({ eventType: "media", track: "inbound" });
    t.send({ ...frames.media, payload: "ZZZZ" });
    await waitFor(() => got.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    t.close();
    expect(got).toEqual(["ZZZZ"]);
  });

  it("drops the oldest buffered frames beyond the cap (10 s of audio)", async () => {
    const t = await pair();
    for (let i = 0; i < 505; i++) t.send({ ...frames.media, payload: `f${i}`, sequenceNumber: String(i + 1) });
    await waitFor(() => t.source.bufferedFrames() === 500, 2000);
    const got: string[] = [];
    t.source.on("media", (p: string) => got.push(p));
    t.source.release();
    t.close();
    expect(got).toHaveLength(500);
    expect(got[0]).toBe("f5");
    expect(got[499]).toBe("f504");
  });

  it("ignores non-JSON frames and unknown event types", async () => {
    const t = await pair();
    t.send("not json at all");
    t.send({ eventType: "somethingNew", data: 1 });
    t.send(frames.start);
    const start = await t.source.waitForStart(1000);
    t.close();
    expect(start.streamName).toBe("connect-stream-1");
  });
});

describe("BwWebSocketSource: stop", () => {
  it("emits stop exactly once for a stop event followed by the socket closing", async () => {
    const t = await pair();
    let stops = 0;
    t.source.on("stop", () => stops++);
    t.send(frames.stop);
    await waitFor(() => stops === 1);
    t.bandwidth.close();
    await new Promise((r) => setTimeout(r, 50));
    t.close();
    expect(stops).toBe(1);
  });

  it("emits stop when the socket closes without a stop event", async () => {
    const t = await pair();
    let stops = 0;
    t.source.on("stop", () => stops++);
    t.bandwidth.close();
    await waitFor(() => stops === 1);
    t.close();
    expect(stops).toBe(1);
  });
});

describe("BwWebSocketSource: bot → Bandwidth", () => {
  it("sendMedia becomes playAudio audio/pcmu and flush becomes clear", async () => {
    const t = await pair();
    t.source.sendMedia("QUJD");
    t.source.flush();
    await waitFor(() => t.received.length >= 2);
    t.close();
    expect(t.received[0]).toEqual({ eventType: "playAudio", media: { contentType: "audio/pcmu", payload: "QUJD" } });
    expect(t.received[1]).toEqual({ eventType: "clear" });
  });

  it("close() closes Bandwidth's socket and is safe to call twice", async () => {
    const t = await pair();
    const closed = new Promise((r) => t.bandwidth.once("close", r));
    t.source.close();
    t.source.close();
    await closed;
    t.close();
  });

  it("onFrame receives every raw frame before parsing", async () => {
    const raws: string[] = [];
    const t = await pair({ onFrame: (raw) => raws.push(raw) });
    t.send(frames.start);
    t.send("garbage");
    t.send(frames.media);
    await waitFor(() => raws.length === 3);
    t.close();
    expect(raws[0]).toContain('"eventType":"start"');
    expect(raws[1]).toBe("garbage");
    expect(raws[2]).toContain('"eventType":"media"');
  });
});
