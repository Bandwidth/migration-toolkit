import { describe, it, expect } from "vitest";
import { buildDoctorProbe } from "../src/server/doctor.js";

describe("buildDoctorProbe", () => {
  it("returns undefined when BW credentials are absent", () => {
    expect(buildDoctorProbe({})).toBeUndefined();
  });

  it("returns a probe fn when BW credentials are present", () => {
    const probe = buildDoctorProbe({ BW_CLIENT_ID: "id", BW_CLIENT_SECRET: "sec" });
    expect(typeof probe).toBe("function");
  });
});
