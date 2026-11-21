// Copy rules for the eight inner pages (wave 1b) and the home page (wave 2): T41 pricing wording
// (plan limits are about customers only, one Enterprise line, no stray lines, one weight) and T37
// (no sentence ends with the brand name, titles stay short) with a dotted fixture name, plus the
// SA-1080 rule (no login or seat numbers on any served page). Pages are read as served.
import { loadBrand } from "@routeflow/types/brand";
import { readServedSitePage } from "@/lib/read-site-page";
import {
  renderSitePage,
  STATIC_SITE_PAGE_NAMES,
  type StaticSitePage,
} from "@/lib/static-site-page";

const PAGES = [
  "pricing",
  "product",
  "company",
  "contact",
  "getting-started",
  "does-and-doesnt",
  "data-in-and-out",
  "security",
] as StaticSitePage[];

const DOTTED = { ...loadBrand(), name: "FIXTURE.TEST" };

const decode = (s: string) =>
  s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** Visible text, plus meta content and aria-label / alt / title attribute values, one per line. */
function readable(html: string): string {
  // og:image:alt is a label ("Name. Share line"), built by shareAlt() in the brand package and
  // pinned by the seam tests; it is not a sentence. Reported to the brand-seam owner (2.5 flip).
  html = html.replace(/<meta property="og:image:alt"[^>]*>/g, "");
  const attrs = [...html.matchAll(/\b(?:content|aria-label|alt|title)="([^"]*)"/g)].map(
    (m) => m[1],
  );
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, "");
  return decode([body, ...attrs].join("\n"));
}

const served = (p: StaticSitePage) => readServedSitePage(p, { websiteId: undefined });
const titleOf = (html: string) => decode(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "");

describe("the page list", () => {
  it("is the eight inner pages", () => {
    for (const p of PAGES) expect(STATIC_SITE_PAGE_NAMES).toContain(p);
  });
});

describe("T41: plans differ by customers only", () => {
  it.each(PAGES)("%s: no plan-limit sentence mentions logins", (p) => {
    const text = readable(served(p));
    // plan-limit sentences: "differ by", "plans differ", "include"
    const lines = text.split(/(?<=[.!?])\s+|\n/);
    const bad = lines.filter((l) => /\bdiffer\b/i.test(l) && /logins?\b/i.test(l));
    expect(bad).toEqual([]);
  });

  it("home: no plan-limit sentence mentions logins, and it says customers only", () => {
    const text = readable(served("home"));
    const lines = text.split(/(?<=[.!?])\s+|\n/);
    expect(lines.filter((l) => /\bdiffer\b/i.test(l) && /logins?\b/i.test(l))).toEqual([]);
    expect(text).toContain("The plans differ by how many customers they include.");
    expect(text).not.toMatch(/customers and logins/);
  });

  it("pricing and product say the plans differ by customers only", () => {
    expect(readable(served("pricing"))).toContain(
      "The plans differ by how many customers they include.",
    );
    expect(readable(served("product"))).toContain(
      "The plans differ by how many customers they include.",
    );
  });

  it("pricing has exactly one Enterprise email line", () => {
    const html = served("pricing");
    expect(readable(html)).not.toMatch(/Need more than Scale/);
    const mails = html.match(/<a[^>]*href="mailto:[^"]*"[^>]*>/g) ?? [];
    const enterprise = mails.filter((m) => /enterprise_click/.test(m));
    expect(enterprise).toHaveLength(1);
    // the card's link keeps the #contact anchor
    expect(enterprise[0]).toMatch(/id="contact"/);
    expect(html.match(/id="contact"/g)).toHaveLength(1);
  });

  it("pricing drops the stray lines", () => {
    const text = readable(served("pricing"));
    expect(text).not.toContain("Includes your team.");
    expect(text).not.toContain("A custom price");
  });

  it("the trial line is the same weight as its siblings", () => {
    const html = served("pricing");
    expect(html).toContain("Every trial starts on Starter and lasts 14 days. No card needed.");
    expect(html).not.toMatch(/<(strong|b)>\s*Every trial starts/);
    expect(html).toMatch(
      /<p>Every trial starts on Starter and lasts 14 days\. No card needed\.<\/p>/,
    );
  });

  it("the closing band says free and the 14 days in one sentence", () => {
    for (const p of PAGES.filter((x) => x !== "contact" && x !== "company")) {
      const html = served(p);
      expect(html).toContain("free for 14 days.</h2><p>No card needed.</p>");
      expect(html).not.toContain("free.</h2><p>14 days free. No card needed.</p>");
    }
  });
});

