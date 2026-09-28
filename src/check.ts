/**
 * `check(url)`: everything this package knows how to look at, in one
 * report. Language-neutral on purpose: findings carry an id, a level and
 * data, and whoever shows them writes the words (the CLI in English).
 */
import { classifyAccess, type AccessResult } from "./access.js";
import { detectCms, type CmsResult } from "./cms.js";
import { readContacts, type ContactsResult } from "./contacts.js";
import { metaMap, parseHtml, type ParsedPage } from "./html.js";
import { BlockedError, decodeBody, safeFetch, type FetchOptions, type FetchResult } from "./net.js";
import { MAJOR_ASSISTANTS, TRAINING_ONLY, assistantAccess, isAllowed as robotsAllow, looksCloudflareManaged, parseRobots, type AssistantAccess } from "./robots.js";
import { readStructuredData, type StructuredResult } from "./structured.js";
import { renderPage, type RenderOptions, type RenderResult } from "./browser.js";

export const DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; readable-by-ai/1.0; +https://github.com/vladIDH/readable-by-ai)";

export type Level = "green" | "yellow" | "red";

export type FindingId =
  | "access-blocked"
  | "robots-blocks-assistants" | "robots-blocks-training" | "robots-unreachable" | "robots-ok"
  | "noindex"
  | "text-empty" | "text-partial" | "text-thin" | "text-ok"
  | "title-missing" | "title-ok"
  | "description-missing" | "description-ok"
  | "lang-missing" | "lang-ok"
  | "canonical-missing" | "canonical-elsewhere" | "canonical-ok"
  | "h1-missing" | "h1-ok"
  | "business-missing" | "business-incomplete" | "business-ok"
  | "faq-missing" | "faq-ok"
  | "llms-missing" | "llms-ok"
  | "sitemap-missing" | "sitemap-ok"
  | "contacts-missing" | "contacts-partial" | "contacts-ok"
  | "name-not-in-text" | "name-mismatch"
  | "home-empty";

export interface Finding {
  id: FindingId;
  level: Level;
  data?: Record<string, string | number | boolean | string[]>;
}

export type StepName = "raw" | "render" | "extras";

export interface CheckOptions {
  userAgent?: string;
  /** Render with a real browser to measure how much text JavaScript adds. Off by default. */
  browser?: Omit<RenderOptions, "userAgent" | "fetchOptions"> & { userAgent?: string } | null;
  /** Per request. Default 8 s. */
  requestTimeoutMs?: number;
  /** Also read the home page when the URL is another page. Default true. */
  checkHome?: boolean;
  onStep?: (step: StepName, state: "start" | "done", ms?: number) => void;
  /** Tests only: DNS and address policy. */
  fetchOptions?: Pick<FetchOptions, "resolver" | "isAllowed">;
}

export type Verdict =
  /** Something in front of the site, or robots.txt, keeps assistants out. */
  | "blocked"
  /** Blocked AND, behind the block, a page that is empty without JavaScript. */
  | "blocked-and-empty"
  /** Assistants get in, but the page is (almost) empty without JavaScript. */
  | "empty"
  /** Part of the text arrives only with JavaScript. */
  | "partial"
  /** Little text, but not because of JavaScript. */
  | "thin"
  /** The site did not answer, or answered with a server error. */
  | "unreachable"
  | "readable";

export interface Report {
  url: string;
  finalUrl: string;
  checkedAt: string;
  verdict: Verdict;
  access: AccessResult;
  text: {
    rawChars: number;
    renderedChars: number | null;
    /** rawChars / renderedChars, 0..1, when the page was rendered. */
    ratio: number | null;
    jsOnly: boolean;
    jsSignals: string[];
    renderIncomplete: boolean;
    renderError: string | null;
  };
  robots: {
    found: boolean;
    status: number | null;
    cloudflareManaged: boolean;
    contentSignals: Record<string, string>;
    assistants: AssistantAccess[];
    /** Training-only crawlers of no assistant (Common Crawl), blocked or not. */
    otherTraining: Array<{ token: string; blocked: boolean }>;
  };
  meta: {
    title: string | null;
    description: string | null;
    lang: string | null;
    canonical: string | null;
    noindex: "meta" | "header" | null;
    h1: string[];
    headings: Array<{ level: number; text: string }>;
    /** Every <meta name|property> → content (lowercased keys). */
    tags: Record<string, string>;
  };
  structuredData: StructuredResult & { businessOnHome: boolean };
  llmsTxt: { found: boolean; url: string };
  sitemap: { found: boolean; url: string | null };
  contacts: ContactsResult;
  cms: CmsResult;
  home: null | { url: string; rawChars: number; jsOnly: boolean; title: string | null };
  findings: Finding[];
  timings: Record<string, number>;
}

