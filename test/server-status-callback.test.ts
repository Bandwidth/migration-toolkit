import { describe, it, expect, vi } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { CreateCallOpts } from "../src/bw/client.js";

const config = {
  accountSid: "AC123",
  authToken: "tok",
  publicBaseUrl: "https://adapter.test",
  voiceUrl: "https://customer.test/voice",
};
const auth = "Basic " + Buffer.from("AC123:tok").toString("base64");

function makeApp() {
  const bwClient = {
    createCall: vi.fn(async (_opts: CreateCallOpts) => ({ callId: "c-out-1" })),
    modifyCall: vi.fn(),
    getCall: vi.fn(),
    listRecordings: vi.fn(),
    getRecording: vi.fn(),
    getRecordingMedia: vi.fn(),
    updateRecording: vi.fn(),
  };
  // Capture egress POSTs to the customer's statusCallback URL.
  const fetchImpl = vi.fn(async () => new Response("", { status: 200 })) as unknown as typeof fetch;
  const app = buildApp(config, { fetchImpl, bwClient });
  return { app, fetchImpl: fetchImpl as ReturnType<typeof vi.fn> };
}

async function createCallWithStatusCallback(app: ReturnType<typeof makeApp>["app"], cb?: string) {
  await app.inject({
    method: "POST",
    url: "/2010-04-01/Accounts/AC123/Calls.json",
    headers: { authorization: auth },
    payload: {
      To: "+15552223333",
      From: "+15550001111",
      Url: "https://customer.test/outbound",
      ...(cb ? { StatusCallback: cb } : {}),
    },
  });
}

describe("status callback egress on call completion", () => {
  it("POSTs Twilio-shaped completion params to the configured StatusCallback URL", async () => {
    const { app, fetchImpl } = makeApp();
    await createCallWithStatusCallback(app, "https://customer.test/status");

    const res = await app.inject({
      method: "POST",
      url: "/bw/disconnect",
      payload: {
        eventType: "disconnect",
        callId: "c-out-1",
        startTime: "2026-06-19T15:00:00Z",
        endTime: "2026-06-19T15:00:42Z",
      },
    });

    expect(res.statusCode).toBe(204);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://customer.test/status");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("CallStatus")).toBe("completed");
    expect(body.get("CallDuration")).toBe("42");
    expect(body.get("CallSid")).toMatch(/^CA[0-9a-f]{32}$/);
    expect((init.headers as Record<string, string>)["X-Twilio-Signature"]).toBeTruthy();
  });

  it("does not POST when no StatusCallback was configured", async () => {
    const { app, fetchImpl } = makeApp();
    await createCallWithStatusCallback(app); // no callback

    const res = await app.inject({
      method: "POST",
      url: "/bw/disconnect",
      payload: { eventType: "disconnect", callId: "c-out-1" },
    });

    expect(res.statusCode).toBe(204);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("still returns 204 if the customer status endpoint errors", async () => {
    const { app, fetchImpl } = makeApp();
    fetchImpl.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    await createCallWithStatusCallback(app, "https://customer.test/status");

    const res = await app.inject({
      method: "POST",
      url: "/bw/disconnect",
      payload: { eventType: "disconnect", callId: "c-out-1" },
    });

    expect(res.statusCode).toBe(204);
  });
});
