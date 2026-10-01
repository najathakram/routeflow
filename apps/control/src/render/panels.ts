/**
 * The 12 command-center panels (ux-spec §3) as server-rendered HTML fragments. Pure: the same
 * state + `now` always gives the same bytes. Every dynamic string goes through the auto-escaping
 * `h` tag (T25); only `raw()` output is trusted. The client never templates; it swaps these.
 */
import { esc } from "./esc";
import { naturalCompare } from "../domain/next";
import { releaseReadiness } from "../domain/releases";
import { PHASES } from "../domain/schema";
import type {
  Derived,
  LaneState,
  ReleaseState,
  TaskState,
  TimelineEntry,
  Warning,
} from "../domain/types";

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
] as const;
export type PanelKey = (typeof PANELS)[number];
export type Fragments = Record<PanelKey, string>;
export interface RenderOpts {
  now: string;
  local?: boolean;
  loading?: boolean;
  csrf?: string;
}

/* ------------------------------------------------------------------ view model (defensive) */
interface PrView {
  pr: number;
  state: string;
  lane: string;
  links: Record<string, string | null | undefined>;
  ci: string;
  review: string;
  mergeable: string;
  files: number;
  deployed: boolean | string;
  title: string;
  headRef: string;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
  serviceDeployed?: { api: boolean | string; web: boolean | string };
}
interface WasteRow {
  key: string;
  rule: string;
  subject: string;
  why: string;
  action?: string;
  since?: string;
}
interface OverlapRow {
  a: string;
  b: string;
  shared: number;
  level: string;
  source?: string;
  paths?: string[];
}
interface PigRow {
  id: string;
  severity?: string;
  score?: number;
  sensitive?: boolean;
  title?: string;
}
interface SrcView {
  github?: { lastOk?: string; rateRemaining?: number } | boolean;
  railway?: { lastOk?: string; api?: boolean; web?: boolean } | boolean;
  master?: { sha?: string };
  state?: { lane?: string; seq?: number };
}
export interface View {
  tasks: Record<string, TaskState>;
  lanes: Record<string, LaneState>;
  releases: Record<string, ReleaseState>;
  prs: PrView[];
  waste: WasteRow[];
  overlap: OverlapRow[];
  piggyback: Record<string, PigRow[]>;
  timeline: TimelineEntry[];
  warnings: Warning[];
  sources: SrcView;
  version: string;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;
export function view(state: unknown): View {
  const o = isObj(state) ? state : {};
  const rec = <T>(k: string): Record<string, T> => (isObj(o[k]) ? (o[k] as Record<string, T>) : {});
  const arr = <T>(k: string): T[] => (Array.isArray(o[k]) ? (o[k] as T[]) : []);
  return {
    tasks: rec<TaskState>("tasks"),
    lanes: rec<LaneState>("lanes"),
    releases: rec<ReleaseState>("releases"),
    prs: arr<PrView>("prs"),
    waste: arr<WasteRow>("waste"),
    overlap: arr<OverlapRow>("overlap"),
    piggyback: rec<PigRow[]>("piggyback"),
    timeline: arr<TimelineEntry>("timeline"),
    warnings: arr<Warning>("warnings"),
    sources: isObj(o.sources) ? o.sources : {},
    version: typeof o.version === "string" ? o.version : "",
  };
}

/* ------------------------------------------------------------------ escaping template tag */
export class Raw {
  constructor(readonly s: string) {}
}
export const raw = (s: string): Raw => new Raw(s);
const part = (v: unknown): string =>
  v instanceof Raw ? v.s : Array.isArray(v) ? v.map(part).join("") : esc(v);
export function h(strings: TemplateStringsArray, ...vals: unknown[]): Raw {
  let out = strings[0];
  vals.forEach((v, i) => {
    out += part(v) + strings[i + 1];
  });
  return new Raw(out);
}
export const join = (xs: Raw[], sep = ""): Raw => new Raw(xs.map((x) => x.s).join(sep));
const EMPTY = raw("");

/* ------------------------------------------------------------------ small helpers */
export type Tone = "risk" | "crit" | "warn" | "ok";
interface Ctx {
  v: View;
  nowMs: number;
  nowIso: string;
  stale: boolean;
  loading: boolean;
}
const val = <T>(d: Derived<T> | null | undefined): T | undefined => d?.value;
const sortedIds = (r: Record<string, unknown>): string[] => Object.keys(r).sort(naturalCompare);
const trunc = (s: string, n: number): string => {
  const cs = [...s];
  return cs.length <= n ? s : cs.slice(0, n - 1).join("") + "…";
};
const thousands = (n: number): string => `${n}`.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const DAY = 86_400_000;

const absTime = (iso: string): string => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z";
};
const relTime = (iso: string | null | undefined, nowMs: number): string => {
  const ms = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(ms)) return "—";
  const m = Math.max(0, Math.floor((nowMs - ms) / 60_000));
  if (m < 60) return `${m} m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} h`;
  return `${Math.floor(m / 1440)} d`;
};
const ago = (iso: string | null | undefined, c: Ctx): Raw =>
  iso && !Number.isNaN(Date.parse(iso))
    ? h`<time datetime="${iso}" title="${absTime(iso)}">${relTime(iso, c.nowMs)}</time>`
    : raw("—");

const tone = (t: Tone, text: unknown): Raw => h`<span class="tone" data-tone="${t}">${text}</span>`;
const chip = (text: unknown, cls = ""): Raw => h`<span class="chip ${cls}">${text}</span>`;
const mono = (text: unknown): Raw => h`<code class="mono">${text}</code>`;
const empty = (copy: Raw): Raw => h`<p class="empty">${copy}</p>`;

/** Own-property lookup: "constructor" and friends fall back instead of leaking Object members. */
const pick = <T>(m: Record<string, T>, k: unknown): T | undefined =>
  typeof k === "string" && Object.hasOwn(m, k) ? m[k] : undefined;
