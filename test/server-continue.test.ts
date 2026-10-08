/**
 * VAPI-4041: /bw/continue answers each verb's action the way Twilio would.
 *
 *  - transferComplete -> Dial action params (DialCallStatus, DialBridged, and,
 *    once the dialed leg's transferDisconnect has landed on /bw/transfer-leg,
 *    DialCallSid and DialCallDuration).
 *  - recordComplete -> Record action params (RecordingUrl, RecordingSid,
 *    RecordingDuration) and the recording becomes fetchable by SID.
 *  - gather with no input -> resume the document after that Gather instead of
 *    requesting the action, unless actionOnEmptyResult="true".
 */
import { describe, it, expect, vi } from "vitest";
import { buildApp } from "../src/server/app.js";
import { toCallSid, toRecordingSid } from "../src/twilio/call-sid.js";

const webhookAuth = "Basic " + Buffer.from("u:p").toString("base64");
const restAuth = "Basic " + Buffer.from("AC123:tok").toString("base64");

function config(extra: Record<string, unknown> = {}) {
  return {
    accountSid: "AC123",
    authToken: "tok",
    publicBaseUrl: "https://translator.test",
    voiceUrl: "https://customer.test/voice",
    allowPrivateEgress: true,
    webhookUser: "u",
    webhookPassword: "p",
    transferLegWaitMs: 150,
    ...extra,
  };
}

function makeApp(twimlByUrl: Record<string, string>, cfg = config()) {
  const fetchImpl = vi.fn(async (url: any) => {
    const twiml = twimlByUrl[String(url)];
    return twiml ? new Response(twiml, { status: 200 }) : new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const bwClient = {
    createCall: vi.fn(),
    modifyCall: vi.fn(),
    getCall: vi.fn(),
    listRecordings: vi.fn(),
    getRecording: vi.fn(async (callId: string, recordingId: string) => ({
      recordingId,
      callId,
      to: "+2",
      from: "+1",
      direction: "inbound",
      channels: 1,
      duration: "PT12S",
      startTime: "2026-09-29T10:00:00Z",
      endTime: "2026-09-29T10:00:12Z",
      fileFormat: "wav",
      status: "complete",
    })),
    getRecordingMedia: vi.fn(),
    updateRecording: vi.fn(),
  };
  const app = buildApp(cfg, { fetchImpl, bwClient });
  /** Form body of the Nth customer POST, decoded. */
  const customerPost = (n: number) => {
    const call = (fetchImpl as any).mock.calls[n];
    if (!call) return undefined;
    const [url, init] = call;
    return { url: String(url), params: Object.fromEntries(new URLSearchParams(String(init.body))) };
  };
  const posts = () => (fetchImpl as any).mock.calls.length;
  return { app, customerPost, posts };
}

const bwEvent = (callId: string, extra: Record<string, unknown>) => ({
  callId,
  from: "+15550001111",
  to: "+15552223333",
  direction: "inbound",
  ...extra,
});

async function initiate(app: any, callId: string) {
  return app.inject({
    method: "POST",
    url: "/bw/initiate",
    headers: { authorization: webhookAuth },
    payload: { eventType: "initiate", ...bwEvent(callId, {}) },
  });
}

const continueUrl = (next: string, extra = "") => `/bw/continue?next=${encodeURIComponent(next)}${extra}`;

const unescape = (s: string) => s.replace(/&amp;/g, "&");
/** Path+query of an absolute translator URL, for app.inject. */
const pathOf = (url: string) => new URL(url).pathname + new URL(url).search;

/** Each Transfer in a BXML body: its transferCompleteUrl and its targets' transferDisconnectUrls. */
function dialUrls(bxml: string) {
  return [...bxml.matchAll(/<Transfer transferCompleteUrl="([^"]+)"[^>]*>(.*?)<\/Transfer>/g)].map((m) => ({
    complete: unescape(m[1]),
    legs: [...m[2].matchAll(/transferDisconnectUrl="([^"]+)"/g)].map((l) => unescape(l[1])),
  }));
}

// ─── Dial action ─────────────────────────────────────────────────────────────

