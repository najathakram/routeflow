import * as fs from "fs";
import * as path from "path";
import { DEMO_CTA } from "./lib/site";

// W-1095 / website W0 "Say it in one look" (SA-1075 A-2, rf-specs COPY.md section 0).
// The owner's rule: the site is understood in a second, by looking at it, even by a second-language
// reader. This file guards what is READABLE; `marketing-claims.static.test.ts` guards what is TRUE.
//
// Static only: it reads source text, renders nothing. The glance test on the real page
// (docs/runbooks/glance-test.md) is the other half, and no builder runs it on their own words.

const MARKETING_ROOT = __dirname;

// Home hero, exactly as COPY.md section 1 prints it. A change here is a spec change, not an edit.
const HERO_H1 = "Wholesale software for orders and delivery.";
const HERO_SUBLINE = "Take orders, plan routes, and send invoices in one system.";
const HERO_BUTTON = "Book a video call";
const HERO_LINK = "See how it works";

// Section 0 word caps. "a", "an" and "the" do not count in headings.
const HEADING_WORD_CAP = 7;
const ARTICLES = new Set(["a", "an", "the"]);

// Section 4 and section 7: words that stopped second-language readers. Matched on whole words.
const BANNED_WORDS = [
  "scattered",
  "workflow",
  "workflows",
  "demo",
  "demos",
  "walkthrough",
  "handoff",
  "handoffs",
  "operation",
  "operations",
  "context",
];
// "No & and no em dash" in anything a visitor reads (headings are what this file reads).
const BANNED_MARKS = ["&", "—"];

// Left out of the caps: the legal pages (COPY.md section 0, "Left out of the caps").
const SKIPPED_DIRS = new Set(["privacy", "terms"]);

/**
 * Headings that are not yet clean, per file. The count may only FALL: W7 takes every entry to 0 and
 * deletes this constant. A new overlong, banned or unreadable heading in a file fails the build;
 * so does a file whose count dropped but whose entry here was not lowered (the ratchet).
 */
const ALLOWED_UNTIL_W7: Record<string, number> = {
  "components/ai-spotlight.tsx": 1,
  "components/conversion-sections.tsx": 4,
  "components/demo-scheduler.tsx": 1,
  "components/feature-catalog.tsx": 1,
  "components/marketing.tsx": 1,
  "components/technology-art.tsx": 1,
  "contact/page.tsx": 3,
  "page.tsx": 2,
  "pricing/page.tsx": 1,
  "product/page.tsx": 4,
  "wholesalers/page.tsx": 2,
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) walk(full, out);
    } else if (/\.tsx$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function rel(file: string): string {
  return path.relative(MARKETING_ROOT, file).split(path.sep).join("/");
}

/** Visible text of a JSX fragment. `readable` is false when it holds an expression we cannot read. */
function jsxText(inner: string): { text: string; readable: boolean } {
  const flat = inner
    .replace(/<br\s*\/?>/g, " ")
    .replace(/\{"\s*"\}/g, " ")
    .replace(/<[^>]+>/g, "");
  const readable = !/[{}]/.test(flat);
  return { text: flat.replace(/\s+/g, " ").trim(), readable };
}

function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function headingWordCount(text: string): number {
  return wordsOf(text).filter((w) => !ARTICLES.has(w.toLowerCase())).length;
}

interface HeadingFinding {
  file: string;
  tag: string;
  text: string;
  why: string;
}

function headingFindings(): HeadingFinding[] {
  const found: HeadingFinding[] = [];
  for (const file of walk(MARKETING_ROOT)) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/<(h1|h2)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      const { text, readable } = jsxText(m[2]);
      const name = rel(file);
      if (!readable) {
        found.push({ file: name, tag: m[1], text, why: "unreadable (an expression)" });
        continue;
      }
      const n = headingWordCount(text);
      if (n > HEADING_WORD_CAP) {
        found.push({ file: name, tag: m[1], text, why: `${n} words, cap ${HEADING_WORD_CAP}` });
      }
      const lower = text.toLowerCase();
      for (const word of BANNED_WORDS) {
        if (new RegExp(`\\b${word}\\b`, "i").test(lower)) {
          found.push({ file: name, tag: m[1], text, why: `banned word "${word}"` });
        }
      }
      for (const mark of BANNED_MARKS) {
        if (text.includes(mark)) {
          found.push({ file: name, tag: m[1], text, why: `banned mark "${mark}"` });
        }
      }
    }
  }
  return found;
}

