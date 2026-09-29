/**
 * Lane B A3 (backoffice audit) — regression net for the axe findings on the platform-admin
 * console: unlabelled selects / checkboxes / inputs / textareas (critical), the icon-only reveal
 * toggles and back link, and horizontal scrollers no keyboard can reach.
 *
 * A visible <label> sitting NEXT to a control does not name it unless it is associated — that was
 * the whole bug. A control counts as named when it has a non-empty `aria-label`, an
 * `aria-labelledby`, an `id` that some `<label htmlFor>` in the same file points at, or it is the
 * first labelable control nested inside an open `<label>`. A placeholder is NOT a name (it vanishes
 * on input; axe reports `label-title-only`). Static scan of the sources — no browser needed.
 */
import * as fs from "fs";
import * as path from "path";

// `(platform-admin)/` — the admin pages AND the shared `_components` (AdminModal, AdminTabs, …).
const ROOT = path.join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    // .ts too: class-name maps (a badge colour table) live in plain .ts and carry text colours the
    // contrast guard must see; the JSX scans below simply find no tags in a .ts file.
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts"))
      out.push(p);
  }
  return out;
}

interface Tag {
  text: string;
  line: number;
  index: number;
}

/** Opening tags of `<tag …>`: scans to the closing `>` while skipping `{…}` expressions and quoted
 *  strings (both contain `>` — `=>` arrows, `a > b`) that a naive regex would stop at. */
function openingTags(src: string, tag: string): Tag[] {
  const out: Tag[] = [];
  const re = new RegExp(`<${tag}(?=[\\s>/])`, "g");
  for (const m of src.matchAll(re)) {
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
    out.push({
      text: src.slice(start, i + 1),
      line: src.slice(0, start).split("\n").length,
      index: start,
    });
  }
  return out;
}

const files = walk(ROOT).map((f) => ({
  rel: path.relative(ROOT, f),
  src: fs.readFileSync(f, "utf8"),
}));

/** Nested in an open <label> and no other labelable control sits between the label and it. */
function firstInOpenLabel(src: string, idx: number): boolean {
  const open = src.lastIndexOf("<label", idx);
  if (open === -1 || open < src.lastIndexOf("</label>", idx)) return false;
  return !/<(input|select|textarea|button)\b/.test(src.slice(open, idx));
}

function isNamed(f: { src: string }, t: Tag): boolean {
  if (/(?<![\w-])aria-label=(?!"\s*")(?!\{""\})/.test(t.text)) return true;
  if (/(?<![\w-])aria-labelledby=/.test(t.text)) return true;
  const id = /(?<![\w-])id="([^"]+)"/.exec(t.text)?.[1];
  if (id && f.src.includes(`htmlFor="${id}"`)) return true;
  return firstInOpenLabel(f.src, t.index);
}

const unnamed = (tag: string, keep: (t: Tag) => boolean = () => true) =>
  files.flatMap((f) =>
    openingTags(f.src, tag)
      .filter((t) => keep(t) && !isNamed(f, t))
      .map((t) => `${f.rel}:${t.line}`),
  );

const NON_TEXT = /type="(hidden|submit|button|reset|radio|image)"/;

