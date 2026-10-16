# readable-by-ai

How much of your website can AI assistants actually read?

```
npx readable-by-ai https://example.com   # run without installing
npm i readable-by-ai                     # or add it to a project
```

AI assistants like ChatGPT, Claude, Perplexity and Gemini miss websites for two different reasons, and this tool tells them apart:

1. **They cannot get in.** `robots.txt` blocks their crawlers, or a firewall/CDN (often Cloudflare's bot protection) answers automated readers with a challenge page.
2. **They get in and find an empty page.** The site is built only with JavaScript (common with Lovable, Bolt, v0 and other single-page apps), and most AI crawlers do not run JavaScript.

It also checks what helps an assistant describe you correctly: title, description, language, canonical URL, headings, schema.org structured data (LocalBusiness and its subtypes, FAQPage), `llms.txt`, the sitemap, contact details written as text, and which platform the site is built with.

## What it checks

| Check | How |
| --- | --- |
| Text without JavaScript | Downloads the raw HTML, the way a crawler that does not run JavaScript does, and extracts the visible text. Recognises JavaScript-only sites (empty `#root`/`#app`/`#__next`, module bundles, `<noscript>` asking for JavaScript). |
| Text with JavaScript (`--browser`) | Opens the page in a local headless Chrome and compares: "AI reads about X% of the text you see". |
| AI crawlers in robots.txt | One by one, grouped by assistant: ChatGPT (OAI-SearchBot, ChatGPT-User, GPTBot), Claude (Claude-SearchBot, Claude-User, ClaudeBot), Perplexity (PerplexityBot, Perplexity-User), Gemini (Googlebot, Google-Extended), Google AI Overviews/AI Mode (Googlebot), Copilot (Bingbot), Apple (Applebot, Applebot-Extended), Meta AI (Meta-ExternalFetcher, meta-externalagent), Le Chat (MistralAI-User), DuckDuckGo (DuckAssistBot), Amazon (Amazonbot), Common Crawl (CCBot). Crawlers that only collect training data are reported separately: blocking them does not remove you from answers. |
| Cloudflare | Detects sites behind Cloudflare, Cloudflare's managed `robots.txt` (Content Signals + AI crawler blocks) and challenge pages. Also Vercel, Akamai, Sucuri, Imperva, DataDome and AWS WAF challenge pages. |
| Indexing | `noindex` in meta robots or `X-Robots-Tag`. |
| Page basics | `<title>`, meta description, `lang`, canonical, H1 and headings. |
| Structured data | JSON-LD (including `@graph`): LocalBusiness/Organization with name, address, telephone, opening hours; FAQPage. |
| Files | `/llms.txt`, sitemap (from robots.txt, `/sitemap.xml`, `/sitemap_index.xml`). |
| Contacts | Phone, e-mail and street address in the visible text; whether the business name appears in the text and matches the name in the metadata. |
| Platform | WordPress, Shopify, Wix, Squarespace, Webflow, Framer, Jimdo, GoDaddy, Weebly, HubSpot, Ghost, Joomla, Drupal, PrestaShop, Magento, BigCommerce, Lovable, Bolt, v0, Base44, Replit, Next.js, Nuxt, Gatsby, Astro, generic single-page apps. |

## Honest limits

- **It never pretends to be GPTBot or any other crawler.** Large networks verify real crawlers by their IP address, so a fake GPTBot would be blocked anyway and the result would be wrong. The tool reads with its own declared user agent. When it gets a challenge page or a block, it says the site *may* block AI assistants too. From the outside, that is all an honest check can say.
- It reads `robots.txt` rules. Some user-triggered fetchers (for example ChatGPT-User or Perplexity-User) may not always follow them; the tool reports what the rules say.
- Heuristics (contacts, platform) are tuned to stay quiet rather than guess.

## Options

```
readable-by-ai <url> [--browser [chrome-path]] [--json] [--no-home]
```

- `--browser`: also render the page with a local Chrome/Chromium/Edge (found automatically, or pass its path, or set `CHROME_PATH`). Needs `puppeteer-core`: `npx -p puppeteer-core -p readable-by-ai readable-by-ai https://example.com --browser`.
- `--json`: the full report as JSON.
- `--no-home`: when checking an inner page, do not also read the home page.

## As a library

```ts
import { check } from "readable-by-ai";

const report = await check("https://example.com", {
  userAgent: "MyTool/1.0 (+https://example.com/bot)",
  browser: { executablePath: "/usr/bin/chromium" }, // optional
  onStep: (step, state, ms) => console.log(step, state, ms),
});

report.verdict;   // "readable" | "partial" | "empty" | "blocked" | "blocked-and-empty" | "thin" | "unreachable"
report.findings;  // [{ id: "robots-blocks-assistants", level: "red", data: { assistants: ["ChatGPT"] } }, …]
report.robots.assistants; // per assistant: answers "yes" | "no" | "partial", trainingBlocked
```

Findings carry an `id`, a `level` (`green`, `yellow`, `red`) and data, not sentences, so you can write your own words in any language.

## Safety

Everything the tool downloads, including every request the headless browser makes, goes through one fetcher that:

- accepts only `http`/`https` on ports 80 and 443, no credentials in the URL;
- refuses private, loopback, link-local, carrier-grade NAT, multicast, documentation and cloud-metadata addresses, including IPv4 hidden in IPv6 (`::ffff:`, NAT64, 6to4) and odd spellings (`2130706433`, `0x7f.1`);
- resolves each host once and connects to exactly the address it checked (no DNS rebinding window);
- follows at most 5 redirects, checking every hop; caps time per request and the decompressed body size.

The browser is cut off from the network: its resolver answers "not found" for every name and its proxy is a dead port, so WebSockets, WebRTC and service workers go nowhere. Pages get only documents, scripts and data requests, served through the fetcher above; images, fonts, stylesheets and media are blocked.

## License

MIT
