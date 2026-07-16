import { describe, it, expect } from "vitest";
import { safeEqual } from "../src/server/safe-equal.js";

describe("safeEqual", () => {
  it("returns true for identical strings", () => {
    expect(safeEqual("Basic abc123", "Basic abc123")).toBe(true);
  });
  it("returns false for same-length differing strings", () => {
    expect(safeEqual("Basic abc123", "Basic abc124")).toBe(false);
  });
  it("returns false (no throw) for different-length strings", () => {
    expect(safeEqual("short", "muchlongervalue")).toBe(false);
  });
  it("returns false for empty vs non-empty", () => {
    expect(safeEqual("", "x")).toBe(false);
  });
});
