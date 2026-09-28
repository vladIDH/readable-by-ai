/**
 * The safe fetcher: every byte this package reads from the network goes
 * through `safeFetch()`, including the requests a headless browser makes.
 *
 * Rules, all enforced here and not by callers:
 * - only `http:` and `https:`, only ports 80 and 443;
 * - no private, loopback, link-local, carrier-grade NAT, multicast or
 *   cloud-metadata addresses, whatever form the address is written in;
 * - the DNS answer that is checked is the SAME answer the socket connects
 *   to (the address is pinned inside the connection's `lookup`), so a name
 *   that resolves to a public address for the check and to 127.0.0.1 for
 *   the request cannot slip through (DNS rebinding);
 * - redirects are followed by hand, at most `maxRedirects`, and every hop
 *   goes through the same checks;
 * - a hard timeout per request and a cap on the decompressed body size.
 */
import * as http from "node:http";
import * as https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { lookup as dnsLookup } from "node:dns";
import * as zlib from "node:zlib";

export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;

/** The real resolver: the system's `getaddrinfo`, all addresses. */
export const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })));
    });
  });

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((n, p) => n * 256 + Number(p), 0);
}

const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata (169.254.169.254)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

function v4Blocked(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
  });
}

/** Expands an IPv6 address to eight 16-bit groups. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // Trailing dotted IPv4 (::ffff:1.2.3.4) becomes two groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    if (isIP(dotted[1]) !== 4) return null;
    const n = ipv4ToInt(dotted[1]);
    s = s.slice(0, -dotted[1].length) + ((n >>> 16) & 0xffff).toString(16) + ":" + (n & 0xffff).toString(16);
  }
  const parts = s.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (parts.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array(parts.length === 2 ? missing : 0).fill("0"), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * True when the address is one a public website can have.
 * Unknown or unparsable input is NOT public: the guard fails closed.
 */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return !v4Blocked(ip);
  if (kind !== 6) return false;
  const g = v6Groups(ip);
  if (!g) return false;
  const embeddedV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  if (g.every((x) => x === 0)) return false; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the IPv4.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return isPublicAddress(embeddedV4(g[6], g[7]));
  // NAT64 (64:ff9b::/96 and 64:ff9b:1::/48): the IPv4 on the other side.
  if (g[0] === 0x64 && g[1] === 0xff9b) return isPublicAddress(embeddedV4(g[6], g[7]));
  if ((g[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local (includes fd00:ec2::254)
  if ((g[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return false; // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return false; // discard-only
  if (g[0] === 0x2002) return isPublicAddress(embeddedV4(g[1], g[2])); // 6to4
  return true;
}

/** Host names that never leave the machine or the local network. */
export function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".home.arpa") ||
    h.endsWith(".lan") ||
    h === "metadata" ||
    (!h.includes(".") && isIP(h) === 0)
  );
}

export class BlockedError extends Error {
  constructor(public readonly reason: "protocol" | "port" | "hostname" | "address" | "redirects" | "credentials") {
    super(`blocked: ${reason}`);
    this.name = "BlockedError";
  }
}

/** Checks everything that can be checked without the network. Throws `BlockedError`. */
export function assertUrlAllowed(raw: string | URL): URL {
  const u = typeof raw === "string" ? new URL(raw) : raw;
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new BlockedError("protocol");
  if (u.username || u.password) throw new BlockedError("credentials");
  if (u.port && u.port !== "80" && u.port !== "443") throw new BlockedError("port");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new BlockedError("address");
  } else if (isBlockedHostname(host)) {
    throw new BlockedError("hostname");
  }
  return u;
}

/**
 * Tests with a custom policy (a local server on a random port): keep the
 * protocol, credential and host-name rules, let the policy judge addresses.
 */
function checkShapeOnly(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new BlockedError("protocol");
  if (u.username || u.password) throw new BlockedError("credentials");
  if (!isIP(u.hostname.replace(/^\[|\]$/g, "")) && isBlockedHostname(u.hostname)) throw new BlockedError("hostname");
  return u;
}

/**
 * A `lookup` for `http.request` that resolves ONCE, refuses the whole
 * answer if any address is not public, and hands the socket exactly the
 * address it just checked. There is no second resolution to race.
 */
export function pinnedLookup(resolver: Resolver, isAllowed: (ip: string) => boolean, onResolved?: (ip: string) => void): LookupFunction {
  return ((hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const cb = typeof options === "function" ? (options as typeof callback) : callback;
    const wantAll = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
    const host = hostname.replace(/^\[|\]$/g, "");
    const literal = isIP(host);
    const answer = literal ? Promise.resolve([{ address: host, family: literal as 4 | 6 }]) : resolver(host);
    answer.then(
      (addresses) => {
        if (addresses.length === 0) return cb(Object.assign(new Error(`no address for ${host}`), { code: "ENOTFOUND" }));
        if (addresses.some((a) => !isAllowed(a.address))) return cb(new BlockedError("address"));
        const chosen = addresses[0];
        onResolved?.(chosen.address);
        if (wantAll) cb(null, [{ address: chosen.address, family: chosen.family }]);
        else cb(null, chosen.address, chosen.family);
      },
      (err) => cb(err),
    );
  }) as LookupFunction;
}

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Per request (each redirect hop gets its own). Default 8000 ms. */
  timeoutMs?: number;
  /** Decompressed body cap. Default 5 MB. Over it: `truncated: true`. */
  maxBytes?: number;
  /** Default 5. Set 0 to get the 3xx back (the browser follows by itself). */
  maxRedirects?: number;
  signal?: AbortSignal;
  /** For tests: replace DNS. */
  resolver?: Resolver;
  /** For tests: replace the address policy. Production code never sets it. */
  isAllowed?: (ip: string) => boolean;
}

