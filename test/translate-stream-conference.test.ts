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

  // VAPI-3989: <Parameter> children used to be dropped silently, so bots got an
  // empty customParameters map and could not identify the call or tenant.
  describe("Stream <Parameter> → StreamParam (VAPI-3989)", () => {
    it("emits one nested StreamParam per Parameter, in order, inside StartStream", () => {
      const r = translateTwiml(
        `<Response><Connect><Stream name="agent" url="wss://bot.test/ws">
           <Parameter name="callSid" value="CA123"/>
           <Parameter name="tenant" value="acme"/>
         </Stream></Connect></Response>`,
        { rewriteUrl: rw },
      );
      expect(r.hasErrors).toBe(false);
      expect(r.bxml).toMatch(
        /<StartStream [^>]*name="agent"[^>]*><StreamParam name="callSid" value="CA123"\/><StreamParam name="tenant" value="acme"\/><\/StartStream><StopStream name="agent" wait="true"\/>/,
      );
      // No drop warnings when every Parameter is valid and within the limit.
      expect(r.findings.some((f) => /dropped/.test(f.message))).toBe(false);
    });

    it("output differs from the same Stream without Parameters", () => {
      const a = translateTwiml(`<Response><Connect><Stream url="wss://bot.test/ws"/></Connect></Response>`);
      const b = translateTwiml(
        `<Response><Connect><Stream url="wss://bot.test/ws"><Parameter name="k" value="v"/></Stream></Connect></Response>`,
      );
      expect(b.bxml).not.toBe(a.bxml);
      expect(a.bxml).not.toContain("StreamParam");
    });

    it("also applies to Start>Stream forks", () => {
      const r = translateTwiml(
        `<Response><Start><Stream name="fork1" url="wss://bot.test/ws"><Parameter name="k" value="v"/></Stream></Start></Response>`,
      );
      expect(r.hasErrors).toBe(false);
      expect(r.bxml).toContain(`<StreamParam name="k" value="v"/></StartStream>`);
      expect(r.bxml).not.toContain("<StopStream");
    });

    it("XML-escapes parameter values", () => {
      const r = translateTwiml(
        `<Response><Connect><Stream url="wss://bot.test/ws"><Parameter name="q" value="a &amp; b &lt; &quot;c&quot;"/></Stream></Connect></Response>`,
      );
      expect(r.bxml).toContain(`<StreamParam name="q" value="a &amp; b &lt; &quot;c&quot;"/>`);
    });

    it("keeps the first 12 Parameters and warns about the rest (Bandwidth limit)", () => {
      const params = Array.from({ length: 14 }, (_, i) => `<Parameter name="p${i}" value="v${i}"/>`).join("");
      const r = translateTwiml(
        `<Response><Connect><Stream url="wss://bot.test/ws">${params}</Stream></Connect></Response>`,
      );
      expect(r.hasErrors).toBe(false);
      expect(r.bxml.match(/<StreamParam /g)).toHaveLength(12);
      expect(r.bxml).toContain(`name="p11"`);
      expect(r.bxml).not.toContain(`name="p12"`);
      const capWarnings = r.findings.filter((f) => f.verb === "Stream" && /at most 12 StreamParam/.test(f.message));
      expect(capWarnings).toHaveLength(1);
      expect(capWarnings[0].message).toContain("2 Stream <Parameter> element(s) beyond that were dropped");
    });

    it("tallies everything past the 12th accepted Parameter under the cap, even if also invalid", () => {
      const valid = Array.from({ length: 12 }, (_, i) => `<Parameter name="p${i}" value="v${i}"/>`).join("");
      const r = translateTwiml(
        `<Response><Connect><Stream url="wss://bot.test/ws">${valid}<Parameter name="${"n".repeat(300)}" value="x"/></Stream></Connect></Response>`,
      );
      expect(r.bxml.match(/<StreamParam /g)).toHaveLength(12);
      expect(r.findings.some((f) => /1 Stream <Parameter> element\(s\) beyond that were dropped/.test(f.message))).toBe(true);
      expect(r.findings.some((f) => /name exceeds/.test(f.message))).toBe(false);
    });

    it("keeps the first of duplicate Parameter names and warns, since streamParams is a flat map", () => {
      const r = translateTwiml(
        `<Response><Connect><Stream url="wss://bot.test/ws">
           <Parameter name="k" value="first"/>
           <Parameter name="other" value="o"/>
           <Parameter name="k" value="second"/>
         </Stream></Connect></Response>`,
      );
      expect(r.hasErrors).toBe(false);
      expect(r.bxml.match(/<StreamParam name="k" /g)).toHaveLength(1);
      expect(r.bxml).toContain(`<StreamParam name="k" value="first"/>`);
      expect(r.bxml).not.toContain(`value="second"`);
      expect(r.findings.filter((f) => f.verb === "Stream" && /Duplicate Stream <Parameter name="k">/.test(f.message))).toHaveLength(1);
    });

    it("never echoes more than 32 characters of a name into a finding", () => {
      const huge = "x".repeat(5000);
      const r = translateTwiml(
        `<Response><Connect><Stream url="wss://bot.test/ws"><Parameter name="${huge}"/></Stream></Connect></Response>`,
      );
      const f = r.findings.find((f) => /requires both name and value/.test(f.message))!;
      expect(f).toBeDefined();
      expect(f.message.length).toBeLessThan(200);
      expect(f.message).toContain(`name="${"x".repeat(32)}…"`);
    });

    it("drops a Parameter whose name exceeds Bandwidth's 256-character limit", () => {
      // Valid TwiML: Twilio's only limit is 500 chars for name+value combined.
      // Bandwidth would reject the entire BXML document for this one name.
      const longName = "n".repeat(300);
      const r = translateTwiml(
        `<Response><Connect><Stream url="wss://bot.test/ws">
           <Parameter name="${longName}" value="x"/>
           <Parameter name="ok" value="1"/>
         </Stream></Connect></Response>`,
      );
      expect(r.hasErrors).toBe(false);
      expect(r.bxml).not.toContain(longName);
      expect(r.bxml).toContain(`<StreamParam name="ok" value="1"/>`);
      expect(r.findings.some((f) => f.verb === "Stream" && /name exceeds Bandwidth's 256-character limit \(300\)/.test(f.message))).toBe(true);
    });

    it("keeps a 256-character name and drops a value over 2048 characters", () => {
      const maxName = "n".repeat(256);
      const longValue = "v".repeat(2049);
      const r = translateTwiml(
        `<Response><Connect><Stream url="wss://bot.test/ws">
           <Parameter name="${maxName}" value="x"/>
           <Parameter name="big" value="${longValue}"/>
         </Stream></Connect></Response>`,
      );
      expect(r.bxml).toContain(`<StreamParam name="${maxName}" value="x"/>`);
      expect(r.bxml).not.toContain(longValue);
      expect(r.findings.some((f) => f.verb === "Stream" && /value exceeds Bandwidth's 2048-character limit \(2049\)/.test(f.message))).toBe(true);
    });

    it("drops a Parameter missing name or value with a warning instead of emitting invalid BXML", () => {
      const r = translateTwiml(
        `<Response><Connect><Stream url="wss://bot.test/ws">
           <Parameter name="ok" value="1"/>
           <Parameter name="novalue"/>
           <Parameter value="noname"/>
         </Stream></Connect></Response>`,
      );
      expect(r.hasErrors).toBe(false);
      expect(r.bxml.match(/<StreamParam /g)).toHaveLength(1);
      expect(r.bxml).toContain(`<StreamParam name="ok" value="1"/>`);
      expect(r.findings.filter((f) => f.verb === "Stream" && /requires both name and value/.test(f.message))).toHaveLength(2);
    });

    it("warns about non-Parameter children of Stream", () => {
      const r = translateTwiml(
        `<Response><Connect><Stream url="wss://bot.test/ws"><Bogus/></Stream></Connect></Response>`,
      );
      expect(r.hasErrors).toBe(false);
      expect(r.bxml).not.toContain("Bogus");
      expect(r.findings.some((f) => f.verb === "Stream" && /<Bogus>/.test(f.message))).toBe(true);
    });
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
