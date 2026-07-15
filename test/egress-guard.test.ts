import { describe, it, expect } from "vitest";
import { isBlockedAddress, assertPublicUrl, EgressBlockedError } from "../src/twilio/egress-guard.js";

describe("isBlockedAddress", () => {
  it("blocks IPv4 loopback / private / link-local / CGNAT", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0"])
      expect(isBlockedAddress(ip)).toBe(true);
  });
  it("blocks IPv6 loopback / ULA / link-local / IPv4-mapped", () => {
    for (const ip of ["::1", "::", "fc00::1", "fe80::1", "::ffff:169.254.169.254"])
      expect(isBlockedAddress(ip)).toBe(true);
  });
  it("allows ordinary public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
      expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  const lookup = async (host: string) =>
    ({ "public.test": ["93.184.216.34"], "evil.test": ["169.254.169.254"] } as Record<string, string[]>)[host] ?? [];

  it("returns the URL for a public host", async () => {
    const u = await assertPublicUrl("https://public.test/hook", { lookup });
    expect(u.host).toBe("public.test");
  });
  it("throws for a host that resolves to a blocked range", async () => {
    await expect(assertPublicUrl("https://evil.test/meta", { lookup })).rejects.toBeInstanceOf(EgressBlockedError);
  });
  it("throws for a non-http scheme", async () => {
    await expect(assertPublicUrl("file:///etc/passwd", { lookup })).rejects.toBeInstanceOf(EgressBlockedError);
  });
  it("allows a blocked host when allowPrivate is set", async () => {
    const u = await assertPublicUrl("https://evil.test/meta", { lookup, allowPrivate: true });
    expect(u.host).toBe("evil.test");
  });
  it("rejects a blocked IPv6 literal without needing DNS", async () => {
    await expect(assertPublicUrl("https://[::1]/", {})).rejects.toBeInstanceOf(EgressBlockedError);
  });
  it("allows a public IPv6 literal without needing DNS", async () => {
    const u = await assertPublicUrl("https://[2606:4700:4700::1111]/", {});
    expect(u.host).toBe("[2606:4700:4700::1111]");
  });
  it("wraps a throwing resolver as EgressBlockedError", async () => {
    const throwingLookup = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(assertPublicUrl("https://unresolvable.test/", { lookup: throwingLookup })).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
  });
});
