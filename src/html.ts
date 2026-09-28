/**
 * A small, tolerant HTML reader. It is not a full HTML5 parser: it reads
 * what an AI crawler that does not run JavaScript can read, and the few
 * head fields the checks need. No dependencies, so `npx` stays fast.
 */

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "param", "keygen"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "template"]);
/** Elements whose content is never visible text. */
const SKIP = new Set(["script", "style", "template", "svg", "math", "head", "iframe", "object", "canvas", "noembed", "noframes", "xmp"]);
const BLOCK = new Set([
  "p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "li", "ul", "ol", "dl", "dt", "dd",
  "h1", "h2", "h3", "h4", "h5", "h6", "table", "tr", "td", "th", "br", "hr", "form", "fieldset", "blockquote", "pre",
  "address", "figure", "figcaption", "details", "summary", "option", "button", "label",
]);
/** Where single-page apps mount themselves. */
const MOUNT_IDS = new Set(["root", "app", "__next", "__nuxt", "svelte", "___gatsby", "q-app", "main-app"]);

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", shy: "", copy: "©", reg: "®", trade: "™",
  euro: "€", pound: "£", laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", sbquo: "‚", bdquo: "„",
  hellip: "…", mdash: "—", ndash: "–", middot: "·", bull: "•", deg: "°", times: "×", divide: "÷", iexcl: "¡", iquest: "¿",
  ordf: "ª", ordm: "º", sect: "§", para: "¶", eacute: "é", egrave: "è", ecirc: "ê", euml: "ë", aacute: "á", agrave: "à",
  acirc: "â", auml: "ä", atilde: "ã", aring: "å", iacute: "í", igrave: "ì", icirc: "î", iuml: "ï", oacute: "ó",
  ograve: "ò", ocirc: "ô", ouml: "ö", otilde: "õ", oslash: "ø", uacute: "ú", ugrave: "ù", ucirc: "û", uuml: "ü",
  ntilde: "ñ", ccedil: "ç", szlig: "ß", yacute: "ý", Eacute: "É", Egrave: "È", Aacute: "Á", Agrave: "À", Iacute: "Í",
  Oacute: "Ó", Ograve: "Ò", Uacute: "Ú", Ntilde: "Ñ", Ccedil: "Ç", Auml: "Ä", Ouml: "Ö", Uuml: "Ü",
};

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[e] ?? NAMED[e.toLowerCase()] ?? m;
  });
}

export interface Tag {
  name: string;
  attrs: Record<string, string>;
}

