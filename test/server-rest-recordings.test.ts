import { describe, it, expect, vi } from "vitest";
import { Readable } from "node:stream";
import { buildApp } from "../src/server/app.js";
import type { CreateCallOpts, BwRecording } from "../src/bw/client.js";

const config = {
  accountSid: "AC123",
  authToken: "tok",
  publicBaseUrl: "https://adapter.test",
  voiceUrl: "https://customer.test/voice",
};
const auth = "Basic " + Buffer.from("AC123:tok").toString("base64");

const bwRecording: BwRecording = {
  recordingId: "r-1",
  callId: "c-out-1",
  to: "+15552223333",
  from: "+15550001111",
  direction: "outbound",
  channels: 1,
  duration: "PT13.67S",
  startTime: "2026-06-11T22:19:40.375Z",
  endTime: "2026-06-11T22:20:00.000Z",
  fileFormat: "wav",
  status: "complete",
};

function makeApp(recordings: BwRecording[]) {
  const bwClient = {
    createCall: vi.fn(async (_opts: CreateCallOpts) => ({ callId: "c-out-1" })),
    modifyCall: vi.fn(),
    getCall: vi.fn(),
    listRecordings: vi.fn(async (_callId: string) => recordings),
    getRecording: vi.fn(async (callId: string, recordingId: string) => ({
      ...bwRecording,
      callId,
      recordingId,
    })),
    getRecordingMedia: vi.fn(async (_callId: string, _recordingId: string) => ({
      body: Readable.from([Buffer.from("RIFFfakewavbytes")]),
      contentType: "audio/vnd.wave",
    })),
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

describe("GET /2010-04-01/Accounts/:sid/Calls/:callSid/Recordings.json", () => {
  it("lists a call's recordings in Twilio shape (RE sid, seconds duration)", async () => {
    const { app, bwClient } = makeApp([bwRecording]);
    const sid = await createCall(app);

    const res = await app.inject({
      method: "GET",
      url: `/2010-04-01/Accounts/AC123/Calls/${sid}/Recordings.json`,
      headers: { authorization: auth },
    });

    expect(res.statusCode).toBe(200);
    expect(bwClient.listRecordings).toHaveBeenCalledWith("c-out-1");
    const body = res.json();
    expect(body.uri).toBe(`/2010-04-01/Accounts/AC123/Calls/${sid}/Recordings.json`);
    expect(body.recordings).toHaveLength(1);
    const rec = body.recordings[0];
    expect(rec.sid).toMatch(/^RE[0-9a-f]{32}$/);
    expect(rec.call_sid).toBe(sid);
    expect(rec.duration).toBe("14"); // PT13.67S -> rounded seconds
    expect(rec.channels).toBe(1);
    expect(rec.status).toBe("completed"); // BW "complete" -> Twilio "completed"
    expect(rec.uri).toBe(`/2010-04-01/Accounts/AC123/Recordings/${rec.sid}.json`);
  });

  it("returns an empty list (not 404) for a call with no recordings", async () => {
    const { app } = makeApp([]);
    const sid = await createCall(app);
    const res = await app.inject({
      method: "GET",
      url: `/2010-04-01/Accounts/AC123/Calls/${sid}/Recordings.json`,
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().recordings).toEqual([]);
  });

  it("returns the live 404 body for an unknown call", async () => {
    const { app } = makeApp([]);
    const res = await app.inject({
      method: "GET",
      url: "/2010-04-01/Accounts/AC123/Calls/CA00000000000000000000000000000000/Recordings.json",
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe(20404);
  });
});

describe("GET /2010-04-01/Accounts/:sid/Recordings/:recordingSid", () => {
  // List first so the adapter learns recordingSid -> (callId, recordingId).
  async function listThenRecordingSid(app: ReturnType<typeof makeApp>["app"]) {
    const callSid = await createCall(app);
    const list = await app.inject({
      method: "GET",
      url: `/2010-04-01/Accounts/AC123/Calls/${callSid}/Recordings.json`,
      headers: { authorization: auth },
    });
    return list.json().recordings[0].sid as string;
  }

  it("fetches a single recording's metadata as a Twilio recording resource", async () => {
    const { app, bwClient } = makeApp([bwRecording]);
    const recordingSid = await listThenRecordingSid(app);

    const res = await app.inject({
      method: "GET",
      url: `/2010-04-01/Accounts/AC123/Recordings/${recordingSid}.json`,
      headers: { authorization: auth },
    });

    expect(res.statusCode).toBe(200);
    expect(bwClient.getRecording).toHaveBeenCalledWith("c-out-1", "r-1");
    expect(res.json().sid).toBe(recordingSid);
    expect(res.json().status).toBe("completed");
  });

  it("streams the recording media bytes with the upstream content-type", async () => {
    const { app, bwClient } = makeApp([bwRecording]);
    const recordingSid = await listThenRecordingSid(app);

    const res = await app.inject({
      method: "GET",
      url: `/2010-04-01/Accounts/AC123/Recordings/${recordingSid}.wav`,
      headers: { authorization: auth },
    });

    expect(res.statusCode).toBe(200);
    expect(bwClient.getRecordingMedia).toHaveBeenCalledWith("c-out-1", "r-1");
    expect(res.headers["content-type"]).toContain("audio/vnd.wave");
    expect(res.rawPayload.toString()).toBe("RIFFfakewavbytes");
  });

  it("returns the live 404 body for an unknown recording", async () => {
    const { app } = makeApp([]);
    const res = await app.inject({
      method: "GET",
      url: "/2010-04-01/Accounts/AC123/Recordings/RE00000000000000000000000000000000.json",
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe(20404);
  });
});
