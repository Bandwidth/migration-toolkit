import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "../src/server/app.js";

// The real Bandwidth initiate webhook, captured live (test/fixtures/bandwidth/
// webhooks.json). Carries extra fields beyond what the adapter reads
// (privacy, applicationId, accountId, startTime, eventTime, callUrl,
// callerDisplayName). This proves those extras don't break the inbound path.
const bwFixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures/bandwidth/webhooks.json"), "utf8"),
);

describe("inbound path against the real captured BW initiate payload", () => {
  it("parses the live BW event shape and returns BXML", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(`<Response><Say>Hello</Say><Hangup/></Response>`, { status: 200 }),
    ) as unknown as typeof fetch;
    const app = buildApp(
      {
        accountSid: "ACtest",
        authToken: "tok",
        publicBaseUrl: "https://adapter.test",
        voiceUrl: "https://customer.test/voice",
      },
      { fetchImpl, bwClient: { createCall: vi.fn(), modifyCall: vi.fn(), getCall: vi.fn(), listRecordings: vi.fn() } },
    );

    const res = await app.inject({
      method: "POST",
      url: "/bw/initiate",
      headers: { "content-type": "application/json" },
      payload: bwFixture.initiateEvent, // full real shape, extra fields included
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/xml");
    expect(res.body).toContain("<SpeakSentence>Hello</SpeakSentence>");
    // confirm the field names we rely on are exactly the ones BW sends
    expect(bwFixture.initiateEvent.eventType).toBe("initiate");
    for (const f of ["callId", "from", "to", "direction"]) {
      expect(Object.keys(bwFixture.initiateEvent)).toContain(f);
    }
  });
});
