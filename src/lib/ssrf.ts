/**
 * SSRF guard for `put sourceUrl`: only https, never loopback, private,
 * link-local, CGNAT, multicast or otherwise reserved addresses, whether given
 * as an IP literal, as a local hostname or reached through DNS or a redirect.
 * Redirects are followed by hand (at most MAX_REDIRECTS) so every hop is
 * checked. A DNS answer that changes between the check and the connection
 * (rebinding) is not covered; the server also sends no credentials to the
 * source, so the exposure is limited to what an anonymous GET can reach.
 */
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

export const MAX_REDIRECTS = 5;

export type HostResolver = (host: string) => Promise<string[]>;

const dnsResolver: HostResolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);
// Tests run without DNS: the default resolver is a no-op under Vitest; resolver tests install their own.
let resolver: HostResolver = process.env.VITEST ? async () => [] : dnsResolver;

/** Test seam (undefined restores the default). */
export function setHostResolver(r: HostResolver | undefined) {
  resolver = r ?? (process.env.VITEST ? async () => [] : dnsResolver);
}

function v4Blocked(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && p[2] === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function v6Blocked(ip: string): boolean {
  const x = ip.toLowerCase();
  if (x === "::" || x === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (mapped) return v4Blocked(mapped[1]!);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(x)) return true; // mapped v4 in hex form
  const first = parseInt(x.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

/** True for addresses a server-side fetch must never reach. */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return v4Blocked(ip);
  if (kind === 6) return v6Blocked(ip);
  return true;
}

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"];

/** Validate one URL (scheme, host name, IP literal, DNS answers); throws with a clear reason. */
export async function assertPublicHttpsUrl(raw: string | URL): Promise<URL> {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error(`sourceUrl is not a valid URL: ${String(raw)}`);
  }
  if (url.protocol !== "https:") throw new Error("sourceUrl must use https");
  if (url.username || url.password) throw new Error("sourceUrl must not contain credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || LOCAL_SUFFIXES.some((s) => host.endsWith(s)) || (!host.includes(".") && isIP(host) === 0)) {
    throw new Error(`sourceUrl host ${host || "(empty)"} is not a public internet host`);
  }
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new Error(`sourceUrl points at a private, loopback or reserved address (${host}); refused`);
    return url;
  }
  let addrs: string[];
  try {
    addrs = await resolver(host);
  } catch {
    throw new Error(`sourceUrl host ${host} does not resolve`);
  }
  const bad = addrs.find(isBlockedAddress);
  if (bad) throw new Error(`sourceUrl host ${host} resolves to a private, loopback or reserved address (${bad}); refused`);
  return url;
}

function isGoogleApi(url: URL): boolean {
  return url.protocol === "https:" && (url.hostname === "www.googleapis.com" || url.hostname.endsWith(".googleapis.com"));
}

/**
 * Wrap `fetchImpl` for uploadFromUrl: requests to Google APIs (the upload
 * session) pass through; any other request is the source download and is
 * checked hop by hop with manual redirects.
 */
export function guardedSourceFetch(fetchImpl: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const first = new URL(input instanceof Request ? input.url : String(input));
    if (isGoogleApi(first)) return fetchImpl(input, init);
    let url = await assertPublicHttpsUrl(first);
    for (let hop = 0; ; hop++) {
      const res = await fetchImpl(url, { ...init, redirect: "manual" });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) return res;
      if (hop >= MAX_REDIRECTS) throw new Error(`sourceUrl redirected more than ${MAX_REDIRECTS} times`);
      url = await assertPublicHttpsUrl(new URL(location, url));
    }
  }) as typeof fetch;
}
