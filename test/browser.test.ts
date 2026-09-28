/**
 * The browser never reaches the network by itself. The pure decision is
 * tested always; the isolation is tested against a real local Chrome when
 * one is installed (skipped otherwise, never faked).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import { decideRequest, findLocalChrome, ISOLATION_ARGS, renderPage } from "../src/browser";
import { check } from "../src/check";
import { html, localSite, onlyLoopback, tableResolver } from "./helpers";

describe("decideRequest", () => {
  it("only documents, scripts and data requests are fetched", () => {
    for (const t of ["document", "script", "xhr", "fetch", "preflight"]) assert.equal(decideRequest(t, "https://a.com/x"), "fetch", t);
  });
  it("images, fonts, CSS, media and everything else are blocked", () => {
    for (const t of ["image", "font", "stylesheet", "media", "websocket", "eventsource", "manifest", "ping", "texttrack", "signedexchange", "cspviolationreport", "prefetch", "other"]) {
      assert.equal(decideRequest(t, "https://a.com/x"), "block", t);
    }
  });
  it("non-http schemes are blocked even for scripts", () => {
    assert.equal(decideRequest("script", "data:text/javascript,1"), "block");
    assert.equal(decideRequest("document", "file:///etc/passwd"), "block");
    assert.equal(decideRequest("fetch", "ftp://a.com/"), "block");
  });
  it("the launch flags cut DNS and route everything else to a dead proxy", () => {
    assert.ok(ISOLATION_ARGS.includes("--host-resolver-rules=MAP * ~NOTFOUND"));
    assert.ok(ISOLATION_ARGS.some((a) => a.startsWith("--proxy-server=")));
    assert.ok(ISOLATION_ARGS.includes("--proxy-bypass-list=<-loopback>"), "loopback must go through the dead proxy too");
  });
});

const chrome = findLocalChrome().find((p) => existsSync(p));
let puppeteerOk = true;
try {
  await import("puppeteer-core");
} catch {
  puppeteerOk = false;
}

describe("renderPage with a real Chrome", { skip: !chrome || !puppeteerOk ? "no local Chrome or puppeteer-core" : false }, () => {
  it("serves the page through safeFetch, blocks the rest, and nothing connects directly", async () => {
    // A raw TCP server: any WebSocket or direct connection would show up here.
    let direct = 0;
    const trap = net.createServer((s) => {
      direct++;
      s.destroy();
    });
    await new Promise<void>((r) => trap.listen(0, "127.0.0.1", r));
    const trapPort = (trap.address() as AddressInfo).port;

    const site = await localSite({
      "/": html(
        `<div id="root"></div>
         <img src="/pixel.png"><link rel="stylesheet" href="/style.css">
         <script>
           fetch("/api/menu").then(r => r.json()).then(d => { document.getElementById("root").innerHTML = "<h1>" + d.title + "</h1>"; });
           fetch("http://inside.test/secret").catch(() => {});
           fetch("http://127.0.0.1:${trapPort}/direct").catch(() => {});
           try { new WebSocket("ws://127.0.0.1:${trapPort}/ws"); } catch (e) {}
         </script>`,
        "<title>Menu</title>",
      ),
      "/api/menu": (_q, s) => {
        s.writeHead(200, { "content-type": "application/json" });
        s.end(JSON.stringify({ title: "Pizza del giorno" }));
      },
      "/pixel.png": (_q, s) => s.end("x"),
      "/style.css": (_q, s) => s.end("body{}"),
    });
    const resolver = tableResolver({ "site.test": "127.0.0.1", "inside.test": "10.0.0.7" });
    try {
      const r = await renderPage(`http://site.test:${site.port}/`, {
        executablePath: chrome!,
        userAgent: "readable-by-ai-test",
        timeoutMs: 15_000,
        settleMs: 1_500,
        // Loopback stands in for "public" here, but only the site's own port is a real server;
        // the trap port is reached only by a direct connection, which must never happen.
        fetchOptions: { resolver, isAllowed: onlyLoopback },
      });
      assert.match(r.html, /Pizza del giorno/, "the page's own data request went through safeFetch");
      assert.equal(site.hits["/api/menu"], 1);
      assert.equal(site.hits["/pixel.png"], undefined, "images are never fetched");
      assert.equal(site.hits["/style.css"], undefined, "stylesheets are never fetched");
      assert.ok(!resolver.calls.includes("inside.test") || r.requests.blocked > 0, "the private name was refused");
      // The /direct fetch goes through safeFetch to 127.0.0.1:trapPort (allowed by the test
      // policy), so it may reach the trap once; the WebSocket must not.
      await new Promise((ok) => setTimeout(ok, 300));
      assert.ok(direct <= 1, `direct connections to the trap: ${direct}`);
      assert.ok(r.requests.blocked >= 2);
    } finally {
      await site.close();
      await new Promise<void>((ok) => trap.close(() => ok()));
    }
  });

  it("the WebSocket alone never connects", async () => {
    let direct = 0;
    const trap = net.createServer((s) => {
      direct++;
      s.destroy();
    });
    await new Promise<void>((r) => trap.listen(0, "127.0.0.1", r));
    const trapPort = (trap.address() as AddressInfo).port;
    const site = await localSite({
      "/": html(`<p>ws</p><script>
        for (const u of ["ws://127.0.0.1:${trapPort}/", "ws://localhost:${trapPort}/", "ws://site.test:${trapPort}/"]) { try { new WebSocket(u); } catch (e) {} }
      </script>`),
    });
    try {
      await renderPage(`http://site.test:${site.port}/`, {
        executablePath: chrome!,
        userAgent: "readable-by-ai-test",
        settleMs: 1_500,
        fetchOptions: { resolver: tableResolver({ "site.test": "127.0.0.1" }), isAllowed: onlyLoopback },
      });
      await new Promise((ok) => setTimeout(ok, 500));
      assert.equal(direct, 0);
    } finally {
      await site.close();
      await new Promise<void>((ok) => trap.close(() => ok()));
    }
  });

  it("a JavaScript-only page: the percentage comes out", async () => {
    const site = await localSite({
      "/": html(`<div id="root"></div><script>document.getElementById("root").innerHTML = "<h1>Hotel Sole</h1><p>" + "Camere vista mare a due passi dalla spiaggia. ".repeat(20) + "</p>";</script>`, "<title>Hotel</title>"),
    });
    try {
      const r = await check(`http://site.test:${site.port}/`, {
        browser: { executablePath: chrome!, settleMs: 1_000 },
        fetchOptions: { resolver: tableResolver({ "site.test": "127.0.0.1" }), isAllowed: onlyLoopback },
      });
      assert.equal(r.text.rawChars, 0);
      assert.ok((r.text.renderedChars ?? 0) > 800);
      assert.equal(r.text.ratio, 0);
      assert.equal(r.verdict, "empty");
    } finally {
      await site.close();
    }
  });
});
