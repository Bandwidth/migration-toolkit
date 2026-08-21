import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildApp } from "../src/server/app.js";

// Regression coverage for the percent-encoding auth-bypass: the /bw/* auth hook
// must key on the router-matched route, so a raw target that find-my-way decodes
// into /bw/... cannot reach a handler without credentials.

const config = {
  accountSid: "AC123",
  authToken: "tok",
  publicBaseUrl: "https://translator.test",
  voiceUrl: "https://customer.test/voice",
  webhookUser: "bw-user",
  webhookPassword: "bw-pass",
  allowPrivateEgress: true,
};

let fetchImpl: ReturnType<typeof vi.fn>;
let bwClient: Record<string, ReturnType<typeof vi.fn>>;

function makeApp() {
  fetchImpl = vi.fn(async () => new Response("<Response><Hangup/></Response>", { status: 200 }));
  bwClient = {
    createCall: vi.fn(),
    modifyCall: vi.fn(),
    getCall: vi.fn(),
    listRecordings: vi.fn(),
    getRecording: vi.fn(),
    getRecordingMedia: vi.fn(),
    updateRecording: vi.fn(),
  };
  return buildApp(config, { fetchImpl: fetchImpl as unknown as typeof fetch, bwClient: bwClient as never });
}

const goodAuth = "Basic " + Buffer.from("bw-user:bw-pass").toString("base64");

// Raw targets that find-my-way percent-decodes into a /bw/* route. If the auth
// gate keyed on the raw URL, none of these would start with "/bw/" and would
// slip past unauthenticated.
const ENCODED_TARGETS = [
  "/%62%77/continue?next=https://customer.test/x", // %62%77 -> bw
  "/%62w/continue?next=https://customer.test/x", // partial: %62 -> b
  "/b%77/continue?next=https://customer.test/x", // partial: %77 -> w
  "/bw/%63ontinue?next=https://customer.test/x", // %63 -> c
  "/bw/continu%65?next=https://customer.test/x", // %65 -> e
  "/bw/co%6Etinue?next=https://customer.test/x", // uppercase hex %6E -> n (co+n+tinue); tests hex-digit case
  "/%62%77/initiate",
  "/%62%77/disconnect",
  "/%62%77/recording-status?cb=https://customer.test/x",
];

describe("/bw/* auth is immune to percent-encoding of the path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const target of ENCODED_TARGETS) {
    it(`rejects unauthenticated ${target} with 401 and no side effects`, async () => {
      const app = makeApp();
      const res = await app.inject({
        method: "POST",
        url: target,
        payload: { eventType: "gather", callId: "c-1", digits: "1", from: "+1", to: "+1", recordingId: "r-1" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers["www-authenticate"]).toContain("Basic");
      // No customer fetch and no Bandwidth API call may occur on an unauthenticated request.
      expect(fetchImpl).not.toHaveBeenCalled();
      for (const [, fn] of Object.entries(bwClient)) expect(fn).not.toHaveBeenCalled();
    });
  }

  it("still serves the canonical route with valid credentials", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/bw/continue?next=https://customer.test/x",
      headers: { authorization: goodAuth },
      payload: { eventType: "gather", callId: "c-1", digits: "1" },
    });
    expect(res.statusCode).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("still serves the encoded route WITH valid credentials (decode is honored, only auth was the gate)", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/%62%77/continue?next=https://customer.test/x",
      headers: { authorization: goodAuth },
      payload: { eventType: "gather", callId: "c-1", digits: "1" },
    });
    expect(res.statusCode).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not 401 an unmatched route (guard falls through when routeOptions.url is undefined)", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "POST", url: "/%62%77/not-a-route" });
    expect(res.statusCode).toBe(404);
  });

  it("authenticates before body parsing: malformed JSON without creds is 401, not 400", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/bw/continue?next=https://customer.test/x",
      headers: { "content-type": "application/json" },
      payload: "{ this is not valid json",
    });
    expect(res.statusCode).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("with valid creds, the same malformed JSON reaches the parser and returns 400", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/bw/continue?next=https://customer.test/x",
      headers: { authorization: goodAuth, "content-type": "application/json" },
      payload: "{ this is not valid json",
    });
    expect(res.statusCode).toBe(400);
  });
});
