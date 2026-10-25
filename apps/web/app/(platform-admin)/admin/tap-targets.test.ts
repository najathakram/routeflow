/**
 * Lane B A3 F7 — the platform-admin console's phone/tablet tap-target floor (audit 2026-09-20: nav
 * menu button, "+ Create tenant", "View all", row actions all under 40 px at <= 768 px). A static net
 * that asserts the REQUIREMENT, not the CSS text or a count of matching elements:
 *   1. the floor is enforced by rules scoped to `.surface-admin` inside a `max-width: 768px` media
 *      query (768, not 767: iPad portrait), giving every <button> and each link class a min-height of
 *      at least 40 px, and an icon-only button a min-width of at least 40 px;
 *   2. every link in the admin tree chooses ONE tap behaviour by class: `admin-tap` (a boxed link),
 *      `admin-tap-text` (a standalone text link) or `admin-inline` (inside a sentence, exempt), so a
 *      new link cannot silently miss the floor;
 *   3. the admin layout root carries `.surface-admin`, the scope the rules key on.
 * #1114 v2: the rules live in their OWN stylesheet (`admin-tap-targets.css`, imported by
 * `layout.tsx`), not `globals.css` — an admin-only floor has no reason to ship to every
 * non-admin page, and globals.css stays byte-identical to the marketing-port migration's pinned
 * baseline (MKT-PIN T7) either way.
 * Browser measurement is the prover's job (PROOF-REQ), not this file's.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "..");
const adminCss = fs.readFileSync(path.join(ROOT, "admin-tap-targets.css"), "utf8");

/** The rules inside every `@media (max-width: 768px) { ... }` block, as { selectors, declarations }. */
function rulesAt768(source: string): Array<{ selectors: string[]; body: string }> {
  const out: Array<{ selectors: string[]; body: string }> = [];
  const media = /@media\s*\(\s*max-width:\s*768px\s*\)\s*\{/g;
  for (const m of source.matchAll(media)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
    }
    const inner = source.slice(start, i - 1);
    for (const r of inner.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      out.push({
        selectors: r[1].split(",").map((s) => s.replace(/\s+/g, " ").trim()),
        body: r[2],
      });
    }
  }
  return out;
}

/** The largest px value a rule set declares for `prop` on `selector` (0 if none). */
function px(rules: ReturnType<typeof rulesAt768>, selector: string, prop: string): number {
  return Math.max(
    0,
    ...rules
      .filter((r) => r.selectors.includes(selector))
      .flatMap((r) => [...r.body.matchAll(new RegExp(`${prop}:\\s*(\\d+(?:\\.\\d+)?)px`, "g"))])
      .map((m) => Number(m[1])),
  );
}

describe("platform-admin tap targets (F7): the requirement", () => {
  const rules = rulesAt768(adminCss);

  it("globals.css does NOT carry the admin tap-target rules — they live in their own stylesheet", () => {
    const APP = path.join(ROOT, "..");
    const globalsCss = fs.readFileSync(path.join(APP, "globals.css"), "utf8");
    expect(rulesAt768(globalsCss).some((r) => r.selectors.includes(".surface-admin button"))).toBe(
      false,
    );
  });

  it("at <= 768 px every admin button and each admin link class has a min-height of at least 40 px, all scoped to .surface-admin", () => {
    for (const sel of [
      ".surface-admin button",
      ".surface-admin .admin-tap",
      ".surface-admin .admin-tap-text",
    ]) {
      expect({ sel, minHeight: px(rules, sel, "min-height") >= 40 }).toEqual({
        sel,
        minHeight: true,
      });
    }
    // nothing at this breakpoint reaches outside the admin surface
    const unscoped = rules
      .flatMap((r) => r.selectors)
      .filter((s) => s && !s.startsWith(".surface-admin"));
    expect(unscoped.filter((s) => /button|admin-tap/.test(s))).toEqual([]);
  });

  it("an icon-only admin button is at least 40 px wide too", () => {
    expect(
      px(rules, ".surface-admin button:has(> svg:only-child)", "min-width"),
    ).toBeGreaterThanOrEqual(40);
  });

  it("a boxed link is laid out so the height floor applies and its label stays centred", () => {
    const boxed = rules.filter((r) => r.selectors.includes(".surface-admin .admin-tap"));
    expect(
      boxed.some((r) => /display:\s*flex/.test(r.body) && /align-items:\s*center/.test(r.body)),
    ).toBe(true);
    const text = rules.filter((r) => r.selectors.includes(".surface-admin .admin-tap-text"));
    expect(
      text.some(
        (r) => /display:\s*inline-flex/.test(r.body) && /align-items:\s*center/.test(r.body),
      ),
    ).toBe(true);
  });

  it("the admin layout root is the .surface-admin scope", () => {
    expect(fs.readFileSync(path.join(ROOT, "layout.tsx"), "utf8")).toContain("surface-admin");
  });
});

// ── every link picks a behaviour ────────────────────────────────────────────────────────────────
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Opening `<tag ...>` texts, skipping `{...}` expressions and quoted strings (both may contain `>`). */
function openingTags(src: string, tag: string): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  for (const m of src.matchAll(new RegExp(`<${tag}(?=[\\s>/])`, "g"))) {
    const start = m.index ?? 0;
    let i = start + m[0].length;
    let depth = 0;
    let quote: string | null = null;
    for (; i < src.length; i++) {
      const c = src[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth = Math.max(0, depth - 1);
      else if (c === ">" && depth === 0) break;
    }
    out.push({ text: src.slice(start, i + 1), line: src.slice(0, start).split("\n").length });
  }
  return out;
}

describe("platform-admin links choose a tap behaviour (F7)", () => {
  const CHOICES = /\b(admin-tap|admin-tap-text|admin-inline)\b/;
  const files = walk(ROOT).map((f) => ({
    rel: path.relative(ROOT, f),
    src: fs.readFileSync(f, "utf8"),
  }));

  it("every <a> and <Link> carries admin-tap, admin-tap-text or admin-inline", () => {
    const bad = files.flatMap((f) =>
      [...openingTags(f.src, "a"), ...openingTags(f.src, "Link")]
        .filter((t) => !CHOICES.test(t.text))
        .map((t) => `${f.rel}:${t.line}`),
    );
    expect(bad).toEqual([]);
  });

  it("no link opts in through a size guess (the old attribute selectors and per-element max-[768px] utilities are gone)", () => {
    expect(adminCss).not.toMatch(/\[class\*="rounded"\]/);
    expect(adminCss).not.toMatch(/\[class\*="hidden"\]/);
    const stray = files
      .filter((f) => /max-\[768px\]:(?:inline-flex|min-h-10)/.test(f.src))
      .map((f) => f.rel);
    expect(stray).toEqual([]);
  });

  it("the scan really sees links (a scanner that finds none would pass vacuously)", () => {
    const total = files.reduce(
      (n, f) => n + openingTags(f.src, "a").length + openingTags(f.src, "Link").length,
      0,
    );
    expect(total).toBeGreaterThan(20);
    expect(openingTags('<Link href="/x" className="admin-tap">', "Link")).toHaveLength(1);
    expect(CHOICES.test('<Link href="/x" className="text-xs">')).toBe(false);
    expect(CHOICES.test('<Link className="admin-inline text-xs">')).toBe(true);
  });
});
