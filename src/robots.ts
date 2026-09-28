/**
 * robots.txt: parsing (RFC 9309, with Google's longest-match rule and the
 * `*` / `$` wildcards), the AI crawlers grouped by the assistant they
 * serve, and Cloudflare's managed robots.txt.
 */

export type BotRole =
  /** Builds the index the assistant answers from. Blocking it removes you from answers. */
  | "search"
  /** Fetches a page when a person asks the assistant about it. */
  | "user"
  /** Collects data to train models. Blocking it does not remove you from answers. */
  | "training";

export interface AiBot {
  token: string;
  role: BotRole;
  docs: string;
}

export interface Assistant {
  id: string;
  name: string;
  bots: AiBot[];
}

/**
 * Documented crawlers, grouped by assistant. Sources are each vendor's
 * own documentation page (in `docs`). Only tokens a vendor documents are
 * listed; guesses are not.
 */
export const ASSISTANTS: Assistant[] = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    bots: [
      { token: "OAI-SearchBot", role: "search", docs: "https://platform.openai.com/docs/bots" },
      { token: "ChatGPT-User", role: "user", docs: "https://platform.openai.com/docs/bots" },
      { token: "GPTBot", role: "training", docs: "https://platform.openai.com/docs/bots" },
    ],
  },
  {
    id: "claude",
    name: "Claude",
    bots: [
      { token: "Claude-SearchBot", role: "search", docs: "https://support.claude.com/en/articles/8896518" },
      { token: "Claude-User", role: "user", docs: "https://support.claude.com/en/articles/8896518" },
      { token: "ClaudeBot", role: "training", docs: "https://support.claude.com/en/articles/8896518" },
    ],
  },
  {
    id: "perplexity",
    name: "Perplexity",
    bots: [
      { token: "PerplexityBot", role: "search", docs: "https://docs.perplexity.ai/guides/bots" },
      { token: "Perplexity-User", role: "user", docs: "https://docs.perplexity.ai/guides/bots" },
    ],
  },
  {
    id: "gemini",
    name: "Gemini",
    bots: [
      { token: "Googlebot", role: "search", docs: "https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers" },
      // Google-Extended controls use in Gemini, including grounding: for Gemini it is not "training only".
      { token: "Google-Extended", role: "user", docs: "https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers" },
    ],
  },
  {
    id: "google-ai",
    name: "Google AI Overviews / AI Mode",
    bots: [{ token: "Googlebot", role: "search", docs: "https://developers.google.com/search/docs/appearance/ai-features" }],
  },
  {
    id: "copilot",
    name: "Microsoft Copilot",
    bots: [{ token: "Bingbot", role: "search", docs: "https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0" }],
  },
  {
    id: "apple",
    name: "Apple Intelligence / Siri",
    bots: [
      { token: "Applebot", role: "search", docs: "https://support.apple.com/en-us/119829" },
      { token: "Applebot-Extended", role: "training", docs: "https://support.apple.com/en-us/119829" },
    ],
  },
  {
    id: "meta",
    name: "Meta AI",
    bots: [
      { token: "Meta-ExternalFetcher", role: "user", docs: "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers" },
      { token: "meta-externalagent", role: "training", docs: "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers" },
    ],
  },
  {
    id: "mistral",
    name: "Le Chat (Mistral)",
    bots: [{ token: "MistralAI-User", role: "user", docs: "https://docs.mistral.ai/robots" }],
  },
  {
    id: "duckduckgo",
    name: "DuckDuckGo Duck.ai",
    bots: [{ token: "DuckAssistBot", role: "user", docs: "https://duckduckgo.com/duckduckgo-help-pages/results/duckassistbot" }],
  },
  {
    id: "amazon",
    name: "Amazon (Alexa, Rufus)",
    bots: [{ token: "Amazonbot", role: "search", docs: "https://developer.amazon.com/amazonbot" }],
  },
];

/** The assistants that matter most for answers: the verdict "blocked" looks at these. */
export const MAJOR_ASSISTANTS: ReadonlySet<string> = new Set(["chatgpt", "claude", "perplexity", "gemini", "google-ai", "copilot"]);

/** Training-only crawlers that belong to no assistant, reported apart. */
export const TRAINING_ONLY: AiBot[] = [{ token: "CCBot", role: "training", docs: "https://commoncrawl.org/ccbot" }];

export interface RobotsGroup {
  agents: string[];
  rules: Array<{ allow: boolean; path: string }>;
}

export interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
  /** `Content-Signal:` lines (contentsignals.org), merged. */
  contentSignals: Record<string, string>;
  /** Cloudflare's managed robots.txt markers were found. */
  cloudflareManaged: boolean;
}