export interface ParsedPage {
  /** Visible text, whitespace collapsed. */
  text: string;
  title: string | null;
  lang: string | null;
  metas: Array<Record<string, string>>;
  links: Array<Record<string, string>>;
  headings: Array<{ level: number; text: string }>;
  jsonLd: string[];
  scripts: Array<{ src: string | null; type: string | null; inline: number }>;
  hrefs: string[];
  /** Mount points (#root, #app…) and how much text they contain. */
  mounts: Array<{ id: string; textChars: number }>;
  /** Anything with an itemtype (microdata). */
  itemTypes: string[];
  noscriptText: string;
  /** Raw HTML length in characters. */
  htmlChars: number;
}

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const k = m[1].toLowerCase();
    if (!(k in attrs)) attrs[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

export interface ParseOptions {
  /**
   * `false` (default): read like a crawler without JavaScript, so the
   * content of <noscript> counts as text. `true`: read a page a browser
   * has already run, so <noscript> is ignored.
   */
  scripting?: boolean;
}

export function parseHtml(html: string, options: ParseOptions = {}): ParsedPage {
  const scripting = options.scripting ?? false;
  const out: ParsedPage = {
    text: "", title: null, lang: null, metas: [], links: [], headings: [], jsonLd: [], scripts: [],
    hrefs: [], mounts: [], itemTypes: [], noscriptText: "", htmlChars: html.length,
  };
  const stack: Array<{ name: string; skip: boolean; hidden: boolean; mount: number }> = [];
  const textParts: string[] = [];
  let headingBuf: { level: number; parts: string[] } | null = null;
  const mountBufs = new Map<number, { id: string; chars: number }>();
  let noscriptDepth = 0;

  const skipping = () => stack.some((s) => s.skip || s.hidden);
  const pushText = (raw: string) => {
    const t = decodeEntities(raw);
    if (!t.trim()) {
      if (t.length) textParts.push(" ");
      return;
    }
    if (noscriptDepth > 0) {
      out.noscriptText += " " + t;
      if (scripting) return;
    }
    if (skipping()) return;
    textParts.push(t);
    if (headingBuf) headingBuf.parts.push(t);
    for (const s of stack) if (s.mount >= 0) mountBufs.get(s.mount)!.chars += t.replace(/\s+/g, "").length;
  };

  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      pushText(html.slice(i));
      break;
    }
    if (lt > i) pushText(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const closing = html[lt + 1] === "/";
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(html.slice(lt + (closing ? 2 : 1), lt + 40));
    if (!nameMatch) {
      pushText("<");
      i = lt + 1;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    // Find the end of the tag, respecting quotes.
    let j = lt + (closing ? 2 : 1) + nameMatch[0].length;
    let quote: string | null = null;
    for (; j < n; j++) {
      const c = html[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    const inner = html.slice(lt + (closing ? 2 : 1) + nameMatch[0].length, j);
    i = j + 1;

    if (closing) {
      if (name === "noscript" && noscriptDepth > 0) noscriptDepth--;
      if (/^h[1-6]$/.test(name) && headingBuf && `h${headingBuf.level}` === name) {
        const t = headingBuf.parts.join(" ").replace(/\s+/g, " ").trim();
        if (t) out.headings.push({ level: headingBuf.level, text: t });
        headingBuf = null;
      }
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].name === name) {
          for (const s of stack.slice(k)) {
            if (s.mount >= 0) {
              const b = mountBufs.get(s.mount)!;
              out.mounts.push({ id: b.id, textChars: b.chars });
            }
          }
          stack.length = k;
          break;
        }
      }
      if (BLOCK.has(name)) textParts.push(" ");
      continue;
    }

    const attrs = parseAttrs(inner);
    const selfClosing = inner.trimEnd().endsWith("/");

    if (name === "html" && attrs.lang) out.lang = attrs.lang;
    if (name === "meta") out.metas.push(attrs);
    if (name === "link") out.links.push(attrs);
    if (name === "a" && attrs.href) out.hrefs.push(attrs.href);
    if (attrs.itemtype) out.itemTypes.push(...attrs.itemtype.split(/\s+/).filter(Boolean));
    if (name === "noscript") noscriptDepth++;
    if (BLOCK.has(name)) textParts.push(" ");

    if (RAW_TEXT.has(name) && !selfClosing) {
      const close = new RegExp(`</${name}\\s*>`, "ig");
      close.lastIndex = i;
      const m = close.exec(html);
      const content = html.slice(i, m ? m.index : n);
      i = m ? m.index + m[0].length : n;
      if (name === "title") {
        if (out.title === null && !stack.some((s) => s.name === "svg")) out.title = decodeEntities(content).replace(/\s+/g, " ").trim();
      } else if (name === "script") {
        const type = attrs.type?.toLowerCase() ?? null;
        out.scripts.push({ src: attrs.src ?? null, type, inline: attrs.src ? 0 : content.length });
        if (type === "application/ld+json") out.jsonLd.push(content.trim());
      } else if (name === "textarea") {
        pushText(content);
      }
      continue;
    }

    if (VOID.has(name) || selfClosing) continue;

    const hidden = "hidden" in attrs || /display\s*:\s*none/i.test(attrs.style ?? "");
    const id = attrs.id ?? "";
    let mount = -1;
    if (MOUNT_IDS.has(id) || name === "app-root") {
      mount = mountBufs.size;
      mountBufs.set(mount, { id: id || name, chars: 0 });
    }
    const hm = /^h([1-6])$/.exec(name);
    if (hm && !skipping()) headingBuf = { level: Number(hm[1]), parts: [] };
    stack.push({ name, skip: SKIP.has(name), hidden, mount });
  }
  // Unclosed mounts at the end of the document.
  for (const s of stack) {
    if (s.mount >= 0) {
      const b = mountBufs.get(s.mount)!;
      out.mounts.push({ id: b.id, textChars: b.chars });
    }
  }
  out.text = textParts.join("").replace(/\s+/g, " ").trim();
  out.noscriptText = out.noscriptText.replace(/\s+/g, " ").trim();
  return out;
}

/** `name` or `property` → `content`, first one wins, keys lowercased. */
export function metaMap(page: ParsedPage): Record<string, string> {
  const m: Record<string, string> = {};
  for (const a of page.metas) {
    const key = (a.name ?? a.property ?? a["http-equiv"] ?? "").toLowerCase();
    if (key && a.content !== undefined && !(key in m)) m[key] = a.content;
  }
  return m;
}
