import { describe, it, expect } from "vitest";
import { translateTwiml } from "../src/translator/translate.js";

const rw = (u: string) =>
  u.startsWith("wss") ? `wss://translator.test/streams?dest=${encodeURIComponent(u)}` : u;

describe("Stream lifecycle", () => {
  it("Connect>Stream → StartStream mode=bidirectional with name and tracks, held by StopStream wait", () => {
    const r = translateTwiml(
      `<Response><Connect><Stream name="agent" url="wss://bot.test/ws" track="both_tracks"/></Connect></Response>`,
      { rewriteUrl: rw },
    );
    expect(r.hasErrors).toBe(false);
    expect(r.bxml).toContain(`name="agent"`);
    expect(r.bxml).toContain(`mode="bidirectional"`);
    expect(r.bxml).toContain(`tracks="both"`);
    expect(r.bxml).toContain(`<StartStream`);
    // VAPI-3985: a bare StartStream ends the call on answer. The StopStream must
    // follow it, carry the same name, and block until the bot closes the socket.
    expect(r.bxml).toMatch(/<StartStream [^>]*name="agent"[^>]*\/><StopStream name="agent" wait="true"\/>/);
    expect(r.findings.some((f) => f.verb === "Connect" && /StopStream/.test(f.message))).toBe(true);
  });

  it("Connect>Stream without a name gets a generated name shared by StartStream and StopStream", () => {
    const r = translateTwiml(
      `<Response><Connect><Stream url="wss://bot.test/ws"/></Connect></Response>`,
      { rewriteUrl: rw },
    );
    expect(r.hasErrors).toBe(false);
    const m = r.bxml.match(/<StartStream [^>]*name="([^"]+)"[^>]*\/><StopStream name="([^"]+)" wait="true"\/>/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(m![2]);
    expect(m![1]).toBe("connect-stream-1");
  });

  it("generated Connect stream names restart at 1 for each document", () => {
    translateTwiml(`<Response><Connect><Stream url="wss://a.test/ws"/></Connect></Response>`);
    const r = translateTwiml(`<Response><Connect><Stream url="wss://b.test/ws"/></Connect></Response>`);
    expect(r.bxml).toContain(`name="connect-stream-1"`);
  });

  it("verbs after Connect are emitted after the StopStream, so they run once the stream ends", () => {
    const r = translateTwiml(
      `<Response><Connect><Stream name="agent" url="wss://bot.test/ws"/></Connect><Say>Goodbye</Say></Response>`,
      { rewriteUrl: rw },
    );
    expect(r.hasErrors).toBe(false);
    expect(r.bxml).toMatch(/<StartStream [^>]*\/><StopStream name="agent" wait="true"\/><SpeakSentence>Goodbye<\/SpeakSentence>/);
  });

  it("StartStream is never the last verb for Connect>Stream", () => {
    const r = translateTwiml(`<Response><Connect><Stream url="wss://bot.test/ws"/></Connect></Response>`);
    expect(r.bxml).not.toMatch(/<StartStream [^>]*\/><\/Response>/);
  });

  it("Start>Stream → StartStream mode=unidirectional (fork)", () => {
    const r = translateTwiml(
      `<Response><Start><Stream name="fork1" url="wss://bot.test/ws"/></Start></Response>`,
      { rewriteUrl: rw },
    );
    expect(r.hasErrors).toBe(false);
    expect(r.bxml).toContain(`mode="unidirectional"`);
    expect(r.bxml).toContain(`name="fork1"`);
    // A fork does not need the call held; no StopStream is inserted (VAPI-3985 is Connect-only).
    expect(r.bxml).not.toContain("<StopStream");
  });

  it("Stop>Stream → StopStream by name", () => {
    const r = translateTwiml(`<Response><Stop><Stream name="fork1"/></Stop></Response>`);
    expect(r.hasErrors).toBe(false);
    expect(r.bxml).toContain(`<StopStream name="fork1"/>`);
  });

  it("Stop>Transcription → StopTranscription", () => {
    const r = translateTwiml(`<Response><Stop><Transcription name="tx1"/></Stop></Response>`);
    expect(r.hasErrors).toBe(false);
    expect(r.bxml).toContain(`<StopTranscription`);
    expect(r.bxml).toContain(`name="tx1"`);
  });
});

describe("Conference attribute fidelity", () => {
  it("maps muted→mute and statusCallback→conferenceEventUrl", () => {
    const r = translateTwiml(
      `<Response><Dial><Conference muted="true" statusCallback="https://app.test/conf">room1</Conference></Dial></Response>`,
    );
    expect(r.bxml).toContain(`<Conference`);
    expect(r.bxml).toContain(`mute="true"`);
    expect(r.bxml).toContain(`conferenceEventUrl="https://app.test/conf"`);
    expect(r.bxml).toContain(`room1`);
  });

  it("flags startConferenceOnEnter/endConferenceOnExit as heads-up (no verb equivalent), not silent", () => {
    const r = translateTwiml(
      `<Response><Dial><Conference startConferenceOnEnter="false" endConferenceOnExit="true">room1</Conference></Dial></Response>`,
    );
    // conference still translates (works), but the behavioral attrs are surfaced
    expect(r.bxml).toContain(`<Conference`);
    expect(r.findings.some((f) => f.severity === "warning" && /startConferenceOnEnter/.test(f.message))).toBe(true);
    expect(r.findings.some((f) => f.severity === "warning" && /endConferenceOnExit/.test(f.message))).toBe(true);
  });
});