const STATUS_KIND: Record<string, string> = {
  planned: "planned",
  proposed: "planned",
  "in-progress": "wip",
  blocked: "risk",
  "code-complete": "done",
  released: "done",
  reconsider: "defer",
  dropped: "low",
};
const statusPill = (s: string | undefined): Raw =>
  s
    ? h`<span class="pill ${pick(STATUS_KIND, s) ?? "planned"}">${s.replace(/-/g, " ")}</span>`
    : EMPTY;
const PRIO_KIND: Record<string, string> = { P0: "critical", P1: "high", P2: "medium", P3: "low" };
const prioPill = (p: string | undefined): Raw =>
  h`<span class="pill ${pick(PRIO_KIND, p) ?? "low"}">${p ?? "—"}</span>`;
const SEV_GLYPH: Record<string, string> = { critical: "!!", high: "!", medium: "·", low: "·" };
const sevPill = (s: string): Raw =>
  h`<span class="pill ${pick(SEV_GLYPH, s) ? s : "low"}"><span aria-hidden="true">${pick(SEV_GLYPH, s) ?? "·"}</span> ${s}</span>`;

const regOf = (t: TaskState, key: string): unknown => {
  const r = t.ref?.["register"];
  return isObj(r) ? r[key] : undefined;
};
/** Provenance badge: glyph + word, never color alone. `reg` = the register's own value. */
function badge(
  d: Derived<unknown> | undefined,
  c: Ctx,
  reg?: unknown,
  loud = false,
  compact = false,
): Raw {
  if (!d) return EMPTY;
  const ref = d.ref ? ` · ${d.ref}` : "";
  let g = "▤";
  let label = "register";
  let cls = "reg";
  let title = "";
  if (d.source === "reported") {
    const over = reg !== undefined && reg !== d.value;
    g = over ? "✎" : "◆";
    label = (over ? "overridden" : "reported") + ref;
    cls = over ? "ov" : "rep";
    if (over) title = "register: " + plain(reg);
  } else if (d.source === "inferred") {
    g = "⟳";
    label = (c.stale ? "old · inferred" : "inferred") + (d.ref ? ` from ${d.ref}` : "");
    cls = "inf";
  } else if (!loud) return EMPTY;
  // compact (table cells): the glyph alone, the full text in title + aria-label
  if (compact) {
    const full = `${label}${title ? " · " + title : ""}`;
    return h`<span class="badge ${cls}" title="${full}" aria-label="${full}">${g}</span>`;
  }
  return h`<span class="badge ${cls}"${title ? h` title="${title}"` : EMPTY}>${g} ${label}</span>`;
}
/** Primitive to text for attribute values (escaped once, by `h`). */
const plain = (v: unknown): string =>
  typeof v === "string" || typeof v === "number" ? String(v) : "none";

/** Alternate values (register vs reported/inferred) as text: the drawer repeats every title=. */
function altText(t: TaskState): string {
  const out: string[] = [];
  const one = (k: "status" | "priority" | "release", d: Derived<unknown> | undefined) => {
    if (!d || d.source === "register") return;
    const reg = regOf(t, k);
    const how = d.source === "inferred" ? "inferred" : "reported";
    out.push(
      `${k} ${how}${d.ref ? " " + d.ref : ""}${reg !== undefined ? ` (register: ${plain(reg)})` : ""}`,
    );
  };
  one("status", t.status);
  one("priority", t.priority);
  one("release", t.release);
  return out.join(" · ");
}

/** A task id that opens the drawer; everything the drawer needs rides as data attributes. */
function taskBtn(t: TaskState | undefined, id: string): Raw {
  if (!t) return mono(id);
  return h`<button type="button" class="tid mono" data-task="${t.id}" data-title="${t.title}" data-status="${val(t.status)}" data-priority="${val(t.priority)}" data-release="${val(t.release) ?? ""}" data-lane="${val(t.lane) ?? ""}" data-areas="${(val(t.areas) ?? []).join("\n")}" data-pr="${val(t.pr) ?? ""}" data-alt="${altText(t)}">${t.id}</button>`;
}
const linkTask = (id: string | null | undefined, c: Ctx): Raw =>
  id ? taskBtn(c.v.tasks[id], id) : EMPTY;

const laneTasks = (c: Ctx): TaskState[] => sortedIds(c.v.tasks).map((k) => c.v.tasks[k]);

/* ------------------------------------------------------------------ freshness */
type Level = "ok" | "amber" | "red" | "off";
interface Fresh {
  name: string;
  level: Level;
  min: number | null;
  extra: string;
}
function freshness(c: Ctx): Fresh[] {
  const s = c.v.sources;
  const one = (name: string, src: unknown, extra: string): Fresh => {
    if (!isObj(src)) return { name, level: src === true ? "ok" : "off", min: null, extra };
    const at = typeof src.lastOk === "string" ? Date.parse(src.lastOk) : NaN;
    if (Number.isNaN(at)) return { name, level: "ok", min: null, extra };
    const age = (c.nowMs - at) / 60_000;
    const level: Level = age > 10 ? "red" : age > 2 ? "amber" : "ok";
    return { name, level, min: Math.max(0, Math.floor(age)), extra };
  };
  const gh = isObj(s.github) ? s.github : null;
  const rate =
    gh && typeof gh.rateRemaining === "number" ? `rate ${thousands(gh.rateRemaining)}` : "";
  return [one("GitHub", s.github, rate), one("Railway", s.railway, "")];
}
const isStale = (v: View, nowMs: number): boolean =>
  freshness({ v, nowMs, nowIso: "", stale: false, loading: false }).some((f) => f.level === "red");