// SA-1080 A-1 (js/prices.js:5): plans differ by price and customers only; seats and logins are not
// counted, so no served page puts a number next to the words login or seat.
const LOGIN_NUMBER =
  /(?:\d[\d,]*|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|unlimited)\b)\s+(?:[a-z-]+\s+)?(?:logins?|seats?)\b|\b(?:logins?|seats?)\s*[:=(]?\s*\d/gi;
const loginNumbers = (text: string): string[] => text.match(LOGIN_NUMBER) ?? [];

describe("SA-1080: no number next to login or seat", () => {
  it("the rule flags a fixture sentence (it is not vacuous)", () => {
    expect(loginNumbers("Starter includes up to 5 logins.")).toHaveLength(1);
    expect(loginNumbers("Each plan has 3 staff seats and 2 driver logins.")).toHaveLength(2);
    expect(loginNumbers("Seats: 10")).toHaveLength(1);
    expect(loginNumbers("Add as many logins as you need.")).toEqual([]);
  });

  it.each(STATIC_SITE_PAGE_NAMES)("%s: no login or seat count", (p) => {
    expect(loginNumbers(readable(served(p)))).toEqual([]);
  });
});

describe("T37 home: no sentence ends with the name (dotted fixture name)", () => {
  const home = () => readServedSitePage("home", { brand: DOTTED, websiteId: undefined });

  it("the home page carries the fixture name and no sentence ends with it", () => {
    const html = home();
    expect(html).toContain("FIXTURE.TEST");
    const text = readable(html);
    expect(text).not.toMatch(/FIXTURE\.TEST\s*[.!?]/);
    // the three lines that used to end with the name, as decided (Set 1)
    expect(text).toContain("What is FIXTURE.TEST for?");
    expect(text).toContain("What FIXTURE.TEST helps you do.");
    expect(text).toContain("You do every step in FIXTURE.TEST, start to finish.");
    expect(text).not.toContain("What is FIXTURE.TEST?");
    expect(text).not.toContain("Every step is in FIXTURE.TEST.");
    expect(text).not.toContain("What you can do with FIXTURE.TEST.");
  });

  it("the title is at most 60 characters with the real name and the fixture", () => {
    expect(titleOf(served("home")).length).toBeLessThanOrEqual(60);
    expect(titleOf(home()).length).toBeLessThanOrEqual(60);
  });

  it("pricing asks the same question as home, with the same answer", () => {
    const q = "What is FIXTURE.TEST for?";
    const answer =
      "Software for businesses that sell to stores. Take orders, send invoices, and get paid.";
    for (const p of ["home", "pricing"] as StaticSitePage[]) {
      const html = readServedSitePage(p, { brand: DOTTED, websiteId: undefined });
      expect(html).toContain("<summary>" + q);
      expect(html).toContain(answer);
      expect(html).not.toContain("What does FIXTURE.TEST do?");
    }
  });
});

describe("T37: no sentence ends with the name (dotted fixture name)", () => {
  it.each(PAGES)("%s: no name followed by . ! or ?", (p) => {
    const html = readServedSitePage(p, { brand: DOTTED, websiteId: undefined });
    expect(html).toContain("FIXTURE.TEST");
    expect(readable(html)).not.toMatch(/FIXTURE\.TEST\s*[.!?]/);
  });

  it.each(PAGES)("%s: title is at most 60 characters with the real name and the fixture", (p) => {
    expect(titleOf(served(p)).length).toBeLessThanOrEqual(60);
    expect(
      titleOf(readServedSitePage(p, { brand: DOTTED, websiteId: undefined })).length,
    ).toBeLessThanOrEqual(60);
  });
});

// T10 (R11): Apple Style Guide copy rules over the visible text of every site page, as served.
// "Visible text" = the text nodes of <body>, nothing else: tags and their attributes (alt, aria-label,
// title, content), <script> (JSON-LD, inline scripts), <style>, <noscript>, <template>, comments, and
// <title> elements inside SVG are all removed first; entities are decoded last, so &amp; counts as "&"
// and &#39; as a straight apostrophe, as a visitor sees them.
// The plan cards are frozen by the owner until a separate ruling: their text nodes are read (so the
// extractor stays honest) but are not asserted on. Hits there are reported by the ledger, not here.
type TextNode = { text: string; frozen: boolean };
type Parsed = { nodes: TextNode[]; figures: number };

const FROZEN_CLASS = /^(?:pcard|pl|pl-[\w-]+|plp)$/;
const VOID_TAGS = new Set([
  "br",
  "img",
  "input",
  "meta",
  "link",
  "hr",
  "use",
  "path",
  "circle",
  "rect",
]);

const NAMED: Record<string, string> = {
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  copy: "©",
  middot: "·",
  times: "×",
  bull: "•",
};
/** Entities as a visitor sees them; an entity this table does not know is left whole (and shows as "&"). */
const decodeVisible = (s: string) =>
  decode(
    s
      .replace(/&#x([0-9a-f]+);/gi, (m, h) =>
        h === "27" ? m : String.fromCodePoint(parseInt(h, 16)),
      )
      .replace(/&#(\d+);/g, (m, d) => (d === "39" ? m : String.fromCodePoint(Number(d))))
      .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m),
  );

// SA-1203 A3 1a: a figure with role="img" AND a non-empty aria-label is an illustration of the app. Its
// inner text mirrors the app's own labels and is skipped; its aria-label is checked in its place. A figure
// without both is read like any other element. The per-page count of such figures is pinned below.
function parseVisible(html: string): Parsed {
  let body = /<body[\s\S]*?<\/body>/i.exec(html)?.[0] ?? html;
  body = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<title\b[\s\S]*?<\/title>/gi, "");
  const nodes: TextNode[] = [];
  let figures = 0;
  const stack: Array<{ tag: string; frozen: boolean; skip: boolean }> = [];
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+)/g;
  for (const m of body.matchAll(re)) {
    if (m[4] !== undefined) {
      const text = decodeVisible(m[4]);
      if (text.trim() && !stack.some((s) => s.skip)) {
        nodes.push({ text, frozen: stack.some((s) => s.frozen) });
      }
      continue;
    }
    const tag = m[2].toLowerCase();
    if (m[1]) {
      const at = stack.map((s) => s.tag).lastIndexOf(tag);
      if (at >= 0) stack.length = at;
    } else if (!VOID_TAGS.has(tag) && !m[3].trimEnd().endsWith("/")) {
      const cls = /\bclass="([^"]*)"/.exec(m[3])?.[1] ?? "";
      const label = /\baria-label="([^"]*)"/.exec(m[3])?.[1] ?? "";
      const skip = tag === "figure" && /\brole="img"/.test(m[3]) && label.trim() !== "";
      if (skip) {
        figures++;
        nodes.push({ text: decodeVisible(label), frozen: stack.some((s) => s.frozen) });
      }
      stack.push({ tag, frozen: cls.split(/\s+/).some((c) => FROZEN_CLASS.test(c)), skip });
    }
  }
  return { nodes, figures };
}
const visibleTextNodes = (html: string): TextNode[] => parseVisible(html).nodes;

