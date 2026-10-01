/**
 * WP6 T24 / T25 / T27 (+ R13 panel order, R34 semantics): renderPage is pure, escaped, CSP-safe.
 * Renderer modules are `require`d as `any` so a missing module fails each test on its own.
 * Assumed contract: renderPage(state, { now, local?, loading? }) -> string; every panel is
 * `<section data-panel="<key>"><h2>..</h2>..</section>` with keys in PANELS order; header lines are
 * `data-line="now|release|broken|waste"` (keys fixed, labels in plain words, an attention headline
 * `<p class="attn">` first); a colored word carries `data-tone="risk|crit|warn|ok"`.
 * Plain-language pass (2026-09-30): the wording below is the owner-facing copy; plain-language.spec.ts
 * pins the cross-cutting rules (no codes, no shorthand).
 */
import * as fs from "fs";
import * as path from "path";

/* eslint-disable @typescript-eslint/no-explicit-any */
const R: any = () => require("../src/render/page");
const P: any = () => require("../src/render/panels");
const E: any = () => require("../src/render/esc");

const NOW = "2026-01-12T10:00:00Z";
const base = (): any =>
  JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/acme/state.json"), "utf8"));
const render = (s: any, o: any = {}) => R().renderPage(s, { now: NOW, ...o }) as string;

export const PANELS = [
  "lanes",
  "blockers",
  "waste",
  "release",
  "queue",
  "bugs",
  "prs",
  "overlap",
  "piggyback",
  "phases",
  "timeline",
  "sources",
];
const HEADINGS = [
  "Who is doing what",
  "Stuck work",
  "Work at risk of being wasted",
  "Releases",
  "Up next",
  "Bugs",
  "Open pull requests",
  "Lanes touching the same files",
  "Quick wins nearby",
  "Feature progress",
  "Recent activity",
  "Where this data comes from",
];
const XSS = "<script>alert(1)</script>";
const ATTR = 't"onmouseover="alert(1)';

