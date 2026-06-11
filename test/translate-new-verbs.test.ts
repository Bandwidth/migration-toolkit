import { describe, it, expect } from "vitest";
import { translateTwiml } from "../src/translator/translate.js";

// ─── 1. Play digits → SendDtmf ────────────────────────────────────────────────
describe("Play digits → SendDtmf", () => {
  it("emits SendDtmf with the digits string as text content", () => {
    const r = translateTwiml(`<Response><Play digits="1234"/></Response>`);
    expect(r.bxml).toContain(`<SendDtmf>1234</SendDtmf>`);
    expect(r.bxml).not.toContain(`<PlayAudio`);
    expect(r.hasErrors).toBe(false);
  });

  it("supports pause characters w, W, and comma in digits", () => {
    const r = translateTwiml(`<Response><Play digits="1w2W3,4"/></Response>`);
    expect(r.bxml).toContain(`<SendDtmf>1w2W3,4</SendDtmf>`);
    expect(r.hasErrors).toBe(false);
  });

  it("Play with both a src URL and digits emits PlayAudio then SendDtmf", () => {
    const r = translateTwiml(
      `<Response><Play digits="5">https://x.test/a.mp3</Play></Response>`,
    );
    expect(r.bxml).toContain(`<PlayAudio>https://x.test/a.mp3</PlayAudio>`);
    expect(r.bxml).toContain(`<SendDtmf>5</SendDtmf>`);
    const pa = r.bxml.indexOf("<PlayAudio");
    const sd = r.bxml.indexOf("<SendDtmf");
    expect(pa).toBeLessThan(sd);
    expect(r.hasErrors).toBe(false);
  });

  it("Play with only a src URL (no digits) is unchanged PlayAudio", () => {
    const r = translateTwiml(`<Response><Play>https://x.test/b.mp3</Play></Response>`);
    expect(r.bxml).toContain(`<PlayAudio>https://x.test/b.mp3</PlayAudio>`);
    expect(r.bxml).not.toContain("SendDtmf");
    expect(r.hasErrors).toBe(false);
  });
});

// ─── 2. Dial record → StartRecording before Transfer ─────────────────────────
describe("Dial record attribute → StartRecording + Transfer", () => {
  it("record-from-answer emits StartRecording before Transfer", () => {
    const r = translateTwiml(
      `<Response><Dial record="record-from-answer"><Number>+15551234567</Number></Dial></Response>`,
    );
    expect(r.bxml).toContain(`<StartRecording/>`);
    expect(r.bxml).toContain(`<Transfer`);
    const sr = r.bxml.indexOf("<StartRecording");
    const tr = r.bxml.indexOf("<Transfer");
    expect(sr).toBeLessThan(tr);
    expect(r.hasErrors).toBe(false);
  });

  it("record-from-ringing also emits StartRecording", () => {
    const r = translateTwiml(
      `<Response><Dial record="record-from-ringing"><Number>+15551234567</Number></Dial></Response>`,
    );
    expect(r.bxml).toContain(`<StartRecording/>`);
    expect(r.hasErrors).toBe(false);
  });

  it("record-from-answer-dual emits StartRecording with multiChannel=true", () => {
    const r = translateTwiml(
      `<Response><Dial record="record-from-answer-dual"><Number>+15551234567</Number></Dial></Response>`,
    );
    expect(r.bxml).toContain(`multiChannel="true"`);
    expect(r.bxml).toContain(`<StartRecording`);
    expect(r.hasErrors).toBe(false);
  });

  it("record-from-ringing-dual also emits multiChannel=true", () => {
    const r = translateTwiml(
      `<Response><Dial record="record-from-ringing-dual"><Number>+15551234567</Number></Dial></Response>`,
    );
    expect(r.bxml).toContain(`multiChannel="true"`);
    expect(r.hasErrors).toBe(false);
  });

  it("do-not-record does NOT emit StartRecording", () => {
    const r = translateTwiml(
      `<Response><Dial record="do-not-record"><Number>+15551234567</Number></Dial></Response>`,
    );
    expect(r.bxml).not.toContain("StartRecording");
    expect(r.hasErrors).toBe(false);
  });

  it("Dial without record attribute does NOT emit StartRecording", () => {
    const r = translateTwiml(
      `<Response><Dial><Number>+15551234567</Number></Dial></Response>`,
    );
    expect(r.bxml).not.toContain("StartRecording");
    expect(r.hasErrors).toBe(false);
  });
});