const T10_RULES: Array<[name: string, test: (line: string) => boolean]> = [
  ["straight quote or apostrophe", (s) => /["']/.test(s)],
  ["e.g. / i.e. / etc.", (s) => /\b(?:e\.g\.|i\.e\.)|\betc\b/i.test(s)],
  ["click", (s) => /\bclick(?:s|ed|ing)?\b/i.test(s)],
  ["log in as a verb", (s) => /\blog(?:s|ged|ging)? in\b/i.test(s)],
  ["exclamation mark", (s) => /!/.test(s)],
  ["ampersand in a sentence", (s) => /&/.test(s)],
  ["two spaces", (s) => /\S {2,}\S/.test(s)],
];

/** Every hit as "rule | text", one per offending line of a text node, outside the frozen plan cards. */
function t10Hits(html: string): string[] {
  const hits: string[] = [];
  for (const n of visibleTextNodes(html)) {
    if (n.frozen) continue;
    for (const line of n.text.split("\n")) {
      for (const [name, test] of T10_RULES) if (test(line)) hits.push(`${name} | ${line.trim()}`);
    }
  }
  return hits;
}

// Pinned per page (SA-1203 A3 1a): a new illustration that wraps real copy changes a count and is reviewed.
const ILLUSTRATIONS: Record<string, number> = {
  company: 0,
  contact: 0,
  "data-in-and-out": 0,
  "does-and-doesnt": 0,
  "getting-started": 1,
  home: 16,
  landing: 0,
  pricing: 0,
  product: 5,
  security: 1,
};

describe("T10: copy rules over the visible text of every page", () => {
  it("the extractor reads text only, and the rules are not vacuous", () => {
    const html =
      '<html><head><title>Don\'t!</title></head><body><p class="a" title="it\'s">Plain text.</p>' +
      '<script type="application/ld+json">{"name":"it\'s!"}</script><style>a::after{content:"\'"}</style>' +
      '<svg><title>say "hi"</title></svg><!-- e.g. --><div class="pcard"><p>Don\'t click!</p></div>' +
      "<p>Tom &amp; Jerry don&#39;t. Click here, e.g. now.  Log in!</p></body></html>";
    expect(visibleTextNodes(html).map((n) => n.text)).toEqual([
      "Plain text.",
      "Don't click!",
      "Tom & Jerry don't. Click here, e.g. now.  Log in!",
    ]);
    expect(t10Hits(html).map((h) => h.split(" | ")[0])).toEqual([
      "straight quote or apostrophe",
      "e.g. / i.e. / etc.",
      "click",
      "log in as a verb",
      "exclamation mark",
      "ampersand in a sentence",
      "two spaces",
    ]);
    expect(t10Hits("<body><p>Take orders, send invoices, and sign in.</p></body>")).toEqual([]);
  });

  it("an illustration figure is skipped only with a non-empty aria-label, which is checked instead", () => {
    const fig = (attrs: string, inner: string) => `<body><figure ${attrs}>${inner}</figure></body>`;
    const ok = fig('role="img" aria-label="A report. Net $5."', "<b>Profit &amp; loss</b>");
    expect(t10Hits(ok)).toEqual([]);
    expect(parseVisible(ok).figures).toBe(1);
    // an ampersand sentence outside a figure still hits
    expect(t10Hits("<body><p>Profit &amp; loss</p></body>")).toHaveLength(1);
    // an empty or missing label does not buy a skip
    expect(t10Hits(fig('role="img" aria-label=""', "<b>Profit &amp; loss</b>"))).toHaveLength(1);
    expect(t10Hits(fig('aria-label="A report."', "<b>Profit &amp; loss</b>"))).toHaveLength(1);
    // the label is checked
    expect(t10Hits(fig('role="img" aria-label="Click here"', "<b>Net</b>"))).toHaveLength(1);
  });

  it.each(STATIC_SITE_PAGE_NAMES)("%s: no hit", (p) => {
    expect(t10Hits(served(p))).toEqual([]);
  });

  it("every page has a pinned illustration count, and it matches", () => {
    expect(Object.keys(ILLUSTRATIONS).sort()).toEqual([...STATIC_SITE_PAGE_NAMES].sort());
    for (const p of STATIC_SITE_PAGE_NAMES) {
      expect({ p, n: parseVisible(served(p)).figures }).toEqual({ p, n: ILLUSTRATIONS[p] });
    }
  });
});
