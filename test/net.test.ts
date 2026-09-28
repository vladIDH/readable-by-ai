import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as zlib from "node:zlib";
import { assertUrlAllowed, BlockedError, isPublicAddress, safeFetch, type Resolver } from "../src/net";
import { localSite, onlyLoopback, tableResolver } from "./helpers";

describe("isPublicAddress", () => {
  it("blocks private, loopback, link-local, CGNAT, multicast and reserved IPv4", () => {
    for (const ip of ["0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "127.8.8.8", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.1", "192.168.1.1", "198.18.0.1", "224.0.0.1", "255.255.255.255"]) {
      assert.equal(isPublicAddress(ip), false, ip);
    }
  });
  it("lets public IPv4 through", () => {
    for (const ip of ["93.184.216.34", "1.1.1.1", "172.32.0.1", "100.128.0.1", "8.8.8.8"]) assert.equal(isPublicAddress(ip), true, ip);
  });
  it("sees private IPv4 hidden inside IPv6, in every spelling", () => {
    for (const ip of ["::1", "::", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::1", "fd00:ec2::254", "fc00::1", "fe80::1", "fe80::1%eth0", "ff02::1", "2001:db8::1"]) {
      assert.equal(isPublicAddress(ip), false, ip);
    }
    for (const ip of ["2606:4700::6810:84e5", "2a00:1450:4001::200e", "::ffff:8.8.8.8", "64:ff9b::808:808"]) assert.equal(isPublicAddress(ip), true, ip);
  });
  it("fails closed on garbage", () => {
    for (const ip of ["", "localhost", "1.2.3", "::gg", "1:2:3:4:5:6:7:8:9"]) assert.equal(isPublicAddress(ip), false, ip);
  });
});

describe("assertUrlAllowed", () => {
  const blocked = (u: string, reason: string) => assert.throws(() => assertUrlAllowed(u), (e: unknown) => e instanceof BlockedError && e.reason === reason, u);
  it("only http and https", () => {
    blocked("file:///etc/passwd", "protocol");
    blocked("ftp://example.com/", "protocol");
    blocked("gopher://example.com/", "protocol");
  });
  it("only the standard ports, no credentials", () => {
    blocked("http://example.com:22/", "port");
    blocked("https://example.com:8443/", "port");
    blocked("http://user:pass@example.com/", "credentials");
    assert.ok(assertUrlAllowed("https://example.com:443/"));
  });
  it("private addresses written in any form new URL() accepts", () => {
    blocked("http://127.0.0.1/", "address");
    blocked("http://2130706433/", "address"); // decimal 127.0.0.1
    blocked("http://0x7f.1/", "address"); // hex
    blocked("http://0177.0.0.1/", "address"); // octal
    blocked("http://[::1]/", "address");
    blocked("http://[::ffff:169.254.169.254]/", "address");
    blocked("http://169.254.169.254/latest/meta-data/", "address");
  });
  it("names that never leave the machine", () => {
    blocked("http://localhost/", "hostname");
    blocked("http://app.localhost/", "hostname");
    blocked("http://metadata.google.internal/", "hostname");
    blocked("http://printer.local/", "hostname");
    blocked("http://intranet/", "hostname");
  });
});

describe("safeFetch: DNS", () => {
  it("refuses a public-looking name that resolves to a private address", async () => {
    const resolver = tableResolver({ "evil.example": "10.0.0.5" });
    await assert.rejects(safeFetch("http://evil.example/", { resolver }), (e: unknown) => e instanceof BlockedError && e.reason === "address");
  });
  it("refuses the whole answer if ANY address is private", async () => {
    const resolver = tableResolver({ "mixed.example": ["93.184.216.34", "127.0.0.1"] });
    await assert.rejects(safeFetch("http://mixed.example/", { resolver }), BlockedError);
  });
  it("cloud metadata by name", async () => {
    const resolver = tableResolver({ "meta.example": "169.254.169.254" });
    await assert.rejects(safeFetch("http://meta.example/latest/", { resolver }), BlockedError);
  });

  it("DNS rebinding: the address checked is the address connected to, and there is no second lookup", async () => {
    const site = await localSite({ "/": (_q, s) => s.end("hello") });
    try {
      // First answer: the allowed address. Every later answer: a private one.
      let n = 0;
      const answers = ["127.0.0.1", "10.0.0.1", "10.0.0.1"];
      const calls: string[] = [];
      const resolver: Resolver = async (h) => {
        calls.push(h);
        return [{ address: answers[n++], family: 4 }];
      };
      const r = await safeFetch(`http://rebind.test:${site.port}/`, { resolver, isAllowed: onlyLoopback });
      assert.equal(r.status, 200);
      assert.equal(r.body.toString(), "hello");
      assert.equal(r.address, "127.0.0.1");
      // One request, ONE resolution: a check-then-fetch implementation would have asked twice
      // and connected to the second answer (10.0.0.1).
      assert.equal(calls.length, 1);
      // The next request gets the private answer, and is refused before connecting.
      await assert.rejects(safeFetch(`http://rebind.test:${site.port}/`, { resolver, isAllowed: onlyLoopback }), BlockedError);
      assert.equal(site.hits["/"], 1);
    } finally {
      await site.close();
    }
  });
});

describe("safeFetch: redirects and limits", () => {
  it("a redirect to a private address is refused, and never requested", async () => {
    const site = await localSite({
      "/go": (_q, s) => {
        s.writeHead(302, { location: "http://inside.test/secret" });
        s.end();
      },
    });
    try {
      const resolver = tableResolver({ "site.test": "127.0.0.1", "inside.test": "192.168.1.10" });
      await assert.rejects(safeFetch(`http://site.test:${site.port}/go`, { resolver, isAllowed: onlyLoopback }), BlockedError);
    } finally {
      await site.close();
    }
  });
  it("a redirect to localhost by name is refused", async () => {
    const site = await localSite({
      "/go": (_q, s) => {
        s.writeHead(301, { location: "http://localhost/admin" });
        s.end();
      },
    });
    try {
      // Real policy on the second hop: the name alone is enough to stop it.
      const resolver = tableResolver({ "site.test": "127.0.0.1" });
      await assert.rejects(safeFetch(`http://site.test:${site.port}/go`, { resolver, isAllowed: onlyLoopback }), BlockedError);
    } finally {
      await site.close();
    }
  });
  it("at most 5 redirects", async () => {
    const site = await localSite({
      "/loop": (q, s) => {
        const n = Number(new URL(q.url!, "http://x").searchParams.get("n") ?? 0);
        s.writeHead(302, { location: `/loop?n=${n + 1}` });
        s.end();
      },
    });
    try {
      const resolver = tableResolver({ "site.test": "127.0.0.1" });
      await assert.rejects(
        safeFetch(`http://site.test:${site.port}/loop`, { resolver, isAllowed: onlyLoopback }),
        (e: unknown) => e instanceof BlockedError && e.reason === "redirects",
      );
      assert.equal(site.hits["/loop"], 6); // the first request + 5 redirects
    } finally {
      await site.close();
    }
  });
  it("caps the body size, also after decompression", async () => {
    const big = Buffer.alloc(3_000_000, "a");
    const site = await localSite({
      "/big": (_q, s) => s.end(big),
      "/bomb": (_q, s) => {
        s.writeHead(200, { "content-encoding": "gzip" });
        s.end(zlib.gzipSync(Buffer.alloc(20_000_000, 0)));
      },
    });
    try {
      const resolver = tableResolver({ "site.test": "127.0.0.1" });
      const r = await safeFetch(`http://site.test:${site.port}/big`, { resolver, isAllowed: onlyLoopback, maxBytes: 100_000 });
      assert.equal(r.truncated, true);
      assert.equal(r.body.length, 100_000);
      const b = await safeFetch(`http://site.test:${site.port}/bomb`, { resolver, isAllowed: onlyLoopback, maxBytes: 1_000_000 });
      assert.equal(b.truncated, true);
      assert.ok(b.body.length <= 1_000_000);
    } finally {
      await site.close();
    }
  });
  it("gives up after the timeout", async () => {
    const site = await localSite({ "/slow": () => {} });
    try {
      const resolver = tableResolver({ "site.test": "127.0.0.1" });
      const t = Date.now();
      await assert.rejects(safeFetch(`http://site.test:${site.port}/slow`, { resolver, isAllowed: onlyLoopback, timeoutMs: 300 }));
      assert.ok(Date.now() - t < 2_000);
    } finally {
      await site.close();
    }
  });
});
