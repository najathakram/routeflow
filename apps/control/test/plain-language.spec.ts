/**
 * Plain-language pass (owner ruling 2026-09-30): the dashboard is read by an owner who is not a
 * programmer. This spec pins the cross-cutting rules, not one string at a time:
 *   1. no code ever reaches VISIBLE text (rule codes, P0..P3, event names, shorthand durations,
 *      register/inferred jargon) on any state the page can be in;
 *   2. every schema event type renders a human sentence;
 *   3. every helper (ago, span, fmtDate, word maps) has table tests incl. the edges;
 *   4. the attention headline: all clear, only-warn, risk ordering;
 *   5. waste: every rule has a headline / noun / advice, and Dismiss keeps its hooks.
 * Hover titles, data-* attributes and the drawer MAY keep codes; "visible" means tags and
 * attributes stripped.
 */
import * as fs from "fs";
import * as path from "path";
import { EFFORTS, EVENT_TYPES, PHASES, PRIORITIES } from "../src/domain/schema";
import { LEGEND, NAV, TAGLINE, renderPage } from "../src/render/page";
import {
  CI_WORD,
  EFFORT_WORD,
  HB_WORD,
  LEVEL_WORD,
  MERGE_WORD,
  PANELS,
  PANEL_SUBS,
  PANEL_TITLES,
  PHASE_WORD,
  PRIO_WORD,
  PR_STATE_WORD,
  READY_WORD,
  REVIEW_WORD,
  RULE_DO,
  RULE_LABEL,
  RULE_NOUN,
  STATUS_WORD,
  VERB,
  ago,
  ctx,
  fmtDate,
  headerLines,
  plainWhy,
  plural,
  relTime,
  renderFragments,
  span,
} from "../src/render/panels";

/* eslint-disable @typescript-eslint/no-explicit-any */
const NOW = "2026-01-12T10:00:00Z";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAYMS = 24 * HOUR;
const base = (): any =>
  JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/acme/state.json"), "utf8"));
const page = (s: any, o: any = {}): string => renderPage(s, { now: NOW, ...o });
const frags = (s: any, o: any = {}): Record<string, string> =>
  renderFragments(s, { now: NOW, ...o }) as any;
const iso = (msAgo: number): string => new Date(Date.parse(NOW) - msAgo).toISOString();

