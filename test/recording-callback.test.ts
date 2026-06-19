import { describe, it, expect, vi } from "vitest";
import { translateTwiml, type UrlKind } from "../src/translator/translate.js";
import { buildApp } from "../src/server/app.js";
import type { CreateCallOpts } from "../src/bw/client.js";

// Kind-aware rewriter mirroring the one in src/server/app.ts.
const rw = (url: string, kind: UrlKind) =>
  kind === "recordingStatus"
    ? `https://adapter.test/bw/recording-status?cb=${encodeURIComponent(url)}`
    : `https://adapter.test/bw/continue?next=${encodeURIComponent(url)}`;

describe("Record recordingStatusCallback → recordingAvailableUrl", () => {
  it("maps the async recording callback onto Bandwidth's recordingAvailableUrl", () => {
    const r = translateTwiml(
      `<Response><Record action="/done" recordingStatusCallback="/rec-ready"/></Response>`,
      { rewriteUrl: rw },
    );
    expect(r.bxml).toContain(`recordCompleteUrl="https://adapter.test/bw/continue?next=%2Fdone"`);
    expect(r.bxml).toContain(
      `recordingAvailableUrl="https://adapter.test/bw/recording-status?cb=%2Frec-ready"`,
    );
    expect(r.hasErrors).toBe(false);
  });

  it("warns that a GET recordingStatusCallbackMethod is not honored", () => {
    const r = translateTwiml(
      `<Response><Record recordingStatusCallback="/r" recordingStatusCallbackMethod="GET"/></Response>`,
      { rewriteUrl: rw },
    );
    expect(r.findings.some((f) => f.severity === "warning" && /GET/.test(f.message))).toBe(true);
  });
});

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
  const fetchImpl = vi.fn(async () => new Response("", { status: 200 })) as unknown as typeof fetch;
  const app = buildApp(config, { fetchImpl, bwClient });
  return { app, fetchImpl: fetchImpl as ReturnType<typeof vi.fn> };
}

async function seedCall(app: ReturnType<typeof makeApp>["app"]) {
  await app.inject({
    method: "POST",
    url: "/2010-04-01/Accounts/AC123/Calls.json",
    headers: { authorization: auth },
    payload: { To: "+15552223333", From: "+15550001111", Url: "https://customer.test/outbound" },
  });
}

describe("POST /bw/recording-status (recording-available egress)", () => {
  it("forwards a Twilio-shaped recording callback to the customer URL", async () => {
    const { app, fetchImpl } = makeApp();
    await seedCall(app);

    const res = await app.inject({
      method: "POST",
      url: "/bw/recording-status?cb=" + encodeURIComponent("https://customer.test/rec-ready"),
      payload: {
        eventType: "recordingAvailable",
        callId: "c-out-1",
        recordingId: "r-abc",
        duration: "PT12S",
        status: "complete",
      },
    });

    expect(res.statusCode).toBe(204);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://customer.test/rec-ready");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("RecordingSid")).toMatch(/^RE[0-9a-f]{32}$/);
    expect(body.get("RecordingStatus")).toBe("completed");
    expect(body.get("RecordingDuration")).toBe("12");
    expect(body.get("CallSid")).toMatch(/^CA[0-9a-f]{32}$/);
    // RecordingUrl points back at the adapter's own facade, not Bandwidth.
    expect(body.get("RecordingUrl")).toContain(
      "https://adapter.test/2010-04-01/Accounts/AC123/Recordings/RE",
    );
    expect((init.headers as Record<string, string>)["X-Twilio-Signature"]).toBeTruthy();
  });

  it("204s without forwarding when the call is unknown", async () => {
    const { app, fetchImpl } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/bw/recording-status?cb=" + encodeURIComponent("https://customer.test/rec-ready"),
      payload: { callId: "nope", recordingId: "r-x" },
    });
    expect(res.statusCode).toBe(204);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