/* ------------------------------------------------------------------ derived numbers */
const SHIPPED = new Set(["shipped", "done", "released"]);
const DONE_ST = new Set(["code-complete", "released"]);
const sev = (t: TaskState): string => {
  const s = t.ref?.["severity"];
  return typeof s === "string" ? s : "low";
};
interface BugStats {
  open: number;
  critical: number;
  flight: number;
  fixed7: number;
  bySev: Record<string, number>;
}
function bugStats(c: Ctx): BugStats {
  const bugs = laneTasks(c).filter((t) => t.kind === "bug");
  const open = bugs.filter(
    (t) => !["released", "dropped", "code-complete"].includes(t.status?.value),
  );
  const bySev: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const t of open) bySev[pick(SEV_GLYPH, sev(t)) ? sev(t) : "low"]++;
  return {
    open: open.length,
    critical: bySev.critical,
    flight: bugs.filter((t) => ["in-progress", "code-complete"].includes(t.status?.value)).length,
    fixed7: c.v.timeline.filter(
      (e) => e.type === "bug.fixed" && c.nowMs - Date.parse(e.ts) <= 7 * DAY,
    ).length,
    bySev,
  };
}
const lagging = (c: Ctx): TaskState[] =>
  laneTasks(c).filter((t) => {
    const reg = regOf(t, "status");
    return t.status?.source === "inferred" && reg !== undefined && reg !== t.status.value;
  });

const nextRelease = (c: Ctx): ReleaseState | null => {
  const open = sortedIds(c.v.releases)
    .map((k) => c.v.releases[k])
    .filter((r) => !SHIPPED.has(val(r.status) ?? ""));
  open.sort((a, b) => (val(a.shipDate) ?? "9999").localeCompare(val(b.shipDate) ?? "9999"));
  return open[0] ?? null;
};
const readiness = (c: Ctx, id: string) => releaseReadiness(c.v, id, c.nowIso);
const READY_KIND: Record<string, string> = {
  READY: "done",
  "IN PROGRESS": "wip",
  "AT RISK": "risk",
  SHIPPED: "done",
};

/** Global queue: planned, deps satisfied, release unshipped, not anyone's current task. */
function queue(c: Ctx): { t: TaskState; reason: string }[] {
  const taken = new Set(Object.values(c.v.lanes).map((l) => val(l.current)));
  const PR: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const rank = (p: string | undefined) => pick(PR, p) ?? 9;
  const ship = (t: TaskState) => {
    const r = val(t.release);
    const d = r ? val(c.v.releases[r]?.shipDate) : undefined;
    return d ?? "9999";
  };
  const dependents = new Map<string, string>();
  for (const t of laneTasks(c))
    for (const d of t.dependsOn ?? []) if (!dependents.has(d)) dependents.set(d, t.id);
  return laneTasks(c)
    .filter((t) => {
      if (val(t.status) !== "planned" || taken.has(t.id)) return false;
      const rid = val(t.release);
      if (rid && SHIPPED.has(val(c.v.releases[rid]?.status) ?? "")) return false;
      return (t.dependsOn ?? []).every(
        (d) =>
          DONE_ST.has(val(c.v.tasks[d]?.status) ?? "") || val(c.v.tasks[d]?.status) === "dropped",
      );
    })
    .sort(
      (a, b) =>
        rank(val(a.priority)) - rank(val(b.priority)) ||
        ship(a).localeCompare(ship(b)) ||
        naturalCompare(a.id, b.id),
    )
    .map((t) => ({
      t,
      reason: dependents.has(t.id) ? `blocks ${dependents.get(t.id)}` : (val(t.priority) ?? ""),
    }));
}

function laneNext(c: Ctx, l: LaneState): { t: TaskState; explicit: boolean } | null {
  const explicit = val(l.next);
  if (explicit && c.v.tasks[explicit]) return { t: c.v.tasks[explicit], explicit: true };
  const q = queue(c).find(
    ({ t }) => val(t.lane) === l.id || val(t.lane) === null || val(t.lane) === undefined,
  );
  return q ? { t: q.t, explicit: false } : null;
}

/* ------------------------------------------------------------------ panel frame */
interface FrameOpts {
  title: string;
  count?: number;
  fold?: boolean;
}
function frame(c: Ctx, key: PanelKey, o: FrameOpts, body: Raw): string {
  const n = o.count !== undefined ? h` <span class="count">${o.count}</span>` : EMPTY;
  const inner = c.loading
    ? h`<div class="skeleton row"></div><div class="skeleton row"></div><div class="skeleton row short"></div>`
    : body;
  if (o.fold)
    return h`<h2 id="h-${key}">${o.title}${n}</h2><details class="fold" data-fold="${key}" open><summary>Show/hide ${o.title}</summary>${inner}</details>`
      .s;
  return h`<h2 id="h-${key}">${o.title}${n}</h2>${inner}`.s;
}

/* ------------------------------------------------------------------ P1 lane board */
const CI_GLYPH: Record<string, string> = {
  green: "✓",
  red: "✗",
  pending: "◌",
  stale: "⟳",
  none: "–",
};
const ciText = (ci: string): string => `CI ${pick(CI_GLYPH, ci) ?? "?"} ${ci}`;
const HB_GLYPH: Record<string, string> = { live: "●", stale: "◐", silent: "○" };

function prFor(c: Ctx, taskId: string | null | undefined): PrView | undefined {
  if (!taskId) return undefined;
  const open = c.v.prs.filter((p) => p.state === "open" || p.state === "draft");
  return open.find(
    (p) => p.links?.task === taskId || p.links?.bug === taskId || p.links?.feature === taskId,
  );
}
function prChip(p: PrView): Raw {
  const conflict = p.mergeable === "conflicting";
  return h`<span class="chip pr ${conflict ? "bad" : ""}" title="${"review: " + p.review + " · " + p.files + " files"}">#${p.pr} · ${ciText(p.ci)} · ${conflict ? "conflicts" : p.mergeable}</span>`;
}
function releaseChip(t: TaskState, c: Ctx, compact = false): Raw {
  const rid = val(t.release);
  if (!rid) return EMPTY;
  return h`<span class="chip rel">${rid}</span> ${badge(t.release, c, regOf(t, "release"), false, compact)}`;
}