describe("/bw/continue transferComplete -> Dial action", () => {
  const AFTER = "https://customer.test/after";
  const docs = {
    "https://customer.test/voice": `<Response><Dial action="/after"><Number>+15552223333</Number></Dial></Response>`,
    [AFTER]: `<Response><Say>After dial</Say></Response>`,
  };

  it("emits transferDisconnectUrl on the dialed number pointing at /bw/transfer-leg with creds", async () => {
    const { app } = makeApp(docs);
    const res = await initiate(app, "c-d1");
    expect(res.body).toMatch(
      /<PhoneNumber transferDisconnectUrl="https:\/\/translator\.test\/bw\/transfer-leg\?dial=[0-9a-f]{8}\.1" username="u" password="p">\+15552223333<\/PhoneNumber>/,
    );
    // The action names the same Dial and how many legs it rings.
    const { complete, legs } = dialUrls(res.body)[0];
    expect(complete).toContain(`&dial=${new URL(legs[0]).searchParams.get("dial")}&legs=1`);
  });

  it("joins the dialed leg's disconnect to the action: completed, bridged, DialCallSid, DialCallDuration", async () => {
    const { app, customerPost } = makeApp(docs);
    await initiate(app, "c-d2");

    // The B leg ended (answered at :20, hung up at :84) and Bandwidth told /bw/transfer-leg first.
    const leg = await app.inject({
      method: "POST",
      url: "/bw/transfer-leg",
      headers: { authorization: webhookAuth },
      payload: bwEvent("c-d2-bleg", {
        eventType: "transferDisconnect",
        parentCallId: "c-d2",
        cause: "hangup",
        startTime: "2026-09-29T10:00:15Z",
        answerTime: "2026-09-29T10:00:20Z",
        endTime: "2026-09-29T10:01:24Z",
        transferTo: "+15552223333",
      }),
    });
    expect(leg.statusCode).toBe(204);

    const res = await app.inject({
      method: "POST",
      url: continueUrl(AFTER),
      headers: { authorization: webhookAuth },
      payload: bwEvent("c-d2", { eventType: "transferComplete", cause: "hangup", transferTo: "+15552223333" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("After dial");

    const { url, params } = customerPost(1)!;
    expect(url).toBe(AFTER);
    expect(params).toMatchObject({
      CallSid: toCallSid("c-d2"),
      CallStatus: "in-progress",
      DialCallStatus: "completed",
      DialBridged: "true",
      DialCallSid: toCallSid("c-d2-bleg"),
      DialCallDuration: "64",
    });
  });

  it("reports busy / no-answer / canceled / failed from the leg's cause with DialBridged=false and duration 0", async () => {
    const cases: [string, string][] = [
      ["busy", "busy"],
      ["rejected", "busy"],
      ["timeout", "no-answer"],
      ["cancel", "canceled"],
      ["callback-error", "failed"],
      ["something-new", "failed"],
    ];
    for (const [cause, expected] of cases) {
      const { app, customerPost } = makeApp(docs);
      const id = `c-${cause}`;
      await initiate(app, id);
      await app.inject({
        method: "POST",
        url: "/bw/transfer-leg",
        headers: { authorization: webhookAuth },
        payload: bwEvent(`${id}-b`, {
          eventType: "transferDisconnect",
          parentCallId: id,
          cause,
          startTime: "2026-09-29T10:00:15Z",
          endTime: "2026-09-29T10:00:45Z",
        }),
      });
      await app.inject({
        method: "POST",
        url: continueUrl(AFTER),
        headers: { authorization: webhookAuth },
        payload: bwEvent(id, { eventType: "transferComplete", cause }),
      });
      expect(customerPost(1)!.params, cause).toMatchObject({
        DialCallStatus: expected,
        DialBridged: "false",
        DialCallDuration: "0",
        DialCallSid: toCallSid(`${id}-b`),
      });
    }
  });

  it("waits briefly for a leg event that arrives just after the completion", async () => {
    const { app, customerPost } = makeApp(docs, config({ transferLegWaitMs: 500 }));
    await initiate(app, "c-d3");
    const completion = app.inject({
      method: "POST",
      url: continueUrl(AFTER),
      headers: { authorization: webhookAuth },
      payload: bwEvent("c-d3", { eventType: "transferComplete", cause: "hangup" }),
    });
    await new Promise((r) => setTimeout(r, 100));
    await app.inject({
      method: "POST",
      url: "/bw/transfer-leg",
      headers: { authorization: webhookAuth },
      payload: bwEvent("c-d3-b", {
        eventType: "transferDisconnect",
        parentCallId: "c-d3",
        cause: "hangup",
        answerTime: "2026-09-29T10:00:20Z",
        endTime: "2026-09-29T10:00:50Z",
      }),
    });
    await completion;
    expect(customerPost(1)!.params).toMatchObject({ DialCallSid: toCallSid("c-d3-b"), DialCallDuration: "30" });
  });

  it("falls back to the parent's cause, without DialCallSid/DialCallDuration, when no leg event arrives", async () => {
    const { app, customerPost } = makeApp(docs);
    await initiate(app, "c-d4");
    const t0 = Date.now();
    await app.inject({
      method: "POST",
      url: continueUrl(AFTER),
      headers: { authorization: webhookAuth },
      payload: bwEvent("c-d4", { eventType: "transferComplete", cause: "busy" }),
    });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140); // waited the configured window
    const { params } = customerPost(1)!;
    expect(params).toMatchObject({ DialCallStatus: "busy", DialBridged: "false" });
    expect(params.DialCallSid).toBeUndefined();
    expect(params.DialCallDuration).toBeUndefined();
  });

  it("a parent cause of hangup with no leg event is reported as completed and bridged", async () => {
    const { app, customerPost } = makeApp(docs);
    await initiate(app, "c-d5");
    await app.inject({
      method: "POST",
      url: continueUrl(AFTER),
      headers: { authorization: webhookAuth },
      payload: bwEvent("c-d5", { eventType: "transferComplete", cause: "hangup" }),
    });
    expect(customerPost(1)!.params).toMatchObject({ DialCallStatus: "completed", DialBridged: "true" });
  });
});

describe("Dial action picks the right leg (multi-target, repeated Dials)", () => {
  const AFTER = "https://customer.test/after";
  const NEXT = "https://customer.test/next";

  const legEvent = (url: string, parent: string, leg: string, extra: Record<string, unknown>) => ({
    method: "POST" as const,
    url: pathOf(url),
    headers: { authorization: webhookAuth },
    payload: bwEvent(leg, { eventType: "transferDisconnect", parentCallId: parent, ...extra }),
  });
  const completion = (url: string, callId: string, cause: string) => ({
    method: "POST" as const,
    url: pathOf(url),
    headers: { authorization: webhookAuth },
    payload: bwEvent(callId, { eventType: "transferComplete", cause }),
  });

  it("reports the answered leg even when the cancelled leg reported first", async () => {
    const { app, customerPost } = makeApp({
      "https://customer.test/voice": `<Response><Dial action="/after"><Number>+15550000001</Number><Number>+15550000002</Number></Dial></Response>`,
      [AFTER]: `<Response><Say>After</Say></Response>`,
    });
    const [dial] = dialUrls((await initiate(app, "c-m1")).body);
    expect(dial.legs).toHaveLength(2);
    expect(dial.complete).toContain("&legs=2");

    // B answers, so A is cut off at once and its event lands first. This is the
    // shape Bandwidth sent on a live call: cause "hangup", no answerTime.
    await app.inject(legEvent(dial.legs[0], "c-m1", "c-m1-a", { cause: "hangup", startTime: "2026-09-29T10:00:00Z", endTime: "2026-09-29T10:00:05Z" }));
    await app.inject(
      legEvent(dial.legs[1], "c-m1", "c-m1-b", { cause: "hangup", answerTime: "2026-09-29T10:00:05Z", endTime: "2026-09-29T10:00:45Z" }),
    );
    await app.inject(completion(dial.complete, "c-m1", "hangup"));

    expect(customerPost(1)!.params).toMatchObject({
      DialCallStatus: "completed",
      DialBridged: "true",
      DialCallSid: toCallSid("c-m1-b"),
      DialCallDuration: "40",
    });
  });

  it("does not report a cancelled loser when the answered leg has not reported yet", async () => {
    const { app, customerPost } = makeApp({
      "https://customer.test/voice": `<Response><Dial action="/after"><Number>+15550000001</Number><Number>+15550000002</Number></Dial></Response>`,
      [AFTER]: `<Response><Say>After</Say></Response>`,
    });
    const [dial] = dialUrls((await initiate(app, "c-m2")).body);
    await app.inject(legEvent(dial.legs[0], "c-m2", "c-m2-a", { cause: "hangup", endTime: "2026-09-29T10:00:05Z" }));
    await app.inject(completion(dial.complete, "c-m2", "hangup"));
    const { params } = customerPost(1)!;
    expect(params).toMatchObject({ DialCallStatus: "completed", DialBridged: "true" });
    expect(params.DialCallSid).toBeUndefined();
  });

  it("once every leg has reported, the legs win over a parent cause of hangup", async () => {
    const { app, customerPost } = makeApp({
      "https://customer.test/voice": `<Response><Dial action="/after"><Number>+15550000001</Number></Dial></Response>`,
      [AFTER]: `<Response><Say>After</Say></Response>`,
    });
    const [dial] = dialUrls((await initiate(app, "c-m7")).body);
    // The only leg reports, unanswered; the parent's cause alone would say "bridged".
    await app.inject(legEvent(dial.legs[0], "c-m7", "c-m7-a", { cause: "hangup", endTime: "2026-09-29T10:00:05Z" }));
    await app.inject(completion(dial.complete, "c-m7", "hangup"));
    expect(customerPost(1)!.params).toMatchObject({
      DialCallStatus: "canceled",
      DialBridged: "false",
      DialCallSid: toCallSid("c-m7-a"),
    });
  });

  it("a redelivered leg event counts once, so the wait still catches the answered leg", async () => {
    const { app, customerPost } = makeApp(
      {
        "https://customer.test/voice": `<Response><Dial action="/after"><Number>+15550000001</Number><Number>+15550000002</Number></Dial></Response>`,
        [AFTER]: `<Response><Say>After</Say></Response>`,
      },
      config({ transferLegWaitMs: 1000 }),
    );
    const [dial] = dialUrls((await initiate(app, "c-m8")).body);
    const loser = legEvent(dial.legs[0], "c-m8", "c-m8-a", { cause: "hangup", endTime: "2026-09-29T10:00:05Z" });
    await app.inject(loser);
    await app.inject(loser); // Bandwidth retry of the same event
    const completing = app.inject(completion(dial.complete, "c-m8", "hangup"));
    await new Promise((r) => setTimeout(r, 100));
    await app.inject(
      legEvent(dial.legs[1], "c-m8", "c-m8-b", { cause: "hangup", answerTime: "2026-09-29T10:00:05Z", endTime: "2026-09-29T10:00:25Z" }),
    );
    await completing;
    expect(customerPost(1)!.params).toMatchObject({
      DialCallStatus: "completed",
      DialBridged: "true",
      DialCallSid: toCallSid("c-m8-b"),
      DialCallDuration: "20",
    });
  });

  it("a leg that ended with cause hangup but was never answered is canceled, not completed", async () => {
    const { app, customerPost } = makeApp({
      "https://customer.test/voice": `<Response><Dial action="/after"><Number>+15550000001</Number></Dial></Response>`,
      [AFTER]: `<Response><Say>After</Say></Response>`,
    });
    const [dial] = dialUrls((await initiate(app, "c-m6")).body);
    await app.inject(legEvent(dial.legs[0], "c-m6", "c-m6-a", { cause: "hangup", startTime: "2026-09-29T10:00:00Z", endTime: "2026-09-29T10:00:05Z" }));
    await app.inject(completion(dial.complete, "c-m6", "timeout"));
    expect(customerPost(1)!.params).toMatchObject({
      DialCallStatus: "canceled",
      DialBridged: "false",
      DialCallDuration: "0",
      DialCallSid: toCallSid("c-m6-a"),
    });
  });

  it("answers as soon as every leg of an unanswered multi-target Dial has reported", async () => {
    const { app, customerPost } = makeApp(
      {
        "https://customer.test/voice": `<Response><Dial action="/after"><Number>+15550000001</Number><Number>+15550000002</Number></Dial></Response>`,
        [AFTER]: `<Response><Say>After</Say></Response>`,
      },
      config({ transferLegWaitMs: 5000 }),
    );
    const [dial] = dialUrls((await initiate(app, "c-m3")).body);
    await app.inject(legEvent(dial.legs[0], "c-m3", "c-m3-a", { cause: "timeout" }));
    await app.inject(legEvent(dial.legs[1], "c-m3", "c-m3-b", { cause: "timeout" }));
    const t0 = Date.now();
    await app.inject(completion(dial.complete, "c-m3", "timeout"));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(customerPost(1)!.params).toMatchObject({ DialCallStatus: "no-answer", DialBridged: "false" });
  });

  it("a leg that reports after its Dial's wait is not applied to the next Dial", async () => {
    const { app, customerPost } = makeApp({
      "https://customer.test/voice": `<Response><Dial action="/after"><Number>+15550000001</Number></Dial></Response>`,
      [AFTER]: `<Response><Dial action="/next"><Number>+15550000002</Number></Dial></Response>`,
      [NEXT]: `<Response><Say>Done</Say></Response>`,
    });
    const [first] = dialUrls((await initiate(app, "c-m4")).body);

    // Dial #1 completes with no leg event inside the wait window.
    const r1 = await app.inject(completion(first.complete, "c-m4", "hangup"));
    expect(customerPost(1)!.params.DialCallSid).toBeUndefined();
    // Its leg reports late.
    await app.inject(
      legEvent(first.legs[0], "c-m4", "c-m4-first", { cause: "hangup", answerTime: "2026-09-29T10:00:05Z", endTime: "2026-09-29T10:00:45Z" }),
    );

    // Dial #2 (from the action's document) times out with no leg event of its own.
    const [second] = dialUrls(r1.body);
    expect(new URL(second.legs[0]).searchParams.get("dial")).not.toBe(new URL(first.legs[0]).searchParams.get("dial"));
    await app.inject(completion(second.complete, "c-m4", "timeout"));
    const { params } = customerPost(2)!;
    expect(params).toMatchObject({ DialCallStatus: "no-answer", DialBridged: "false" });
    expect(params.DialCallSid).toBeUndefined();
  });

  it("drops unread legs when the call disconnects", async () => {
    const { app, customerPost } = makeApp({
      "https://customer.test/voice": `<Response><Dial action="/after"><Number>+15550000001</Number></Dial></Response>`,
      [AFTER]: `<Response><Say>After</Say></Response>`,
    });
    await initiate(app, "c-m5");
    // An old-style (unkeyed) leg, then the call ends before any Dial reads it.
    await app.inject(legEvent("https://translator.test/bw/transfer-leg", "c-m5", "c-m5-x", { cause: "hangup", answerTime: "2026-09-29T10:00:05Z" }));
    await app.inject({ method: "POST", url: "/bw/disconnect", headers: { authorization: webhookAuth }, payload: bwEvent("c-m5", { eventType: "disconnect" }) });
    await app.inject(completion(`https://translator.test${continueUrl(AFTER)}`, "c-m5", "busy"));
    expect(customerPost(1)!.params.DialCallSid).toBeUndefined();
  });
});

describe("/bw/transfer-leg", () => {
  it("rejects a malformed dial key", async () => {
    const { app } = makeApp({});
    const res = await app.inject({
      method: "POST",
      url: "/bw/transfer-leg?dial=../x",
      headers: { authorization: webhookAuth },
      payload: { eventType: "transferDisconnect", callId: "c-1", parentCallId: "c-0", cause: "hangup" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("requires webhook auth and safe ids", async () => {
    const { app } = makeApp({});
    expect((await app.inject({ method: "POST", url: "/bw/transfer-leg", payload: { callId: "c-1", parentCallId: "c-0" } })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/bw/transfer-leg",
          headers: { authorization: webhookAuth },
          payload: { eventType: "transferDisconnect", callId: "c-1", parentCallId: "../etc" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/bw/transfer-leg",
          headers: { authorization: webhookAuth },
          payload: { eventType: "transferDisconnect", callId: "c-1", parentCallId: "c-0", cause: "hangup" },
        })
      ).statusCode,
    ).toBe(204);
  });
});

// ─── Record action ───────────────────────────────────────────────────────────

describe("/bw/continue recordComplete -> Record action", () => {
  const DONE = "https://customer.test/done";
  const docs = {
    "https://customer.test/voice": `<Response><Record action="/done" maxLength="30"/></Response>`,
    [DONE]: `<Response><Say>Thanks</Say></Response>`,
  };

  it("sends RecordingUrl, RecordingSid, RecordingDuration and registers the recording", async () => {
    const { app, customerPost } = makeApp(docs);
    await initiate(app, "c-r1");
    const res = await app.inject({
      method: "POST",
      url: continueUrl(DONE),
      headers: { authorization: webhookAuth },
      payload: bwEvent("c-r1", {
        eventType: "recordComplete",
        recordingId: "r-abc",
        mediaUrl: "https://voice.bandwidth.com/api/v2/accounts/x/calls/c-r1/recordings/r-abc/media",
        duration: "PT12.4S",
        channels: 1,
        fileFormat: "wav",
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Thanks");

    const sid = toRecordingSid("r-abc");
    const { url, params } = customerPost(1)!;
    expect(url).toBe(DONE);
    expect(params).toMatchObject({
      CallSid: toCallSid("c-r1"),
      CallStatus: "in-progress",
      RecordingSid: sid,
      RecordingUrl: `https://translator.test/2010-04-01/Accounts/AC123/Recordings/${sid}`,
      RecordingDuration: "12",
    });
    // Bandwidth's event has no digits field; Twilio's Digits cannot be reproduced.
    expect(params.Digits).toBeUndefined();

    // The recording is now resolvable through the Twilio-shaped facade.
    const get = await app.inject({
      method: "GET",
      url: `/2010-04-01/Accounts/AC123/Recordings/${sid}.json`,
      headers: { authorization: restAuth },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().sid).toBe(sid);
  });

  it("rejects an unsafe recordingId rather than registering it, and still continues the call", async () => {
    const { app, customerPost } = makeApp(docs);
    await initiate(app, "c-r2");
    const res = await app.inject({
      method: "POST",
      url: continueUrl(DONE),
      headers: { authorization: webhookAuth },
      payload: bwEvent("c-r2", { eventType: "recordComplete", recordingId: "../../x", duration: "PT5S" }),
    });
    expect(res.statusCode).toBe(200);
    expect(customerPost(1)!.params.RecordingSid).toBeUndefined();
  });
});

// ─── Gather empty result ─────────────────────────────────────────────────────

describe("/bw/continue gather with no input", () => {
  const MENU = "https://customer.test/menu";
  const AGAIN = "https://customer.test/again";
  const docs = {
    "https://customer.test/voice": `<Response>
      <Gather action="/menu" numDigits="1" timeout="6"><Say>Press 1 for sales</Say></Gather>
      <Say>We did not get that.</Say>
      <Gather action="/again" numDigits="1" actionOnEmptyResult="true"><Say>Try again</Say></Gather>
      <Record action="/voicemail" maxLength="30"/>
    </Response>`,
    [MENU]: `<Response><Say>You pressed one</Say></Response>`,
    [AGAIN]: `<Response><Say>Second try handled</Say></Response>`,
  };

  it("resumes the document after the Gather instead of requesting the action (Twilio semantics)", async () => {
    const { app, posts } = makeApp(docs);
    const first = await initiate(app, "c-g1");
    const gatherUrl = /gatherUrl="([^"]+)"/.exec(first.body)![1].replace(/&amp;/g, "&");
    expect(gatherUrl).toContain("&gather=1");
    expect(gatherUrl).not.toContain("onEmpty");

    const res = await app.inject({
      method: "POST",
      url: new URL(gatherUrl).pathname + new URL(gatherUrl).search,
      headers: { authorization: webhookAuth },
      payload: bwEvent("c-g1", { eventType: "gather", digits: "", terminatingDigit: "" }),
    });
    expect(res.statusCode).toBe(200);
    // The remainder: the fallback prompt, the second Gather, the voicemail Record.
    expect(res.body).toContain("We did not get that.");
    expect(res.body).toContain("Try again");
    expect(res.body).toContain("<Record ");
    expect(res.body).not.toContain("Press 1 for sales");
    // The second Gather keeps its document index and its own onEmpty flag.
    expect(res.body).toContain("&amp;gather=2&amp;onEmpty=1");
    // No POST went to the customer's action.
    expect(posts()).toBe(1);
  });

  it("requests the action with Digits='' when actionOnEmptyResult=\"true\"", async () => {
    const { app, customerPost } = makeApp(docs);
    await initiate(app, "c-g2");
    const res = await app.inject({
      method: "POST",
      url: continueUrl(AGAIN, "&gather=2&onEmpty=1"),
      headers: { authorization: webhookAuth },
      payload: bwEvent("c-g2", { eventType: "gather", digits: "" }),
    });
    expect(res.body).toContain("Second try handled");
    expect(customerPost(1)!.params.Digits).toBe("");
  });

  it("treats Bandwidth's speech-timeout sentinel text as no input", async () => {
    const { app, posts } = makeApp(docs);
    await initiate(app, "c-g3");
    const res = await app.inject({
      method: "POST",
      url: continueUrl(MENU, "&gather=1"),
      headers: { authorization: webhookAuth },
      payload: bwEvent("c-g3", { eventType: "gather", digits: "", text: "Speech timeout elapsed before transcription" }),
    });
    expect(res.body).toContain("We did not get that.");
    expect(posts()).toBe(1);
  });

  it("still requests the action when digits or speech were received", async () => {
    const { app, customerPost } = makeApp(docs);
    await initiate(app, "c-g4");
    await app.inject({
      method: "POST",
      url: continueUrl(MENU, "&gather=1"),
      headers: { authorization: webhookAuth },
      payload: bwEvent("c-g4", { eventType: "gather", digits: "1", terminatingDigit: "" }),
    });
    expect(customerPost(1)!.params).toMatchObject({ Digits: "1" });

    await app.inject({
      method: "POST",
      url: continueUrl(MENU, "&gather=1"),
      headers: { authorization: webhookAuth },
      payload: bwEvent("c-g4", { eventType: "gather", digits: "", text: "sales please" }),
    });
    expect(customerPost(2)!.params).toMatchObject({ SpeechResult: "sales please" });
    expect(customerPost(2)!.params.Digits).toBe("");
  });

  it("releases the remembered document when the call disconnects", async () => {
    const { app, customerPost } = makeApp(docs);
    await initiate(app, "c-g7");
    await app.inject({ method: "POST", url: "/bw/disconnect", headers: { authorization: webhookAuth }, payload: bwEvent("c-g7", { eventType: "disconnect" }) });
    // With the document gone there is nothing to resume, so an (unlikely) late
    // empty gather falls back to requesting the action.
    const res = await app.inject({
      method: "POST",
      url: continueUrl(MENU, "&gather=1"),
      headers: { authorization: webhookAuth },
      payload: bwEvent("c-g7", { eventType: "gather", digits: "" }),
    });
    expect(res.body).toContain("You pressed one");
    expect(customerPost(1)!.params.Digits).toBe("");
  });

  it("falls back to requesting the action when there is no document to resume (fresh instance)", async () => {
    const { app, customerPost } = makeApp(docs);
    // No /bw/initiate on this instance, so no remembered TwiML for the call.
    const res = await app.inject({
      method: "POST",
      url: continueUrl(MENU, "&gather=1"),
      headers: { authorization: webhookAuth },
      payload: bwEvent("c-g5", { eventType: "gather", digits: "" }),
    });
    expect(res.body).toContain("You pressed one");
    expect(customerPost(0)!.params.Digits).toBe("");
  });

  it("a document fetched from a later action is what gets resumed", async () => {
    // After the caller presses 1, the customer returns a new document with its own Gather.
    const SECOND = `<Response><Gather action="/deep" numDigits="1"><Say>Deep menu</Say></Gather><Say>Deep fallback</Say></Response>`;
    const { app } = makeApp({ ...docs, [MENU]: SECOND });
    await initiate(app, "c-g6");
    const r1 = await app.inject({
      method: "POST",
      url: continueUrl(MENU, "&gather=1"),
      headers: { authorization: webhookAuth },
      payload: bwEvent("c-g6", { eventType: "gather", digits: "1" }),
    });
    expect(r1.body).toContain("Deep menu");
    const r2 = await app.inject({
      method: "POST",
      url: continueUrl("https://customer.test/deep", "&gather=1"),
      headers: { authorization: webhookAuth },
      payload: bwEvent("c-g6", { eventType: "gather", digits: "" }),
    });
    expect(r2.body).toContain("Deep fallback");
    expect(r2.body).not.toContain("Deep menu");
  });
});
