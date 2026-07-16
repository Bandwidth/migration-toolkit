import { describe, it, expect } from "vitest";
import { translateTwiml } from "../src/translator/translate.js";

const auth = { username: "bw-user", password: "bw-pass" };
const rewriteUrl = (u: string) => `https://adapter.test/bw/continue?next=${encodeURIComponent(u)}`;

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
  it("omits credentials when callbackAuth is not provided", () => {
    const { bxml } = translateTwiml(`<Response><Redirect>https://c.test/next</Redirect></Response>`, { rewriteUrl });
    expect(bxml).not.toContain("username=");
  });
});