function laneCard(c: Ctx, l: LaneState): Raw {
  const cur = val(l.current);
  const curT = cur ? c.v.tasks[cur] : undefined;
  const nx = laneNext(c, l);
  const pr = prFor(c, cur);
  const hot = c.v.overlap.filter((o) => o.level !== "none" && (o.a === l.id || o.b === l.id));
  const hb = val(l.stale) ?? "silent";
  const blockers = l.blockers ?? [];
  const current = cur
    ? h`<p class="cur"><span class="lbl">Current</span> ${taskBtn(curT, cur)} <span class="ttl">${curT?.title ?? ""}</span> ${curT ? statusPill(val(curT.status)) : EMPTY} ${curT ? badge(curT.status, c) : EMPTY}</p>`
    : h`<p class="cur"><span class="lbl">Current</span> <span class="mut">Idle</span></p>`;
  const next = nx
    ? h`<p class="nxt"><span class="lbl">Next</span> <span aria-hidden="true">${nx.explicit ? "★" : "→"}</span> ${taskBtn(nx.t, nx.t.id)} <span class="ttl mut">${nx.t.title}</span> ${prioPill(val(nx.t.priority))} ${releaseChip(nx.t, c)}</p>`
    : h`<p class="nxt"><span class="lbl">Next</span> <span class="mut">No next eligible — queue empty for this lane</span></p>`;
  return h`<article class="lane" data-lane="${l.id}" data-hb="${hb}">
<div class="lane-h"><strong class="mono">${l.name || l.id}</strong> ${chip(l.machine)} <span class="hb"><span aria-hidden="true">${pick(HB_GLYPH, hb) ?? "○"}</span> ${hb}${val(l.heartbeat) ? h` · ${ago(val(l.heartbeat), c)}` : EMPTY}</span>${hot.length ? h` ${chip(h`overlap ▲${hot.length} ${hot[0].level}`, "warn")}` : EMPTY}</div>
${current}${pr ? h`<p class="prl">${prChip(pr)}</p>` : EMPTY}${next}${join(
    blockers.map((b) => h`<p class="blk">⛔ ${linkTask(b.task, c)} <span>${b.reason}</span></p>`),
  )}</article>`;
}

function lanesPanel(c: Ctx): string {
  const rank: Record<string, number> = { live: 0, stale: 1, silent: 2 };
  const ls = sortedIds(c.v.lanes)
    .map((k) => c.v.lanes[k])
    .sort(
      (a, b) =>
        (pick(rank, val(a.stale)) ?? 3) - (pick(rank, val(b.stale)) ?? 3) ||
        naturalCompare(a.id, b.id),
    );
  const body = ls.length
    ? h`<div class="lanes">${join(ls.map((l) => laneCard(c, l)))}</div>`
    : empty(h`No lanes registered — ${mono("npm run ctl -- lane register …")}`);
  return frame(c, "lanes", { title: "Lane board" }, body);
}

/* ------------------------------------------------------------------ P2 blockers, P3 waste */
const CAP = 6;
function capped(rows: Raw[], cls: string): Raw {
  const first = join(rows.slice(0, CAP));
  if (rows.length <= CAP) return h`<ul class="${cls}">${first}</ul>`;
  return h`<ul class="${cls}">${first}</ul><details class="more"><summary>+${rows.length - CAP} more</summary><ul class="${cls}">${join(rows.slice(CAP))}</ul></details>`;
}
function blockersPanel(c: Ctx): string {
  const rows: Raw[] = [];
  for (const id of sortedIds(c.v.lanes))
    for (const b of c.v.lanes[id].blockers ?? [])
      rows.push(
        h`<li>⛔ ${linkTask(b.task, c)} · <span class="mono">${id}</span> · <span>${b.reason}</span> ${mono(b.ref)}</li>`,
      );
  const body = rows.length ? capped(rows, "rows") : empty(raw("No blockers"));
  return frame(c, "blockers", { title: "Blockers", count: rows.length || undefined }, body);
}
/** First PR number in a waste subject ("PR #12 + #34" gives 12). */
const prNum = (subject: string): string => /^PR #(\d+)/.exec(subject)?.[1] ?? "";
function wastePanel(c: Ctx): string {
  const sorted = [...c.v.waste].sort(
    (a, b) => naturalCompare(a.rule, b.rule) || naturalCompare(a.key, b.key),
  );
  const rows = sorted.map(
    (w) =>
      h`<li class="waste" data-key="${w.key}"><span class="glyph" aria-hidden="true">⚠</span> ${chip(w.rule)} <strong>${w.subject}</strong> <span>${w.why}</span> <span class="mut">${w.since && !/\d+ (?:d|h|min)\b/.test(w.why) ? ago(w.since, c) : EMPTY}</span> <span class="acts"><button type="button" class="btn" data-act="ack" data-key="${w.key}">${w.action || "Ack"}</button>${prNum(w.subject) && (w.rule === "W5" || w.rule === "W9") ? h` <button type="button" class="btn" data-act="superseded" data-pr="${prNum(w.subject)}">Mark superseded</button>` : EMPTY}</span></li>`,
  );
  const body = rows.length
    ? capped(rows, "rows")
    : empty(raw("Nothing at risk — every open PR is moving"));
  return frame(c, "waste", { title: "At risk of waste", count: rows.length || undefined }, body);
}

