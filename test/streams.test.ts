import { describe, it, expect } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { EventEmitter } from "node:events";
import { TwilioStreamBridge, type BwStreamSource } from "../src/streams/bridge.js";

class FakeBwSource extends EventEmitter implements BwStreamSource {
  sent: string[] = [];
  sendMedia(payloadB64: string): void {
    this.sent.push(payloadB64);
  }
  flush(): void {}
  close(): void {}
}

// Distinct from streams-wire.test.ts (8200+) to avoid EADDRINUSE under parallel runs.
const PORT = 8190;

function collectBot(
  port: number,
): Promise<{ messages: any[]; socket: Promise<WebSocket>; close: () => void }> {
  return new Promise((resolve) => {
    const messages: any[] = [];
    const wss = new WebSocketServer({ port });
    const socket = new Promise<WebSocket>((res) => {
      wss.on("connection", (ws) => {
        ws.on("message", (d) => messages.push(JSON.parse(String(d))));
        res(ws);
      });
    });
    wss.on("listening", () => resolve({ messages, socket, close: () => wss.close() }));
  });
}

describe("TwilioStreamBridge", () => {
  it("performs connected/start handshake and forwards media both ways", async () => {
    const { messages, socket, close } = await collectBot(PORT);
    const source = new FakeBwSource();
    const bridge = new TwilioStreamBridge({
      botUrl: `ws://127.0.0.1:${PORT}`,
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
    expect(messages[1].start.mediaFormat).toMatchObject({
      encoding: "audio/x-mulaw",
      sampleRate: 8000,
    });
    expect(messages[1].streamSid).toMatch(/^MZ/);
    expect(messages[2]).toMatchObject({ event: "media", media: { payload: "AAAA" } });

    bot.send(JSON.stringify({ event: "media", media: { payload: "BBBB" } }));
    await new Promise((r) => setTimeout(r, 100));
    expect(source.sent).toEqual(["BBBB"]);

    bridge.close();
    close();
  });
});
