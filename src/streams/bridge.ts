import { WebSocket } from "ws";
import { randomBytes } from "node:crypto";
import type { EventEmitter } from "node:events";

/**
 * Abstraction over the Bandwidth side of a media stream. The live StartStream
 * WS schema binding lands once fixtures are captured against a real account;
 * tests use a fake. Emits "media" (base64 mulaw payload) and "stop".
 *
 * flush() is called when the bot sends a Twilio "clear" event, signalling that
 * buffered audio on the playout queue should be discarded.
 *
 * There is deliberately no playback-complete signal here: Bandwidth's
 * StartStream protocol does not send one. The bridge tracks playout by
 * duration instead (see TwilioStreamBridge.pendingPlayoutMs).
 */

/** Bytes of 8 kHz mono mulaw per millisecond of audio: 8000 samples/s, 1 byte each. */
const MULAW_BYTES_PER_MS = 8;

/** Milliseconds of playback represented by a base64-encoded mulaw payload. */
export function mulawPayloadDurationMs(payloadB64: string): number {
  return Buffer.from(payloadB64, "base64").length / MULAW_BYTES_PER_MS;
}
export interface BwStreamSource extends EventEmitter {
  sendMedia(payloadB64: string): void;
  flush(): void;
  close(): void;
}

export interface BridgeOpts {
  botUrl: string;
  callSid: string;
  accountSid: string;
  /** Key/value pairs forwarded verbatim as `customParameters` in the Twilio
   *  "start" message. These are the TwiML <Stream><Parameter> values, which the
   *  translator emits as <StreamParam/> and Bandwidth echoes back in its own
   *  "start" event as `streamParams`; build them with customParametersFromBwStart. */
  customParameters?: Record<string, string>;
  source: BwStreamSource;
}

/**
 * Map Bandwidth's StartStream WebSocket "start" event to Twilio `customParameters`.
 *
 * Bandwidth copies every <StreamParam name value/> under the <StartStream> into
 * the start event as `streamParams: { name: value, ... }` (a flat map, per the
 * StartStream docs). Twilio delivers the same data as `start.customParameters`,
 * also a flat string map, so the mapping is a copy with primitive values
 * coerced to strings. Nested objects and arrays are not in the documented
 * shape and are skipped rather than forwarded as "[object Object]". Anything
 * that is not a plain object yields an empty map; a bot always receives a
 * `customParameters` object, never undefined.
 */
export function customParametersFromBwStart(event: unknown): Record<string, string> {
  const params = (event as { streamParams?: unknown } | null)?.streamParams;
  if (params === null || typeof params !== "object" || Array.isArray(params)) return {};
  // Null prototype so a key literally named "__proto__" is stored as an own
  // property instead of hitting the Object.prototype setter and vanishing.
  const out: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
}

export class TwilioStreamBridge {
  readonly streamSid: string;
  private ws: WebSocket;
  /** Monotonically increasing counter for every message sent to the bot. */
  private seq = 0;
  /** Monotonically increasing counter for media frames only (chunk field). */
  private chunkSeq = 0;
  private readyPromise: Promise<void>;

  // ── Playout clock ────────────────────────────────────────────────────────
  // Twilio returns a bot's "mark" only once every media frame queued before it
  // has finished playing on the call. Bandwidth gives us no playback signal, so
  // we model the playout queue as a clock: each outbound frame extends
  // `playoutEndAt` by its mulaw duration, and a mark becomes due at whatever
  // `playoutEndAt` was when the mark arrived. Audio queued after a mark does not
  // delay it. Marks are due in arrival order because the clock only moves
  // forward between clears.
  private playoutEndAt = 0;
  private pendingMarks: { mark: unknown; dueAt: number }[] = [];
  private markTimer: NodeJS.Timeout | undefined;

