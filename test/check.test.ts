/**
 * The whole check against local sites. The two ways AI assistants miss a
 * site are kept apart: they cannot get IN (robots.txt, a challenge page),
 * or they get in and find an EMPTY page (JavaScript only), and the mixes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { check, type Report } from "../src/check";
import { BlockedError } from "../src/net";
import { CLOUDFLARE_MANAGED, html, localSite, onlyLoopback, tableResolver, text, type Route } from "./helpers";

const RICH_HEAD = `<title>Da Mario | Pizzeria a Roma</title><meta name="description" content="Pizzeria a Roma dal 1990">
<link rel="canonical" href="/"><script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org", "@type": "Restaurant", name: "Da Mario", telephone: "+39 06 1234 5678",
  address: { "@type": "PostalAddress", streetAddress: "Via Roma 12", addressLocality: "Roma" }, openingHours: "Mo-Su 12:00-23:00",
})}</script><script type="application/ld+json">${JSON.stringify({ "@type": "FAQPage", mainEntity: [{ "@type": "Question" }] })}</script>`;
const RICH_BODY = `<h1>Da Mario</h1><p>${"Pizza napoletana cotta nel forno a legna, impasto a lunga lievitazione. ".repeat(6)}</p>
<p>Via Roma 12, 00100 Roma. Tel. +39 06 1234 5678, info@damario.it</p>`;
const SPA = `<!doctype html><html lang="en"><head><title>App</title><script type="module" src="/assets/index-abc123.js"></script></head><body><div id="root"></div></body></html>`;

async function run(routes: Record<string, Route>, path = "/"): Promise<Report> {
  const site = await localSite(routes);
  try {
    return await check(`http://site.test:${site.port}${path}`, {
      fetchOptions: { resolver: tableResolver({ "site.test": "127.0.0.1" }), isAllowed: onlyLoopback },
      requestTimeoutMs: 2_000,
    });
  } finally {
    await site.close();
  }
}
const ids = (r: Report) => r.findings.map((f) => `${f.level}:${f.id}`);
const spa: Route = (_q, s) => {
  s.writeHead(200, { "content-type": "text/html" });
  s.end(SPA);
};
const challenge: Route = (_q, s) => {
  s.writeHead(403, { "content-type": "text/html", server: "cloudflare", "cf-ray": "8abc-MXP", "cf-mitigated": "challenge" });
  s.end(`<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>`);
};
const blockAssistants = text("User-agent: OAI-SearchBot\nUser-agent: ChatGPT-User\nUser-agent: PerplexityBot\nUser-agent: Perplexity-User\nDisallow: /\n");

describe("check: a good page", () => {
  it("everything green that can be", async () => {
    const r = await run({
      "/": html(RICH_BODY, RICH_HEAD),
      "/robots.txt": text("User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n"),
      "/sitemap.xml": text(`<?xml version="1.0"?><urlset></urlset>`, 200, { "content-type": "application/xml" }),
      "/llms.txt": text("# Da Mario\n> Pizzeria a Roma"),
    });
    assert.equal(r.verdict, "readable");
    for (const id of ["robots-ok", "text-ok", "title-ok", "description-ok", "lang-ok", "canonical-ok", "h1-ok", "business-ok", "faq-ok", "llms-ok", "sitemap-ok", "contacts-ok"]) {
      assert.ok(ids(r).includes(`green:${id}`), `${id} in ${ids(r).join(", ")}`);
    }
    assert.equal(r.findings.some((f) => f.level === "red"), false);
    assert.equal(r.contacts.nameInText, true);
  });
  it("structured data and files missing", async () => {
    const r = await run({ "/": html(`<h1>Bar</h1><p>${"Testo di prova per il bar. ".repeat(20)}</p>`, "<title>Bar</title>") });
    assert.ok(ids(r).includes("yellow:business-missing"));
    assert.ok(ids(r).includes("yellow:faq-missing"));
    assert.ok(ids(r).includes("yellow:llms-missing"));
    assert.ok(ids(r).includes("yellow:sitemap-missing"));
    assert.ok(ids(r).includes("green:robots-ok"), "no robots.txt means nobody is blocked");
  });
  it("an HTML 200 at /llms.txt is a soft 404, not an llms.txt", async () => {
    const r = await run({ "/": html(RICH_BODY, RICH_HEAD), "/llms.txt": html("<p>Pagina non trovata</p>") });
    assert.equal(r.llmsTxt.found, false);
  });
});

describe("check: they get in, but the page is empty (JavaScript only)", () => {
  it("empty mount point + module bundle, without a browser", async () => {
    const r = await run({ "/": spa });
    assert.equal(r.verdict, "empty");
    assert.equal(r.text.jsOnly, true);
    assert.ok(r.text.jsSignals.some((s) => s.startsWith("empty mount point")));
    assert.ok(ids(r).includes("red:text-empty"));
    assert.equal(r.cms.id, "spa");
    // The page-level misses are marked as consequences of the empty page.
    assert.equal(r.findings.find((f) => f.id === "h1-missing")?.data?.cause, "empty");
  });
  it("an empty home behind a readable inner page is flagged", async () => {
    const r = await run({ "/": spa, "/menu": html(RICH_BODY, RICH_HEAD) }, "/menu");
    assert.equal(r.verdict, "readable");
    assert.ok(ids(r).includes("red:home-empty"));
  });
  it("little text but no JavaScript signs is thin, not empty", async () => {
    const r = await run({ "/": html("<p>Ciao</p>", "<title>Ciao</title>") });
    assert.equal(r.verdict, "thin");
    assert.equal(r.text.jsOnly, false);
  });
});

describe("check: they cannot get in", () => {
  it("robots.txt blocks the assistants' crawlers", async () => {
    const r = await run({ "/": html(RICH_BODY, RICH_HEAD), "/robots.txt": blockAssistants });
    assert.equal(r.verdict, "blocked");
    const f = r.findings.find((x) => x.id === "robots-blocks-assistants")!;
    assert.equal(f.level, "red");
    assert.deepEqual(f.data?.assistants, ["ChatGPT", "Perplexity"]);
    const by = Object.fromEntries(r.robots.assistants.map((a) => [a.id, a.answers]));
    assert.equal(by.chatgpt, "no");
    assert.equal(by.perplexity, "no");
    assert.equal(by.claude, "yes");
  });
  it("a Cloudflare challenge page (403 + cf-mitigated) with our declared user agent", async () => {
    let ua = "";
    const r = await run({
      "/": (q, s) => {
        ua = String(q.headers["user-agent"]);
        challenge(q, s);
      },
    });
    assert.doesNotMatch(ua, /GPTBot|ClaudeBot|PerplexityBot/, "never pretend to be an AI crawler");
    assert.equal(r.verdict, "blocked");
    assert.equal(r.access.cloudflare, true);
    assert.deepEqual(r.access.blocked, { kind: "challenge", shield: "cloudflare" });
    assert.ok(ids(r).includes("red:access-blocked"));
    assert.ok(!ids(r).some((x) => x.endsWith("text-empty")), "a challenge is not an empty page");
  });
  it("a 503 'Just a moment' without special headers is still a challenge", async () => {
    const r = await run({
      "/": (_q, s) => {
        s.writeHead(503, { "content-type": "text/html" });
        s.end(`<html><head><title>Just a moment...</title></head><body></body></html>`);
      },
    });
    assert.equal(r.access.blocked?.kind, "challenge");
    assert.equal(r.verdict, "blocked");
  });
  it("a plain 403 is 'forbidden' and counts as a block", async () => {
    const r = await run({ "/": text("no", 403) });
    assert.equal(r.access.blocked?.kind, "forbidden");
    assert.equal(r.verdict, "blocked");
  });
  it("a normal page that loads a bot-protection script is NOT a challenge", async () => {
    const r = await run({ "/": html(RICH_BODY + `<script src="https://js.captcha-delivery.com/x.js"></script>`, RICH_HEAD) });
    assert.equal(r.access.blocked, null);
    assert.equal(r.verdict, "readable");
  });
  it("a 500 is 'unreachable', not blocked", async () => {
    const r = await run({ "/": text("boom", 500) });
    assert.equal(r.verdict, "unreachable");
  });
});

describe("check: mixed cases", () => {
  it("robots.txt blocks AND the page is JavaScript-only", async () => {
    const r = await run({ "/": spa, "/robots.txt": blockAssistants });
    assert.equal(r.verdict, "blocked-and-empty");
    assert.ok(ids(r).includes("red:robots-blocks-assistants"));
    assert.ok(ids(r).includes("red:text-empty"));
  });
  it("Cloudflare managed robots.txt: training blocked, answers open, page readable", async () => {
    const r = await run({
      "/": (q, s) => {
        s.setHeader("server", "cloudflare");
        s.setHeader("cf-ray", "8abc-MAD");
        html(RICH_BODY, RICH_HEAD)(q, s);
      },
      "/robots.txt": text(CLOUDFLARE_MANAGED),
    });
    assert.equal(r.robots.cloudflareManaged, true);
    assert.equal(r.access.cloudflare, true);
    assert.equal(r.access.blocked, null);
    // Amazon (Alexa) is blocked by the managed file, but it is not one of the assistants the verdict weighs.
    assert.equal(r.verdict, "readable");
    const training = r.findings.find((f) => f.id === "robots-blocks-training")!;
    assert.equal(training.level, "yellow");
    assert.ok((training.data?.bots as string[]).includes("GPTBot"));
    assert.equal(r.findings.find((f) => f.id === "robots-blocks-assistants")?.data?.cloudflareManaged, true);
  });
  it("Cloudflare managed robots.txt AND a JavaScript-only page: empty, with the robots note", async () => {
    const r = await run({ "/": spa, "/robots.txt": text(CLOUDFLARE_MANAGED) });
    assert.equal(r.verdict, "empty");
    assert.ok(ids(r).includes("yellow:robots-blocks-training"));
  });
  it("a challenge AND robots.txt blocking: blocked, both reasons listed", async () => {
    const r = await run({ "/": challenge, "/robots.txt": blockAssistants });
    assert.equal(r.verdict, "blocked");
    assert.ok(ids(r).includes("red:access-blocked"));
    assert.ok(ids(r).includes("red:robots-blocks-assistants"));
  });
});

describe("check: refuses non-public targets", () => {
  it("throws BlockedError for a private address", async () => {
    await assert.rejects(check("http://192.168.1.1/"), BlockedError);
    await assert.rejects(check("http://localhost:3000/"), BlockedError);
  });
});
