import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { Resolver } from "../src/net";

export type Route = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** A local site. `hits` counts requests per path. */
export async function localSite(routes: Record<string, Route>) {
  const hits: Record<string, number> = {};
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    hits[path] = (hits[path] ?? 0) + 1;
    const route = routes[path];
    if (route) route(req, res);
    else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export const html = (body: string, head = "") => (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html lang="it"><head>${head}</head><body>${body}</body></html>`);
};

export const text = (body: string, status = 200, headers: Record<string, string> = {}) => (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(status, { "content-type": "text/plain", ...headers });
  res.end(body);
};

/**
 * In tests the "public internet" is 127.0.0.1: the policy allows only
 * that address, and every other private range stays blocked exactly as
 * in production.
 */
export const onlyLoopback = (ip: string) => ip === "127.0.0.1";

/** A resolver from a table; unknown names fail like a real NXDOMAIN. */
export function tableResolver(table: Record<string, string | string[]>): Resolver & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (host: string) => {
    calls.push(host);
    const v = table[host];
    if (!v) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return (Array.isArray(v) ? v : [v]).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }) as const);
  }) as Resolver & { calls: string[] };
  fn.calls = calls;
  return fn;
}

/** Shaped like the robots.txt Cloudflare writes when "managed robots.txt" is on. */
export const CLOUDFLARE_MANAGED = `# As a condition of accessing this website, you agree to abide by the following
# content signals:
# BEGIN Cloudflare Managed content

User-agent: *
Content-Signal: search=yes,ai-train=no
Allow: /

User-agent: Amazonbot
Disallow: /

User-agent: Applebot-Extended
Disallow: /

User-agent: Bytespider
Disallow: /

User-agent: CCBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

User-agent: Google-Extended
Disallow: /

User-agent: GPTBot
Disallow: /

User-agent: meta-externalagent
Disallow: /

# END Cloudflare Managed Content

User-agent: *
Disallow: /cart
`;

