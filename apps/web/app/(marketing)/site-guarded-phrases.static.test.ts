/**
 * @jest-environment node
 */
// Pricing v14 Phase 1 (2026-11-24): phrases for things the claims register (docs/product/claims-register.md, section
// D) marks not built. The honest pages name these on purpose ("There's no proof photo or signature"), so a plain deny
// list would fail on them. Instead, like site-pin-ledger.json, every sentence on a site page that holds a guarded phrase
// must be listed in site-guarded-phrase-ledger.json with its page and exact wording. A new sentence fails until someone
// adds it to the ledger on purpose and a reviewer reads it; a ledger row whose sentence is gone fails too.
//
// Scope: the visible text and the search descriptions of apps/web/public/site/*.html. The home wheel paints its own copy
// at run time from graphics/rf-wheel-up.js; site-truth.static.test.ts pins that copy.
import * as fs from "fs";
import * as path from "path";

const HERE = __dirname;
const SITE = path.resolve(HERE, "../../public/site");

type Phrase = { id: string; pattern: string; register: string };
type Row = { phrase: string; page: string; sentence: string; why: string };
type Ledger = { definition: string; phrases: Phrase[]; rows: Row[] };

const ledger: Ledger = JSON.parse(
  fs.readFileSync(path.join(HERE, "site-guarded-phrase-ledger.json"), "utf8"),
);

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  middot: "·",
  copy: "©",
};
const decode = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);

const BLOCK =
  /<\/?(?:p|li|ul|ol|td|th|tr|table|h[1-6]|div|section|article|header|footer|nav|main|aside|figure|figcaption|summary|details|dt|dd|br|small|button|a|label|blockquote|text|title)\b[^>]*>/gi;

/** The page's public text as sentences: block-level tags end a chunk, and . ! ? end a sentence. */
export function sentences(raw: string): string[] {
  const metas = [...raw.matchAll(/<meta\b[^>]*\bcontent="([^"]*)"[^>]*>/gi)]
    .filter((m) =>
      /name="description"|property="og:description"|name="twitter:description"/i.test(m[0]),
    )
    .map((m) => m[1]);
  const body = raw
    .replace(/<script\b[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "\n")
    .replace(/<!--[\s\S]*?-->/g, "\n")
    .replace(BLOCK, "\n")
    .replace(/<[^>]+>/g, "");
  const out: string[] = [];
  for (const chunk of [...metas, ...body.split("\n")]) {
    const text = decode(chunk).replace(/\s+/g, " ").trim();
    if (!text) continue;
    for (const s of text.split(/(?<=[.!?])\s+/)) if (s.trim()) out.push(s.trim());
  }
  return [...new Set(out)];
}

const pages = () =>
  fs
    .readdirSync(SITE)
    .filter((f) => f.endsWith(".html"))
    .sort();

const compiled = () => ledger.phrases.map((p) => ({ ...p, re: new RegExp(p.pattern, "i") }));

/** Every (phrase, page, sentence) on the site. */
function occurrences(): Row[] {
  const found: Row[] = [];
  for (const page of pages()) {
    for (const sentence of sentences(fs.readFileSync(path.join(SITE, page), "utf8"))) {
      for (const p of compiled()) {
        if (p.re.test(sentence)) found.push({ phrase: p.id, page, sentence, why: "" });
      }
    }
  }
  return found;
}

const key = (r: Pick<Row, "phrase" | "page" | "sentence">) =>
  `${r.phrase} | ${r.page} | ${r.sentence}`;

describe("guarded phrases appear only in sentences the ledger lists", () => {
  it("the scan is not vacuous: it reads every site page and finds sentences", () => {
    expect(pages().length).toBeGreaterThanOrEqual(10);
    const product = sentences(fs.readFileSync(path.join(SITE, "product.html"), "utf8"));
    expect(product.length).toBeGreaterThan(50);
    expect(occurrences().length).toBeGreaterThan(5);
  });

  it("each guarded phrase catches its own sample, and the sentence split sees a planted one", () => {
    const samples: Record<string, string> = {
      "live-map": "See your drivers on a live map.",
      signature: "Drivers collect a signature.",
      photo: "Drivers take a proof photo.",
      "pay-at-the-door": "Take payment at the door.",
      "accounting-tools": "It syncs with QuickBooks.",
      "text-messages": "Stores get text messages.",
      warehouses: "Run several warehouses.",
      edi: "Connect by EDI.",
      "two-step-login": "Turn on two-step login.",
      "lots-expiry-bins": "Track expiry dates and bins.",
      "api-webhooks": "Use our API and webhooks.",
    };
    expect(ledger.phrases.map((p) => p.id).sort()).toEqual(Object.keys(samples).sort());
    for (const p of compiled())
      expect(`${p.id}: ${p.re.test(samples[p.id])}`).toBe(`${p.id}: true`);
    const planted = sentences("<p>Plain words. Stores get text messages.</p>");
    expect(planted).toEqual(["Plain words.", "Stores get text messages."]);
  });

  it("every phrase points at a claims-register row", () => {
    const bad = ledger.phrases.filter((p) => !/^(A\d+|D)$/.test(p.register)).map((p) => p.id);
    expect(bad).toEqual([]);
  });

  it("every sentence on the site that holds a guarded phrase is in the ledger", () => {
    const listed = new Set(ledger.rows.map(key));
    const missing = occurrences()
      .filter((o) => !listed.has(key(o)))
      .map((o) => ({ phrase: o.phrase, page: o.page, sentence: o.sentence }));
    expect(missing).toEqual([]);
  });

  it("every ledger row is still on its page, matches its phrase, and says why it is allowed", () => {
    const seen = new Set(occurrences().map(key));
    const ids = new Map(compiled().map((p) => [p.id, p.re]));
    const stale = ledger.rows.filter((r) => !seen.has(key(r))).map(key);
    const wrong = ledger.rows.filter((r) => !ids.get(r.phrase)?.test(r.sentence)).map(key);
    const bare = ledger.rows.filter((r) => r.why.trim().length < 10).map(key);
    expect({ stale, wrong, bare }).toEqual({ stale: [], wrong: [], bare: [] });
  });

  it("the ledger lists each sentence once", () => {
    const keys = ledger.rows.map(key);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });
});
