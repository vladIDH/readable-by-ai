#!/usr/bin/env node
/**
 * npx readable-by-ai https://example.com [--browser [path]] [--json] [--no-home]
 */
import { existsSync } from "node:fs";
import { check, type Finding, type Report, type Verdict } from "./check.js";
import { findLocalChrome } from "./browser.js";
import { BlockedError } from "./net.js";

const TEXT: Record<Finding["id"], [why: string, todo: string]> = {
  "access-blocked": ["An automated reader was stopped (challenge page or block). AI assistants may be stopped too.", "In your firewall/CDN, allow the crawlers of the assistants you want to be found by."],
  "robots-blocks-assistants": ["robots.txt keeps these assistants from reading the page.", "Remove the Disallow rules for their search/user crawlers (keep blocking training crawlers if you want)."],
  "robots-blocks-training": ["Training crawlers are blocked. This does not stop assistants from citing you.", "Nothing, if that is your choice."],
  "robots-unreachable": ["robots.txt answers with a server error: many crawlers then read nothing.", "Make /robots.txt return 200 (or 404 if you have none)."],
  "robots-ok": ["robots.txt lets the assistants' crawlers in.", "Nothing to do."],
  noindex: ["The page asks search engines not to index it; assistants built on search indexes will not find it.", "Remove noindex (meta robots or X-Robots-Tag) from pages you want found."],
  "text-empty": ["Without JavaScript the page is almost empty: most AI crawlers do not run JavaScript.", "Serve the content as HTML: static generation or server-side rendering."],
  "text-partial": ["Part of the text only appears after JavaScript runs.", "Render the main content on the server."],
  "text-thin": ["There is very little text on the page.", "Say who you are, what you do and where, in plain text."],
  "text-ok": ["The text is in the HTML.", "Nothing to do."],
  "title-missing": ["No <title>: the page has no name to be cited by.", "Add a title with your business name and what you do."],
  "title-ok": ["The page has a title.", "Nothing to do."],
  "description-missing": ["No meta description.", "Add a one-sentence description."],
  "description-ok": ["The page has a description.", "Nothing to do."],
  "lang-missing": ["The language is not declared.", "Add lang to <html>."],
  "lang-ok": ["The language is declared.", "Nothing to do."],
  "canonical-missing": ["No canonical URL.", "Add <link rel=canonical>."],
  "canonical-elsewhere": ["The canonical URL points to another site.", "Point it to this page unless that is intended."],
  "canonical-ok": ["Canonical URL set.", "Nothing to do."],
  "h1-missing": ["No H1 heading.", "Add one H1 that says what the page is about."],
  "h1-ok": ["The page has an H1.", "Nothing to do."],
  "business-missing": ["No LocalBusiness/Organization structured data.", "Add schema.org JSON-LD with name, address, phone and opening hours."],
  "business-incomplete": ["Structured data is missing some key fields.", "Complete name, address, phone and opening hours."],
  "business-ok": ["Structured data describes the business.", "Nothing to do."],
  "faq-missing": ["No FAQPage structured data.", "If you have a FAQ, mark it up as FAQPage."],
  "faq-ok": ["FAQPage structured data found.", "Nothing to do."],
  "llms-missing": ["No /llms.txt. Few assistants read it today; it is cheap to add.", "Optional: publish a short /llms.txt."],
  "llms-ok": ["/llms.txt found.", "Nothing to do."],
  "sitemap-missing": ["No sitemap found.", "Publish /sitemap.xml and list it in robots.txt."],
  "sitemap-ok": ["Sitemap found.", "Nothing to do."],
  "contacts-missing": ["No phone, e-mail or address in the text.", "Write your contact details as text, not only in images or forms."],
  "contacts-partial": ["Some contact details are missing from the text.", "Add the missing ones as text."],
  "contacts-ok": ["Phone, e-mail and address are in the text.", "Nothing to do."],
  "name-not-in-text": ["The business name does not appear in the visible text.", "Write your name in the page text."],
  "name-mismatch": ["The site uses different names for itself.", "Use one name everywhere."],
  "home-empty": ["The home page is empty without JavaScript.", "Render the home page on the server too."],
};

const HEADLINE: Record<Verdict, string> = {
  blocked: "AI assistants cannot get in.",
  "blocked-and-empty": "AI assistants cannot get in, and behind the block the page is empty without JavaScript.",
  empty: "AI assistants get in, but find an empty page.",
  partial: "AI assistants read only part of the page.",
  thin: "AI assistants get in, but there is little to read.",
  unreachable: "The site did not answer.",
  readable: "AI assistants can read this page.",
};

const tty = process.stdout.isTTY;
const color = (c: number, s: string) => (tty ? `\x1b[${c}m${s}\x1b[0m` : s);
const MARK = { red: color(31, "✗"), yellow: color(33, "!"), green: color(32, "✓") };

function print(r: Report) {
  const pct = r.text.ratio === null ? "" : ` (${Math.round(r.text.ratio * 100)}% of the text you see)`;
  console.log(`\n${color(1, HEADLINE[r.verdict])}${pct}`);
  console.log(`${r.finalUrl}${r.cms.name ? `  ·  ${r.cms.name}` : ""}${r.access.cloudflare ? "  ·  Cloudflare" : ""}\n`);
  console.log("Assistants (robots.txt):");
  for (const a of r.robots.assistants) {
    const mark = a.answers === "yes" ? MARK.green : a.answers === "no" ? MARK.red : MARK.yellow;
    console.log(`  ${mark} ${a.name}${a.trainingBlocked ? color(2, "  (training blocked)") : ""}`);
  }
  console.log("");
  const order = { red: 0, yellow: 1, green: 2 };
  for (const f of [...r.findings].sort((a, b) => order[a.level] - order[b.level])) {
    const [why, todo] = TEXT[f.id];
    console.log(`${MARK[f.level]} ${why}`);
    if (f.level !== "green") console.log(color(2, `  → ${todo}`));
  }
  console.log(color(2, `\n${r.timings.total} ms`));
}

async function main(argv: string[]) {
  const args = argv.slice(2);
  const url = args.find((a) => /^https?:\/\//i.test(a)) ?? (args[0] && !args[0].startsWith("-") ? `https://${args[0]}` : null);
  if (!url || args.includes("--help") || args.includes("-h")) {
    console.log("Usage: readable-by-ai <url> [--browser [chrome-path]] [--json] [--no-home]");
    process.exitCode = url ? 0 : 1;
    return;
  }
  let browser: { executablePath: string } | null = null;
  const bi = args.indexOf("--browser");
  if (bi >= 0) {
    const explicit = args[bi + 1] && !args[bi + 1].startsWith("-") && !/^https?:/i.test(args[bi + 1]) ? args[bi + 1] : null;
    const path = explicit ?? findLocalChrome().find((p) => existsSync(p));
    if (!path) {
      console.error("No local Chrome/Chromium found. Pass its path: --browser /path/to/chrome, or set CHROME_PATH.");
      process.exitCode = 2;
      return;
    }
    try {
      await import("puppeteer-core");
    } catch {
      console.error("--browser needs puppeteer-core: npm i -g puppeteer-core (or npx -p puppeteer-core -p readable-by-ai readable-by-ai …)");
      process.exitCode = 2;
      return;
    }
    browser = { executablePath: path };
  }
  try {
    const report = await check(url, { browser, checkHome: !args.includes("--no-home") });
    if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else print(report);
  } catch (e) {
    if (e instanceof BlockedError) {
      console.error(`Refusing to read ${url}: it is not a public website address (${e.reason}).`);
      process.exitCode = 2;
    } else throw e;
  }
}

main(process.argv).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
