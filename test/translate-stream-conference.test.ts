import { describe, it, expect } from "vitest";
import { translateTwiml } from "../src/translator/translate.js";

const rw = (u: string) =>
  u.startsWith("wss") ? `wss://translator.test/streams?dest=${encodeURIComponent(u)}` : u;

describe("Stream lifecycle", () => {
  it("Connect>Stream → StartStream mode=bidirectional with name and tracks", () => {
    const r = translateTwiml(
      `<Response><Connect><Stream name="agent" url="wss://bot.test/ws" track="both_tracks"/></Connect></Response>`,
      { rewriteUrl: rw },
    );
    expect(r.hasErrors).toBe(false);
    expect(r.bxml).toContain(`name="agent"`);
    expect(r.bxml).toContain(`mode="bidirectional"`);
    expect(r.bxml).toContain(`tracks="both"`);
    expect(r.bxml).toContain(`<StartStream`);
  });

  it("Start>Stream → StartStream mode=unidirectional (fork)", () => {
    const r = translateTwiml(
      `<Response><Start><Stream name="fork1" url="wss://bot.test/ws"/></Start></Response>`,
      { rewriteUrl: rw },
    );
    expect(r.hasErrors).toBe(false);
    expect(r.bxml).toContain(`mode="unidirectional"`);
    expect(r.bxml).toContain(`name="fork1"`);
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
