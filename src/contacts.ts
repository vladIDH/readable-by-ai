/**
 * Contact details an assistant can read in the text itself: phone,
 * e-mail, street address. Heuristics, tuned to be quiet rather than
 * clever: a number that is not clearly a phone is not reported.
 */
import type { ParsedPage } from "./html.js";

export interface ContactsResult {
  phones: string[];
  emails: string[];
  address: string | null;
  /** The name the site gives itself (structured data, og:site_name, title). */
  name: string | null;
  /** Does that name appear in the visible text? `null` when there is no name to look for. */
  nameInText: boolean | null;
  /** Names that disagree with each other (e.g. structured data vs title). */
  otherNames: string[];
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// International (+39 …, 0034 …) or national numbers with the usual groupings.
const PHONE = /(?:(?:\+|00)\d{1,3}[\s.\-/]?)?(?:\(?\d{2,4}\)?[\s.\-/]?){2,4}\d{2,4}/g;
const STREET =
  /\b(?:via|viale|piazza|piazzale|corso|largo|vicolo|strada|contrada|calle|c\/|avenida|avda\.?|plaza|paseo|carrer|carretera|urbanizaci[oó]n|rua|rue|street|st\.|road|rd\.|avenue|ave\.|lane|boulevard|blvd\.?|stra(?:ss|ß)e)\s+[^\n,.;]{2,60}?,?\s*\d{1,4}\b[^\n]{0,60}/i;

function normalizePhone(p: string): string {
  return p.replace(/[^\d+]/g, "");
}

function looksLikePhone(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return false;
  // Dates, years and prices are the usual false positives.
  if (/^\d{4}[\s.\-/]\d{2}[\s.\-/]\d{2}$/.test(raw.trim())) return false;
  if (/^(19|20)\d{2}\s*[-–]\s*(19|20)\d{2}$/.test(raw.trim())) return false;
  return raw.trim().startsWith("+") || raw.trim().startsWith("00") || /[\s.\-/()]/.test(raw.trim()) || digits.length >= 9;
}

const norm = (s: string) =>
  s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function readContacts(page: ParsedPage, siteNames: Array<string | null | undefined>): ContactsResult {
  const text = page.text;
  const emails = new Set<string>();
  for (const m of text.match(EMAIL) ?? []) if (!/\.(png|jpe?g|webp|gif|svg)$/i.test(m)) emails.add(m.toLowerCase());
  const phones = new Set<string>();
  for (const m of text.match(PHONE) ?? []) if (looksLikePhone(m)) phones.add(normalizePhone(m));
  // tel:/mailto: links count only when the text shows them too; the link alone is kept as a hint.
  for (const h of page.hrefs) {
    if (/^tel:/i.test(h)) {
      const p = normalizePhone(decodeURIComponent(h.slice(4)));
      if (p.replace(/\D/g, "").length >= 8 && text.replace(/[^\d+]/g, "").includes(p.replace("+", ""))) phones.add(p);
    }
  }
  const address = STREET.exec(text)?.[0].trim().replace(/\s+/g, " ").slice(0, 120) ?? null;

  const names = siteNames
    .map((n) => (n ?? "").trim())
    .filter(Boolean)
    // "Home | Pizzeria Da Mario" → the part that is not a generic page word.
    .map((n) => n.split(/\s[|·•–—-]\s|\s:\s/).map((s) => s.trim()).filter((s) => s && !/^(home|homepage|inicio|inizio|benvenuti|welcome)$/i.test(s))[0] ?? n);
  const name = names[0] ?? null;
  const textNorm = " " + norm(text) + " ";
  const nameInText = name ? textNorm.includes(" " + norm(name) + " ") : null;
  const otherNames = [...new Set(names.slice(1).filter((n) => {
    const a = norm(n), b = norm(name ?? "");
    return a && b && !a.includes(b) && !b.includes(a);
  }))];
  return { phones: [...phones].slice(0, 5), emails: [...emails].slice(0, 5), address, name, nameInText, otherNames };
}
