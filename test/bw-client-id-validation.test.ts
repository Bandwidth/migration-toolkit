import { describe, it, expect, vi } from "vitest";
import { createBwClient, isSafeBwId } from "../src/bw/client.js";

// Guards against path/argument injection: ids planted via webhooks must not be
// able to reshape the authenticated Bandwidth API request path. The client
// rejects unsafe ids before constructing the URL (encodeURIComponent alone does
// NOT neutralize "." / ".." path segments).

function fetchWithToken() {
  return vi.fn(async (url: string) => {
    if (String(url).endsWith("/api/v1/oauth2/token"))
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    return new Response(JSON.stringify({ state: "active" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}
const base = { accountId: "9900", clientId: "C", clientSecret: "s", applicationId: "app", environment: "prod" as const };

const BAD = "..";

// Every method that interpolates an id into the upstream URL, invoked with an
// unsafe id in each id position.
const SINKS: Array<[string, (c: ReturnType<typeof createBwClient>) => Promise<unknown>]> = [
  ["modifyCall(callId)", (c) => c.modifyCall(BAD, { state: "completed" })],
  ["getCall(callId)", (c) => c.getCall(BAD)],
  ["listRecordings(callId)", (c) => c.listRecordings(BAD)],
  ["getRecording(callId)", (c) => c.getRecording(BAD, "r-1")],
  ["getRecording(recordingId)", (c) => c.getRecording("c-1", BAD)],
  ["getRecordingMedia(callId)", (c) => c.getRecordingMedia(BAD, "r-1")],
  ["getRecordingMedia(recordingId)", (c) => c.getRecordingMedia("c-1", BAD)],
  ["updateRecording(callId)", (c) => c.updateRecording(BAD, "paused")],
];

describe("bw client rejects unsafe identifiers at every sink", () => {
  for (const [label, call] of SINKS) {
    it(`${label} throws and makes NO network call`, async () => {
      const fetchImpl = fetchWithToken();
      const client = createBwClient({ ...base, fetchImpl });
      await expect(call(client)).rejects.toThrow(/Invalid Bandwidth identifier/);
      expect(fetchImpl).not.toHaveBeenCalled(); // rejected before token fetch or API call
    });
  }
});

describe("isSafeBwId", () => {
  it("rejects path syntax, reserved chars, empty, and over-long ids", () => {
    for (const id of [".", "..", "../secret", "a/b", "a?b", "a#b", "a@b", "a%2Fb", "", "c 1", "a".repeat(257), 5 as unknown as string])
      expect(isSafeBwId(id)).toBe(false);
  });
  it("accepts real Bandwidth id shapes", () => {
    for (const id of ["c-95ac8d6e-1a2b-4c3d", "r-1", "abc123", "A_B-9"]) expect(isSafeBwId(id)).toBe(true);
  });
});
