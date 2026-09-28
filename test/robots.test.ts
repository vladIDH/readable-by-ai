import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assistantAccess, isAllowed, looksCloudflareManaged, parseRobots } from "../src/robots";
import { CLOUDFLARE_MANAGED } from "./helpers";

const answers = (txt: string | null, path = "/") =>
  Object.fromEntries(assistantAccess(txt === null ? null : parseRobots(txt), path).map((a) => [a.id, a.answers]));

describe("robots.txt rules", () => {
  it("longest match wins, Allow wins a tie, wildcards and $", () => {
    const r = parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/public\nDisallow: /*.pdf$\nDisallow: /tmp*\n");
    assert.equal(isAllowed(r, "AnyBot", "/private/x"), false);
    assert.equal(isAllowed(r, "AnyBot", "/private/public/page"), true);
    assert.equal(isAllowed(r, "AnyBot", "/doc.pdf"), false);
    assert.equal(isAllowed(r, "AnyBot", "/doc.pdf?x=1"), true);
    assert.equal(isAllowed(r, "AnyBot", "/tmpfile"), false);
    assert.equal(isAllowed(r, "AnyBot", "/"), true);
  });
  it("a named group replaces * for that crawler", () => {
    const r = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: OAI-SearchBot\nAllow: /\n");
    assert.equal(isAllowed(r, "OAI-SearchBot", "/"), true);
    assert.equal(isAllowed(r, "GPTBot", "/"), false);
  });
  it("an empty Disallow allows everything, case-insensitive agents, CRLF", () => {
    const r = parseRobots("User-Agent: gptbot\r\nDisallow:\r\n");
    assert.equal(isAllowed(r, "GPTBot", "/x"), true);
  });
  it("several User-agent lines share one group", () => {
    const r = parseRobots("User-agent: ClaudeBot\nUser-agent: Claude-User\nDisallow: /\n");
    assert.equal(isAllowed(r, "Claude-User", "/"), false);
    assert.equal(isAllowed(r, "ClaudeBot", "/"), false);
    assert.equal(isAllowed(r, "Claude-SearchBot", "/"), true);
  });
});

describe("assistants, one by one", () => {
  it("no robots.txt: everyone reads", () => {
    assert.ok(Object.values(answers(null)).every((v) => v === "yes"));
  });
  it("blocking only GPTBot does not remove you from ChatGPT answers", () => {
    const a = assistantAccess(parseRobots("User-agent: GPTBot\nDisallow: /\n"), "/");
    const chatgpt = a.find((x) => x.id === "chatgpt")!;
    assert.equal(chatgpt.answers, "yes");
    assert.equal(chatgpt.trainingBlocked, true);
  });
  it("blocking OAI-SearchBot and ChatGPT-User removes ChatGPT", () => {
    assert.equal(answers("User-agent: OAI-SearchBot\nUser-agent: ChatGPT-User\nDisallow: /\n").chatgpt, "no");
    assert.equal(answers("User-agent: OAI-SearchBot\nDisallow: /\n").chatgpt, "partial");
  });
  it("Disallow: / for everyone blocks every assistant", () => {
    assert.ok(Object.values(answers("User-agent: *\nDisallow: /\n")).every((v) => v === "no"));
  });
  it("Google-Extended counts for Gemini answers (grounding), not for Google Search", () => {
    const a = answers("User-agent: Google-Extended\nDisallow: /\n");
    assert.equal(a.gemini, "partial");
    assert.equal(a["google-ai"], "yes");
  });
  it("judges the page that was checked, not only the home", () => {
    const a = answers("User-agent: PerplexityBot\nUser-agent: Perplexity-User\nDisallow: /blog/\n", "/blog/post");
    assert.equal(a.perplexity, "no");
    assert.equal(answers("User-agent: PerplexityBot\nUser-agent: Perplexity-User\nDisallow: /blog/\n", "/").perplexity, "yes");
  });
});

describe("Cloudflare managed robots.txt", () => {
  it("is recognised, with its Content Signals", () => {
    const r = parseRobots(CLOUDFLARE_MANAGED);
    assert.equal(r.cloudflareManaged, true);
    assert.equal(looksCloudflareManaged(CLOUDFLARE_MANAGED, r), true);
    assert.deepEqual(r.contentSignals, { search: "yes", "ai-train": "no" });
  });
  it("is recognised without the comment, from Content-Signal + several AI blocks", () => {
    const txt = CLOUDFLARE_MANAGED.replace(/#.*\n/g, "");
    const r = parseRobots(txt);
    assert.equal(r.cloudflareManaged, false);
    assert.equal(looksCloudflareManaged(txt, r), true);
  });
  it("its default blocks training crawlers and Google-Extended, not ChatGPT, Claude or Perplexity answers", () => {
    const a = assistantAccess(parseRobots(CLOUDFLARE_MANAGED), "/");
    const by = Object.fromEntries(a.map((x) => [x.id, x]));
    assert.equal(by.chatgpt.answers, "yes");
    assert.equal(by.chatgpt.trainingBlocked, true);
    assert.equal(by.claude.answers, "yes");
    assert.equal(by.perplexity.answers, "yes");
    assert.equal(by.gemini.answers, "partial");
    assert.equal(by.amazon.answers, "no");
  });
  it("a plain robots.txt is not Cloudflare's", () => {
    const txt = "User-agent: *\nDisallow: /admin\n";
    assert.equal(looksCloudflareManaged(txt, parseRobots(txt)), false);
  });
});
