/**
 * Is there something in front of the site that stops automated readers?
 *
 * This package never pretends to be GPTBot or any other crawler: big
 * networks verify real crawlers by their IP address, so a fake GPTBot
 * would be blocked anyway and the result would be false. It reads with
 * its own declared user agent, and when it gets a challenge page or a
 * block it says the site MAY block AI assistants too, which is all an
 * honest outside check can say.
 */

export type Shield = "cloudflare" | "vercel" | "akamai" | "sucuri" | "imperva" | "datadome" | "aws-waf" | "other";

export interface AccessResult {
  status: number | null;
  /** The site is served through Cloudflare (it may still let everyone in). */
  cloudflare: boolean;
  /** What stopped the request, if anything. */
  blocked: null | {
    kind: "challenge" | "forbidden" | "rate-limited" | "server-error" | "unreachable";
    shield: Shield | null;
  };
}

const CHALLENGE_BODY = [
  { re: /<title>\s*Just a moment\.\.\.\s*<\/title>|challenges\.cloudflare\.com|cf-browser-verification|cf_chl_opt|\/cdn-cgi\/challenge-platform/i, shield: "cloudflare" as const },
  { re: /Attention Required! \| Cloudflare|cf-error-details|Sorry, you have been blocked/i, shield: "cloudflare" as const },
  { re: /Vercel Security Checkpoint/i, shield: "vercel" as const },
  { re: /Sucuri WebSite Firewall/i, shield: "sucuri" as const },
  { re: /Incapsula incident|_Incapsula_Resource/i, shield: "imperva" as const },
  { re: /captcha-delivery\.com|datadome/i, shield: "datadome" as const },
  { re: /Access Denied[\s\S]{0,400}Reference\s*#[\d.a-f]+/i, shield: "akamai" as const },
];

export function detectShieldFromHeaders(headers: Record<string, string>): Shield | null {
  const server = (headers["server"] ?? "").toLowerCase();
  if (headers["cf-ray"] || server.includes("cloudflare")) return "cloudflare";
  if (headers["x-vercel-mitigated"]) return "vercel";
  if (headers["x-sucuri-id"] || server.includes("sucuri")) return "sucuri";
  if (headers["x-iinfo"] || headers["x-cdn"]?.toLowerCase().includes("imperva")) return "imperva";
  if (headers["x-datadome"] || headers["x-dd-b"]) return "datadome";
  if (server.includes("akamaighost")) return "akamai";
  if (headers["x-amzn-waf-action"]) return "aws-waf";
  return null;
}

/**
 * `visibleChars` keeps a normal page that merely loads a bot-protection
 * script from being called a challenge: a real challenge page has almost
 * no text of its own.
 */
export function classifyAccess(status: number | null, headers: Record<string, string>, bodyStart: string, visibleChars: number): AccessResult {
  const cloudflare = !!headers["cf-ray"] || (headers["server"] ?? "").toLowerCase().includes("cloudflare");
  if (status === null) return { status, cloudflare, blocked: { kind: "unreachable", shield: null } };
  const headerShield = detectShieldFromHeaders(headers);
  const bodyShield = CHALLENGE_BODY.find((c) => c.re.test(bodyStart))?.shield ?? null;
  const mitigated =
    (headers["cf-mitigated"] ?? "").toLowerCase() === "challenge" ||
    (headers["x-vercel-mitigated"] ?? "").toLowerCase() === "challenge" ||
    /captcha|challenge/i.test(headers["x-amzn-waf-action"] ?? "");
  // A challenge can come back as 403, 503, 429 or even 200 with a JS check page.
  if (mitigated || (bodyShield && (status >= 400 || visibleChars < 400))) {
    return { status, cloudflare, blocked: { kind: "challenge", shield: bodyShield ?? headerShield } };
  }
  if (status === 401 || status === 403) return { status, cloudflare, blocked: { kind: "forbidden", shield: headerShield } };
  if (status === 429) return { status, cloudflare, blocked: { kind: "rate-limited", shield: headerShield } };
  if (status >= 500) return { status, cloudflare, blocked: { kind: "server-error", shield: headerShield } };
  return { status, cloudflare, blocked: null };
}