/* ------------------------------------------------------------------ P4 release bar */
const SEGS: { key: string; label: string; match: (s: string) => boolean }[] = [
  { key: "released", label: "released", match: (s) => s === "released" },
  { key: "cc", label: "code-complete", match: (s) => s === "code-complete" },
  { key: "wip", label: "in progress", match: (s) => s === "in-progress" },
  {
    key: "planned",
    label: "planned",
    match: (s) => ["planned", "proposed", "reconsider"].includes(s),
  },
  { key: "blocked", label: "blocked", match: (s) => s === "blocked" },
];
function releaseBar(tasks: TaskState[]): Raw {
  const counts = SEGS.map((g) => ({
    g,
    n: tasks.filter((t) => g.match(val(t.status) ?? "")).length,
  }));
  const total = counts.reduce((a, x) => a + x.n, 0);
  let x = 0;
  const rects = counts
    .filter((k) => k.n > 0)
    .map((k) => {
      const w = (k.n / total) * 100;
      const r = h`<rect class="seg ${k.g.key}" x="${x.toFixed(2)}" y="0" width="${Math.max(w - 0.6, 0.4).toFixed(2)}" height="6"></rect>`;
      x += w;
      return r;
    });
  const label = counts
    .filter((k) => k.n > 0)
    .map((k) => `${k.n} ${k.g.label}`)
    .join(" · ");
  return h`<svg class="bar" viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label="${label || "no tasks"}">${total ? join(rects) : raw('<rect class="seg planned" x="0" y="0" width="100" height="6"></rect>')}</svg><p class="mut small">${label || "no tasks"}</p>`;
}
function prMetrics(c: Ctx, rid: string): string {
  const mine = c.v.prs.filter((p) => {
    const id = p.links?.task ?? p.links?.bug ?? p.links?.feature;
    return id && val(c.v.tasks[id]?.release) === rid;
  });
  if (!mine.length) return "";
  const lead = mine
    .filter((p) => p.state === "merged" && p.mergedAt)
    .map((p) => (Date.parse(p.mergedAt ?? "") - Date.parse(p.createdAt)) / DAY)
    .filter((d) => Number.isFinite(d))
    .sort((a, b) => a - b);
  const med = lead.length ? lead[Math.floor((lead.length - 1) / 2)].toFixed(1) : null;
  const closed = mine.filter((p) => p.state === "closed").length;
  return `${mine.length} PR${mine.length === 1 ? "" : "s"}${med ? ` · lead time med ${med} d` : ""}${closed ? ` · ${closed} closed-unmerged` : ""}`;
}
function releaseCard(c: Ctx, r: ReleaseState): Raw {
  const rd = readiness(c, r.id);
  const tasks = laneTasks(c).filter((t) => val(t.release) === r.id && val(t.status) !== "dropped");
  const date = val(r.shipDate);
  const metrics = prMetrics(c, r.id);
  return h`<article class="rel" data-release="${r.id}">
<p class="rel-h"><strong class="mono">${r.id}</strong> <span>${r.name}</span> · ${date ? h`ships <time datetime="${date}">${date}</time> ${badge(r.shipDate, c)}` : raw("no ship date")} <span class="pill ${pick(READY_KIND, rd.state) ?? "wip"}">${rd.state}</span> ${rd.moved ? chip(`MOVED ${rd.moved.from ?? "?"} → ${rd.moved.to ?? "?"}`, "warn") : EMPTY} <span class="mut">${rd.done}/${rd.total} done</span></p>
${releaseBar(tasks)}${metrics ? h`<p class="mut small">${metrics}</p>` : EMPTY}</article>`;
}
function releasePanel(c: Ctx): string {
  const first = nextRelease(c);
  const rest = sortedIds(c.v.releases)
    .map((k) => c.v.releases[k])
    .filter((r) => r !== first)
    .sort((a, b) => (val(a.shipDate) ?? "9999").localeCompare(val(b.shipDate) ?? "9999"));
  const body =
    first || rest.length
      ? h`${first ? releaseCard(c, first) : EMPTY}${rest.length ? h`<details class="fold" data-fold="rel-more" open><summary>Other releases (${rest.length})</summary>${join(rest.map((r) => releaseCard(c, r)))}</details>` : EMPTY}`
      : empty(h`No releases — add one in ${mono("releases.jsonl")}`);
  return frame(c, "release", { title: "Release bar" }, body);
}

/* ------------------------------------------------------------------ P5 queue */
function queuePanel(c: Ctx): string {
  const all = queue(c);
  const rows = all.slice(0, 10).map(({ t, reason }) => {
    const lane = val(t.lane);
    const prev = lane ? (val(c.v.lanes[lane]?.next) ?? "") : "";
    return h`<tr><td>${prioPill(val(t.priority))}</td><th scope="row">${taskBtn(t, t.id)}</th><td class="ttl">${t.title}</td><td class="c-opt">${releaseChip(t, c, true)}</td><td class="c-opt">${t.effort}</td><td class="mono">${lane ?? "any"}</td><td class="mut c-opt">${reason}</td><td><button type="button" class="btn" data-act="next" data-task="${t.id}" data-lane="${lane ?? ""}" data-prev="${prev}" aria-label="${"Set " + t.id + " as next"}">★</button></td></tr>`;
  });
  const body = rows.length
    ? h`<div class="tw"><table class="tbl queue"><thead><tr><th scope="col">Pri</th><th scope="col">ID</th><th scope="col">Title</th><th scope="col" class="c-opt">Release</th><th scope="col" class="c-opt">Effort</th><th scope="col">Lane</th><th scope="col" class="c-opt">Reason</th><th scope="col">Action</th></tr></thead><tbody>${join(rows)}</tbody></table></div>${all.length > 10 ? h`<p class="mut small">+${all.length - 10} more eligible</p>` : EMPTY}`
    : empty(raw("Queue empty"));
  return frame(c, "queue", { title: "Queue — top 10", count: all.length || undefined }, body);
}

