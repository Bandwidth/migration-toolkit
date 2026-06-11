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
 */
export interface BwStreamSource extends EventEmitter {
  sendMedia(payloadB64: string): void;
  flush(): void;
  close(): void;
}

export interface BridgeOpts {
  botUrl: string;
  callSid: string;
  accountSid: string;
  /** Optional key/value pairs forwarded verbatim in the TwiML <Stream> start message. */
  customParameters?: Record<string, string>;
  source: BwStreamSource;
}

export class TwilioStreamBridge {
  readonly streamSid: string;
  private ws: WebSocket;
  /** Monotonically increasing counter for every message sent to the bot. */
  private seq = 0;
  /** Monotonically increasing counter for media frames only (chunk field). */
  private chunkSeq = 0;
  private readyPromise: Promise<void>;

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

    // BW network → bot: stream ended
    opts.source.on("stop", () => {
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
          // Bot is sending audio to be played out on the call
          if (msg.media && typeof (msg.media as any).payload === "string") {
            this.opts.source.sendMedia((msg.media as any).payload as string);
          }
          break;

        case "mark":
          // Echo the mark back to acknowledge playback completion.
          // Real playout tracking comes with the live BW binding.
          this.send({ event: "mark", streamSid: this.streamSid, mark: (msg as any).mark });
          break;

        case "clear":
          // Flush buffered audio on the BW source's playout queue
          this.opts.source.flush();
          break;
      }
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
