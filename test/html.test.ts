import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { metaMap, parseHtml } from "../src/html";
import { readStructuredData } from "../src/structured";
import { readContacts } from "../src/contacts";
import { detectCms } from "../src/cms";

describe("parseHtml", () => {
  it("reads visible text and leaves scripts, styles and svg out", () => {
    const p = parseHtml(`<html lang="es"><head><title>Casa &amp; Mar</title><style>.a{}</style></head>
      <body><h1>Hola <b>mundo</b></h1><script>var x = "no";</script><svg><text>no</text></svg><p>Calle&nbsp;Mayor 3</p><div hidden>oculto</div></body></html>`);
    assert.equal(p.title, "Casa & Mar");
    assert.equal(p.lang, "es");
    assert.equal(p.text, "Hola mundo Calle Mayor 3");
    assert.deepEqual(p.headings, [{ level: 1, text: "Hola mundo" }]);
  });
  it("counts <noscript> for a crawler without JavaScript, not for a rendered page", () => {
    const html = `<body><noscript>Enable JavaScript to run this app.</noscript><div id="root"></div></body>`;
    assert.match(parseHtml(html).text, /Enable JavaScript/);
    assert.equal(parseHtml(html, { scripting: true }).text, "");
  });
  it("finds empty mount points and module scripts (a JavaScript-only site)", () => {
    const p = parseHtml(`<html><head><script type="module" src="/assets/index-a1b2.js"></script></head><body><div id="root"></div></body></html>`);
    assert.deepEqual(p.mounts, [{ id: "root", textChars: 0 }]);
    assert.equal(p.scripts[0].type, "module");
    assert.equal(p.text, "");
  });
  it("a server-rendered mount point is not empty", () => {
    const p = parseHtml(`<body><div id="__next"><main><h1>Pizzeria</h1></main></div></body>`);
    assert.deepEqual(p.mounts, [{ id: "__next", textChars: 8 }]);
  });
  it("keeps JSON-LD, metas and links", () => {
    const p = parseHtml(`<head><meta name="description" content="Una frase"><meta property="og:site_name" content="Bar Uno">
      <link rel="canonical" href="https://bar.it/"><script type="application/ld+json">{"@type":"Restaurant"}</script></head>`);
    assert.equal(metaMap(p)["description"], "Una frase");
    assert.equal(metaMap(p)["og:site_name"], "Bar Uno");
    assert.equal(p.links[0].href, "https://bar.it/");
    assert.equal(p.jsonLd.length, 1);
  });
  it("survives broken markup", () => {
    const p = parseHtml(`<div><p>uno<p>due</div></span><a href="x>tre</a> < quattro`);
    assert.match(p.text, /uno due/);
  });
});

describe("structured data", () => {
  const ld = (o: unknown) => parseHtml(`<script type="application/ld+json">${JSON.stringify(o)}</script>`);
  it("a complete local business", () => {
    const s = readStructuredData(ld({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", name: "x" },
        {
          "@type": ["Restaurant"], name: "Da Mario", telephone: "+39 06 1234567",
          address: { "@type": "PostalAddress", streetAddress: "Via Roma 1", addressLocality: "Roma" },
          openingHoursSpecification: [{ "@type": "OpeningHoursSpecification", dayOfWeek: "Monday", opens: "12:00", closes: "23:00" }],
        },
        { "@type": "FAQPage", mainEntity: [{ "@type": "Question" }, { "@type": "Question" }] },
      ],
    }));
    assert.equal(s.business?.type, "Restaurant");
    assert.deepEqual(s.business?.missing, []);
    assert.equal(s.business?.address, "Via Roma 1, Roma");
    assert.deepEqual(s.faq, { questions: 2 });
  });
  it("missing fields are named", () => {
    const s = readStructuredData(ld({ "@type": "LocalBusiness", name: "Bar" }));
    assert.deepEqual(s.business?.missing, ["address", "telephone", "openingHours"]);
  });
  it("nothing found, and invalid JSON counted", () => {
    const s = readStructuredData(parseHtml(`<script type="application/ld+json">{oops</script>`));
    assert.equal(s.business, null);
    assert.equal(s.faq, null);
    assert.equal(s.invalidBlocks, 1);
  });
});

describe("contacts and name", () => {
  it("phone, e-mail and street in the text", () => {
    const p = parseHtml(`<body><p>Chiamaci al +39 347 123 4567 o scrivi a info@damario.it</p><p>Via Roma 12, 00100 Roma</p><p>Da Mario dal 1990 - 2024</p></body>`);
    const c = readContacts(p, ["Da Mario", "Home | Da Mario"]);
    assert.deepEqual(c.phones, ["+393471234567"]);
    assert.deepEqual(c.emails, ["info@damario.it"]);
    assert.match(c.address ?? "", /^Via Roma 12/);
    assert.equal(c.nameInText, true);
    assert.deepEqual(c.otherNames, []);
  });
  it("a name that is not in the text, and names that disagree", () => {
    const c = readContacts(parseHtml(`<body><p>Benvenuti</p></body>`), ["Hotel Sole", "Albergo Luna"]);
    assert.equal(c.nameInText, false);
    assert.deepEqual(c.otherNames, ["Albergo Luna"]);
  });
});

describe("CMS", () => {
  const cms = (html: string, url = "https://x.com/", headers: Record<string, string> = {}) => detectCms(html, parseHtml(html), url, headers).id;
  it("recognises the common ones", () => {
    assert.equal(cms(`<link href="/wp-content/themes/a.css">`), "wordpress");
    assert.equal(cms(`<script src="https://cdn.shopify.com/s/x.js"></script>`), "shopify");
    assert.equal(cms(`<meta name="generator" content="Wix.com Website Builder">`), "wix");
    assert.equal(cms(`<html data-wf-page="1">`), "webflow");
    assert.equal(cms(`<meta name="generator" content="Framer 1234">`), "framer");
    assert.equal(cms(`<img src="https://static1.squarespace.com/a.png">`), "squarespace");
  });
  it("recognises AI builders before the framework they use", () => {
    assert.equal(cms(`<div id="root"></div><script type="module" src="/assets/index-1.js"></script>`, "https://shop.lovable.app/"), "lovable");
    assert.equal(cms(`<img src="/lovable-uploads/a.png"><div id="root"></div>`), "lovable");
    assert.equal(cms(`<div id="root"></div><script type="module" src="/assets/index-1.js"></script>`), "spa");
  });
});