function looksHtml(r: FetchResult): boolean {
  const ct = (r.headers["content-type"] ?? "").toLowerCase();
  if (ct.includes("html") || ct.includes("xml")) return true;
  return /^\s*(<!doctype html|<html|<head|<body)/i.test(r.body.subarray(0, 512).toString("latin1"));
}

/** A crawler without JavaScript sees (almost) nothing, and JavaScript is why. */
function jsSignals(page: ParsedPage): string[] {
  const s: string[] = [];
  const empty = page.mounts.filter((m) => m.textChars === 0);
  if (empty.length) s.push(`empty mount point #${empty[0].id}`);
  if (page.scripts.some((x) => x.type === "module")) s.push("module scripts");
  if (/enable javascript|javascript (is )?(required|disabled)|attiva(re)? javascript|habilita(r)? javascript/i.test(page.noscriptText)) {
    s.push("<noscript> asks for JavaScript");
  }
  const scriptBytes = page.scripts.reduce((n, x) => n + x.inline, 0);
  if (page.htmlChars > 0 && scriptBytes / page.htmlChars > 0.6) s.push("page is mostly inline script");
  return s;
}

const THIN = 200;

export async function check(url: string, options: CheckOptions = {}): Promise<Report> {
  const started = Date.now();
  const timings: Record<string, number> = {};
  const ua = options.userAgent ?? DEFAULT_USER_AGENT;
  const base: FetchOptions = {
    ...options.fetchOptions,
    timeoutMs: options.requestTimeoutMs ?? 8_000,
    headers: { "user-agent": ua, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "accept-language": "*" },
  };
  const step = async <T>(name: StepName, fn: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    options.onStep?.(name, "start");
    try {
      return await fn();
    } finally {
      timings[name] = Date.now() - t;
      options.onStep?.(name, "done", timings[name]);
    }
  };

  // 1. The page as a crawler without JavaScript reads it.
  const raw = await step("raw", async () => {
    try {
      return await safeFetch(url, base);
    } catch (e) {
      if (e instanceof BlockedError) throw e; // not a website we may read: the caller says so
      return null;
    }
  });
  const finalUrl = raw?.url ?? url;
  const rawHtml = raw && looksHtml(raw) ? decodeBody(raw.body, raw.headers["content-type"]) : "";
  const page = parseHtml(rawHtml);
  const access = classifyAccess(raw?.status ?? null, raw?.headers ?? {}, rawHtml.slice(0, 20_000), page.text.length);
  const origin = new URL(finalUrl).origin;
  const pathOf = (u: string) => {
    const x = new URL(u);
    return x.pathname + x.search;
  };

  // 2. In parallel: the browser, and the site-level files.
  const renderP: Promise<RenderResult | Error | null> =
    options.browser && !access.blocked
      ? step("render", () =>
          renderPage(finalUrl, { ...options.browser!, userAgent: options.browser!.userAgent ?? ua, fetchOptions: options.fetchOptions }).catch(
            (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
          ),
        )
      : Promise.resolve(null);

  const extrasP = step("extras", async () => {
    const get = (u: string, accept = "text/plain,*/*") =>
      safeFetch(u, { ...base, headers: { ...base.headers, accept }, maxBytes: 2_000_000 }).catch(() => null);
    const isHome = new URL(finalUrl).pathname === "/" && !new URL(finalUrl).search;
    const [robotsRes, llmsRes, homeRes] = await Promise.all([
      get(`${origin}/robots.txt`),
      get(`${origin}/llms.txt`),
      options.checkHome !== false && !isHome ? get(`${origin}/`, "text/html,*/*") : Promise.resolve(null),
    ]);
    const robotsOk = !!robotsRes && robotsRes.status === 200 && !looksHtml(robotsRes);
    const robotsTxt = robotsOk ? decodeBody(robotsRes!.body, robotsRes!.headers["content-type"]) : "";
    const robots = robotsOk ? parseRobots(robotsTxt) : null;

    let sitemapUrl: string | null = null;
    const candidates = [...(robots?.sitemaps ?? []).slice(0, 2), `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
    for (const c of candidates) {
      let u: string;
      try {
        u = new URL(c, origin).toString();
      } catch {
        continue;
      }
      const r = await get(u, "application/xml,text/xml,*/*");
      if (r && r.status === 200 && /<(urlset|sitemapindex)[\s>]/i.test(decodeBody(r.body.subarray(0, 4096), r.headers["content-type"]))) {
        sitemapUrl = u;
        break;
      }
    }
    const llmsBody = llmsRes && llmsRes.status === 200 ? decodeBody(llmsRes.body.subarray(0, 4096), llmsRes.headers["content-type"]) : "";
    const llmsFound = !!llmsBody.trim() && !/^\s*</.test(llmsBody);
    const home = homeRes && homeRes.status === 200 && looksHtml(homeRes) ? { res: homeRes, page: parseHtml(decodeBody(homeRes.body, homeRes.headers["content-type"])) } : null;
    return { robotsRes, robotsTxt, robots, sitemapUrl, llmsFound, home };
  });

  const [render, extras] = await Promise.all([renderP, extrasP]);

  // 3. Put it together.
  const rendered = render && !(render instanceof Error) ? parseHtml(render.html, { scripting: true }) : null;
  const rawChars = page.text.length;
  const renderedChars = rendered ? rendered.text.length : null;
  const ratio = renderedChars ? Math.min(1, rawChars / renderedChars) : null;
  const signals = jsSignals(page);
  const jsOnly = rendered
    ? rawChars < THIN && renderedChars! >= Math.max(400, rawChars * 3)
    : rawChars < THIN && signals.some((s) => s.startsWith("empty mount") || s.startsWith("<noscript>") || s === "module scripts");

  const tags = metaMap(page);
  const robotsMeta = `${tags["robots"] ?? ""} ${tags["googlebot"] ?? ""}`.toLowerCase();
  const headerRobots = (raw?.headers["x-robots-tag"] ?? "").toLowerCase();
  const noindex = /noindex|none/.test(robotsMeta) ? "meta" : /noindex|none/.test(headerRobots) ? "header" : null;
  const canonical = page.links.find((l) => (l.rel ?? "").toLowerCase().split(/\s+/).includes("canonical"))?.href ?? null;

  const structured = readStructuredData(page);
  const homeStructured = extras.home ? readStructuredData(extras.home.page) : null;
  const businessOnHome = !structured.business && !!homeStructured?.business;
  const structuredData = { ...structured, business: structured.business ?? homeStructured?.business ?? null, businessOnHome };

  const cms = detectCms(rawHtml, page, finalUrl, raw?.headers ?? {});
  const contacts = readContacts(page, [structuredData.business?.name, tags["og:site_name"], page.title]);
  const assistants = assistantAccess(extras.robots, pathOf(finalUrl));
  const cloudflareManaged = !!extras.robots && looksCloudflareManaged(extras.robotsTxt, extras.robots);

  const homeInfo = extras.home
    ? {
        url: extras.home.res.url,
        rawChars: extras.home.page.text.length,
        jsOnly: extras.home.page.text.length < THIN && jsSignals(extras.home.page).length > 0,
        title: extras.home.page.title,
      }
    : null;

  const report: Report = {
    url,
    finalUrl,
    checkedAt: new Date().toISOString(),
    verdict: "readable",
    access,
    text: {
      rawChars,
      renderedChars,
      ratio,
      jsOnly,
      jsSignals: signals,
      renderIncomplete: !!render && !(render instanceof Error) && render.incomplete,
      renderError: render instanceof Error ? render.message.slice(0, 200) : null,
    },
    robots: {
      found: !!extras.robots,
      status: extras.robotsRes?.status ?? null,
      cloudflareManaged,
      contentSignals: extras.robots?.contentSignals ?? {},
      assistants,
      otherTraining: TRAINING_ONLY.map((b) => ({ token: b.token, blocked: !!extras.robots && !robotsAllow(extras.robots, b.token, pathOf(finalUrl)) })),
    },
    meta: {
      title: page.title,
      description: tags["description"] ?? tags["og:description"] ?? null,
      lang: page.lang,
      canonical,
      noindex,
      h1: page.headings.filter((h) => h.level === 1).map((h) => h.text).slice(0, 5),
      headings: page.headings.slice(0, 40),
      tags,
    },
    structuredData,
    llmsTxt: { found: extras.llmsFound, url: `${origin}/llms.txt` },
    sitemap: { found: !!extras.sitemapUrl, url: extras.sitemapUrl },
    contacts,
    cms,
    home: homeInfo,
    findings: [],
    timings,
  };
  if (render && !(render instanceof Error)) {
    for (const [k, v] of Object.entries(render.timings)) timings[`render.${k}`] = v;
  }
  report.findings = findingsFor(report);
  report.verdict = verdictFor(report);
  timings.total = Date.now() - started;
  return report;
}


export function isBlocked(r: Pick<Report, "access" | "robots">): boolean {
  const shield = !!r.access.blocked && r.access.blocked.kind !== "server-error" && r.access.blocked.kind !== "unreachable";
  return shield || r.robots.assistants.some((a) => MAJOR_ASSISTANTS.has(a.id) && a.answers === "no");
}

export function verdictFor(r: Report): Verdict {
  const blocked = isBlocked(r);
  const empty = r.text.jsOnly || (r.text.ratio !== null && r.text.ratio < 0.3 && (r.text.renderedChars ?? 0) >= 400);
  if (blocked && empty) return "blocked-and-empty";
  if (blocked) return "blocked";
  if (r.access.blocked) return "unreachable";
  if (empty) return "empty";
  if (r.text.ratio !== null && r.text.ratio < 0.8) return "partial";
  if (r.text.rawChars < THIN && !r.access.blocked) return "thin";
  return "readable";
}

export function findingsFor(r: Report): Finding[] {
  const f: Finding[] = [];
  const push = (id: FindingId, level: Level, data?: Finding["data"]) => f.push(data ? { id, level, data } : { id, level });
  const cf = r.access.cloudflare || r.robots.cloudflareManaged;

  if (r.access.blocked) {
    push("access-blocked", r.access.blocked.kind === "server-error" || r.access.blocked.kind === "unreachable" ? "yellow" : "red", {
      kind: r.access.blocked.kind,
      shield: r.access.blocked.shield ?? "",
      status: r.access.status ?? 0,
      cloudflare: cf,
    });
  }

  const blockedFor = r.robots.assistants.filter((a) => a.answers !== "yes");
  const trainingBlocked = r.robots.assistants.filter((a) => a.trainingBlocked);
  if (r.robots.status !== null && r.robots.status >= 500) {
    push("robots-unreachable", "yellow", { status: r.robots.status, cloudflare: cf });
  } else if (blockedFor.length) {
    push("robots-blocks-assistants", "red", {
      assistants: blockedFor.map((a) => a.name),
      partial: blockedFor.every((a) => a.answers === "partial"),
      cloudflare: cf,
      cloudflareManaged: r.robots.cloudflareManaged,
    });
  } else {
    push("robots-ok", "green", { found: r.robots.found });
  }
  const trainingBots = [
    ...trainingBlocked.flatMap((a) => a.bots.filter((b) => b.role === "training" && b.page === "blocked").map((b) => b.token)),
    ...r.robots.otherTraining.filter((b) => b.blocked).map((b) => b.token),
  ];
  if (trainingBots.length) {
    push("robots-blocks-training", "yellow", {
      bots: trainingBots,
      cloudflareManaged: r.robots.cloudflareManaged,
    });
  }

  if (r.meta.noindex) push("noindex", "red", { where: r.meta.noindex });

  // When the page is empty without JavaScript, the page-level checks below fail for the same reason.
  const cause = r.text.jsOnly ? { cause: "empty" } : undefined;
  const pct = r.text.ratio === null ? null : Math.round(r.text.ratio * 100);
  if (r.text.jsOnly) push("text-empty", "red", { raw: r.text.rawChars, rendered: r.text.renderedChars ?? -1, percent: pct ?? -1 });
  else if (pct !== null && pct < 80) push("text-partial", pct < 30 ? "red" : "yellow", { percent: pct, raw: r.text.rawChars, rendered: r.text.renderedChars ?? -1 });
  else if (r.text.rawChars < THIN && !r.access.blocked) push("text-thin", "yellow", { raw: r.text.rawChars });
  else if (!r.access.blocked) push("text-ok", "green", { raw: r.text.rawChars, percent: pct ?? -1 });

  if (!r.access.blocked) {
    const title = r.meta.title ?? "";
    push(title ? "title-ok" : "title-missing", title ? "green" : "red", title ? { title } : undefined);
    push(r.meta.description ? "description-ok" : "description-missing", r.meta.description ? "green" : "yellow");
    push(r.meta.lang ? "lang-ok" : "lang-missing", r.meta.lang ? "green" : "yellow", r.meta.lang ? { lang: r.meta.lang } : undefined);
    if (!r.meta.canonical) push("canonical-missing", "yellow");
    else {
      let other = false;
      try {
        other = new URL(r.meta.canonical, r.finalUrl).hostname.replace(/^www\./, "") !== new URL(r.finalUrl).hostname.replace(/^www\./, "");
      } catch {
        other = false;
      }
      push(other ? "canonical-elsewhere" : "canonical-ok", other ? "yellow" : "green", { canonical: r.meta.canonical });
    }
    push(r.meta.h1.length ? "h1-ok" : "h1-missing", r.meta.h1.length ? "green" : "yellow", r.meta.h1.length ? { h1: r.meta.h1[0] } : cause);

    const b = r.structuredData.business;
    if (!b) push("business-missing", "yellow", { microdata: r.structuredData.microdataTypes.length > 0 });
    else if (b.missing.length) push("business-incomplete", "yellow", { type: b.type, missing: b.missing, onHome: r.structuredData.businessOnHome });
    else push("business-ok", "green", { type: b.type, onHome: r.structuredData.businessOnHome });
    push(r.structuredData.faq ? "faq-ok" : "faq-missing", r.structuredData.faq ? "green" : "yellow", r.structuredData.faq ? { questions: r.structuredData.faq.questions } : undefined);
  }

  push(r.llmsTxt.found ? "llms-ok" : "llms-missing", r.llmsTxt.found ? "green" : "yellow");
  push(r.sitemap.found ? "sitemap-ok" : "sitemap-missing", r.sitemap.found ? "green" : "yellow", r.sitemap.url ? { url: r.sitemap.url } : undefined);

  if (!r.access.blocked) {
    const c = r.contacts;
    const have = [c.phones.length ? "phone" : "", c.emails.length ? "email" : "", c.address ? "address" : ""].filter(Boolean);
    const missing = ["phone", "email", "address"].filter((x) => !have.includes(x));
    if (have.length === 0) push("contacts-missing", "yellow", cause);
    else if (missing.length) push("contacts-partial", "yellow", { have, missing });
    else push("contacts-ok", "green");
    if (c.name && c.nameInText === false) push("name-not-in-text", "yellow", { name: c.name, ...(cause ?? {}) });
    if (c.name && c.otherNames.length) push("name-mismatch", "yellow", { name: c.name, others: c.otherNames });
  }
  if (r.home?.jsOnly && !r.text.jsOnly) push("home-empty", "red", { url: r.home.url });
  return f;
}