describe("T24 determinism and self-containment", () => {
  it("renders byte-identical html twice for the same state", () => {
    const s = base();
    expect(render(s)).toBe(render(JSON.parse(JSON.stringify(s))));
  });
  it("links only same-origin assets and carries the control-version meta", () => {
    const h = render(base());
    const urls = [...h.matchAll(/\s(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u.startsWith("/") || u.startsWith("#")).toBe(true);
    expect(h).not.toMatch(/(?:src|href)="https?:\/\//);
    expect(h).toContain('<link rel="stylesheet" href="/assets/styles.css"');
    expect(h).toContain('src="/assets/client.js"');
    expect(h).toMatch(/<meta name="control-version" content="9f3a1c0d5e7b"\s*\/?>/);
  });
  it("stays under 400 KB for 817 bugs + 100 PRs", () => {
    const s = base();
    const t = s.tasks.B906;
    for (let i = 0; i < 817; i++)
      s.tasks[`B${2000 + i}`] = { ...t, id: `B${2000 + i}`, title: `Acme generated bug ${i}` };
    const pr = s.prs[0];
    s.prs = Array.from({ length: 100 }, (_, i) => ({ ...pr, pr: 3000 + i, title: `Acme pr ${i}` }));
    expect(Buffer.byteLength(render(s))).toBeLessThanOrEqual(400 * 1024);
  });
});

describe("esc()", () => {
  it("escapes the five html-significant characters", () => {
    expect(E().esc(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });
  it("is total: null/undefined/number never throw", () => {
    expect(E().esc(null)).toBe("");
    expect(E().esc(undefined)).toBe("");
    expect(E().esc(42)).toBe("42");
  });
});

describe("T25 every dynamic string is escaped", () => {
  const hostile = (): any => {
    const s = base();
    s.tasks["F-1"].title = XSS + ATTR;
    s.tasks["F-3"].title = XSS + ATTR; // queue row
    s.tasks["F-2"].title = XSS + ATTR; // lane next
    s.prs[0].title = XSS + ATTR;
    s.prs[0].headRef = ATTR;
    s.lanes["lane-u"].blockers = [{ task: "F-1", reason: XSS + ATTR, ref: "lane-u#1" }];
    s.waste[0].why = XSS + ATTR;
    s.warnings = [{ lane: "lane-b", seq: 14, reason: XSS + ATTR }];
    s.timeline[0].by = XSS + ATTR;
    s.timeline[0].lane = XSS + ATTR; // the timeline actor is a lane name
    s.lanes["lane-b"].name = XSS + ATTR; // lane names land in text AND aria-labels / titles
    s.lanes["lane-b"].machine = XSS + ATTR;
    s.overlap[0].source = XSS + ATTR;
    return s;
  };
  it("emits no raw <script> apart from the one external client include", () => {
    const h = render(hostile());
    expect(h).not.toContain("<script>alert");
    expect(h).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/); // no inline script at all (CSP script-src 'self')
    expect(h).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
  it("never lets a quote break out of an attribute", () => {
    const h = render(hostile());
    expect(h).not.toContain('"onmouseover=');
    expect(h).toContain("&quot;onmouseover=&quot;alert(1)");
  });
  it("fragments escape too", () => {
    const f = P().renderFragments(hostile(), { now: NOW });
    const all = Object.values(f).join("");
    expect(all).not.toContain("<script>alert");
    expect(all).not.toContain('"onmouseover=');
  });
});

describe("CSP-friendly markup", () => {
  it("has no inline event handler attributes", () => {
    const h = render(base()).replace(/"[^"]*"/g, '""');
    expect(h).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
    expect(render(base())).not.toMatch(/javascript:/i);
  });
  it("has no inline script body and styles only via the stylesheet or style attributes", () => {
    const h = render(base());
    const scripts = [...h.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBe(1);
    expect(scripts[0][1]).toContain('src="/assets/client.js"');
    expect(scripts[0][2].trim()).toBe("");
  });
});

describe("R13 panels and hierarchy", () => {
  it("renders the 12 panels in ux-spec order, each with one h2", () => {
    const h = render(base());
    const keys = [...h.matchAll(/data-panel="([a-z-]+)"/g)].map((m) => m[1]);
    expect(keys).toEqual(PANELS);
    const h2 = [...h.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) =>
      m[1].replace(/<[^>]+>/g, ""),
    );
    expect(h2).toHaveLength(12);
    HEADINGS.forEach((t, i) => expect(h2[i].trim().slice(0, t.length)).toBe(t));
  });
  it("has landmarks and exactly one h1", () => {
    const h = render(base());
    expect((h.match(/<h1[\s>]/g) ?? []).length).toBe(1);
    for (const tag of ["header", "main", "nav", "footer"]) expect(h).toContain(`<${tag}`);
    expect(h).toContain('aria-live="polite"');
    expect(h).toMatch(/<html[^>]*\slang="en"/);
  });
  it("header is an attention headline then four labelled lines in order", () => {
    const h = render(base());
    const head = h.slice(h.indexOf("<header"), h.indexOf("</header>"));
    const rows = [...head.matchAll(/data-line="([a-z]+)"[^>]*><span class="lbl">([^<]+)<\/span>/g)];
    expect(rows.map((m) => [m[1], m[2]])).toEqual([
      ["now", "Lanes"],
      ["release", "Next release"],
      ["broken", "Bugs"],
      ["waste", "Work at risk"],
    ]);
    const attn = head.indexOf('<p class="attn" data-level="');
    expect(attn).toBeGreaterThan(-1);
    expect(attn).toBeLessThan(head.indexOf('data-line="now"'));
    expect(head).not.toMatch(/<p class="attn"[^>]*data-line=/); // a headline, not a fifth status row
  });
  it("colors at most one word per header line", () => {
    const h = render(base());
    const head = h.slice(h.indexOf("<header"), h.indexOf("</header>"));
    const lines = head.split(/(?=data-line=")/).slice(1);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const l of lines) expect((l.match(/data-tone="/g) ?? []).length).toBeLessThanOrEqual(1);
  });
  it("lane board shows current then next and the PR chip", () => {
    const h = render(base());
    const lanes = h.slice(h.indexOf('data-panel="lanes"'), h.indexOf('data-panel="blockers"'));
    const cur = lanes.indexOf("F-1");
    expect(cur).toBeGreaterThan(-1);
    expect(lanes.indexOf("F-2")).toBeGreaterThan(cur);
    expect(lanes.indexOf("Doing now")).toBeLessThan(cur);
    expect(lanes.indexOf("Next up")).toBeGreaterThan(cur);
    expect(lanes).toContain("PR #2801 · Checks passed · Ready to merge");
    expect(lanes).toContain("lane-u");
  });
  it("tables use th scope", () => {
    const h = render(base());
    expect(h).toMatch(/<table[\s\S]*<th scope="(?:col|row)"/);
    for (const m of h.matchAll(/<th(?![a-z])([^>]*)>/g)) expect(m[1]).toContain("scope=");
  });
  it("queue lists at most 10 rows", () => {
    const s = base();
    for (let i = 0; i < 25; i++)
      s.tasks[`F-${50 + i}`] = { ...s.tasks["F-3"], id: `F-${50 + i}`, title: `Acme queued ${i}` };
    const h = render(s);
    const q = h.slice(h.indexOf('data-panel="queue"'), h.indexOf('data-panel="bugs"'));
    expect((q.match(/<tr[\s>]/g) ?? []).length).toBeLessThanOrEqual(11); // header row + 10
  });
});

describe("empty states (panels never removed)", () => {
  it("renders every panel with its empty copy", () => {
    const s = base();
    Object.assign(s, { tasks: {}, lanes: {}, releases: {}, prs: [], branches: [], waste: [] });
    Object.assign(s, { overlap: [], piggyback: {}, timeline: [], warnings: [] });
    const h = render(s);
    expect([...h.matchAll(/data-panel="([a-z-]+)"/g)].map((m) => m[1])).toEqual(PANELS);
    for (const copy of [
      "No lanes yet. A lane appears when a Claude session registers it with the ctl tool.",
      "Nothing is stuck.",
      "Nothing at risk — every open pull request is moving.",
      "No releases yet — add one in",
      "Nothing waiting — every planned task is already taken.",
      "No open bugs.",
      "No open pull requests.",
      "No lanes are changing the same files.",
      "No quick wins near current work.",
      "No features are being built right now.",
      "No activity yet. Changes appear here as lanes report them.",
    ])
      expect(h).toContain(copy);
  });
});

describe("T27 badges (R14)", () => {
  it("shows an overridden release as 'Changed by you' with the register value in title", () => {
    const h = render(base());
    expect(h).toContain('<span aria-hidden="true">✎</span> Changed by you');
    expect(h).toContain('title="register: R1 · owner#3"');
    expect(h).toMatch(/R2[\s\S]{0,400}Changed by you|Changed by you[\s\S]{0,400}R2/);
  });
  it("shows the out-of-date records chip when inferred status differs from the register", () => {
    const h = render(base());
    expect(h).toContain("Out of date records: 1");
    expect(h).toContain("The register file and GitHub disagree about these:");
    expect(h).toContain("now code finished (register file says planned)");
    expect(h).toMatch(/<span class="badge inf" title="#2801">/); // the ref moved into the hover title
  });
  it("carries provenance glyph badges for each source, in words", () => {
    const h = render(base());
    expect(h).toContain('<span aria-hidden="true">⟳</span> Detected from GitHub or Railway');
    expect(h).toContain('<span aria-hidden="true">◆</span> Reported by lane-u');
    expect(h).toContain('<span aria-hidden="true">◆</span> Set by you');
    expect(h).toMatch(/✎<\/span> Changed by you/);
  });
});

describe("local mode and logout", () => {
  it("normal mode has a logout control and no local-only chip", () => {
    const h = render(base());
    expect(h).toMatch(/logout/i);
    expect(h).not.toContain("Running on this computer only");
  });
  it("local mode shows the chip and hides logout", () => {
    const h = render(base(), { local: true });
    expect(h).toContain("Running on this computer only");
    expect(h).not.toMatch(/action="\/logout"/);
  });
});

describe("fragments", () => {
  it("renderFragments returns one html fragment per panel, embedded in the page", () => {
    const f = P().renderFragments(base(), { now: NOW });
    expect(Object.keys(f)).toEqual(PANELS);
    const h = render(base());
    for (const k of PANELS) expect(h).toContain(f[k]);
  });
});

describe("B939 a ready-to-merge PR stays on the dashboard", () => {
  const withReady = (): any => {
    const s = base();
    const pr = s.prs.find((p: any) => p.pr === 2801);
    pr.state = "ready";
    pr.review = "approved";
    pr.ci = "green";
    pr.mergeable = "clean";
    return s;
  };
  const panel = (html: string, key: string): string =>
    new RegExp(`<section[^>]*data-panel="${key}"[\\s\\S]*?</section>`).exec(html)?.[0] ?? "";

  it("lists the ready PR in Open pull requests and counts it", () => {
    const html = render(withReady());
    const prs = panel(html, "prs");
    expect(prs).toContain("#2801");
    // 2801 (ready) + 2810 (open) are both open work; the merged 2788 is not
    expect(prs).toMatch(/<h2[^>]*>Open pull requests <span class="count">2<\/span>/);
  });

  it("shows the ready PR as the lane's PR chip", () => {
    const lanes = panel(render(withReady()), "lanes");
    expect(lanes).toContain("#2801");
  });
});