/* ------------------------------------------------------------------ P6 bugs */
function bugsPanel(c: Ctx): string {
  const s = bugStats(c);
  const lag = lagging(c);
  if (s.open === 0 && lag.length === 0)
    return frame(c, "bugs", { title: "Bugs" }, empty(raw("No open bugs")));
  const tile = (n: number, label: string, cls = "") =>
    h`<div class="tile ${cls}"><b class="mono">${n}</b><span>${label}</span></div>`;
  const total = Math.max(s.open, 1);
  let x = 0;
  const order = ["critical", "high", "medium", "low"];
  const rects = order
    .filter((k) => s.bySev[k] > 0)
    .map((k) => {
      const w = (s.bySev[k] / total) * 100;
      const r = h`<rect class="seg sev-${k}" x="${x.toFixed(2)}" y="0" width="${Math.max(w - 0.6, 0.4).toFixed(2)}" height="6"></rect>`;
      x += w;
      return r;
    });
  const mix = order.map((k) => `${SEV_GLYPH[k]} ${k} ${s.bySev[k]}`).join(" · ");
  const body = h`<div class="tiles">${tile(s.open, "open")}${tile(s.critical, "critical", s.critical ? "crit" : "")}${tile(s.flight, "in flight")}${tile(s.fixed7, "fixed 7 d")}</div>
<svg class="bar" viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label="${mix}">${join(rects)}</svg><p class="mut small">${mix}</p>
${lag.length ? h`<p>${chip(`register lag ${lag.length}`, "warn")}</p><ul class="rows">${join(lag.slice(0, 5).map((t) => h`<li>${taskBtn(t, t.id)} <span>${val(t.status)}</span> ${badge(t.status, c)} <span class="mut">register: ${String(regOf(t, "status"))}</span></li>`))}</ul>` : EMPTY}`;
  return frame(c, "bugs", { title: "Bugs" }, body);
}

/* ------------------------------------------------------------------ P7 PR ledger */
const depText = (d: unknown): string =>
  d === true ? "✓ deployed" : d === false ? "— not deployed" : "? unknown";
function deployCell(p: PrView): string {
  if (p.state !== "merged") return "—";
  if (p.serviceDeployed) {
    const f = (n: string, d: unknown) => `${d === true ? "✓" : d === false ? "—" : "?"} ${n}`;
    return `${f("api", p.serviceDeployed.api)} ${f("web", p.serviceDeployed.web)}`;
  }
  return depText(p.deployed);
}
function prsPanel(c: Ctx): string {
  const open = c.v.prs
    .filter((p) => p.state === "open" || p.state === "draft")
    .sort((a, b) => b.pr - a.pr);
  const recent = (iso: string | null) => !!iso && c.nowMs - Date.parse(iso) <= 7 * DAY;
  const merged = c.v.prs.filter((p) => p.state === "merged" && recent(p.mergedAt));
  const closed = c.v.prs.filter((p) => p.state === "closed" && recent(p.closedAt));
  const ids = (p: PrView) =>
    join(
      [p.links?.task, p.links?.bug, p.links?.feature]
        .filter((x): x is string => !!x)
        .map((id) => linkTask(id, c)),
      " ",
    );
  const rows = open.map(
    (p) =>
      h`<tr><th scope="row" class="mono" title="${p.headRef}">#${p.pr}</th><td class="ttl">${trunc(p.title, 60)}</td><td class="mono">${p.lane}</td><td>${ids(p)}</td><td>${p.state}</td><td>${ciText(p.ci)}</td><td class="c-opt">${p.review}</td><td class="${p.mergeable === "conflicting" ? "bad" : ""}">${p.mergeable}</td><td>${ago(p.createdAt, c)}</td><td class="c-opt">${p.files}</td></tr>`,
  );
  const list = (ps: PrView[], at: (p: PrView) => string | null, verb: string) =>
    ps.length
      ? h`<details class="fold sub" data-fold="prs-${verb}"><summary>${verb} (7 d) · ${ps.length}</summary><ul class="rows">${join(ps.map((p) => h`<li><span class="mono">#${p.pr}</span> ${trunc(p.title, 60)} <span class="mut">${verb} ${ago(at(p), c)} ago</span> <span class="mut">${verb === "merged" ? deployCell(p) : ""}</span></li>`))}</ul></details>`
      : EMPTY;
  const body = open.length
    ? h`<div class="tw"><table class="tbl prs"><thead><tr><th scope="col">PR</th><th scope="col">Title</th><th scope="col">Lane</th><th scope="col">Links</th><th scope="col">State</th><th scope="col">CI</th><th scope="col" class="c-opt">Review</th><th scope="col">Mergeable</th><th scope="col">Age</th><th scope="col" class="c-opt">Files</th></tr></thead><tbody>${join(rows)}</tbody></table></div>`
    : empty(raw("No open PRs"));
  return frame(
    c,
    "prs",
    { title: "Open PRs", count: open.length || undefined, fold: true },
    h`${body}${list(merged, (p) => p.mergedAt, "merged")}${list(closed, (p) => p.closedAt, "closed")}`,
  );
}