const decode = (t: string): string =>
  t
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
/** Tags that run text together (inline); every other tag breaks the line. */
const INLINE = /<\/?(?:span|strong|em|i|code|kbd|a|time|small|abbr)\b[^>]*>/g;
/** What a reader sees: tags (and so every attribute) stripped, entities decoded. */
const visible = (html: string): string =>
  decode(
    html
      .replace(/<script\b[\s\S]*?<\/script>/g, " ")
      .replace(/<style\b[\s\S]*?<\/style>/g, " ")
      .replace(INLINE, "")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
const panel = (h: string, k: string): string =>
  h.slice(h.indexOf(`data-panel="${k}"`), h.indexOf("</section>", h.indexOf(`data-panel="${k}"`)));
const headerOf = (h: string): string => h.slice(h.indexOf("<header"), h.indexOf("</header>"));
const attn = (s: any, o: any = {}): { level: string; text: string } => {
  const m = /<p class="attn" data-level="([a-z]+)">([^<]*)<\/p>/.exec(headerOf(page(s, o)));
  expect(m).not.toBeNull();
  return { level: m![1], text: decode(m![2]) };
};

/** Everything that must never be read on screen. */
const BANNED: [string, RegExp][] = [
  ["a rule code (W1..W10, W7b)", /\bW\d+b?\b/],
  ["a priority code (P0..P3)", /\bP[0-3]\b/],
  ["a shorthand duration (5 d, 3 h, 2 m)", /\b\d+ [dhm]\b/],
  ["an event name (task.started)", /\b(?:task|bug|lane|inferred|release|pr|waste)\.[a-z]+\b/],
  ["Show/hide", /Show\/hide/i],
  ["CI with a glyph", /CI [✓✗◌⟳–]/],
  ["register lag", /register lag/i],
  ["inferred", /inferred/i],
  ["Jump to section", /Jump to section/],
  ["a lane#seq reference", /lane-[a-z]#\d/],
  ["a template slip", /\bundefined\b|\bNaN\b|\bnull\b|\[object Object\]/],
];
const expectPlain = (html: string, label: string): void => {
  const t = visible(html);
  for (const [what, re] of BANNED) {
    const m = re.exec(t);
    expect(
      m ? `${label}: ${what}: "...${t.slice(Math.max(0, m.index - 30), m.index + 40)}..."` : "",
    ).toBe("");
  }
};

/** A state that shows every kind of row the page can render. */
function rich(): any {
  const s = base();
  // six working lanes: the overlap matrix renders; one lane is blocked, one gone quiet (from base)
  for (const n of ["x", "y", "z"])
    s.lanes[`lane-${n}`] = {
      ...s.lanes["lane-u"],
      id: `lane-${n}`,
      name: `Lane ${n.toUpperCase()}`,
    };
  s.lanes["lane-idle"].current = { ...s.lanes["lane-u"].current, value: "F-3" };
  s.overlap = [
    { a: "lane-u", b: "lane-x", shared: 2, level: "WARN", source: "declared", paths: ["a/b.ts"] },
    { a: "lane-u", b: "lane-b", shared: 1, level: "HOT", source: "diff", paths: [] },
    { a: "lane-y", b: "lane-z", shared: 5, level: "HOT", source: "diff", paths: ["c/d.ts"] },
  ];
  const w = (rule: string, subject: string, why: string, since?: string) => ({
    key: `${rule}:${subject}`,
    rule,
    subject,
    why,
    action: "ignored: the page uses its own advice",
    ...(since ? { since } : {}),
  });
  s.waste = [
    w("W1", "PR #101", "no activity for 262 d"),
    w("W2", "PR #102", "draft for 6 d, never marked ready"),
    w("W3", "PR #103", "CI red for 3 d"),
    w("W3", "PR #104", "no check run on the head for 5 h"),
    w("W4", "PR #105", "merge conflict with master", iso(3 * DAYMS)),
    w("W5", "PR #106", "closed without merge and its work never reached master", iso(9 * DAYMS)),
    w("W6", "feat/acme-orphan", "ahead of master with no open or merged PR, last push 4 d ago"),
    w("W7", "PR #107", "merged 1 d ago and not deployed"),
    w("W7b", "PR #108", "bookkeeping follow-up pending for 3 min"),
    w("W8", "F-4", "reported done 4 d ago with no merged PR linking it"),
    w("W9", "PR #109", "merged with no task/bug/feature link and no Lane trailer", iso(DAYMS)),
    w("W10", "PR #110 + #111", "lanes lane-b and lane-u share 3 files"),
  ];
  const pr = (n: number, extra: any) => ({
    ...s.prs[0],
    pr: n,
    title: `Acme pr ${n}`,
    headRef: `feat/acme-${n}`,
    links: { task: null, bug: null, feature: null, defers: null, issue: null },
    ...extra,
  });
  s.prs = [
    ...s.prs,
    pr(3001, { state: "draft", ci: "none", review: "required", mergeable: "unknown" }),
    pr(3002, { state: "open", ci: "stale", review: "changes", lane: "unattributed" }),
    pr(3003, {
      state: "merged",
      mergedAt: iso(2 * DAYMS),
      serviceDeployed: { api: true, web: false },
    }),
    pr(3004, { state: "merged", mergedAt: iso(HOUR), deployed: "unknown" }),
    pr(3005, { state: "merged", mergedAt: iso(HOUR), deployed: true }),
    pr(3006, { state: "closed", closedAt: iso(3 * DAYMS) }),
  ];
  // every event type the schema knows, plus the one the inference layer adds
  s.timeline = [...EVENT_TYPES, "inferred.status"].map((type, i) => ({
    ts: iso((i + 1) * 7 * MIN),
    lane: i % 3 === 0 ? "lane-u" : i % 3 === 1 ? "owner" : "lane-b",
    seq: i + 1,
    type,
    task: /^(task|inferred)\./.test(type) ? "F-1" : /^bug\./.test(type) ? "B905" : null,
    by: i % 3 === 1 ? "owner" : i % 3 === 2 ? "sync" : "agent",
  }));
  s.warnings = [
    { lane: "lane-b", seq: 14, reason: "illegal transition planned -> released" },
    { lane: "owner", seq: 2, reason: "bad payload" },
  ];
  s.sources.github.lastOk = iso(12 * MIN); // a red banner
  s.releases.R1.status = { value: "planned", source: "register", ref: null };
  s.releases.R1.shipDate = { value: null, source: "register", ref: null };
  return s;
}

describe("1. visible text holds no code", () => {
  const cases: [string, () => string][] = [
    ["the acme page", () => page(base())],
    ["the acme page, local mode", () => page(base(), { local: true })],
    ["the loading page", () => page(base(), { loading: true })],
    [
      "an empty page",
      () => {
        const s = base();
        Object.assign(s, { tasks: {}, lanes: {}, releases: {}, prs: [], branches: [], waste: [] });
        Object.assign(s, { overlap: [], piggyback: {}, timeline: [], warnings: [] });
        return page(s);
      },
    ],
    ["a page that shows every kind of row", () => page(rich())],
  ];
  it.each(cases)("%s", (name, make) => expectPlain(make(), name));

  it("every fragment on its own is plain too (the client swaps these in)", () => {
    for (const [k, html] of Object.entries(frags(rich()))) expectPlain(html, `fragment ${k}`);
  });
  it("codes may stay in hover titles and data attributes, where the drawer reads them", () => {
    const h = page(base());
    expect(h).toContain('data-priority="P1"');
    expect(h).toMatch(/<span class="pill high" title="P1">High<\/span>/);
    expect(h).toMatch(/<strong class="w-head" title="W2">/);
  });
  it("the legend and the help dialog follow the same rules", () => {
    expectPlain(LEGEND.map(([k, v]) => `${k} ${v}`).join(" "), "legend");
    expectPlain(NAV.map((n) => n.label).join(" "), "nav");
    expectPlain(TAGLINE, "tagline");
  });
});

describe("2. every event type renders a human sentence", () => {
  const types = [...EVENT_TYPES, "inferred.status"];
  const row = (type: string, o: any = {}): string => {
    const s = base();
    s.timeline = [
      {
        ts: iso(5 * MIN),
        lane: "lane-u",
        seq: 1,
        type,
        task: /^(task|inferred)\./.test(type) ? "F-1" : /^bug\./.test(type) ? "B905" : null,
        by: "agent",
        ...o,
      },
    ];
    return panel(page(s), "timeline");
  };

  it("VERB has an entry for every schema event type and no stray ones", () => {
    for (const t of types) expect(Object.hasOwn(VERB, t)).toBe(true);
    expect(Object.keys(VERB).sort()).toEqual([...types].sort());
    for (const v of Object.values(VERB)) expect(v.replace(/:$/, "").length).toBeGreaterThan(3);
  });
  it.each(types)("%s reads as a sentence, never as its event name", (type) => {
    const t = visible(row(type));
    expect(t).not.toContain(type);
    expect(t).toContain(VERB[type].replace(/:$/, "").replace(/ (?:of|in)$/, ""));
    expect(t).toContain("5 min ago");
  });
  it("the sentence is: when - who - what - title, then the muted id", () => {
    const t = visible(row("task.started"));
    expect(t).toContain("5 min ago — lane-u started Acme invoice date fixes F-1");
    const h = row("task.started");
    expect(h).toMatch(
      /started <span class="ttl">Acme invoice date fixes<\/span> <span class="idtag"><button[^>]*data-task="F-1"/,
    );
  });
  it.each([
    ["task.priority", "changed the priority of Acme invoice date fixes F-1"],
    ["task.areas", "changed the file areas of Acme invoice date fixes F-1"],
    ["task.progress", "moved on to the next step of Acme invoice date fixes F-1"],
    ["task.release", "moved to another release: Acme invoice date fixes F-1"],
    ["task.lane", "gave to another lane: Acme invoice date fixes F-1"],
    ["task.reconsider", "put up for reconsideration: Acme invoice date fixes F-1"],
    ["task.done", "finished Acme invoice date fixes F-1"],
    ["task.dropped", "dropped Acme invoice date fixes F-1"],
    ["bug.filed", "filed bug Acme rounding on credit notes B905"],
    ["bug.fixed", "fixed bug Acme rounding on credit notes B905"],
  ])("%s keeps its preposition when a task follows: '%s'", (type, words) =>
    expect(visible(row(type))).toContain(`lane-u ${words}`),
  );
  it("the actor is You for the owner, An automatic check for sync/server/infer, else the lane", () => {
    expect(visible(row("task.started", { by: "owner", lane: "owner" }))).toContain("— You started");
    for (const by of ["sync", "server", "infer"])
      expect(visible(row("task.started", { by }))).toContain("— An automatic check started");
    expect(visible(row("task.started", { by: "ctl", lane: "lane-b" }))).toContain(
      "— lane-b started",
    );
    const s = base();
    s.lanes["lane-u"].name = "Lane U";
    s.timeline = [
      { ts: iso(MIN), lane: "lane-u", seq: 1, type: "task.done", task: "F-1", by: "agent" },
    ];
    expect(visible(panel(page(s), "timeline"))).toContain(
      "— Lane U finished Acme invoice date fixes F-1",
    );
  });
  it("a colon after the verb is dropped when no task follows it", () => {
    const t = visible(row("waste.ack", { task: null }));
    expect(t).toContain("— lane-u dismissed a warning");
    expect(t).not.toContain("dismissed a warning:");
    expect(visible(row("task.next"))).toContain("chose the next task: Acme invoice date fixes F-1");
  });
  it("the inferred status names the task first: '<task> had its status updated automatically'", () => {
    expect(visible(row("inferred.status", { by: "infer" }))).toContain(
      "Acme invoice date fixes F-1 had its status updated automatically",
    );
  });
  it("a long title is cut at 60 characters, an unknown task shows its id", () => {
    const s = base();
    s.tasks["F-1"].title = "A".repeat(80);
    s.timeline = [
      { ts: iso(MIN), lane: "lane-u", seq: 1, type: "task.done", task: "F-1", by: "agent" },
    ];
    expect(visible(panel(page(s), "timeline"))).toContain(`${"A".repeat(59)}…`);
    expect(visible(row("task.done", { task: "RF-99" }))).toContain("finished RF-99");
  });
  it("an event type the page has no sentence for is humanised, never leaking object members", () => {
    expect(visible(row("foo.bar-baz", { task: null }))).toContain("lane-u foo bar baz");
    const t = visible(row("constructor", { task: null }));
    expect(t).toContain("lane-u constructor");
    expect(t).not.toMatch(/function|native code/);
  });
  it("a lane note in its own lane reads 'left a note', registering names the lane", () => {
    expect(visible(row("lane.note"))).toMatch(/lane-u left a note(?! in)/);
    expect(visible(row("lane.note", { by: "owner", lane: "lane-b" }))).toContain(
      "You left a note in lane-b",
    );
    expect(visible(row("lane.registered", { by: "owner", lane: "lane-b" }))).toContain(
      "You registered lane lane-b",
    );
  });
});

describe("3. helpers: table tests", () => {
  describe("span (a length of time)", () => {
    it.each([
      [-5_000, "0 min"],
      [0, "0 min"],
      [59_999, "0 min"],
      [MIN, "1 min"],
      [3 * MIN, "3 min"],
      [59 * MIN, "59 min"],
      [60 * MIN, "1 hour"],
      [119 * MIN, "1 hour"],
      [5 * HOUR, "5 hours"],
      [47 * HOUR, "47 hours"],
      [47 * HOUR + 59 * MIN, "47 hours"],
      [48 * HOUR, "2 days"],
      [262 * DAYMS, "262 days"],
    ])("%i ms is %s", (ms, words) => expect(span(ms)).toBe(words));
  });
  describe("relTime and ago (how long ago)", () => {
    it.each([
      [0, "just now"],
      [59_999, "just now"],
      [-HOUR, "just now"], // a clock a little ahead is not "in the future"
      [MIN, "1 min ago"],
      [5 * MIN, "5 min ago"],
      [59 * MIN, "59 min ago"],
      [60 * MIN, "1 hour ago"],
      [3 * HOUR, "3 hours ago"],
      [47 * HOUR + 59 * MIN, "47 hours ago"],
      [48 * HOUR, "2 days ago"],
      [262 * DAYMS, "262 days ago"],
    ])("%i ms ago reads %s", (ms, words) => expect(relTime(iso(ms), Date.parse(NOW))).toBe(words));
    it("an unknown or unparseable time reads as a dash", () => {
      for (const v of [null, undefined, "", "not a date"])
        expect(relTime(v as any, Date.parse(NOW))).toBe("—");
      expect(relTime(NOW, Number.NaN)).toBe("—");
    });
    it("the <time> element keeps the exact UTC time in its title and the ISO in datetime", () => {
      const c = ctx({}, { now: NOW });
      expect(ago("2026-01-12T09:48:00Z", c).s).toBe(
        '<time datetime="2026-01-12T09:48:00Z" title="2026-01-12 09:48Z">12 min ago</time>',
      );
      expect(ago(null, c).s).toBe("—");
      expect(ago("nope", c).s).toBe("—");
    });
  });
  describe("fmtDate (20 Jan 2026)", () => {
    it.each([
      ["2026-01-20", "20 Jan 2026"],
      ["2026-01-05", "5 Jan 2026"],
      ["2026-02-10", "10 Feb 2026"],
      ["2026-12-31", "31 Dec 2026"],
      ["2026-03-01T09:30:00Z", "1 Mar 2026"],
      ["2026-13-01", "2026-13-01"], // not a month: shown as given
      ["2026-01-00", "2026-01-00"],
      ["soon", "soon"],
      [null, "—"],
      [undefined, "—"],
    ])("%s reads %s", (d, words) => expect(fmtDate(d as any)).toBe(words));
    it("covers all twelve month names", () => {
      const names = Array.from(
        { length: 12 },
        (_, i) => fmtDate(`2026-${String(i + 1).padStart(2, "0")}-15`).split(" ")[1],
      );
      expect(names).toEqual([
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ]);
    });
  });
  describe("plural", () => {
    it.each([
      [0, "hour", undefined, "0 hours"],
      [1, "hour", undefined, "1 hour"],
      [2, "hour", undefined, "2 hours"],
      [1, "branch without a PR", "branches without a PR", "1 branch without a PR"],
      [3, "branch without a PR", "branches without a PR", "3 branches without a PR"],
    ])("%i %s", (n, one, many, words) => expect(plural(n, one, many)).toBe(words));
  });
  describe("plainWhy (render-only text pass over a domain 'why')", () => {
    it.each([
      ["no activity for 262 d", "no activity for 262 days"],
      ["no activity for 1 d", "no activity for 1 day"],
      ["a deploy failed; merged 5 h ago", "a deploy failed; merged 5 hours ago"],
      ["merged 1 h ago and not deployed", "merged 1 hour ago and not deployed"],
      ["bookkeeping follow-up pending for 3 min", "bookkeeping follow-up pending for 3 min"],
      ["draft for 6 d, never marked ready", "draft for 6 days, never marked ready"],
      ["merge conflict with master", "merge conflict with master"],
      ["lanes lane-b and lane-u share 3 files", "lanes lane-b and lane-u share 3 files"],
      ["5 days already", "5 days already"], // spelled out: left alone
    ])("%s", (why, words) => expect(plainWhy(why)).toBe(words));
    it("is total: a missing why reads as nothing", () => {
      expect(plainWhy(undefined)).toBe("");
      expect(plainWhy(42)).toBe("");
    });
  });
  describe("the word maps (the owner-approved tables)", () => {
    it("priority", () =>
      expect(PRIO_WORD).toEqual({ P0: "Urgent", P1: "High", P2: "Normal", P3: "Low" }));
    it("status", () =>
      expect(STATUS_WORD).toEqual({
        planned: "Planned",
        proposed: "Proposed",
        "in-progress": "In progress",
        blocked: "Blocked",
        "code-complete": "Code finished",
        released: "Released",
        reconsider: "Being reconsidered",
        dropped: "Dropped",
      }));
    it("effort", () => expect(EFFORT_WORD).toEqual({ S: "Small", M: "Medium", L: "Large" }));
    it("checks", () =>
      expect(CI_WORD).toEqual({
        green: "Checks passed",
        red: "Checks failing",
        pending: "Checks running",
        stale: "Checks out of date",
        none: "No checks yet",
      }));
    it("merge", () =>
      expect(MERGE_WORD).toEqual({
        clean: "Ready to merge",
        conflicting: "Has conflicts",
        unknown: "Not known yet",
      }));
    it("review", () =>
      expect(REVIEW_WORD).toEqual({
        required: "Needs review",
        changes: "Changes requested",
        approved: "Approved",
        none: "No reviews yet",
      }));
    it("pull request state", () =>
      expect(PR_STATE_WORD).toEqual({
        open: "Open",
        draft: "Draft",
        ready: "Ready",
        merged: "Merged",
        closed: "Closed",
      }));
    it("lane activity", () =>
      expect(HB_WORD).toEqual({ live: "Active", stale: "Quiet", silent: "Inactive" }));
    it("feature phase", () =>
      expect(PHASE_WORD).toEqual({
        idea: "Idea",
        requirements: "Requirements",
        design: "Design",
        phase1: "Build, part 1",
        phase2: "Build, part 2",
        testing: "Testing",
        qa: "QA",
        rc: "Release candidate",
        released: "Released",
      }));
    it("collision level and release state", () => {
      expect(LEVEL_WORD).toEqual({ HOT: "High collision risk", WARN: "Possible collision" });
      expect(READY_WORD).toEqual({
        READY: "Ready to ship",
        "IN PROGRESS": "In progress",
        "AT RISK": "At risk",
        SHIPPED: "Shipped",
      });
    });
    it("every value the schema allows has a word (a new enum value fails here first)", () => {
      expect(Object.keys(PRIO_WORD)).toEqual([...PRIORITIES]);
      expect(Object.keys(PHASE_WORD)).toEqual([...PHASES]);
      expect(Object.keys(EFFORT_WORD)).toEqual([...EFFORTS]);
    });
  });
});

describe("4. the attention headline", () => {
  /** A state with nothing wrong: no blocker, no critical bug, no waste, nothing quiet, fresh data. */
  const calm = (): any => {
    const s = base();
    s.lanes["lane-b"].blockers = [];
    s.lanes["lane-b"].stale.value = "live";
    s.tasks.B906.ref.severity = "low";
    s.waste = [];
    return s;
  };

  it("is the first thing in the header, before the four status lines", () => {
    const head = headerOf(page(base()));
    expect(head.indexOf('class="attn"')).toBeGreaterThan(head.indexOf('class="lines"'));
    expect(head.indexOf('class="attn"')).toBeLessThan(head.indexOf('data-line="now"'));
    const lines = headerLines(ctx(base(), { now: NOW }));
    expect(lines).toHaveLength(5);
    expect(lines[0].s).toMatch(/^<p class="attn" data-level="/);
    expect(lines[0].s).not.toContain("data-line");
  });
  it("all clear when nothing needs attention", () => {
    expect(attn(calm())).toEqual({
      level: "ok",
      text: "All clear — nothing needs your attention.",
    });
  });
  it("only-warn: items that are not blocked / critical / release at risk give level warn", () => {
    const s = calm();
    s.waste = [{ key: "W4:1", rule: "W4", subject: "PR #1", why: "merge conflict with master" }];
    expect(attn(s)).toEqual({
      level: "warn",
      text: "Needs your attention: 1 piece of work at risk of being wasted.",
    });
    const q = calm();
    q.lanes["lane-b"].stale.value = "stale";
    expect(attn(q)).toEqual({
      level: "warn",
      text: "Needs your attention: 1 lane gone quiet.",
    });
    const g = calm();
    g.sources.github.lastOk = iso(30 * MIN);
    g.sources.railway.lastOk = iso(30 * MIN);
    expect(attn(g)).toEqual({
      level: "warn",
      text: "Needs your attention: GitHub data is old · Railway data is old.",
    });
  });
  it("each risk item alone gives level risk", () => {
    const blocked = calm();
    blocked.lanes["lane-b"].blockers = [{ task: "F-4", reason: "x", ref: "lane-b#1" }];
    expect(attn(blocked)).toEqual({ level: "risk", text: "Needs your attention: 1 blocked lane." });
    const crit = calm();
    crit.tasks.B906.ref.severity = "critical";
    expect(attn(crit)).toEqual({ level: "risk", text: "Needs your attention: 1 critical bug." });
    const rel = calm();
    rel.releases.R2.shipDate = { value: "2026-01-13", source: "register", ref: null }; // due tomorrow, 1 of 1 open
    expect(attn(rel)).toEqual({ level: "risk", text: "Needs your attention: Release R2 at risk." });
  });
  it("lists the items in a fixed order, with singular and plural words", () => {
    const s = calm();
    s.lanes["lane-b"].blockers = [{ task: "F-4", reason: "x", ref: "lane-b#1" }];
    s.lanes["lane-u"].blockers = [{ task: "F-1", reason: "y", ref: "lane-u#1" }];
    s.lanes["lane-idle"].stale.value = "stale";
    s.tasks.B906.ref.severity = "critical";
    s.tasks.B907.ref.severity = "critical";
    s.releases.R2.shipDate = { value: "2026-01-13", source: "register", ref: null };
    s.waste = [
      { key: "W4:1", rule: "W4", subject: "PR #1", why: "merge conflict with master" },
      { key: "W4:2", rule: "W4", subject: "PR #2", why: "merge conflict with master" },
      { key: "W4:3", rule: "W4", subject: "PR #3", why: "merge conflict with master" },
    ];
    s.lanes["lane-b"].stale.value = "stale";
    s.sources.github.lastOk = iso(30 * MIN);
    expect(attn(s)).toEqual({
      level: "risk",
      text:
        "Needs your attention: 2 blocked lanes · 2 critical bugs · Release R2 at risk · " +
        "3 pieces of work at risk of being wasted · 2 lanes gone quiet · GitHub data is old.",
    });
  });
  it("the header lines say it in words: Lanes, Next release, Bugs, Work at risk", () => {
    const t = visible(headerOf(page(base())));
    expect(t).toContain("Lanes 3 lanes · 2 working now · 1 blocked · 1 gone quiet");
    expect(t).toContain("Next release R2 ships 20 Jan 2026 · In progress · 0 of 1 task done");
    expect(t).toContain("Bugs 3 open · 1 critical · 2 being fixed");
    expect(t).toContain("Work at risk 2 at risk — 1 stale draft, 1 branch without a PR");
    const none = base();
    none.waste = [];
    none.releases = {};
    none.lanes = {};
    expect(visible(headerOf(page(none)))).toContain("Work at risk Nothing at risk");
    expect(visible(headerOf(page(none)))).toContain("Next release No releases yet");
    expect(visible(headerOf(page(none)))).toContain("Lanes No lanes yet");
  });
  it("colors at most one word per status line (the headline carries its level, not a tone)", () => {
    const head = headerOf(page(rich()));
    expect(head.slice(0, head.indexOf('data-line="now"'))).not.toContain("data-tone");
    for (const l of head.split(/(?=data-line=")/).slice(1))
      expect((l.match(/data-tone="/g) ?? []).length).toBeLessThanOrEqual(1);
  });
});

describe("5. waste: every rule is translated, Dismiss keeps its hooks", () => {
  const RULES = ["W1", "W2", "W3", "W4", "W5", "W6", "W7", "W7b", "W8", "W9", "W10"];
  const one = (rule: string, extra: any = {}): string => {
    const s = base();
    s.waste = [
      {
        key: `${rule}:PR #12`,
        rule,
        subject: "PR #12",
        why: "no activity for 4 d",
        action: "the old advice",
        ...extra,
      },
    ];
    return panel(page(s), "waste");
  };

  it("W1..W10 and W7b each have a headline, a noun and an advice sentence", () => {
    expect(Object.keys(RULE_LABEL).sort()).toEqual([...RULES].sort());
    expect(Object.keys(RULE_NOUN).sort()).toEqual([...RULES].sort());
    expect(Object.keys(RULE_DO).sort()).toEqual([...RULES].sort());
    for (const r of RULES) {
      expect(RULE_LABEL[r].length).toBeGreaterThan(8);
      expect(RULE_NOUN[r]).toHaveLength(2);
      expect(RULE_DO[r].endsWith(".")).toBe(true);
    }
  });
  it("the headline, the noun and the advice are the owner-approved words", () => {
    expect(RULE_LABEL).toEqual({
      W1: "Nobody has touched it",
      W2: "Draft left unfinished",
      W3: "Checks failing or missing",
      W4: "Has merge conflicts",
      W5: "Closed but the work never landed",
      W6: "Branch has no pull request",
      W7: "Merged but not live",
      W7b: "Follow-up docs missing",
      W8: "Marked done but nothing merged",
      W9: "Merged with no task attached",
      W10: "Two lanes changing the same files",
    });
    expect(RULE_NOUN.W1).toEqual(["idle", "idle"]);
    expect(RULE_NOUN.W2).toEqual(["stale draft", "stale drafts"]);
    expect(RULE_NOUN.W3[0]).toBe("without passing checks");
    expect(RULE_NOUN.W6).toEqual(["branch without a PR", "branches without a PR"]);
    expect(RULE_DO.W1).toBe("Update it from master and ask the lane to continue, or close it.");
    expect(RULE_DO.W9).toBe("Add the task link in the follow-up, or dismiss.");
  });
  it.each(RULES)("%s renders its headline and advice, and no code", (rule) => {
    const h = one(rule);
    const t = visible(h);
    expect(t).toContain(`PR #12 — ${RULE_LABEL[rule]}`);
    expect(t).toContain(`What to do: ${RULE_DO[rule]}`);
    expect(t).not.toContain("the old advice"); // the page's own advice replaces the domain's
    expect(t).not.toMatch(new RegExp(`\\b${rule}\\b`));
    expect(t).toContain("No activity for 4 days."); // the duration, expanded; a sentence
  });
  it("Dismiss keeps data-act='ack' and the data-key, and says what it does", () => {
    const h = one("W2");
    expect(h).toMatch(
      /<button type="button" class="btn" data-act="ack" data-key="W2:PR #12" title="Hide this warning until the pull request changes">Dismiss<\/button>/,
    );
    expect(one("W6", { subject: "feat/x", key: "W6:feat/x" })).toContain(
      "Hide this warning until the branch changes",
    );
    expect(one("W8", { subject: "F-4", key: "W8:F-4" })).toContain(
      "Hide this warning until the task changes",
    );
    expect(visible(h)).not.toContain("Ack"); // the button is no longer labelled with the advice
  });
  it("the row names the thing first: '<subject> — <headline>' in one .w-head", () => {
    expect(one("W4")).toContain(
      '<strong class="w-head" title="W4">PR #12 — Has merge conflicts</strong>',
    );
  });
  it("Mark as replaced is offered on PR rows for W5 and W9 only", () => {
    for (const r of RULES) {
      const h = one(r);
      if (r === "W5" || r === "W9")
        expect(h).toMatch(/data-act="superseded" data-pr="12"[^>]*>Mark as replaced<\/button>/);
      else expect(h).not.toContain('data-act="superseded"');
    }
    expect(one("W5", { subject: "branch x" })).not.toContain("superseded"); // no PR number to name
  });
  it("shows 'since ...' only when the why has no duration of its own", () => {
    const withDur = one("W1", { since: iso(DAYMS) });
    expect(visible(withDur)).not.toContain("since");
    const without = one("W4", { why: "merge conflict with master", since: iso(3 * DAYMS) });
    expect(visible(without)).toContain("Merge conflict with master. first seen 3 days ago");
    expect(without).toMatch(/first seen <time datetime="[^"]+" title="[^"]+">3 days ago<\/time>/);
  });
  it("an unknown rule falls back to the domain's own advice instead of failing", () => {
    const t = visible(one("W99", { action: "do the thing" }));
    expect(t).toContain("PR #12 — Needs attention");
    expect(t).toContain("What to do: do the thing");
    expect(visible(one("W99", { action: "" }))).not.toContain("What to do");
  });
  it("the header counts use each rule's noun, singular or plural", () => {
    const s = base();
    const row = (rule: string, n: number) => ({
      key: `${rule}:${n}`,
      rule,
      subject: `PR #${n}`,
      why: "x",
    });
    s.waste = [
      row("W1", 1),
      row("W1", 2),
      row("W2", 3),
      row("W6", 4),
      row("W6", 5),
      row("W7b", 6),
      row("W99", 7),
    ];
    expect(visible(headerOf(page(s)))).toContain(
      "7 at risk — 2 idle, 1 stale draft, 2 branches without a PR, 1 missing docs follow-up, 1 other",
    );
  });
  it("an empty list says what is true", () => {
    const s = base();
    s.waste = [];
    expect(visible(panel(page(s), "waste"))).toContain(
      "Nothing at risk — every open pull request is moving.",
    );
  });
});

describe("6. every panel: a heading, a purpose line, the words of the brief", () => {
  it("PANEL_TITLES and PANEL_SUBS are the owner-approved copy", () => {
    expect(PANEL_TITLES).toEqual({
      lanes: "Who is doing what",
      blockers: "Stuck work",
      waste: "Work at risk of being wasted",
      release: "Releases",
      queue: "Up next",
      bugs: "Bugs",
      prs: "Open pull requests",
      overlap: "Lanes touching the same files",
      piggyback: "Quick wins nearby",
      phases: "Feature progress",
      timeline: "Recent activity",
      sources: "Where this data comes from",
    });
    expect(Object.keys(PANEL_SUBS)).toEqual([...PANELS]);
    expect(PANEL_SUBS.waste).toContain("Dismiss hides a warning until the pull request changes.");
    expect(PANEL_SUBS.queue).toContain('"Make next" puts a task at the front of its lane.');
  });
  it("each panel has its h2 and then exactly one purpose line", () => {
    const h = page(base());
    for (const k of PANELS) {
      const p = panel(h, k);
      expect(p).toMatch(
        new RegExp(
          `<h2 id="h-${k}">[^<]*(?:<span class="count">\\d+</span>\\s*)?</h2><p class="panel-sub">`,
        ),
      );
      expect((p.match(/class="panel-sub"/g) ?? []).length).toBe(1);
      expect(visible(p.match(/<p class="panel-sub">([\s\S]*?)<\/p>/)![1])).toBe(
        PANEL_SUBS[k as keyof typeof PANEL_SUBS],
      );
    }
  });
  it("the purpose line is there while loading too", () => {
    const h = page(base(), { loading: true });
    for (const k of PANELS) expect(panel(h, k)).toContain('class="panel-sub"');
  });
  it("fold summaries read Hide / Show, with the panel's name for screen readers", () => {
    const h = page(base());
    for (const k of ["prs", "overlap", "piggyback", "phases", "timeline"])
      expect(panel(h, k)).toContain(
        `<summary><span class="when-open">Hide</span><span class="when-closed">Show</span> <span class="sr">${PANEL_TITLES[k as keyof typeof PANEL_TITLES]}</span></summary>`,
      );
    expect(h).not.toMatch(/Show\/hide/i);
  });
});

describe("7. page chrome", () => {
  it("under the title: what the page is, in one breath", () => {
    const h = page(base());
    expect(h).toContain(`<h1>RouteFlow Control</h1><p class="tagline">${TAGLINE}</p>`);
    expect(TAGLINE).toBe(
      "A live view of what every lane is doing, what is next, and what is at risk. A lane is one Claude session. This page updates by itself.",
    );
  });
  it("section list: Go to a section, with the approved labels in order", () => {
    const h = page(base());
    expect(h).toContain("<summary>Go to a section</summary>");
    const labels = [...h.matchAll(/<li><a href="#([a-z-]+)">([^<]+)<\/a><\/li>/g)].map((m) => [
      m[1],
      m[2],
    ]);
    expect(labels).toEqual([
      ["top", "Summary"],
      ["p-lanes", "Who is doing what"],
      ["p-waste", "At risk"],
      ["p-release", "Releases"],
      ["p-queue", "Up next"],
      ["p-bugs", "Bugs"],
      ["p-prs", "Pull requests"],
      ["p-overlap", "More"],
    ]);
  });
  it("Light / dark and Help buttons keep their hooks and give a longer accessible name", () => {
    const h = page(base());
    expect(h).toMatch(/data-act="theme" aria-label="Light \/ dark[^"]*">Light \/ dark<\/button>/);
    expect(h).toMatch(/data-act="legend" aria-label="Help: what the symbols mean">Help<\/button>/);
    expect(page(base(), { local: true })).toMatch(
      /class="chip local"[^>]*>Running on this computer only</,
    );
  });
  it("the help dialog: title, one row per symbol in the page's own words, the keys line", () => {
    const h = page(base());
    expect(h).toContain('<h3 id="legend-title">Help: how to read this page</h3>');
    const dl = visible(h.slice(h.indexOf('<dialog id="legend"'), h.indexOf("</dialog>")));
    for (const w of [
      "Set by you, or reported by a lane",
      "Changed from the register file",
      "Detected from GitHub or Railway",
      "From the register file",
      "Checks on a pull request: passed, failing, running, out of date, none yet.",
      "active",
      "quiet",
      "inactive",
      "High collision risk",
      "Possible collision",
      "Blocked",
      "At risk of being wasted",
      "Keys: / go to a section · ? this help · Esc close.",
    ])
      expect(dl).toContain(w);
  });
  it("the live chip reads 'Live — updates automatically'", () => {
    expect(page(base())).toContain(
      '<span id="live" class="chip" data-live="on">Live — updates automatically</span>',
    );
  });
});

describe("8. panels in plain words (the acme page)", () => {
  const h = page(base());
  it("lanes: Doing now / Next up, the state of the lane in words, a collision chip with a name", () => {
    const t = visible(panel(h, "lanes"));
    expect(t).toContain("Doing now Acme invoice date fixes F-1 In progress");
    expect(t).toContain("Next up Chosen next Acme route export F-2 High R2 ✎ Changed by you");
    expect(t).toContain("Active · last update 12 min ago");
    expect(t).toContain("Quiet · last update 5 hours ago");
    expect(t).toContain("Inactive");
    expect(t).toContain("Collision risk with lane-b");
    expect(t).toContain("Nothing right now");
    expect(t).toContain("Nothing queued for this lane");
    expect(t).toContain("Blocked: F-4 — waiting on SA-442");
    expect(t).toContain("PR #2810 · Checks running · Has conflicts");
    expect(panel(h, "lanes")).toContain('<span class="chip " title="Machine">PC</span>');
    expect(panel(h, "lanes")).toContain('<span class="chip " title="Machine">Mac</span>');
  });
  it("stuck work: '<title> <id> (<lane>) — <reason>'", () => {
    expect(visible(panel(h, "blockers"))).toContain(
      "Acme dashboards polish F-4 (lane-b) — waiting on SA-442",
    );
  });
  it("releases: head, keyed legend, metrics", () => {
    const t = visible(panel(h, "release"));
    expect(t).toContain(
      "R2 · Release 2 · ships 20 Jan 2026 ◆ Set by you · In progress Moved from 15 Jan 2026 to 20 Jan 2026 · 0 of 1 task done",
    );
    expect(t).toContain("1 released · 1 code finished · 2 in progress · 3 planned · 1 blocked");
    expect(t).toContain("3 pull requests · typically merged within 1.1 days");
    expect(t).toContain("Other releases (2)");
    expect(t).toContain("R1 · Release 1 · ships 5 Jan 2026 · At risk · 2 of 8 tasks done");
    expect(t).toContain("R3 · Release 3 · ships 10 Feb 2026 · In progress · no tasks yet");
    const p = panel(h, "release");
    for (const k of ["released", "cc", "wip", "planned", "blocked"])
      expect(p).toContain(`<span class="swatch ${k}"></span>`);
  });
  it("up next: the approved columns and the Make next button", () => {
    const p = panel(h, "queue");
    const cols = [...p.matchAll(/<th scope="col"[^>]*>([\s\S]*?)<\/th>/g)].map((m) =>
      visible(m[1]),
    );
    expect(cols).toEqual([
      "Priority",
      "Task",
      "Release",
      "Size",
      "Lane",
      "Why it is here",
      "Action",
    ]);
    const t = visible(p);
    expect(t).toContain("High Acme route export F-2 R2");
    expect(t).toContain("Small lane-u High Make next");
  });
  it("up next: unblocking is the reason when something waits on it, else the priority word", () => {
    const s = base();
    s.tasks["F-3"].release = { value: "R2", source: "register", ref: null }; // R1 has shipped
    s.tasks["F-2"].dependsOn = ["F-3"]; // F-2 waits on F-3, so F-3 "unblocks F-2"
    for (let i = 0; i < 12; i++)
      s.tasks[`F-${60 + i}`] = { ...s.tasks["F-3"], id: `F-${60 + i}`, title: `Acme queued ${i}` };
    const q = panel(page(s), "queue");
    const t = visible(q);
    expect(t).toContain("Acme driver notes F-3 R2 Small Any lane Unblocks F-2 Make next");
    expect(t).toContain("Acme queued 0 F-60 R2 Small Any lane Urgent Make next");
    expect(q).toContain('aria-label="Make F-3 the next task for any lane"');
    expect(t).toContain("+3 more waiting"); // 13 are waiting, the table shows ten
    expect((q.match(/<tr[\s>]/g) ?? []).length).toBe(11); // header row + ten
  });
  it("bugs: tiles, severity line, and the out-of-date records as a sentence", () => {
    const t = visible(panel(h, "bugs"));
    for (const w of ["3 Open bugs", "1 Critical", "2 Being fixed", "0 Fixed in the last 7 days"])
      expect(t).toContain(w);
    expect(t).toContain("Critical 1 · High 0 · Medium 1 · Low 1");
    expect(t).toContain(
      "Out of date records: 1 The register file and GitHub disagree about these:",
    );
    expect(t).toContain(
      "Acme rounding on credit notes B905 — now code finished (register file says planned)",
    );
  });
  it("bugs: severity pills show the word only", () => {
    const t = visible(panel(h, "piggyback"));
    expect(t).toContain("Acme bug 0 B906 Low Value score 0.8 Sensitive Give to lane-u");
    expect(panel(h, "piggyback")).not.toMatch(/aria-hidden="true">·</);
  });
  it("pull requests: the approved headers and cells in words", () => {
    const p = panel(h, "prs");
    const cols = [...p.matchAll(/<th scope="col"[^>]*>([\s\S]*?)<\/th>/g)].map((m) =>
      visible(m[1]),
    );
    expect(cols).toEqual([
      "PR",
      "Title",
      "Lane",
      "Task",
      "Status",
      "Checks",
      "Review",
      "Can merge?",
      "Opened",
      "Files changed",
    ]);
    const t = visible(p);
    expect(t).toContain(
      "#2810 Acme export rewrite lane-b F-4 Open ◌ Checks running No reviews yet Has conflicts 2 days ago 4",
    );
    expect(t).toContain(
      "#2801 Acme invoice date fix lane-u F-1 Open ✓ Checks passed No reviews yet Ready to merge 2 days ago 4",
    );
    expect(t).toContain("Merged in the last 7 days · 1");
    expect(t).toContain("#2788 Acme rounding merged — merged 22 hours ago · Not live yet");
  });
  it("pull requests: closed list, deploy words per service, unknown values fall back", () => {
    const t = visible(panel(page(rich()), "prs"));
    expect(t).toContain("Closed in the last 7 days · 1");
    expect(t).toContain("#3006 Acme pr 3006 — closed 3 days ago");
    expect(t).toContain("#3003 Acme pr 3003 — merged 2 days ago · api live · web not live");
    expect(t).toContain("#3004 Acme pr 3004 — merged 1 hour ago · Live status unknown");
    expect(t).toContain("#3005 Acme pr 3005 — merged 1 hour ago · Live");
    expect(t).toContain("Draft – No checks yet");
    expect(t).toContain("Needs review");
    expect(t).toContain("Changes requested");
    expect(t).toContain("No lane"); // a pull request no lane claimed
    expect(t).toContain("Not known yet");
    expect(t).toContain("Checks out of date");
  });
  it("lanes touching the same files: a sentence, the level in words, where it was measured", () => {
    const t = visible(panel(h, "overlap"));
    expect(t).toContain(
      "lane-u and lane-b are both changing 4 of the same files — High collision risk based on the real changes",
    );
    expect(t).toContain("Files apps/api/src/invoices/a.ts");
    const r = visible(panel(page(rich()), "overlap"));
    expect(r).toContain(
      "Lane X are both changing 2 of the same files — Possible collision based on planned file areas",
    );
    expect(r).toContain("lane-u and lane-b are both changing the same file — High collision risk");
    expect(r).toContain("2 files · possible");
    expect(r).toContain("5 files · high");
  });
  it("feature progress: step of nine, the phase's name, or Not started", () => {
    const s = base();
    s.tasks["F-1"].phase.value = "phase1";
    let t = visible(panel(page(s), "phases"));
    expect(t).toContain("Acme invoice date fixes F-1 Step 4 of 9 · Build, part 1 44%");
    s.tasks["F-1"].phase.value = null;
    t = visible(panel(page(s), "phases"));
    expect(t).toContain("Not started 0%");
    s.tasks["F-1"].phase.value = "released";
    expect(visible(panel(page(s), "phases"))).toContain("Step 9 of 9 · Released 100%");
  });
  it("where this data comes from: the chips in words", () => {
    const t = visible(panel(h, "sources"));
    expect(t).toContain("Latest code on master: 47f648c");
    expect(t).toContain("Last event written: lane-u #4");
    expect(t).toContain("GitHub · updated 1 min ago · 4,120 requests left");
    expect(t).toContain("Railway · updated 1 min ago");
    expect(t).toContain("api live ✓ · web live ✓");
    expect(t).toContain("Dashboard version 9f3a1c0");
    expect(t).toContain("Live — updates automatically");
    const s = base();
    s.sources.github = false;
    s.sources.railway.lastOk = NOW;
    s.sources.railway.api = false;
    const u = visible(panel(page(s), "sources"));
    expect(u).toContain("GitHub · not connected");
    expect(u).toContain("Railway · updated just now");
    expect(u).toContain("api not live ✗ · web live ✓");
  });
});

describe("9. banners in words", () => {
  it("a stale source says how long and what that means for the numbers", () => {
    const s = base();
    s.sources.railway.lastOk = iso(40 * MIN);
    expect(visible(page(s))).toContain(
      "Railway has not updated for 40 minutes, so the numbers below may be out of date.",
    );
  });
  it("unreadable updates: counted, explained, listed as '<lane> #<seq>: <reason>', capped at ten", () => {
    const s = base();
    s.warnings = Array.from({ length: 12 }, (_, i) => ({
      lane: "lane-b",
      seq: i + 1,
      reason: `bad ${i}`,
    }));
    const t = visible(page(s));
    expect(t).toContain(
      "12 updates from the lanes could not be read — the rest of the page is fine.",
    );
    expect(t).toContain("lane-b #1: bad 0");
    expect(t).toContain("lane-b #10: bad 9");
    expect(t).not.toContain("lane-b #11");
    expect(t).toContain("+2 more");
    s.warnings = [s.warnings[0]];
    expect(visible(page(s))).toContain("1 update from the lanes could not be read");
  });
});

describe("10. hooks other code relies on are untouched", () => {
  const h = page(base());
  it("keeps the ids, panel keys and data hooks the client and the tests use", () => {
    for (const id of [
      "live",
      "drawer",
      "legend",
      "toasts",
      "sr",
      "banners",
      "main",
      "top",
      "scrim",
    ])
      expect(h).toContain(`id="${id}"`);
    for (const k of PANELS) {
      expect(h).toContain(`id="p-${k}"`);
      expect(h).toContain(`id="h-${k}"`);
      expect(h).toContain(`data-panel="${k}"`);
    }
    for (const k of ["now", "release", "broken", "waste"]) expect(h).toContain(`data-line="${k}"`);
    for (const a of ["ack", "next", "assign", "theme", "legend", "close-drawer", "close-legend"])
      expect(h).toContain(`data-act="${a}"`);
    for (const d of [
      "data-task=",
      "data-key=",
      "data-lane=",
      "data-prev=",
      "data-prev-lane=",
      "data-fold=",
      "data-hb=",
      "data-fresh=",
      "data-live=",
      "data-tone=",
    ])
      expect(h).toContain(d);
    expect(h).toMatch(/class="tid mono"/);
  });
  it("keeps the posted values raw: the words are display, the data attributes keep P0..P3", () => {
    expect(h).toContain('data-priority="P1"');
    expect(h).toContain('data-status="in-progress"');
    expect(h).toContain('data-act="next" data-task="F-2" data-lane="lane-u" data-prev="F-2"');
  });
  it("a task id is always the button that opens the drawer, after the title", () => {
    for (const m of h.matchAll(/<span class="idtag">(<button[^>]*>)/g))
      expect(m[1]).toContain('class="tid mono"');
    expect((h.match(/class="idtag"/g) ?? []).length).toBeGreaterThan(5);
  });
});

describe("11. odd values read as nothing, they never break the page", () => {
  const cases: [string, (s: any) => void][] = [
    ["a pull request with no title", (s) => (s.prs[0].title = null)],
    [
      "a pull request with no lane, files or checks",
      (s) => Object.assign(s.prs[0], { lane: undefined, files: undefined, ci: null }),
    ],
    ["a timeline entry with a number for a type", (s) => (s.timeline[0].type = 5)],
    [
      "a timeline entry with no actor, lane or task",
      (s) => Object.assign(s.timeline[0], { by: null, lane: null, task: 5 }),
    ],
    ["a lane whose machine is a number", (s) => (s.lanes["lane-u"].machine = 5)],
    ["a lane with no name", (s) => (s.lanes["lane-u"].name = null)],
    ["a master sha that is not text", (s) => (s.sources.master.sha = 12345678)],
    ["a state head with no lane", (s) => (s.sources.state = { seq: 3 })],
    ["a source with no timestamp", (s) => (s.sources.github = { rateRemaining: "many" })],
    ["a waste row with no why, subject or rule", (s) => (s.waste[0] = { key: "x" })],
    [
      "an overlap row with no source, level or paths",
      (s) => (s.overlap[0] = { a: "lane-u", b: "lane-b", shared: null }),
    ],
    [
      "a piggyback row with a number for a severity",
      (s) => Object.assign(s.piggyback["lane-u"][0], { severity: 5, title: 7 }),
    ],
    ["a task phase that is not text", (s) => (s.tasks["F-1"].phase.value = 5)],
    ["a task with no effort", (s) => delete s.tasks["F-2"].effort],
    ["a release with no name", (s) => (s.releases.R2.name = null)],
  ];
  it.each(cases)("%s", (_name, mutate) => {
    const s = base();
    mutate(s);
    expect(() => page(s)).not.toThrow();
    expect(() => frags(s, { loading: true })).not.toThrow();
  });
});

describe("12. every new interpolation is escaped (T25)", () => {
  const PAYLOAD = `"><img src=x onerror=alert(1)><script>alert(1)</script>`;
  const leaves = (o: any, p: (string | number)[] = []): (string | number)[][] =>
    typeof o === "string"
      ? [p]
      : o && typeof o === "object"
        ? Object.entries(o).flatMap(([k, v]) => leaves(v, [...p, Array.isArray(o) ? Number(k) : k]))
        : [];
  const put = (o: any, p: (string | number)[], v: string): void => {
    let at = o;
    for (const k of p.slice(0, -1)) at = at[k];
    at[p[p.length - 1]] = v;
  };

  it("a markup payload in ANY string of a page that shows every kind of row stays text", () => {
    const paths = leaves(rich());
    expect(paths.length).toBeGreaterThan(300);
    for (const p of paths) {
      const s = rich();
      put(s, p, PAYLOAD);
      const html = page(s);
      const where = p.join(".");
      expect([where, (html.match(/<script\b/g) ?? []).length]).toEqual([where, 1]); // only client.js
      expect([where, /<img\b/.test(html)]).toEqual([where, false]);
      // no attribute value was closed early: nothing outside quotes looks like an on* handler
      expect([where, /<[a-z][^>]*\son[a-z]+\s*=/i.test(html.replace(/"[^"]*"/g, '""'))]).toEqual([
        where,
        false,
      ]);
    }
  });
});

describe("13. review fixes: who a badge credits, time words, areas, tile name", () => {
  const one = (rule: string, extra: any = {}): string => {
    const s = base();
    s.waste = [
      {
        key: `${rule}:PR #12`,
        rule,
        subject: "PR #12",
        why: "no activity for 4 d",
        action: "x",
        ...extra,
      },
    ];
    return panel(page(s), "waste");
  };
  const lanesOf = (s: any): string => visible(panel(page(s), "lanes"));
  const lanesHtml = (s: any): string => panel(page(s), "lanes");
  const withStatusRef = (ref: string | null): any => {
    const s = base();
    s.tasks["F-1"].status = { value: "in-progress", source: "reported", ref };
    delete s.tasks["F-1"].ref;
    return s;
  };
  const withReleaseRef = (ref: string): any => {
    const s = base();
    s.lanes["lane-b"].name = "Billing lane";
    s.tasks["F-2"].release = { value: "R2", source: "reported", ref };
    return s;
  };

  it("a value the owner set (no register value) reads 'Set by you'", () => {
    const s = withStatusRef("owner#5");
    expect(lanesOf(s)).toContain("◆ Set by you");
    expect(lanesOf(s)).not.toContain("Reported by");
    expect(lanesHtml(s)).toMatch(/<span class="badge rep" title="owner#5">/);
  });
  it("a value a lane sent reads 'Reported by <lane name>'", () => {
    const s = withStatusRef("lane-b#2");
    s.lanes["lane-b"].name = "Billing lane";
    expect(lanesOf(s)).toContain("◆ Reported by Billing lane");
    expect(lanesOf(s)).not.toContain("Set by you");
    expect(lanesHtml(s)).toMatch(/<span class="badge rep" title="lane-b#2">/);
  });
  it("a lane's name falls back to its id when the name is empty", () => {
    const s = withStatusRef("lane-b#2");
    s.lanes["lane-b"].name = "";
    expect(lanesOf(s)).toContain("◆ Reported by lane-b");
  });
  it("a lane not in the state, a missing ref and a hostile id all fall back safely", () => {
    expect(lanesOf(withStatusRef("lead-zz#2"))).toContain("◆ Reported by lead-zz");
    expect(lanesOf(withStatusRef(null))).toContain("◆ Reported by a lane");
    expect(lanesOf(withStatusRef(""))).toContain("◆ Reported by a lane");
    const hostile = lanesOf(withStatusRef("constructor#1"));
    expect(hostile).toContain("◆ Reported by constructor");
    expect(hostile).not.toMatch(/native code|\[object|function/);
    const html = lanesHtml(withStatusRef("<img src=x onerror=alert(1)>#3"));
    expect(html).not.toContain("<img");
    expect(html).toContain("Reported by &lt;img src=x onerror=alert(1)&gt;");
  });
  it("a changed value names the right actor: you for an owner ref, the lane for a lane ref", () => {
    expect(lanesOf(withReleaseRef("owner#3"))).toContain("R2 ✎ Changed by you");
    const theirs = withReleaseRef("lane-b#2");
    expect(lanesOf(theirs)).toContain("R2 ✎ Changed by Billing lane");
    expect(lanesOf(theirs)).not.toContain("Changed by you");
    expect(lanesOf(withReleaseRef("lead-zz#2"))).toContain("R2 ✎ Changed by lead-zz");
    expect(lanesOf(withReleaseRef("constructor#1"))).toContain("R2 ✎ Changed by constructor");
  });
  it("the hover title keeps the register value AND the ref in every layout", () => {
    expect(lanesHtml(withReleaseRef("owner#3"))).toMatch(
      /<span class="badge ov" title="register: R1 · owner#3">/,
    );
    const q = panel(page(withReleaseRef("lane-b#2")), "queue");
    expect(q).toMatch(/title="Changed by Billing lane · register: R1 · lane-b#2"/);
    expect(visible(q)).not.toMatch(/Changed by Billing lane/); // compact cells show the glyph only
  });
  it("the drawer line (data-alt) names the same actor", () => {
    const alt = (s: any): string => {
      const m = /data-task="F-2"[^>]* data-alt="([^"]*)"/.exec(page(s));
      return decode(m ? m[1] : "");
    };
    expect(alt(withReleaseRef("owner#3"))).toContain("release changed by you (register: R1)");
    expect(alt(withReleaseRef("lane-b#2"))).toContain(
      "release changed by Billing lane (register: R1)",
    );
    expect(alt(withReleaseRef("constructor#1"))).toContain("release changed by constructor");
    const s = withReleaseRef("owner#3");
    s.tasks["F-2"].status = { value: "planned", source: "reported", ref: "owner#5" };
    expect(alt(s)).toContain("status set by you");
    s.tasks["F-2"].status = { value: "planned", source: "reported", ref: "lane-b#2" };
    expect(alt(s)).toContain("status reported by Billing lane");
    expect(alt(s)).not.toMatch(/by the lane/);
  });
  it("the help dialog no longer generalises 'by the lane' or 'by you'", () => {
    const rows = LEGEND.map(([k]) => k).join(" | ");
    expect(rows).not.toContain("Reported by the lane");
    expect(rows).not.toContain("Changed by you");
    expect(visible(page(base()))).toContain(
      "Set or changed by you or by a lane — the badge names who",
    );
  });

  it("a duration-less waste row says 'first seen 3 days ago', not 'since'", () => {
    const h = one("W4", { why: "merge conflict with master", since: iso(3 * DAYMS) });
    expect(visible(h)).toContain("first seen 3 days ago");
    expect(visible(h)).not.toContain("since");
    expect(h).toMatch(/first seen <time datetime="[^"]+" title="[^"]+">3 days ago<\/time>/);
  });
  it("a waste 'why' starts with a capital and ends with a full stop", () => {
    const v = (why: string): string => visible(one("W4", { why }));
    expect(v("draft for 5 d, never marked ready")).toContain(
      "Draft for 5 days, never marked ready.",
    );
    expect(v("Already neat.")).toContain("Already neat. What to do");
    expect(v("is it done?")).toContain("Is it done? What to do");
    expect(v("conflicts!")).toContain("Conflicts! What to do");
    expect(v("")).not.toContain("..");
    expect(one("W4", { why: "draft for 5 d" })).toContain(
      '<span class="why">Draft for 5 days.</span>',
    );
    expect(one("W4", { why: "draft for 5 d" })).toContain('data-key="W4:PR #12"'); // hook untouched
  });

  it("the quick-wins header shows the area without glob characters", () => {
    expect(visible(panel(page(base()), "piggyback"))).toContain(
      "lane-u (apps/api/src/invoices) · 1 quick win",
    );
    for (const a of [
      "apps/api/src/invoices/*",
      "apps/api/src/invoices/**",
      "apps/api/src/invoices",
    ]) {
      const s = base();
      s.tasks["F-1"].areas.value = [a];
      const p = visible(panel(page(s), "piggyback"));
      expect(p).toContain("(apps/api/src/invoices)");
      expect(p).not.toContain("*");
    }
    const s = base();
    s.tasks["F-1"].areas.value = ["apps/api/src/*.ts"];
    expect(visible(panel(page(s), "piggyback"))).not.toContain("*");
  });

  it("the bugs tile counts the last 7 days and says so", () => {
    const t = visible(panel(page(base()), "bugs"));
    expect(t).toContain("0 Fixed in the last 7 days");
    expect(t).not.toContain("this week");
  });
});
