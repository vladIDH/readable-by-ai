/**
 * Which platform built the site, from the traces it leaves in the HTML,
 * the headers and the host name. First match wins, so the order matters:
 * site builders before the frameworks they are built on.
 */
import type { ParsedPage } from "./html.js";

export type CmsId =
  | "wordpress" | "shopify" | "wix" | "squarespace" | "webflow" | "framer" | "jimdo" | "godaddy" | "weebly"
  | "hubspot" | "ghost" | "joomla" | "drupal" | "prestashop" | "magento" | "bigcommerce"
  | "lovable" | "bolt" | "v0" | "base44" | "replit"
  | "nextjs" | "nuxt" | "gatsby" | "astro" | "spa";

export interface CmsResult {
  id: CmsId | null;
  name: string | null;
  /** The family decides which advice fits. */
  family: "builder" | "cms" | "ecommerce" | "ai-builder" | "framework" | null;
  signals: string[];
}

interface Rule {
  id: CmsId;
  name: string;
  family: NonNullable<CmsResult["family"]>;
  test: (ctx: Ctx) => string | null;
}

interface Ctx {
  html: string;
  host: string;
  headers: Record<string, string>;
  generator: string;
  scriptSrcs: string[];
}

const has = (s: string, needle: string | RegExp) => (typeof needle === "string" ? s.includes(needle) : needle.test(s));

