/** WP6 fix round 1: renderer/CSS regressions found in Opus review. */
import * as fs from "fs";
import * as path from "path";

/* eslint-disable @typescript-eslint/no-explicit-any */
const R: any = () => require("../src/render/page");
const P: any = () => require("../src/render/panels");
const NOW = "2026-01-12T10:00:00Z";
const base = (): any =>
  JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/acme/state.json"), "utf8"));
const render = (s: any, o: any = {}) => R().renderPage(s, { now: NOW, ...o }) as string;
const css = fs.readFileSync(path.join(__dirname, "../src/render/assets/styles.css"), "utf8");
const panel = (h: string, k: string) =>
  h.slice(h.indexOf(`data-panel="${k}"`), h.indexOf("</section>", h.indexOf(`data-panel="${k}"`)));
const text = (h: string) => h.replace(/<[^>]+>/g, " ");

describe("H1 superseded button carries only the first PR number", () => {
  it('"PR #12 + #34" gives data-pr="12"', () => {
    const s = base();
    s.waste = [{ key: "W2:12", rule: "W2", subject: "PR #12 + #34", why: "x", action: "Ack" }];
    const h = render(s);
    expect(h).toContain('data-act="superseded" data-pr="12"');
    expect(h).not.toContain('data-pr="1234"');
  });
});

describe("H2 overlap list is hidden only when a matrix is present", () => {
  it("css hides .ov-list via the sibling selector only", () => {
    expect(css).toMatch(/\.ov-matrix\s*\+\s*\.ov-list\s*\{[^}]*display:\s*none/);
    expect(css).not.toMatch(/(^|\n)\s*\.ov-list\s*\{[^}]*display:\s*none/);
  });
  it("3 working lanes with a HOT pair render the list and no matrix", () => {
    const h = render(base());
    const o = panel(h, "overlap");
    expect(o).toContain("ov-list");
    expect(o).not.toContain("ov-matrix");
  });
  it("5 working lanes render the matrix immediately followed by the list", () => {
    const s = base();
    for (const n of ["a", "b", "c"]) {
      s.lanes[`lane-${n}`] = { ...s.lanes["lane-u"], id: `lane-${n}`, name: `lane-${n}` };
    }
    s.lanes["lane-idle"].current = { ...s.lanes["lane-u"].current, value: "F-3" };
    const o = panel(render(s), "overlap");
    expect(o).toMatch(/ov-matrix[\s\S]*<\/div><ul class="rows ov-list"/);
  });
});

describe("LOW renderer items", () => {
  it("h2 is not inside a summary; folds use a plain summary label", () => {
    const h = render(base());
    expect(h).not.toMatch(/<summary[^>]*>\s*<h2/);
    expect(h).toMatch(/<h2 id="h-prs"[\s\S]*<details class="fold"[^>]*><summary>/);
  });
  it("badge() escapes register values exactly once", () => {
    const s = base();
    s.tasks["F-2"].ref.register.release = "a&b";
    const h = render(s);
    expect(h).toContain('title="register: a&amp;b"');
    expect(h).not.toContain("a&amp;amp;b");
  });
  it("timeline verbs use own properties only", () => {
    const s = base();
    s.timeline[0].type = "constructor";
    const t = panel(render(s), "timeline");
    expect(t).toContain("constructor");
    expect(t).not.toMatch(/function|native code/);
  });
  it("a task with no priority renders an empty data-priority", () => {
    const s = base();
    s.tasks["F-3"].priority = { value: "", source: "register", ref: null };
    expect(render(s)).toContain('data-priority=""');
  });
});

describe("design round", () => {
  it("queue action is an icon-only star with the aria-label", () => {
    const q = panel(render(base()), "queue");
    expect(q).toMatch(/aria-label="Set F-2 as next">★<\/button>/);
  });
  it("queue table cells show only the pencil glyph; full text lives in title", () => {
    const q = panel(render(base()), "queue");
    expect(q).toContain("✎");
    expect(text(q)).not.toMatch(/overridden/);
    expect(q).toMatch(/title="[^"]*overridden · owner#3/);
  });
  it("768 queue shows exactly 5 columns (others are c-opt)", () => {
    const q = panel(render(base()), "queue");
    const head = q.slice(q.indexOf("<thead"), q.indexOf("</thead>"));
    const cols = [...head.matchAll(/<th scope="col"([^>]*)>/g)].filter(
      (m) => !m[1].includes("c-opt"),
    );
    expect(cols).toHaveLength(5);
  });
  it("css: nowrap on buttons and table badges; >=1400 gives queue a wide track, PRs a full row", () => {
    expect(css).toMatch(/\.btn[^{]*\{[^}]*white-space:\s*nowrap/);
    expect(css).toMatch(/\.tbl \.badge[^{]*\{[^}]*white-space:\s*nowrap/);
    const i = css.indexOf("@media (min-width: 1400px)");
    const block = css.slice(i, css.indexOf("@media", i + 10));
    expect(block).not.toMatch(/\.p-prs/);
    expect(block).not.toMatch(/\.p-queue/);
    expect(css).toMatch(/\.p-queue\s*\{[^}]*grid-column:\s*1 \/ 8/);
  });
});

describe("drawer wiring attributes", () => {
  it("piggyback Assign carries the task's previous lane", () => {
    const s = base();
    s.tasks["B906"].lane = { value: "lane-b", source: "register", ref: null };
    expect(panel(render(s), "piggyback")).toContain('data-prev-lane="lane-b"');
  });
  it("drawer knows each lane's current next and the task alt values as text", () => {
    const h = render(base());
    expect(h).toMatch(/id="drawer"[^>]*data-nexts="[^"]*lane-u:F-2/);
    expect(h).toMatch(/data-task="F-2"[^>]*data-alt="[^"]*register: R1/);
  });
  it("hostile alt text stays escaped", () => {
    const s = base();
    s.tasks["F-2"].release.ref = '"><script>x</script>';
    const h = render(s);
    expect(h).not.toContain("<script>x");
  });
});

describe("fragments still embedded", () => {
  it("renderFragments keys unchanged", () => {
    expect(Object.keys(P().renderFragments(base(), { now: NOW })).length).toBe(12);
  });
});

describe("round 2: lookup maps and fold names", () => {
  it('inherited keys like "constructor" fall back instead of leaking Object members', () => {
    const s = base();
    s.tasks["F-1"].status.value = "constructor";
    s.tasks["F-1"].priority.value = "constructor";
    s.tasks["B906"].ref.severity = "constructor";
    s.prs[0].ci = "constructor";
    s.lanes["lane-u"].stale.value = "constructor";
    s.piggyback["lane-u"][0].severity = "constructor";
    const h = render(s);
    expect(h).not.toMatch(/function|native code|\[object/);
    expect(h).toContain("CI ? constructor");
    expect(h).toMatch(/pill low"><span aria-hidden="true">·<\/span> constructor/);
  });
  it("each folded panel summary has a unique Show/hide <title> name", () => {
    const h = render(base());
    const names = [...h.matchAll(/<summary>(Show\/hide [^<]+)<\/summary>/g)].map((m) => m[1]);
    expect(names).toContain("Show/hide Open PRs");
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(5);
  });
});