/* ------------------------------------------------------------------ P8 overlap, P9 piggyback */
function overlapPanel(c: Ctx): string {
  const rows = c.v.overlap.filter((o) => o.level !== "none");
  const working = Object.values(c.v.lanes).filter((l) => val(l.current));
  const list = h`<ul class="rows ov-list">${join(
    rows.map(
      (o) =>
        h`<li><span class="mono">${o.a} ↔ ${o.b}</span> · ${o.shared} shared · ${chip(o.level, o.level === "HOT" ? "bad" : "warn")} <span class="mut">${o.source ?? ""}</span>${o.paths?.length ? h`<details class="more"><summary>paths</summary><ul>${join(o.paths.slice(0, 10).map((p) => h`<li class="mono">${p}</li>`))}</ul></details>` : EMPTY}</li>`,
    ),
  )}</ul>`;
  let matrix = EMPTY;
  if (rows.length && working.length >= 5) {
    const ids = working.map((l) => l.id).sort(naturalCompare);
    const cell = (a: string, b: string) => {
      const o = rows.find((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a));
      return o
        ? h`<td class="${o.level === "HOT" ? "bad" : "warn"}">${o.shared} ${o.level}</td>`
        : h`<td>–</td>`;
    };
    matrix = h`<div class="tw ov-matrix"><table class="tbl"><thead><tr><th scope="col"><span class="sr">lane</span></th>${join(ids.map((i) => h`<th scope="col" class="mono">${i}</th>`))}</tr></thead><tbody>${join(ids.map((a) => h`<tr><th scope="row" class="mono">${a}</th>${join(ids.map((b) => (a === b ? h`<td>·</td>` : cell(a, b))))}</tr>`))}</tbody></table></div>`;
  }
  const body = rows.length ? h`${matrix}${list}` : empty(raw("No overlapping work"));
  return frame(
    c,
    "overlap",
    { title: "Overlap", count: rows.length || undefined, fold: true },
    body,
  );
}
function piggybackPanel(c: Ctx): string {
  const lanes = sortedIds(c.v.piggyback).filter((l) => (c.v.piggyback[l] ?? []).length);
  const body = lanes.length
    ? join(
        lanes.map((l) => {
          const cur = val(c.v.lanes[l]?.current);
          const area = cur ? (val(c.v.tasks[cur]?.areas) ?? [])[0] : undefined;
          return h`<div class="pig"><p><strong class="mono">${l}</strong>${area ? h` <span class="mut">(${area})</span>` : EMPTY} · ${c.v.piggyback[l].length} cheap win${c.v.piggyback[l].length === 1 ? "" : "s"}</p><ul class="rows">${join(
            c.v.piggyback[l].map(
              (p) =>
                h`<li>${taskBtn(c.v.tasks[p.id], p.id)} ${p.severity ? sevPill(p.severity) : EMPTY} <span class="mut">score ${p.score ?? "—"}</span> ${p.sensitive ? chip("sensitive", "warn") : EMPTY} <span class="ttl">${p.title ?? ""}</span> <button type="button" class="btn" data-act="assign" data-task="${p.id}" data-lane="${l}" data-prev-lane="${val(c.v.tasks[p.id]?.lane) ?? ""}">Assign to ${l}</button></li>`,
            ),
          )}</ul></div>`;
        }),
      )
    : empty(raw("No cheap wins near current work"));
  return frame(c, "piggyback", { title: "Piggyback", fold: true }, body);
}

/* ------------------------------------------------------------------ P10 phases, P11 timeline */
function phasesPanel(c: Ctx): string {
  const fs = laneTasks(c).filter((t) => t.kind === "feature" && val(t.status) === "in-progress");
  const body = fs.length
    ? h`<ul class="rows">${join(
        fs.map((t) => {
          const ph = val(t.phase) ?? null;
          const idx = ph ? (PHASES as readonly string[]).indexOf(ph) : -1;
          const ticks = PHASES.map(
            (_, i) =>
              h`<rect class="tick ${i <= idx ? "on" : ""}" x="${i * 11.2}" y="0" width="10" height="6"></rect>`,
          );
          const pct = idx < 0 ? 0 : Math.round(((idx + 1) / PHASES.length) * 100);
          return h`<li class="phase">${taskBtn(t, t.id)} <span class="ttl">${t.title}</span> <span class="mut">${ph ?? "no phase"}</span><svg class="bar ticks" viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label="${"phase " + (ph ?? "none") + " " + pct + "%"}">${join(ticks)}</svg><span class="mono">${pct}%</span></li>`;
        }),
      )}</ul>`
    : empty(raw("No features in progress"));
  return frame(c, "phases", { title: "Feature phases", fold: true }, body);
}
const VERB: Record<string, string> = {
  "task.started": "started",
  "task.done": "finished",
  "task.released": "released",
  "task.blocked": "blocked",
  "task.unblocked": "unblocked",
  "task.priority": "changed priority of",
  "task.release": "moved release of",
  "task.lane": "reassigned",
  "task.next": "set next",
  "task.dropped": "dropped",
  "task.created": "created",
  "bug.filed": "filed",
  "bug.fixed": "fixed",
  "waste.ack": "acknowledged waste",
  "lane.registered": "registered lane",
  "lane.note": "noted on",
};
function timelinePanel(c: Ctx): string {
  const rows = [...c.v.timeline]
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
    .slice(0, 40);
  const glyph = (by: string) =>
    by === "owner" ? "✎" : by === "sync" || by === "server" ? "⟳" : "◆";
  const body = rows.length
    ? h`<ol class="rows tl">${join(
        rows.map(
          (e) =>
            h`<li><span class="glyph" aria-hidden="true">${glyph(e.by)}</span> <span class="mono">${ago(e.ts, c)}</span> · <span class="mono">${e.lane}</span> · ${Object.hasOwn(VERB, e.type) ? VERB[e.type] : e.type} ${e.task ? linkTask(e.task, c) : e.type === "lane.note" || e.type === "lane.registered" ? h`<span class="mono">${Object.hasOwn(c.v.lanes, e.lane) ? c.v.lanes[e.lane].name || e.lane : e.lane}</span>` : EMPTY} <span class="mut">${e.by}</span></li>`,
        ),
      )}</ol>`
    : empty(raw("No activity yet"));
  return frame(
    c,
    "timeline",
    { title: "Timeline", count: rows.length || undefined, fold: true },
    body,
  );
}

