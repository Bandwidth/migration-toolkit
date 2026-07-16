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

describe("postToCustomer response-size cap", () => {
  it("aborts an oversized streamed body early and cancels the reader", async () => {
    let pulls = 0;
    let cancelled = false;
    const chunk = new Uint8Array(64 * 1024); // 64 KiB per pull
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(chunk); // never-ending source
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
    await expect(
      postToCustomer({ url: "http://public.test/hook", params: {}, authToken: "t", fetchImpl, lookup: async () => ["93.184.216.34"] }),
    ).rejects.toThrow(/too large/);
    expect(cancelled).toBe(true); // reader was cancelled, not drained
    expect(pulls).toBeLessThan(16); // stopped ~5 pulls in (256 KiB / 64 KiB), not unbounded
  });

  it("rejects (and cancels) when Content-Length alone declares oversize", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(8));
        c.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = new Response(stream, { status: 200, headers: { "content-length": String(300 * 1024) } });
    const fetchImpl = vi.fn(async () => res) as unknown as typeof fetch;
    await expect(
      postToCustomer({ url: "http://public.test/hook", params: {}, authToken: "t", fetchImpl, lookup: async () => ["93.184.216.34"] }),
    ).rejects.toThrow(/too large/);
    expect(cancelled).toBe(true);
  });
  it("accepts a normal-sized response", async () => {
    const fetchImpl = vi.fn(async () => new Response("<Response/>", { status: 200 })) as unknown as typeof fetch;
    const body = await postToCustomer({ url: "http://public.test/hook", params: {}, authToken: "t", fetchImpl, lookup: async () => ["93.184.216.34"] });
    expect(body).toBe("<Response/>");
  });
});
