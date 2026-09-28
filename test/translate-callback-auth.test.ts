import { describe, it, expect } from "vitest";
import { translateTwiml } from "../src/translator/translate.js";

const auth = { username: "bw-user", password: "bw-pass" };
const rewriteUrl = (u: string) => `https://translator.test/bw/continue?next=${encodeURIComponent(u)}`;

describe("callback auth stamping", () => {
  it("adds username/password to a Gather that has a rewritten action", () => {
    const { bxml } = translateTwiml(
      `<Response><Gather numDigits="1" action="https://c.test/menu"><Say>Hi</Say></Gather></Response>`,
      { rewriteUrl, callbackAuth: auth },
    );
    expect(bxml).toContain(`username="bw-user"`);
    expect(bxml).toContain(`password="bw-pass"`);
  });
  it("adds username/password to a Redirect", () => {
    const { bxml } = translateTwiml(`<Response><Redirect>https://c.test/next</Redirect></Response>`, { rewriteUrl, callbackAuth: auth });
    expect(bxml).toContain(`username="bw-user"`);
  });
  it("adds destinationUsername/destinationPassword to a StartStream (Bandwidth sends them on the WebSocket upgrade)", () => {
    const { bxml } = translateTwiml(
      `<Response><Connect><Stream url="wss://bot.test/ws"/></Connect></Response>`,
      { rewriteUrl: (u) => `wss://translator.test/bw/stream?dest=${encodeURIComponent(u)}`, callbackAuth: auth },
    );
    expect(bxml).toMatch(/<StartStream [^>]*destinationUsername="bw-user"[^>]*destinationPassword="bw-pass"/);
    // The StopStream that follows has no URL and gets nothing.
    expect(bxml).toMatch(/<StopStream name="connect-stream-1" wait="true"\/>/);
  });
  it("omits destination credentials from StartStream when callbackAuth is not provided", () => {
    const { bxml } = translateTwiml(`<Response><Connect><Stream url="wss://bot.test/ws"/></Connect></Response>`, { rewriteUrl });
    expect(bxml).not.toContain("destinationUsername=");
  });
  it("omits credentials when callbackAuth is not provided", () => {
    const { bxml } = translateTwiml(`<Response><Redirect>https://c.test/next</Redirect></Response>`, { rewriteUrl });
    expect(bxml).not.toContain("username=");
  });
});
