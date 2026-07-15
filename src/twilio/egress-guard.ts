import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, BlockList } from "node:net";

export class EgressBlockedError extends Error {}

const blocks = new BlockList();
// IPv4 special-use ranges that must never be reachable via customer-supplied URLs.
blocks.addSubnet("0.0.0.0", 8, "ipv4");
blocks.addSubnet("10.0.0.0", 8, "ipv4");
blocks.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT
blocks.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
blocks.addSubnet("169.254.0.0", 16, "ipv4"); // link-local (cloud metadata)
blocks.addSubnet("172.16.0.0", 12, "ipv4");
blocks.addSubnet("192.168.0.0", 16, "ipv4");
blocks.addSubnet("192.0.0.0", 24, "ipv4");
blocks.addSubnet("198.18.0.0", 15, "ipv4"); // benchmarking
blocks.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
blocks.addSubnet("240.0.0.0", 4, "ipv4"); // reserved
blocks.addAddress("255.255.255.255", "ipv4");
// IPv6
blocks.addAddress("::1", "ipv6"); // loopback
blocks.addAddress("::", "ipv6"); // unspecified
blocks.addSubnet("fc00::", 7, "ipv6"); // ULA
blocks.addSubnet("fe80::", 10, "ipv6"); // link-local

/** Decode ::ffff:a.b.c.d IPv4-mapped IPv6 to its embedded IPv4, else null. */
function mappedV4(ip: string): string | null {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1] : null;
}

export function isBlockedAddress(ip: string): boolean {
  const v4 = mappedV4(ip);
  if (v4) return isBlockedAddress(v4);
  const family = isIP(ip);
  if (family === 4) return blocks.check(ip, "ipv4");
  if (family === 6) return blocks.check(ip, "ipv6");
  return true; // not a parseable IP → fail closed
}

export async function assertPublicUrl(
  rawUrl: string,
  opts: { allowPrivate?: boolean; allowHosts?: string[]; lookup?: (host: string) => Promise<string[]> } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EgressBlockedError(`Malformed URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new EgressBlockedError(`Disallowed scheme: ${url.protocol}`);

  // Opt-in host allowlist ("full remediation"): default-deny by host. Listed
  // hosts are explicitly trusted, so they bypass the range denylist below.
  if (opts.allowHosts && opts.allowHosts.length > 0) {
    const host = url.hostname.toLowerCase();
    if (!opts.allowHosts.some((h) => h.toLowerCase() === host))
      throw new EgressBlockedError(`Host not on egress allowlist: ${url.hostname}`);
    return url;
  }

  if (opts.allowPrivate) return url;

  const resolve =
    opts.lookup ??
    (async (host: string) => (await dnsLookup(host, { all: true })).map((a) => a.address));

  // Strip brackets from IPv6 literals: new URL("http://[::1]/").hostname === "[::1]",
  // and net.isIP() does not accept brackets, so classification would otherwise
  // fall through to DNS resolution instead of the IP fast path.
  const host = url.hostname.replace(/^\[|\]$/g, "");

  let literal: string[];
  if (isIP(host)) {
    literal = [host];
  } else {
    try {
      literal = await resolve(url.hostname);
    } catch {
      throw new EgressBlockedError(`Cannot resolve host: ${url.hostname}`);
    }
  }
  if (literal.length === 0) throw new EgressBlockedError(`Cannot resolve host: ${url.hostname}`);
  for (const addr of literal) if (isBlockedAddress(addr))
    throw new EgressBlockedError(`Blocked egress target ${url.hostname} -> ${addr}`);
  // NOTE: this only validates the IP(s) resolved here — it does not pin the
  // connection to them. The caller's fetch() re-resolves the hostname on its
  // own, so a low-TTL DNS answer could differ between this check and the
  // actual connect. This is defense-in-depth, not a hard guarantee against
  // DNS rebinding; the primary control is inbound Basic auth on `/bw/*`.
  return url;
}