const RULES: Rule[] = [
  { id: "lovable", name: "Lovable", family: "ai-builder", test: (c) =>
      c.host.endsWith(".lovable.app") ? "host *.lovable.app"
      : has(c.html, "lovable-uploads/") ? "lovable-uploads"
      : has(c.html, /Lovable Generated Project|gptengineer\.js|cdn\.gpteng\.co/) ? "Lovable markers"
      : null },
  { id: "bolt", name: "Bolt", family: "ai-builder", test: (c) =>
      c.host.endsWith(".bolt.host") ? "host *.bolt.host"
      : has(c.html, /bolt\.new|Made with Bolt|stackblitz/i) ? "Bolt markers" : null },
  { id: "v0", name: "v0", family: "ai-builder", test: (c) =>
      has(c.generator, /^v0/i) ? `generator ${c.generator}`
      : c.host.endsWith(".v0.app") || c.host.endsWith(".vusercontent.net") ? "host v0" : null },
  { id: "base44", name: "Base44", family: "ai-builder", test: (c) =>
      c.host.endsWith(".base44.app") || has(c.html, "base44") ? "Base44 markers" : null },
  { id: "replit", name: "Replit", family: "ai-builder", test: (c) =>
      c.host.endsWith(".replit.app") || c.host.endsWith(".repl.co") ? "host Replit" : null },
  { id: "shopify", name: "Shopify", family: "ecommerce", test: (c) =>
      has(c.html, "cdn.shopify.com") ? "cdn.shopify.com"
      : c.headers["x-shopid"] || c.headers["x-shopify-stage"] ? "Shopify headers"
      : has(c.html, "Shopify.theme") ? "Shopify.theme" : null },
  { id: "wix", name: "Wix", family: "builder", test: (c) =>
      has(c.generator, /wix\.com/i) ? `generator ${c.generator}`
      : has(c.html, "static.wixstatic.com") || c.headers["x-wix-request-id"] ? "Wix markers" : null },
  { id: "squarespace", name: "Squarespace", family: "builder", test: (c) =>
      has(c.html, "static1.squarespace.com") || has(c.html, "Static.SQUARESPACE_CONTEXT") ? "Squarespace markers" : null },
  { id: "webflow", name: "Webflow", family: "builder", test: (c) =>
      has(c.generator, /webflow/i) ? `generator ${c.generator}` : has(c.html, "data-wf-page") ? "data-wf-page" : null },
  { id: "framer", name: "Framer", family: "builder", test: (c) =>
      has(c.generator, /framer/i) ? `generator ${c.generator}` : has(c.html, "framerusercontent.com") ? "framerusercontent.com" : null },
  { id: "jimdo", name: "Jimdo", family: "builder", test: (c) =>
      has(c.html, /jimdo(cdn|static)?\.com|jimcdn\.com/i) ? "Jimdo markers" : null },
  { id: "godaddy", name: "GoDaddy Website Builder", family: "builder", test: (c) =>
      has(c.html, "img1.wsimg.com") || has(c.generator, /Starfield|GoDaddy/i) ? "GoDaddy markers" : null },
  { id: "weebly", name: "Weebly", family: "builder", test: (c) => (has(c.html, /weebly\.com|editmysite\.com/) ? "Weebly markers" : null) },
  { id: "hubspot", name: "HubSpot CMS", family: "cms", test: (c) =>
      has(c.generator, /HubSpot/i) ? `generator ${c.generator}` : has(c.html, "hs-scripts.com") && has(c.html, "hubspot") ? "HubSpot markers" : null },
  { id: "wordpress", name: "WordPress", family: "cms", test: (c) =>
      has(c.generator, /wordpress/i) ? `generator ${c.generator}`
      : has(c.html, /\/wp-content\/|\/wp-includes\//) ? "/wp-content/"
      : c.headers["link"]?.includes("api.w.org") ? "api.w.org link" : null },
  { id: "ghost", name: "Ghost", family: "cms", test: (c) => (has(c.generator, /^Ghost/i) ? `generator ${c.generator}` : null) },
  { id: "joomla", name: "Joomla", family: "cms", test: (c) => (has(c.generator, /joomla/i) ? `generator ${c.generator}` : null) },
  { id: "drupal", name: "Drupal", family: "cms", test: (c) =>
      has(c.generator, /drupal/i) ? `generator ${c.generator}` : c.headers["x-drupal-cache"] ? "x-drupal-cache" : null },
  { id: "prestashop", name: "PrestaShop", family: "ecommerce", test: (c) =>
      has(c.generator, /prestashop/i) || has(c.html, "var prestashop") ? "PrestaShop markers" : null },
  { id: "magento", name: "Magento / Adobe Commerce", family: "ecommerce", test: (c) =>
      has(c.html, /Magento_|mage\/cookies/) ? "Magento markers" : null },
  { id: "bigcommerce", name: "BigCommerce", family: "ecommerce", test: (c) => (has(c.html, "cdn11.bigcommerce.com") ? "BigCommerce markers" : null) },
  { id: "nextjs", name: "Next.js", family: "framework", test: (c) =>
      has(c.html, /\/_next\/static\/|__NEXT_DATA__/) ? "/_next/static/" : c.headers["x-powered-by"]?.includes("Next.js") ? "x-powered-by" : null },
  { id: "nuxt", name: "Nuxt", family: "framework", test: (c) => (has(c.html, /\/_nuxt\/|__NUXT__/) ? "/_nuxt/" : null) },
  { id: "gatsby", name: "Gatsby", family: "framework", test: (c) => (has(c.html, "___gatsby") ? "___gatsby" : null) },
  { id: "astro", name: "Astro", family: "framework", test: (c) => (has(c.generator, /astro/i) || has(c.html, "astro-island") ? "Astro markers" : null) },
];

export function detectCms(html: string, page: ParsedPage, url: string, headers: Record<string, string>): CmsResult {
  const generator = page.metas.find((m) => (m.name ?? "").toLowerCase() === "generator")?.content ?? "";
  const ctx: Ctx = {
    html,
    host: new URL(url).hostname.toLowerCase(),
    headers,
    generator,
    scriptSrcs: page.scripts.map((s) => s.src ?? "").filter(Boolean),
  };
  for (const r of RULES) {
    const signal = r.test(ctx);
    if (signal) return { id: r.id, name: r.name, family: r.family, signals: [signal] };
  }
  // A bare single-page app: an empty mount point and a module bundle.
  if (page.mounts.some((m) => m.textChars === 0) && page.scripts.some((s) => s.type === "module" || /\/assets\/index-[\w-]+\.js$/.test(s.src ?? ""))) {
    return { id: "spa", name: "JavaScript app (React, Vue or similar)", family: "framework", signals: ["empty mount point + module bundle"] };
  }
  return { id: null, name: null, family: null, signals: [] };
}
