import { describe, it, expect, vi } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { CreateCallOpts, ModifyCallOpts } from "../src/bw/client.js";

const config = {
  accountSid: "AC123",
  authToken: "tok",
  publicBaseUrl: "https://adapter.test",
  voiceUrl: "https://customer.test/voice",
  webhookUser: "u",
  webhookPassword: "p",
};
const auth = "Basic " + Buffer.from("AC123:tok").toString("base64");

function makeApp() {
  const bwClient = {
    createCall: vi.fn(async (_opts: CreateCallOpts) => ({ callId: "c-out-1" })),
    modifyCall: vi.fn(async (_callId: string, _opts: ModifyCallOpts) => {}),
    getCall: vi.fn(),
    listRecordings: vi.fn(),
    getRecording: vi.fn(),
    getRecordingMedia: vi.fn(),
    updateRecording: vi.fn(),
  };
  const app = buildApp(config, { fetchImpl: fetch, bwClient });
  return { app, bwClient };
}

// Put a call in the adapter's store and return its Twilio CallSid.
async function createCall(app: ReturnType<typeof makeApp>["app"]): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/2010-04-01/Accounts/AC123/Calls.json",
    headers: { authorization: auth },
    payload: { To: "+15552223333", From: "+15550001111", Url: "https://customer.test/outbound" },
  });
  return res.json().sid;
}

describe("POST /2010-04-01/Accounts/:sid/Calls/:callSid.json (modify live call)", () => {
  it("Status=completed hangs up the underlying BW call", async () => {
    const { app, bwClient } = makeApp();
    const sid = await createCall(app);

    const res = await app.inject({
      method: "POST",
      url: `/2010-04-01/Accounts/AC123/Calls/${sid}.json`,
      headers: { authorization: auth },
      payload: { Status: "completed" },
    });

    expect(res.statusCode).toBe(200);
    expect(bwClient.modifyCall).toHaveBeenCalledWith("c-out-1", { state: "completed" });
    expect(res.json().sid).toBe(sid);
  });

  it("Url redirects the call through the adapter to the new customer TwiML", async () => {
    const { app, bwClient } = makeApp();
    const sid = await createCall(app);

    const res = await app.inject({
      method: "POST",
      url: `/2010-04-01/Accounts/AC123/Calls/${sid}.json`,
      headers: { authorization: auth },
      payload: { Url: "https://customer.test/step2" },
    });

    expect(res.statusCode).toBe(200);
    expect(bwClient.modifyCall).toHaveBeenCalledWith("c-out-1", {
      state: "active",
      redirectUrl: `https://adapter.test/bw/initiate?voiceUrl=${encodeURIComponent("https://customer.test/step2")}`,
      redirectMethod: "POST",
    });
  });

  it("returns the exact live 404 body for an unknown CallSid", async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/2010-04-01/Accounts/AC123/Calls/CA00000000000000000000000000000000.json",
      headers: { authorization: auth },
      payload: { Status: "completed" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      code: 20404,
      message:
        "The requested resource /2010-04-01/Accounts/AC123/Calls/CA00000000000000000000000000000000.json was not found",
      more_info: "https://www.twilio.com/docs/errors/20404",
      status: 404,
    });
  });

  it("rejects bad credentials with the live 401 body", async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/2010-04-01/Accounts/AC123/Calls/CAanything.json",
      headers: { authorization: "Basic " + Buffer.from("AC123:wrong").toString("base64") },
      payload: { Status: "completed" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe(20003);
  });
});