export interface FetchResult {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
  redirects: string[];
  /** The address the socket actually connected to, for the last hop. */
  address: string | null;
}

function oneRequest(u: URL, opts: FetchOptions): Promise<Omit<FetchResult, "redirects" | "url">> {
  const maxBytes = opts.maxBytes ?? 5_000_000;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  let connected: string | null = null;
  const lookup = pinnedLookup(opts.resolver ?? systemResolver, opts.isAllowed ?? isPublicAddress, (ip) => (connected = ip));
  const mod = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      u,
      {
        method: opts.method ?? "GET",
        headers: { "accept-encoding": "gzip, deflate, br", ...opts.headers },
        lookup,
        // No connection reuse: a pooled socket would skip `lookup`.
        agent: false,
        signal: opts.signal,
      },
      (res) => {
        const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
        let stream: NodeJS.ReadableStream = res;
        if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
        }
        const done = () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks), truncated, address: connected });
        };
        stream.on("data", (c: Buffer) => {
          if (truncated) return;
          size += c.length;
          if (size > maxBytes) {
            truncated = true;
            chunks.push(c.subarray(0, c.length - (size - maxBytes)));
            req.destroy();
            done();
            return;
          }
          chunks.push(c);
        });
        stream.on("end", done);
        stream.on("error", (e) => (truncated ? undefined : fail(e)));
      },
    );
    const fail = (e: unknown) => {
      clearTimeout(timer);
      reject(e);
    };
    const timer = setTimeout(() => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), timeoutMs);
    req.on("error", fail);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Fetches a URL under all the rules above. Throws `BlockedError` or a network error. */
export async function safeFetch(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const redirects: string[] = [];
  let current = url;
  let method = opts.method ?? "GET";
  let body = opts.body;
  for (;;) {
    // Literal addresses are judged here; names are judged in the pinned lookup.
    const u = opts.isAllowed ? checkShapeOnly(current) : assertUrlAllowed(current);
    const r = await oneRequest(u, { ...opts, method, body });
    const location = r.headers["location"];
    if (maxRedirects > 0 && r.status >= 300 && r.status < 400 && location) {
      if (redirects.length >= maxRedirects) throw new BlockedError("redirects");
      current = new URL(location, u).toString();
      redirects.push(current);
      if (r.status === 303 || ((r.status === 301 || r.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      continue;
    }
    return { ...r, url: u.toString(), redirects };
  }
}

/** Decodes a body using the charset the response declares (or the page's meta), UTF-8 by default. */
export function decodeBody(body: Buffer, contentType: string | undefined): string {
  const fromHeader = contentType ? /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1] : undefined;
  const head = body.subarray(0, 2048).toString("latin1");
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  for (const label of [fromHeader, fromMeta, "utf-8"]) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(body);
    } catch {
      /* unknown label: try the next one */
    }
  }
  return body.toString("utf8");
}