  constructor(private opts: BridgeOpts) {
    this.streamSid = "MZ" + randomBytes(16).toString("hex");
    this.ws = new WebSocket(opts.botUrl);
    this.readyPromise = new Promise((resolve, reject) => {
      this.ws.on("open", () => {
        // 1. connected — protocol handshake (no sequenceNumber per Twilio spec)
        this.send({ event: "connected", protocol: "Call", version: "1.0.0" });

        // 2. start — full metadata including customParameters
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
            customParameters: opts.customParameters ?? {},
          },
        });
        resolve();
      });
      this.ws.on("error", reject);
    });

    // BW network → bot: relay media frames with correct framing
    opts.source.on("media", (payloadB64: string) => {
      const chunk = ++this.chunkSeq;
      this.send({
        event: "media",
        sequenceNumber: String(++this.seq),
        streamSid: this.streamSid,
        media: {
          track: "inbound",
          chunk: String(chunk),
          timestamp: String(Date.now()),
          payload: payloadB64,
        },
      });
    });

    // BW network → bot: caller pressed a digit. Per Twilio's Media Streams
    // protocol, "dtmf" flows toward the bot (same direction as media/stop),
    // NOT from the bot. The BW source emits "dtmf" with { track, digit }.
    opts.source.on("dtmf", (payload: { track?: string; digit: string }) => {
      this.send({
        event: "dtmf",
        sequenceNumber: String(++this.seq),
        streamSid: this.streamSid,
        dtmf: { track: payload.track ?? "inbound_track", digit: payload.digit },
      });
    });

    // BW network → bot: stream ended. Anything still queued will never play.
    opts.source.on("stop", () => {
      this.dropPendingMarks();
      this.send({
        event: "stop",
        sequenceNumber: String(++this.seq),
        streamSid: this.streamSid,
        stop: {
          accountSid: opts.accountSid,
          callSid: opts.callSid,
        },
      });
      this.ws.close();
    });

    // Bot → bridge inbound message handler. The bot only ever sends
    // media / mark / clear back to us (per Twilio's protocol).
    this.ws.on("message", (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        // Malformed frame from the bot — ignore rather than crash the process.
        return;
      }

      switch ((msg as any).event) {
        case "media":
          // Bot is sending audio to be played out on the call. Extend the
          // playout clock by the frame's duration before handing it on.
          if (msg.media && typeof (msg.media as any).payload === "string") {
            const payload = (msg.media as any).payload as string;
            const now = Date.now();
            this.playoutEndAt = Math.max(now, this.playoutEndAt) + mulawPayloadDurationMs(payload);
            this.opts.source.sendMedia(payload);
          }
          break;

        case "mark":
          // Per Twilio: the mark comes back when the audio queued before it has
          // finished playing. Nothing queued means it comes back at once.
          this.pendingMarks.push({ mark: (msg as any).mark, dueAt: this.playoutEndAt });
          this.flushDueMarks();
          break;

        case "clear":
          // Per Twilio: "empties all buffered audio and causes any mark messages
          // to be sent back". Discard the queue, then return every outstanding
          // mark immediately so a mark-gated bot is not left waiting forever.
          this.opts.source.flush();
          this.playoutEndAt = 0;
          for (const p of this.pendingMarks) p.dueAt = 0;
          this.flushDueMarks();
          break;
      }
    });
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  /** Milliseconds of bot audio still to play on the call, by the playout clock. */
  pendingPlayoutMs(): number {
    return Math.max(0, this.playoutEndAt - Date.now());
  }

  close(): void {
    this.dropPendingMarks();
    this.opts.source.close();
    this.ws.close();
  }

  /** Echo every mark whose audio has played out, then arm one timer for the next. */
  private flushDueMarks(): void {
    if (this.markTimer) {
      clearTimeout(this.markTimer);
      this.markTimer = undefined;
    }
    const now = Date.now();
    while (this.pendingMarks.length && this.pendingMarks[0].dueAt <= now) {
      const { mark } = this.pendingMarks.shift()!;
      this.send({
        event: "mark",
        sequenceNumber: String(++this.seq),
        streamSid: this.streamSid,
        mark,
      });
    }
    if (this.pendingMarks.length) {
      const wait = this.pendingMarks[0].dueAt - now;
      this.markTimer = setTimeout(() => this.flushDueMarks(), wait);
      this.markTimer.unref?.();
    }
  }

  private dropPendingMarks(): void {
    if (this.markTimer) {
      clearTimeout(this.markTimer);
      this.markTimer = undefined;
    }
    this.pendingMarks = [];
    this.playoutEndAt = 0;
  }

  private send(obj: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }
}
