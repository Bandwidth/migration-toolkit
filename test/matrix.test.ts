import { describe, it, expect } from "vitest";
import { loadMatrix } from "../src/matrix/load.js";

describe("compatibility matrix", () => {
  it("loads and validates", () => {
    const m = loadMatrix();
    expect(m.provider).toBe("twilio");
    expect(m.verbs.Say.bxml).toBe("SpeakSentence");
    expect(m.verbs.Say.status).toBe("supported");
  });
  it("marks Enqueue unsupported with notes", () => {
    const m = loadMatrix();
    expect(m.verbs.Enqueue.status).toBe("unsupported");
    expect(m.verbs.Enqueue.notes.length).toBeGreaterThan(0);
  });
  it("every verb entry has notes when not fully supported", () => {
    const m = loadMatrix();
    for (const [name, v] of Object.entries(m.verbs)) {
      if (v.status !== "supported") expect(v.notes, name).not.toBe("");
    }
  });
});
