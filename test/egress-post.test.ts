import { describe, it, expect, vi } from "vitest";
import { postToCustomer } from "../src/twilio/egress.js";

describe("postToCustomer egress guard", () => {
  it("refuses to fetch an internal address", async () => {
    const fetchImpl = vi.fn();
    await expect(
      postToCustomer({ url: "http://169.254.169.254/latest/meta-data/", params: {}, authToken: "t", fetchImpl }),
    ).rejects.toThrow(/Blocked egress/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches a public URL with redirects disabled", async () => {
    const fetchImpl = vi.fn(async () => new Response("<Response/>", { status: 200 })) as unknown as typeof fetch;
    await postToCustomer({
      url: "http://public.test/hook",
      params: { A: "1" },
      authToken: "t",
      fetchImpl,
      lookup: async () => ["93.184.216.34"],
    });
    const [, init] = (fetchImpl as any).mock.calls[0];
    expect(init.redirect).toBe("manual");
  });

  it("allows an internal address when allowPrivate is set (local dev)", async () => {
    const fetchImpl = vi.fn(async () => new Response("<Response/>", { status: 200 })) as unknown as typeof fetch;
    await postToCustomer({
      url: "http://127.0.0.1:4000/voice", params: {}, authToken: "t", fetchImpl, allowPrivate: true,
    });
    expect(fetchImpl).toHaveBeenCalled();
  });
});