/* ------------------------------------------------------------------ P12 sources footer */
function sourcesPanel(c: Ctx): string {
  const s = c.v.sources;
  const fr = freshness(c);
  const rw = isObj(s.railway) ? s.railway : null;
  const fchip = (f: Fresh): Raw => {
    const age = f.min === null ? (f.level === "off" ? "not connected" : "ok") : `${f.min} min ago`;
    return h`<span class="chip src" data-fresh="${f.level}"><span aria-hidden="true">${f.level === "ok" ? "●" : f.level === "off" ? "○" : "◐"}</span> ${f.name} ${age}${f.extra ? ` · ${f.extra}` : ""}</span>`;
  };
  const body = c.loading
    ? h`<p class="foot">warming up · sources: master ◌ state ◌ GitHub ◌</p>`
    : h`<p class="foot">${chip(h`master ${s.master?.sha ?? "—"}`)} ${chip(h`state ${s.state?.lane ?? "—"}#${s.state?.seq ?? "—"}`)} ${join(fr.map(fchip), " ")}${rw ? h` ${chip(h`Railway api ${rw.api ? "✓" : "✗"} web ${rw.web ? "✓" : "✗"}`)}` : EMPTY} ${chip(h`version ${c.v.version.slice(0, 12) || "—"}`)} <span id="live" class="chip" data-live="on">live ●</span></p>`;
  // loading keeps the h2 and the warming-up line; the skeleton would hide it, so build directly
  return h`<h2 id="h-sources">Sources and freshness</h2>${body}`.s;
}

/* ------------------------------------------------------------------ header lines + banners */
export function headerLines(c: Ctx): Raw[] {
  const line = (key: string, label: string, body: Raw) =>
    h`<p class="line" data-line="${key}"><span class="lbl">${label}</span> ${body}</p>`;
  if (c.loading)
    return [
      line("now", "NOW", raw("—")),
      line("release", "RELEASE", raw("—")),
      line("broken", "BROKEN", raw("—")),
      line("waste", "WASTE", raw("—")),
    ];
  const ls = Object.values(c.v.lanes);
  const working = ls.filter((l) => l.active && val(l.current)).length;
  const blocked = ls.filter((l) => (l.blockers ?? []).length > 0).length;
  const stale = ls.filter((l) => val(l.stale) === "stale").length;
  const now = ls.length
    ? h`${ls.length} lanes · ${working} active · ${blocked ? tone("risk", `${blocked} blocked`) : raw("0 blocked")} · ${stale && !blocked ? tone("warn", `${stale} stale`) : `${stale} stale`}`
    : h`No lanes registered — ${mono("npm run ctl -- lane register …")}`;

  const rel = nextRelease(c);
  let relBody: Raw = raw("No releases");
  if (rel) {
    const rd = readiness(c, rel.id);
    const t: Tone | null = rd.state === "AT RISK" ? "risk" : rd.state === "READY" ? "ok" : null;
    relBody = h`${rel.id} ships ${val(rel.shipDate) ?? "—"} · ${t ? tone(t, rd.state) : rd.state} · ${rd.done}/${rd.total} done`;
  }
  const b = bugStats(c);
  const bro = h`${b.open} open · ${b.critical ? tone("crit", `${b.critical} critical`) : raw("0 critical")} · ${b.flight} in flight`;
  const wn = c.v.waste.length;
  const rules = new Map<string, number>();
  for (const w of c.v.waste) rules.set(w.rule, (rules.get(w.rule) ?? 0) + 1);
  const was = wn
    ? h`${tone("warn", `${wn} at risk`)} (${[...rules].map(([r, n]) => `${r} ×${n}`).join(" · ")})`
    : raw("Nothing at risk");
  return [
    line("now", "NOW", now),
    line("release", "RELEASE", relBody),
    line("broken", "BROKEN", bro),
    line("waste", "WASTE", was),
  ];
}

export function banners(c: Ctx): Raw {
  const out: Raw[] = [];
  for (const f of freshness(c)) {
    if (f.level !== "red" || f.min === null) continue;
    out.push(
      h`<div class="banner red" data-banner="stale" role="status"><strong>${f.name} data is ${f.min} min old</strong>${f.extra ? ` (${f.extra})` : ""} — panels keep the last data.</div>`,
    );
  }
  const w = c.v.warnings;
  if (w.length)
    out.push(
      h`<div class="banner warn" data-banner="warnings" role="status"><button type="button" class="btn dismiss" data-act="dismiss" aria-label="Dismiss">×</button><strong>${w.length} event${w.length === 1 ? "" : "s"} could not be applied</strong><ul>${join(w.slice(0, 10).map((x) => h`<li>${mono(`${x.lane}#${x.seq}`)} ${x.reason}</li>`))}</ul>${w.length > 10 ? h`<p class="mut">+${w.length - 10} more</p>` : EMPTY}</div>`,
    );
  return join(out);
}

/* ------------------------------------------------------------------ public API */
export function ctx(state: unknown, opts: RenderOpts): Ctx {
  const v = view(state);
  const nowMs = Date.parse(opts.now);
  return { v, nowMs, nowIso: opts.now, stale: isStale(v, nowMs), loading: !!opts.loading };
}

const BUILD: Record<PanelKey, (c: Ctx) => string> = {
  lanes: lanesPanel,
  blockers: blockersPanel,
  waste: wastePanel,
  release: releasePanel,
  queue: queuePanel,
  bugs: bugsPanel,
  prs: prsPanel,
  overlap: overlapPanel,
  piggyback: piggybackPanel,
  phases: phasesPanel,
  timeline: timelinePanel,
  sources: sourcesPanel,
};

export function renderFragments(state: unknown, opts: RenderOpts): Fragments {
  const c = ctx(state, opts);
  const out = {} as Fragments;
  for (const k of PANELS) out[k] = BUILD[k](c);
  return out;
}

export const PANEL_TITLES: Record<PanelKey, string> = {
  lanes: "Lanes",
  blockers: "Blockers",
  waste: "Waste",
  release: "Release",
  queue: "Queue",
  bugs: "Bugs",
  prs: "PRs",
  overlap: "Overlap",
  piggyback: "Piggyback",
  phases: "Phases",
  timeline: "Timeline",
  sources: "Sources",
};
