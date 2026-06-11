import { describe, it, expect, vi } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { CreateCallOpts, GetCallResult } from "../src/bw/client.js";

const config = {
  accountSid: "AC123",
  authToken: "tok",
  publicBaseUrl: "https://adapter.test",
  voiceUrl: "https://customer.test/voice",
};
const auth = "Basic " + Buffer.from("AC123:tok").toString("base64");

function makeApp(bwState: Partial<GetCallResult>) {
  const bwClient = {
    createCall: vi.fn(async (_opts: CreateCallOpts) => ({ callId: "c-out-1" })),
    modifyCall: vi.fn(),
    getCall: vi.fn(
      async (callId: string): Promise<GetCallResult> => ({
        callId,
        to: "+15552223333",
        from: "+15550001111",
        direction: "outbound",
        state: "active",
        ...bwState,
      }),
    ),
    listRecordings: vi.fn(),
    getRecording: vi.fn(),
    getRecordingMedia: vi.fn(),
  };
  const app = buildApp(config, { fetchImpl: fetch, bwClient });
  return { app, bwClient };
}

async function createCall(app: ReturnType<typeof makeApp>["app"]): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/2010-04-01/Accounts/AC123/Calls.json",
    headers: { authorization: auth },
    payload: { To: "+15552223333", From: "+15550001111", Url: "https://customer.test/outbound" },
  });
  return res.json().sid;
}

describe("GET /2010-04-01/Accounts/:sid/Calls/:callSid.json (fetch call)", () => {
  it("maps BW state 'active' to Twilio status 'in-progress'", async () => {
    const { app, bwClient } = makeApp({ state: "active" });
    const sid = await createCall(app);

    const res = await app.inject({
      method: "GET",
      url: `/2010-04-01/Accounts/AC123/Calls/${sid}.json`,
      headers: { authorization: auth },
    });

    expect(res.statusCode).toBe(200);
    expect(bwClient.getCall).toHaveBeenCalledWith("c-out-1");
    const body = res.json();
    expect(body.sid).toBe(sid);
    expect(body.status).toBe("in-progress");
  });

  it("maps BW state 'disconnected' to Twilio status 'completed' with timing", async () => {
    const { app } = makeApp({
      state: "disconnected",
      answerTime: "2026-06-11T13:15:18.126Z",
      endTime: "2026-06-11T13:15:28.126Z",
    });
    const sid = await createCall(app);

    const res = await app.inject({
      method: "GET",
      url: `/2010-04-01/Accounts/AC123/Calls/${sid}.json`,
      headers: { authorization: auth },
    });

    const body = res.json();
    expect(body.status).toBe("completed");
    expect(body.duration).toBe("10");
    expect(body.end_time).toMatch(/\+0000$/);
  });

  it("returns the live 404 body for an unknown CallSid", async () => {
    const { app } = makeApp({});
    const res = await app.inject({
      method: "GET",
      url: "/2010-04-01/Accounts/AC123/Calls/CA00000000000000000000000000000000.json",
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe(20404);
  });
});
