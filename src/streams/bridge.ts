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
        media: {
          track: "inbound",
          chunk: String(this.seq),
          timestamp: String(Date.now()),
          payload: payloadB64,
        },
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