export function parseRobots(txt: string): ParsedRobots {
  const out: ParsedRobots = { groups: [], sitemaps: [], contentSignals: {}, cloudflareManaged: false };
  if (/BEGIN Cloudflare Managed content/i.test(txt)) out.cloudflareManaged = true;
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const rawLine of txt.replace(/^﻿/, "").split(/\r?\n|\r/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        out.groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === "sitemap") {
      if (value) out.sitemaps.push(value);
    } else if (key === "content-signal") {
      for (const part of value.split(",")) {
        const [k, v] = part.split("=").map((s) => s.trim().toLowerCase());
        if (k && v) out.contentSignals[k] = v;
      }
    } else if ((key === "allow" || key === "disallow") && current) {
      // An empty Disallow means "allow everything": it adds no rule.
      if (value || key === "allow") current.rules.push({ allow: key === "allow", path: value });
    }
  }
  return out;
}

function patternMatches(pattern: string, path: string): boolean {
  if (pattern === "") return true;
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "$") re += "$";
    else re += ch.replace(/[.+?^{}()|[\]\\]/g, "\\$&");
  }
  // `$` only means "end" as the last character.
  re = re.replace(/\$(?!$)/g, "\\$");
  try {
    return new RegExp("^" + re).test(path);
  } catch {
    return false;
  }
}

/** The group that applies to a crawler token: the most specific match, else `*`. */
export function groupFor(robots: ParsedRobots, token: string): RobotsGroup[] {
  const t = token.toLowerCase();
  const exact = robots.groups.filter((g) => g.agents.some((a) => a !== "*" && (a === t || t.startsWith(a))));
  if (exact.length) {
    // Longest agent value wins (Googlebot-Image vs Googlebot); merge groups with the same best value.
    const best = Math.max(...exact.flatMap((g) => g.agents.filter((a) => a !== "*" && (a === t || t.startsWith(a))).map((a) => a.length)));
    return exact.filter((g) => g.agents.some((a) => a.length === best && (a === t || t.startsWith(a))));
  }
  return robots.groups.filter((g) => g.agents.includes("*"));
}

/** Can this crawler fetch `path`? Longest matching rule wins; on a tie, Allow wins. */
export function isAllowed(robots: ParsedRobots, token: string, path: string): boolean {
  const groups = groupFor(robots, token);
  let best: { allow: boolean; len: number } | null = null;
  for (const g of groups) {
    for (const r of g.rules) {
      if (!patternMatches(r.path, path)) continue;
      const len = r.path.length;
      if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { allow: r.allow, len };
    }
  }
  return best ? best.allow : true;
}

export type Access = "allowed" | "blocked";

export interface BotAccess {
  token: string;
  role: BotRole;
  /** For the page that was checked. */
  page: Access;
  /** For the home page. */
  home: Access;
  /** A group names this crawler explicitly (not only `*`). */
  named: boolean;
}

export interface AssistantAccess {
  id: string;
  name: string;
  /** Can the assistant read the page to answer? Only non-training crawlers count. */
  answers: "yes" | "no" | "partial";
  /** Is the training crawler (if any) blocked? `null` when the vendor has none. */
  trainingBlocked: boolean | null;
  bots: BotAccess[];
}

export function assistantAccess(robots: ParsedRobots | null, path: string): AssistantAccess[] {
  return ASSISTANTS.map((a) => {
    const bots: BotAccess[] = a.bots.map((b) => {
      const named = !!robots && robots.groups.some((g) => g.agents.some((x) => x !== "*" && b.token.toLowerCase().startsWith(x)));
      return {
        token: b.token,
        role: b.role,
        page: !robots || isAllowed(robots, b.token, path) ? "allowed" : "blocked",
        home: !robots || isAllowed(robots, b.token, "/") ? "allowed" : "blocked",
        named,
      };
    });
    const answering = bots.filter((b) => b.role !== "training");
    const blocked = answering.filter((b) => b.page === "blocked").length;
    const training = bots.filter((b) => b.role === "training");
    return {
      id: a.id,
      name: a.name,
      answers: answering.length === 0 ? "yes" : blocked === 0 ? "yes" : blocked === answering.length ? "no" : "partial",
      trainingBlocked: training.length ? training.some((b) => b.page === "blocked") : null,
      bots,
    };
  });
}

/**
 * Cloudflare's managed robots.txt, recognised by its markers: the
 * "BEGIN Cloudflare Managed content" comment or Content-Signal lines
 * next to blocks for several AI crawlers at once.
 */
export function looksCloudflareManaged(txt: string, robots: ParsedRobots): boolean {
  if (robots.cloudflareManaged) return true;
  if (Object.keys(robots.contentSignals).length === 0) return false;
  const aiTokens = ["gptbot", "claudebot", "perplexitybot", "google-extended", "ccbot", "bytespider", "applebot-extended", "amazonbot", "meta-externalagent"];
  const named = new Set(robots.groups.flatMap((g) => g.agents));
  return aiTokens.filter((t) => named.has(t)).length >= 3 || /cloudflare/i.test(txt);
}
