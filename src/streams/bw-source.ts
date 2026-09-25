import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import type { BwStreamSource } from "./bridge.js";

/**
 * The Bandwidth side of the Media Streams bridge: a BwStreamSource over the
 * WebSocket Bandwidth opens to a <StartStream destination> (VAPI-3991).
 *
 * Protocol (StartStream docs, confirmed on real calls 2026-09-17), all JSON:
 *
 *   Bandwidth → us
 *     { eventType: "start", metadata: { accountId, callId, streamId, streamName,
 *         tracks: [{ name, mediaFormat: { encoding: "PCMU", sampleRate: 8000 } }] },
 *       streamParams?: { name: value } }
 *     { eventType: "media", track: "inbound" | "outbound", payload: <base64 PCMU>,
 *       sequenceNumber: "1" }
 *     { eventType: "stop", metadata: { ...same shape as start } }
 *
 *   us → Bandwidth (bidirectional streams only)
 *     { eventType: "playAudio", media: { contentType: "audio/pcmu", payload } }
 *     { eventType: "clear" }
 *
 * Bandwidth does not deliver DTMF over this socket (it arrives via BXML Gather
 * webhooks), so this source never emits "dtmf".
 *
 * Only the "inbound" track (the caller) is relayed: the bridge presents a single
 * inbound track to the bot, matching what the translator emits (tracks="inbound").
 * Outbound-track frames, if a BXML author asked for them, are ignored.
 *
 * Media that arrives before release() is buffered (bounded), so the server can
 * wait for the bot's WebSocket to open before the first caller audio flows and
 * nothing said in the first few hundred milliseconds is lost.
 */

export interface BwStreamTrack {
  name: string;
  mediaFormat?: { encoding?: string; sampleRate?: number };
}

export interface BwStreamStart {
  accountId: string;
  callId: string;
  streamId: string;
  streamName: string;
  tracks: BwStreamTrack[];
  /** <StreamParam/> values echoed by Bandwidth, as a flat map. */
  streamParams: Record<string, string>;
  /** The start event exactly as received (input to customParametersFromBwStart). */
  raw: unknown;
}

export interface BwWebSocketSourceOpts {
  /** Receives every inbound frame's raw text before parsing; used for fixture capture. */
  onFrame?: (raw: string) => void;
}

/** Frames of caller audio held before release(): 500 × 20 ms = 10 s, oldest dropped first. */
const MAX_BUFFERED_FRAMES = 500;

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

function parseStart(msg: Record<string, unknown>): BwStreamStart {
  const md = (msg.metadata ?? {}) as Record<string, unknown>;
  const tracks: BwStreamTrack[] = Array.isArray(md.tracks)
    ? (md.tracks as unknown[]).flatMap((t) => {
        if (!t || typeof t !== "object") return [];
        const tr = t as Record<string, unknown>;
        const mf = (tr.mediaFormat ?? undefined) as Record<string, unknown> | undefined;
        return [
          {
            name: str(tr.name),
            ...(mf ? { mediaFormat: { encoding: str(mf.encoding), sampleRate: Number(mf.sampleRate) || undefined } } : {}),
          },
        ];
      })
    : [];
  const streamParams: Record<string, string> = Object.create(null);
  const sp = msg.streamParams;
  if (sp && typeof sp === "object" && !Array.isArray(sp)) {
    for (const [k, v] of Object.entries(sp as Record<string, unknown>)) {
      if (typeof v === "string") streamParams[k] = v;
      else if (typeof v === "number" || typeof v === "boolean") streamParams[k] = String(v);
    }
  }
  return {
    accountId: str(md.accountId),
    callId: str(md.callId),
    streamId: str(md.streamId),
    streamName: str(md.streamName),
    tracks,
    streamParams,
    raw: msg,
  };
}

export class BwWebSocketSource extends EventEmitter implements BwStreamSource {
  /** Set once Bandwidth's start event has been parsed. */
  start: BwStreamStart | undefined;
  private released = false;
  private buffered: string[] = [];
  private stopped = false;

  constructor(
    private ws: WebSocket,
    private opts: BwWebSocketSourceOpts = {},
  ) {
    super();
    ws.on("message", (data) => this.onMessage(String(data)));
    // "close" always follows "error" on ws; nothing to do here except keep an
    // unhandled error from crashing the process.
    ws.on("error", () => {});
    ws.on("close", () => this.emitStop());
  }

  /**
   * Resolve with the parsed start event, or reject if the socket closes or
   * `timeoutMs` passes first. Bandwidth sends start as its first frame, so a
   * timeout means whatever connected is not a Bandwidth stream.
   */
  waitForStart(timeoutMs: number): Promise<BwStreamStart> {
    if (this.start) return Promise.resolve(this.start);
    if (this.stopped) return Promise.reject(new Error("stream closed before start"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`no start event within ${timeoutMs} ms`));
      }, timeoutMs);
      const onStart = (s: BwStreamStart) => {
        cleanup();
        resolve(s);
      };
      const onStop = () => {
        cleanup();
        reject(new Error("stream closed before start"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off("start", onStart);
        this.off("stop", onStop);
      };
      this.once("start", onStart);
      this.once("stop", onStop);
    });
  }

  /** Start emitting "media"; frames received so far are emitted first, in order. */
  release(): void {
    if (this.released) return;
    this.released = true;
    const pending = this.buffered;
    this.buffered = [];
    for (const p of pending) this.emit("media", p);
  }

  /** Frames of caller audio currently held back (0 once released). */
  bufferedFrames(): number {
    return this.buffered.length;
  }

  sendMedia(payloadB64: string): void {
    this.sendJson({ eventType: "playAudio", media: { contentType: "audio/pcmu", payload: payloadB64 } });
  }

  flush(): void {
    this.sendJson({ eventType: "clear" });
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
  }

  private sendJson(obj: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private onMessage(raw: string): void {
    this.opts.onFrame?.(raw);
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // not one of ours; ignore rather than tear the stream down
    }
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;
    switch (m.eventType) {
      case "start":
        this.start = parseStart(m);
        this.emit("start", this.start);
        break;
      case "media": {
        if (typeof m.payload !== "string") return;
        if (m.track !== undefined && m.track !== "inbound") return;
        if (this.released) {
          this.emit("media", m.payload);
        } else {
          if (this.buffered.length >= MAX_BUFFERED_FRAMES) this.buffered.shift();
          this.buffered.push(m.payload);
        }
        break;
      }
      case "stop":
        this.emitStop();
        break;
    }
  }

  private emitStop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.emit("stop");
  }
}