// ─── 3. Start > Transcription → StartTranscription ───────────────────────────
describe("Start > Transcription → StartTranscription", () => {
  it("basic Start/Transcription emits StartTranscription", () => {
    const r = translateTwiml(
      `<Response><Start><Transcription statusCallbackUrl="https://my.app/events"/></Start></Response>`,
    );
    expect(r.bxml).toContain(`<StartTranscription`);
    expect(r.hasErrors).toBe(false);
  });

  it("maps statusCallbackUrl to transcriptionEventUrl", () => {
    const r = translateTwiml(
      `<Response><Start><Transcription statusCallbackUrl="https://my.app/cb"/></Start></Response>`,
    );
    expect(r.bxml).toContain(`transcriptionEventUrl="https://my.app/cb"`);
  });

  it("maps name attribute through", () => {
    const r = translateTwiml(
      `<Response><Start><Transcription name="my_tx" statusCallbackUrl="https://my.app/cb"/></Start></Response>`,
    );
    expect(r.bxml).toContain(`name="my_tx"`);
  });

  it("maps track='both_legs' to tracks='both'", () => {
    const r = translateTwiml(
      `<Response><Start><Transcription track="both_legs" statusCallbackUrl="https://my.app/cb"/></Start></Response>`,
    );
    expect(r.bxml).toContain(`tracks="both"`);
  });

  it("maps track='inbound_track' to tracks='inbound'", () => {
    const r = translateTwiml(
      `<Response><Start><Transcription track="inbound_track" statusCallbackUrl="https://my.app/cb"/></Start></Response>`,
    );
    expect(r.bxml).toContain(`tracks="inbound"`);
  });

  it("maps track='outbound_track' to tracks='outbound'", () => {
    const r = translateTwiml(
      `<Response><Start><Transcription track="outbound_track" statusCallbackUrl="https://my.app/cb"/></Start></Response>`,
    );
    expect(r.bxml).toContain(`tracks="outbound"`);
  });

  it("produces a warning about transcription payload differences", () => {
    const r = translateTwiml(
      `<Response><Start><Transcription statusCallbackUrl="https://my.app/cb"/></Start></Response>`,
    );
    expect(r.findings.some((f) => f.severity === "warning" && /transcript/i.test(f.message))).toBe(
      true,
    );
  });

  it("Start with unsupported noun produces an error", () => {
    const r = translateTwiml(`<Response><Start><Stream url="wss://x.test/s"/></Start></Response>`);
    expect(r.hasErrors).toBe(true);
  });
});

// ─── 4. Voice mapping: full BW voice set + Polly.* + common aliases ───────────
describe("SpeakSentence voice mapping – expanded BW voice allowlist", () => {
  // Voices newly added beyond the original 9 (docs-verified from dev.bandwidth.com)
  for (const v of [
    "bridget", "simon", "katrin", "stefan", "esperanza", "violeta", "jorge",
    "rosa", "jolie", "bernard", "paola", "luca", "masako", "kenji", "nadiya",
    "anatoli", "zeina", "zhiyu", "ruth", "stephen", "lupe", "pedro",
    "gabrielle", "liam", "salli", "salli_enh", "chantal", "miguel", "joey",
    "joey_enh", "penelope", "russell", "emma", "emma_enh", "nicole", "raveena",
    "mads", "justin", "ivy", "ivy_enh", "carmen", "naja", "ruben", "geraint",
  ]) {
    it(`BW voice "${v}" passes through unchanged`, () => {
      const r = translateTwiml(`<Response><Say voice="${v}">Hello</Say></Response>`);
      expect(r.bxml).toContain(`voice="${v}"`);
      expect(
        r.findings.some(
          (f) => f.severity === "warning" && f.message.includes("no Bandwidth equivalent"),
        ),
      ).toBe(false);
    });
  }

  // Polly.* voices must NOT be passed through raw
  for (const pollyVoice of ["Polly.Joanna", "Polly.Matthew", "Polly.Kendra", "Polly.Salli"]) {
    it(`Polly voice "${pollyVoice}" is not passed through raw`, () => {
      const r = translateTwiml(`<Response><Say voice="${pollyVoice}">Hi</Say></Response>`);
      expect(r.bxml).not.toContain(`voice="${pollyVoice}"`);
    });
  }

  // Specific Polly mappings that are expected
  it("Polly.Joanna → salli (closest BW US-English female equivalent)", () => {
    const r = translateTwiml(`<Response><Say voice="Polly.Joanna">Hi</Say></Response>`);
    expect(r.bxml).toContain(`voice="salli"`);
  });

  it("Polly.Matthew → joey (BW US-English male)", () => {
    const r = translateTwiml(`<Response><Say voice="Polly.Matthew">Hi</Say></Response>`);
    expect(r.bxml).toContain(`voice="joey"`);
  });

  it("Polly.Kendra → kate (BW US-English female)", () => {
    const r = translateTwiml(`<Response><Say voice="Polly.Kendra">Hi</Say></Response>`);
    expect(r.bxml).toContain(`voice="kate"`);
  });

  it("Polly.Salli → salli (direct name match)", () => {
    const r = translateTwiml(`<Response><Say voice="Polly.Salli">Hi</Say></Response>`);
    expect(r.bxml).toContain(`voice="salli"`);
  });

  it("'woman' alias maps to susan", () => {
    const r = translateTwiml(`<Response><Say voice="woman">Hi</Say></Response>`);
    expect(r.bxml).toContain(`voice="susan"`);
  });

  it("'man' alias maps to dave", () => {
    const r = translateTwiml(`<Response><Say voice="man">Hi</Say></Response>`);
    expect(r.bxml).toContain(`voice="dave"`);
  });

  it("completely unknown voice is dropped with a warning", () => {
    const r = translateTwiml(`<Response><Say voice="SomeGibberish">Hi</Say></Response>`);
    expect(r.bxml).not.toContain(`voice=`);
    expect(r.findings.some((f) => f.severity === "warning")).toBe(true);
  });
});