describe("platform-admin a11y — controls carry an accessible name (A3 F1/F2/F3)", () => {
  it("every <select> is named", () => expect(unnamed("select")).toEqual([]));
  it("every <textarea> is named", () => expect(unnamed("textarea")).toEqual([]));
  it("every <input> is named (a placeholder is not a name; radios are named by their label text)", () =>
    expect(unnamed("input", (t) => !NON_TEXT.test(t.text))).toEqual([]));

  it("the password / API-key reveal toggles are named and reachable by keyboard", () => {
    const toggles = files.flatMap((f) =>
      openingTags(f.src, "button")
        .filter(
          (t) => /set(ShowPw|ShowKey)\(/.test(t.text) || /absolute right-3 top-1\/2/.test(t.text),
        )
        .map((t) => ({ ...t, f })),
    );
    expect(toggles.length).toBeGreaterThanOrEqual(2);
    for (const t of toggles) {
      expect(isNamed(t.f, t)).toBe(true);
      expect(/tabIndex=\{-1\}/.test(t.text)).toBe(false); // tabindex=-1 made them unreachable
    }
  });

  it("the merge-requests back link (icon only) is named", () => {
    const f = files.find(
      (x) => x.rel === path.join("admin", "buyers", "merge-requests", "page.tsx"),
    )!;
    const back = /<Link[^>]*href="\/admin\/buyers"[^>]*>/.exec(f.src)![0];
    expect(back).toMatch(/aria-label=/);
  });

  // axe `scrollable-region-focusable`: a horizontal scroller with nothing focusable inside is a
  // keyboard dead end. It needs tabIndex=0 (+ a role and name so it announces); a scroller that
  // contains its own controls passes without one and is listed here with the reason.
  const SCROLLERS_WITH_OWN_CONTROLS = new Set([
    path.join("admin", "plans", "page.tsx"), // price inputs in every row
    path.join("admin", "tenants", "page.tsx"), // row checkboxes + links
    path.join("_components", "AdminTabs.tsx"), // the tab strip: the tab buttons are focusable
    path.join("admin", "buyers", "[id]", "page.tsx"), // its overflow-x-auto is a tab strip (buttons)
  ]);
  it("every overflow-x-auto scroller is keyboard-reachable or holds its own controls", () => {
    const bad = files.flatMap((f) =>
      openingTags(f.src, "div")
        .filter((t) => /\boverflow-x-auto\b/.test(t.text))
        .filter((t) => !/tabIndex=\{0\}/.test(t.text) && !SCROLLERS_WITH_OWN_CONTROLS.has(f.rel))
        .map((t) => `${f.rel}:${t.line}`),
    );
    expect(bad).toEqual([]);
  });

  it("the scanner itself: skips `>` inside strings/braces and only trusts a real name", () => {
    const tag = (s: string) => openingTags(s, "select")[0];
    expect(tag('<select placeholder="a > b" aria-label="Real">x').text).toContain("Real");
    expect(tag("<select onChange={(e) => go(e)} aria-label='X'>").text).toContain("aria-label");
    const f = (src: string) => ({ src });
    expect(isNamed(f("<select>"), tag("<select>"))).toBe(false);
    expect(isNamed(f('<select aria-label="">'), tag('<select aria-label="">'))).toBe(false);
    expect(isNamed(f('<select data-test-id="x">'), tag('<select data-test-id="x">'))).toBe(false);
    expect(isNamed(f('<select id="a">'), tag('<select id="a">'))).toBe(false); // orphan id
    expect(
      isNamed(f('<label htmlFor="a"/><select id="a">'), tag('<label htmlFor="a"/><select id="a">')),
    ).toBe(true);
    const wrapped = "<label>Name <input/><select>";
    expect(isNamed(f(wrapped), openingTags(wrapped, "select")[0])).toBe(false); // only the FIRST control is named
  });

  // axe `color-contrast`: #64748b (slate-500) on the slate-800 cards is 3.07:1 and #475569
  // (slate-600) is 1.93:1 — both below WCAG AA's 4.5:1 for body text. Secondary text on this dark
  // console is slate-400 (5.7:1) or lighter; a new slate-500/600 text colour would bring back the
  // ~130 failing nodes the A3 audit found on every page.
  it("the contrast scan covers plain .ts colour tables, not only .tsx (badge.ts once slipped past it)", () => {
    expect(files.some((f) => f.rel.endsWith("badge.ts"))).toBe(true);
    expect(files.some((f) => /\.test\.tsx?$/.test(f.rel))).toBe(false);
  });

  it("no text-slate-500 / text-slate-600 text colour (fails AA on the dark console surfaces)", () => {
    const bad = files.flatMap((f) =>
      f.src
        .split("\n")
        .map((l, i) => ({ l, n: i + 1 }))
        .filter(({ l }) => /(?<![\w:-])text-slate-(500|600)\b/.test(l))
        .map(({ n }) => `${f.rel}:${n}`),
    );
    expect(bad).toEqual([]);
  });

  // A3 F8: a control disabled for a reason the user cannot see. Each site below renders a
  // <DisabledHint id="X"> and points the control's aria-describedby at the same id, in the same
  // file. (The other ~60 `disabled` sites are pending-state or pagination bounds: self-evident.)
  const REASONED_DISABLED: Array<[string, string]> = [
    [path.join("admin", "tenants", "[id]", "page.tsx"), "feature-override-hint"],
    [
      path.join("admin", "tenants", "[id]", "_features", "ConfigSnapshotsTab.tsx"),
      "restore-nothing-hint",
    ],
    [
      path.join("admin", "tenants", "[id]", "_features", "PreviewDrawer.tsx"),
      "preview-empty-reason",
    ],
    [path.join("admin", "buyers", "merge-requests", "[id]", "page.tsx"), "mr-notes-hint"],
    [path.join("admin", "settings", "page.tsx"), "test-connection-hint"],
    [path.join("admin", "billing", "page.tsx"), "export-csv-hint"],
  ];
  it.each(REASONED_DISABLED)("%s explains why a control is disabled (%s)", (rel, id) => {
    const f = files.find((x) => x.rel === rel);
    expect(f).toBeDefined();
    expect(f!.src).toContain(`aria-describedby={`); // some control is described
    expect(f!.src).toContain(`"${id}"`); // by this id
    const declared = new RegExp(`(<DisabledHint\\s+id="${id}"|\\bid="${id}")`).test(f!.src);
    expect({ rel, id, declared }).toEqual({ rel, id, declared: true });
  });

  // A3 F9: an error banner must be announced. The red banner pattern of the console
  // (`bg-red-900/40 … text-red-400`) has to carry role="alert".
  it("every red error banner div carries role=alert", () => {
    const bad = files.flatMap((f) =>
      openingTags(f.src, "div")
        .filter((t) => /bg-red-900\/40/.test(t.text) && /text-red-400/.test(t.text))
        .filter((t) => !/role="alert"/.test(t.text))
        .map((t) => `${f.rel}:${t.line}`),
    );
    expect(bad).toEqual([]);
  });
});