function countByFile(findings: HeadingFinding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.file] = (counts[f.file] ?? 0) + 1;
  return counts;
}

function homeHero(): string {
  const src = fs.readFileSync(path.join(MARKETING_ROOT, "page.tsx"), "utf8");
  const start = src.indexOf('<section className="glass-hero');
  const end = src.indexOf("</section>", start);
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, end);
}

describe("W0 one look: the home hero", () => {
  it("O1 pins the H1 exactly", () => {
    const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(homeHero());
    expect(h1).not.toBeNull();
    const { text, readable } = jsxText(h1![1]);
    expect(readable).toBe(true);
    expect(text).toBe(HERO_H1);
  });

  it("pins the subline exactly (one sentence, 12 words)", () => {
    const sub = /<\/h1>\s*<p\b[^>]*>([\s\S]*?)<\/p>/.exec(homeHero());
    expect(sub).not.toBeNull();
    const { text, readable } = jsxText(sub![1]);
    expect(readable).toBe(true);
    expect(text).toBe(HERO_SUBLINE);
    expect(wordsOf(text).length).toBeLessThanOrEqual(12);
  });

  it("has one filled button and one text link, and the old kicker, audience line and AI link are gone", () => {
    const hero = homeHero();
    expect(hero).toContain("{DEMO_CTA}");
    expect(hero).toContain(HERO_LINK);
    expect(hero).not.toMatch(/<Eyebrow>/);
    expect(hero).not.toContain("hero-assurance");
    expect(hero).not.toContain("hero-ai-link");
  });

  it("O3 says nothing about a trial, free or a price (the trial is not real until W1)", () => {
    const hero = homeHero().replace(/className="[^"]*"/g, "");
    expect(hero).not.toMatch(/\b(trial|free|price|prices|pricing)\b|[$€£]\d/i);
  });
});

describe("W0 one look: one name for the call button (O2)", () => {
  it("DEMO_CTA is the one label constant", () => {
    expect(DEMO_CTA).toBe(HERO_BUTTON);
    expect(wordsOf(DEMO_CTA).length).toBeLessThanOrEqual(4);
  });

  it("the label text exists in lib/site.ts only: every other file uses the constant", () => {
    const hits: string[] = [];
    for (const file of walk(MARKETING_ROOT)) {
      if (rel(file) === "lib/site.ts") continue;
      if (fs.readFileSync(file, "utf8").includes("Book a video call")) hits.push(rel(file));
    }
    expect(hits).toEqual([]);
  });

  it("no label or sentence says 'book a ... demo' or 'in a demo' (class three, A-2)", () => {
    // FAQ question at faq.tsx is W6's to remove; it is the only line allowed to stay.
    const hits: string[] = [];
    for (const file of [...walk(MARKETING_ROOT), path.join(MARKETING_ROOT, "lib", "site.ts")]) {
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/book an? [\w ]*demo|in a demo|see it in a demo/i.test(line)) {
            hits.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(hits.filter((h) => !h.startsWith("components/faq.tsx"))).toEqual([]);
  });
});

describe("W0 one look: headings (ratchet to W7)", () => {
  const findings = headingFindings();
  const counts = countByFile(findings);

  it("no file has more unclean headings than ALLOWED_UNTIL_W7 allows", () => {
    const over = Object.entries(counts)
      .filter(([file, n]) => n > (ALLOWED_UNTIL_W7[file] ?? 0))
      .map(([file, n]) => `${file}: ${n} found, ${ALLOWED_UNTIL_W7[file] ?? 0} allowed`);
    expect(over).toEqual([]);
  });

  it("the allowance only falls: lower an entry the moment its file gets cleaner", () => {
    const stale = Object.entries(ALLOWED_UNTIL_W7)
      .filter(([file, n]) => (counts[file] ?? 0) < n)
      .map(([file, n]) => `${file}: ${counts[file] ?? 0} found, ${n} allowed. Lower it.`);
    expect(stale).toEqual([]);
  });

  it("the home hero H1 is always clean", () => {
    expect(findings.filter((f) => f.file === "page.tsx" && f.tag === "h1")).toEqual([]);
  });
});
