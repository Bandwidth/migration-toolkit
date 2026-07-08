import { describe, it, expect } from "vitest";
import { buildView } from "../web/view-model.js";
import { EXAMPLES } from "../web/examples.js";

const byId = (id: string) => EXAMPLES.find((e) => e.id === id)!.twiml;

describe("buildView — input guards", () => {
  it("rejects empty input", () => {
    const v = buildView("   ");
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/paste/i);
  });

  it("rejects non-TwiML", () => {
    const v = buildView("just some text");
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/Response/);
  });
});

describe("buildView — curated examples", () => {
  for (const ex of EXAMPLES) {
    it(`${ex.label} analyzes cleanly with a bounded score and real BXML`, () => {
      const v = buildView(ex.twiml);
      expect(v.ok).toBe(true);
      expect(v.score).toBeGreaterThanOrEqual(1);
      expect(v.score).toBeLessThanOrEqual(10);
      expect(v.bxml).toContain("<Response>");
      expect(v.bxml).toContain("SpeakSentence"); // every example has a <Say>
      const total = v.counts.clean + v.counts.headsUp + v.counts.blocker;
      expect(total).toBe(v.blockers.length + v.headsUp.length + v.clean.length);
      expect(total).toBeGreaterThan(0);
    });
  }

  it("Queue example surfaces Enqueue as a blocker", () => {
    const v = buildView(byId("queue"));
    expect(v.blockers.some((c) => c.verb === "Enqueue")).toBe(true);
    expect(v.blockers[0].pill).toBe("No equivalent");
  });

  it("Conference example flags the hold-music blocker", () => {
    const v = buildView(byId("conference"));
    expect(v.blockers.some((c) => c.verb === "Conference")).toBe(true);
  });

  it("IVR example maps the Polly voice as a heads-up, not a failure", () => {
    const v = buildView(byId("ivr"));
    expect(v.headsUp.some((c) => c.verb === "Say")).toBe(true);
    expect(v.counts.blocker).toBe(0);
  });

  it("marks a supported 1:1 verb with a target and 'Maps 1:1'", () => {
    const v = buildView(byId("ivr"));
    const gather = v.clean.find((c) => c.verb === "Gather");
    expect(gather?.pill).toBe("Maps 1:1");
    expect(gather?.target).toBe("Gather");
  });
});
