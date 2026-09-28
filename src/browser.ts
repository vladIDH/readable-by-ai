/**
 * Optional: open the page in a headless Chromium, the way a person sees
 * it, to compare with what a crawler without JavaScript reads.
 *
 * The browser never touches the network by itself:
 * - every request it makes is intercepted and fetched by `safeFetch()`
 *   (pinned DNS, no private addresses, size and time caps), then handed
 *   back to the page;
 * - images, fonts, stylesheets, media and everything that is not a
 *   document, a script or a data request are aborted;
 * - Chromium's own resolver answers NOTFOUND for every name and its proxy
 *   points to a dead port, so anything that escapes interception
 *   (WebSocket, WebRTC, a service worker) goes nowhere;
 * - service workers are bypassed.
 *
 * `puppeteer-core` is an optional peer dependency, loaded only here.
 */
import type { Browser, HTTPRequest } from "puppeteer-core";
import { BlockedError, safeFetch, type FetchOptions } from "./net.js";

/** Chromium flags that cut the browser off from the network. Exported for tests. */
export const ISOLATION_ARGS = [
  "--host-resolver-rules=MAP * ~NOTFOUND",
  "--proxy-server=http://127.0.0.1:9",
  "--proxy-bypass-list=<-loopback>",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-domain-reliability",
  "--disable-sync",
  "--no-first-run",
  "--no-pings",
];

const ALLOWED_TYPES = new Set(["document", "script", "xhr", "fetch", "preflight"]);

export type RequestDecision = "fetch" | "block";

/** The pure part of the interception, tested on its own. */
export function decideRequest(resourceType: string, url: string): RequestDecision {
  if (!ALLOWED_TYPES.has(resourceType)) return "block";
  if (!/^https?:/i.test(url)) return "block";
  return "fetch";
}

export interface RenderOptions {
  /** Path to a Chromium/Chrome binary. */
  executablePath: string;
  /** Extra launch flags (e.g. those of @sparticuz/chromium). The isolation flags are always added. */
  args?: string[];
  userAgent: string;
  /** Whole render, navigation included. Default 15 s. */
  timeoutMs?: number;
  /** How long the network must be quiet after `load`. Default 500 ms, capped by `settleMs`. */
  settleMs?: number;
  /** Requests the page may make before the rest are aborted. Default 150. */
  maxRequests?: number;
  /** Bytes the page may download in total. Default 15 MB. */
  maxTotalBytes?: number;
  /** Passed to every `safeFetch()` (tests use it for DNS and policy). */
  fetchOptions?: FetchOptions;
  /** An already-launched browser to reuse (it is not closed). */
  browser?: Browser;
}

export interface RenderResult {
  html: string;
  finalUrl: string;
  requests: { served: number; blocked: number; failed: number; bytes: number };
  /** Navigation did not finish or the network never settled; the HTML is what was there at the deadline. */
  incomplete: boolean;
  timings: { launch: number; navigate: number; settle: number; serialize: number };
}

export async function launchIsolated(executablePath: string, args: string[] = []): Promise<Browser> {
  const puppeteer = await import("puppeteer-core");
  const launch = (puppeteer.default ?? puppeteer).launch;
  return launch({ executablePath, args: [...args, ...ISOLATION_ARGS], headless: true, defaultViewport: { width: 1280, height: 900 } });
}

export async function renderPage(url: string, opts: RenderOptions): Promise<RenderResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxRequests = opts.maxRequests ?? 150;
  const maxTotalBytes = opts.maxTotalBytes ?? 15_000_000;
  const started = Date.now();
  const timings = { launch: 0, navigate: 0, settle: 0, serialize: 0 };
  const requests = { served: 0, blocked: 0, failed: 0, bytes: 0 };

  const own = !opts.browser;
  const browser = opts.browser ?? (await launchIsolated(opts.executablePath, opts.args));
  timings.launch = Date.now() - started;
  // ⚠️ A page in the default context, not `createBrowserContext()`: the
  // single-process Chromium used on serverless platforms (@sparticuz/chromium)
  // answers "Target closed" to a new context. Each render gets its own page,
  // closed at the end.
  const page = await browser.newPage();
  try {
    await page.setUserAgent(opts.userAgent);
    await page.setBypassServiceWorker(true);
    await page.setRequestInterception(true);
    let documentHops = 0;

    const handle = async (req: HTTPRequest) => {
      if (req.isInterceptResolutionHandled()) return;
      const decision = decideRequest(req.resourceType(), req.url());
      if (decision === "block" || requests.served >= maxRequests || requests.bytes >= maxTotalBytes) {
        requests.blocked++;
        return req.abort("blockedbyclient").catch(() => {});
      }
      if (req.isNavigationRequest() && req.frame() === page.mainFrame() && ++documentHops > 6) {
        requests.blocked++;
        return req.abort("blockedbyclient").catch(() => {});
      }
      try {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers())) if (!k.startsWith(":")) headers[k] = v;
        const r = await safeFetch(req.url(), {
          ...opts.fetchOptions,
          method: req.method(),
          headers,
          body: req.hasPostData() ? req.postData() : undefined,
          // The browser follows redirects itself, one intercepted hop at a time.
          maxRedirects: 0,
          maxBytes: Math.min(5_000_000, maxTotalBytes - requests.bytes),
          timeoutMs: 8_000,
        });
        requests.served++;
        requests.bytes += r.body.length;
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(r.headers)) {
          if (!["content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie", "alt-svc"].includes(k)) out[k] = v;
        }
        await req.respond({ status: r.status, headers: out, body: r.body });
      } catch (e) {
        if (e instanceof BlockedError) requests.blocked++;
        else requests.failed++;
        await req.abort(e instanceof BlockedError ? "blockedbyclient" : "failed").catch(() => {});
      }
    };
    page.on("request", (req) => void handle(req));

    let incomplete = false;
    const t0 = Date.now();
    try {
      await page.goto(url, { waitUntil: "load", timeout: Math.max(1_000, timeoutMs - (Date.now() - started)) });
    } catch {
      incomplete = true;
    }
    timings.navigate = Date.now() - t0;
    const t1 = Date.now();
    const settleBudget = Math.max(0, Math.min(opts.settleMs ?? 3_000, timeoutMs - (Date.now() - started)));
    if (!incomplete && settleBudget > 0) {
      try {
        await page.waitForNetworkIdle({ idleTime: 500, timeout: settleBudget });
      } catch {
        // Pages that poll forever (analytics, chat widgets) never go idle: take what is there.
      }
    }
    timings.settle = Date.now() - t1;
    const t2 = Date.now();
    const html = await page.content().catch(() => "");
    const finalUrl = page.url();
    timings.serialize = Date.now() - t2;
    return { html, finalUrl, requests, incomplete, timings };
  } finally {
    await page.close().catch(() => {});
    if (own) await browser.close().catch(() => {});
  }
}

/** Where Chrome usually lives, for the CLI's `--browser`. */
export function findLocalChrome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const list: string[] = [];
  if (env.CHROME_PATH) list.push(env.CHROME_PATH);
  if (platform === "win32") {
    for (const base of [env["PROGRAMFILES"], env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean) as string[]) {
      list.push(`${base}\\Google\\Chrome\\Application\\chrome.exe`, `${base}\\Chromium\\Application\\chrome.exe`, `${base}\\Microsoft\\Edge\\Application\\msedge.exe`);
    }
  } else if (platform === "darwin") {
    list.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else {
    list.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium");
  }
  return list;
}
