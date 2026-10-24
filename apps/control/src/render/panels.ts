/**
 * The 12 command-center panels (ux-spec §3) as server-rendered HTML fragments. Pure: the same
 * state + `now` always gives the same bytes. Every dynamic string goes through the auto-escaping
 * `h` tag (T25); only `raw()` output is trusted. The client never templates; it swaps these.
 *
 * Plain-language pass (owner ruling 2026-09-30): every visible word is written for a reader who is
 * not a programmer. Rule codes (W1..W10), P0..P3, event names and shorthand durations never reach
 * visible text; the domain keeps producing its codes and THIS layer translates them for display,
 * by code, with own-property lookups so an odd value falls back instead of leaking an Object member.
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
  /** The web write path is on (CONTROL_WRITEBACK=on). Default true; false renders "View only". */
  writeback?: boolean;
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

/** What every switched-off write button says (hover text) and the header chip's hover text. */
export const VIEW_ONLY_TITLE = "View only: changes are switched off on this dashboard";
export const VIEW_ONLY_CHIP_TITLE = "Changes are switched off on this dashboard";
/** The extra attributes of a write button: its own title, or disabled + the view-only title. */
const lock = (c: Ctx, title = ""): Raw =>
  c.writeback
    ? title
      ? h` title="${title}"`
      : EMPTY
    : h` disabled aria-disabled="true" title="${VIEW_ONLY_TITLE}"`;

/* ------------------------------------------------------------------ small helpers */
export type Tone = "risk" | "crit" | "warn" | "ok";
interface Ctx {
  v: View;
  nowMs: number;
  nowIso: string;
  stale: boolean;
  loading: boolean;
  writeback: boolean;
}
const val = <T>(d: Derived<T> | null | undefined): T | undefined => d?.value;
const sortedIds = (r: Record<string, unknown>): string[] => Object.keys(r).sort(naturalCompare);
const trunc = (s: string, n: number): string => {
  const cs = [...(typeof s === "string" ? s : "")];
  return cs.length <= n ? cs.join("") : cs.slice(0, n - 1).join("") + "…";
};
const thousands = (n: number): string => `${n}`.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const DAY = 86_400_000;

/** Own-property lookup: "constructor" and friends fall back instead of leaking Object members. */
const pick = <T>(m: Record<string, T>, k: unknown): T | undefined =>
  typeof k === "string" && Object.hasOwn(m, k) ? m[k] : undefined;
/** Text for display from a value that should be a string; anything else reads as nothing. */
const asText = (s: unknown): string =>
  typeof s === "string" || typeof s === "number" ? `${s}` : "";
const lc = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
const cap = (s: unknown): string => asText(s).charAt(0).toUpperCase() + asText(s).slice(1);

/* ---- numbers, dates and durations in words (display only; the data keeps its values) */
/** "1 hour", "5 hours": the noun is singular only for exactly 1. */
export const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;
/** A length of time in everyday words: "3 min", "1 hour", "5 hours", "262 days" (cut-offs as `relTime`). */
export function span(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) return plural(Math.floor(m / 60), "hour");
  return plural(Math.floor(m / 1440), "day");
}
/** "just now" under a minute, otherwise the span and "ago". */
const agoMs = (ms: number): string => (ms < 60_000 ? "just now" : `${span(ms)} ago`);
const absTime = (iso: string): string => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z";
};
/** How long ago, in words: "just now", "5 min ago", "3 hours ago", "262 days ago"; "—" when unknown. */
export const relTime = (iso: string | null | undefined, nowMs: number): string => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) || !Number.isFinite(nowMs) ? "—" : agoMs(nowMs - ms);
};
/** A `<time>` element reading "5 min ago"; the exact UTC time is in its title. */
export const ago = (iso: string | null | undefined, c: Ctx): Raw =>
  iso && !Number.isNaN(Date.parse(iso))
    ? h`<time datetime="${iso}" title="${absTime(iso)}">${relTime(iso, c.nowMs)}</time>`
    : raw("—");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-01-20" gives "20 Jan 2026" (a fixed English month table, no locale); anything else as given. */
export function fmtDate(d: string | null | undefined): string {
  if (typeof d !== "string") return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  const mon = m ? Number(m[2]) : 0;
  const day = m ? Number(m[3]) : 0;
  return m && mon >= 1 && mon <= 12 && day >= 1 && day <= 31
    ? `${day} ${MONTHS[mon - 1]} ${m[1]}`
    : d;
}

/* ---- the words for every coded value (display only; `title=` and the drawer may keep the codes) */
export const PRIO_WORD: Record<string, string> = {
  P0: "Urgent",
  P1: "High",
  P2: "Normal",
  P3: "Low",
};
export const STATUS_WORD: Record<string, string> = {
  planned: "Planned",
  proposed: "Proposed",
  "in-progress": "In progress",
  blocked: "Blocked",
  "code-complete": "Code finished",
  released: "Released",
  reconsider: "Being reconsidered",
  dropped: "Dropped",
};
export const EFFORT_WORD: Record<string, string> = { S: "Small", M: "Medium", L: "Large" };
export const CI_WORD: Record<string, string> = {
  green: "Checks passed",
  red: "Checks failing",
  pending: "Checks running",
  stale: "Checks out of date",
  none: "No checks yet",
};
export const MERGE_WORD: Record<string, string> = {
  clean: "Ready to merge",
  conflicting: "Has conflicts",
  unknown: "Not known yet",
};
export const REVIEW_WORD: Record<string, string> = {
  required: "Needs review",
  changes: "Changes requested",
  approved: "Approved",
  none: "No reviews yet",
};
export const PR_STATE_WORD: Record<string, string> = {
  open: "Open",
  draft: "Draft",
  ready: "Ready",
  merged: "Merged",
  closed: "Closed",
};
export const HB_WORD: Record<string, string> = {
  live: "Active",
  stale: "Quiet",
  silent: "Inactive",
};
export const PHASE_WORD: Record<string, string> = {
  idea: "Idea",
  requirements: "Requirements",
  design: "Design",
  phase1: "Build, part 1",
  phase2: "Build, part 2",
  testing: "Testing",
  qa: "QA",
  rc: "Release candidate",
  released: "Released",
};
export const LEVEL_WORD: Record<string, string> = {
  HOT: "High collision risk",
  WARN: "Possible collision",
};
/** The same level, short, for a table cell ("3 files · high"). */
const LEVEL_SHORT: Record<string, string> = { HOT: "high", WARN: "possible" };
export const READY_WORD: Record<string, string> = {
  READY: "Ready to ship",
  "IN PROGRESS": "In progress",
  "AT RISK": "At risk",
  SHIPPED: "Shipped",
};
const SEV_WORD: Record<string, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** Status as words; an unknown value reads as written, hyphens as spaces. */
const statusWord = (s: unknown): string =>
  typeof s === "string" ? (pick(STATUS_WORD, s) ?? s.replace(/-/g, " ")) : "unknown";
const ciWord = (ci: unknown): string =>
  pick(CI_WORD, ci) ?? `Checks: ${typeof ci === "string" && ci ? ci : "unknown"}`;
const mergeWord = (m: unknown): string =>
  pick(MERGE_WORD, m) ?? (typeof m === "string" && m ? m : MERGE_WORD.unknown);
const reviewWord = (r: unknown): string =>
  pick(REVIEW_WORD, r) ?? (typeof r === "string" && r ? r : "unknown");
const prStateWord = (s: unknown): string =>
  pick(PR_STATE_WORD, s) ?? (typeof s === "string" && s ? s : "unknown");
const levelWord = (l: unknown): string => pick(LEVEL_WORD, l) ?? (typeof l === "string" ? l : "");
/** "Mac", "PC": the machine a lane runs on, capitalised for display. */
const machineWord = (m: unknown): string => (asText(m).toLowerCase() === "pc" ? "PC" : cap(m));

const tone = (t: Tone, text: unknown): Raw => h`<span class="tone" data-tone="${t}">${text}</span>`;
const chip = (text: unknown, cls = "", title = ""): Raw =>
  h`<span class="chip ${cls}"${title ? h` title="${title}"` : EMPTY}>${text}</span>`;
const mono = (text: unknown): Raw => h`<code class="mono">${text}</code>`;
const empty = (copy: Raw): Raw => h`<p class="empty">${copy}</p>`;

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
  s ? h`<span class="pill ${pick(STATUS_KIND, s) ?? "planned"}">${statusWord(s)}</span>` : EMPTY;
const PRIO_KIND: Record<string, string> = { P0: "critical", P1: "high", P2: "medium", P3: "low" };
/** "Urgent", "High", "Normal", "Low"; the code (P0..P3) rides in the hover title only. */
const prioPill = (p: string | undefined): Raw =>
  h`<span class="pill ${pick(PRIO_KIND, p) ?? "low"}"${p ? h` title="${p}"` : EMPTY}>${pick(PRIO_WORD, p) ?? (p || "—")}</span>`;
const sevPill = (s: string): Raw =>
  h`<span class="pill ${pick(SEV_WORD, s) ? s : "low"}">${pick(SEV_WORD, s) ?? cap(s)}</span>`;

const regOf = (t: TaskState, key: string): unknown => {
  const r = t.ref?.["register"];
  return isObj(r) ? r[key] : undefined;
};
/** Primitive to text for attribute values (escaped once, by `h`). */
const plain = (v: unknown): string =>
  typeof v === "string" || typeof v === "number" ? String(v) : "none";
/**
 * Who a value's ref credits: `owner#N` is the owner, `<laneId>#N` a lane (any lane, lead and
 * coordinator lanes included). A lane reads by its name, else its id, else "a lane"; an id that is
 * not a lane of this state (or is an Object member like "constructor") reads as written.
 */
function actorOf(c: Ctx, ref: string): { you: boolean; name: string } {
  if (ref.startsWith("owner#")) return { you: true, name: "you" };
  const id = ref.includes("#") ? ref.slice(0, ref.indexOf("#")) : ref;
  const l = Object.hasOwn(c.v.lanes, id) ? c.v.lanes[id] : undefined;
  const name = typeof l?.name === "string" && l.name ? l.name : id;
  return { you: false, name: name || "a lane" };
}
/** The badge words for a value somebody reported: "Set by you", "Reported by Mac Lead", "Changed by you". */
const reportedWords = (c: Ctx, ref: string, over: boolean): string => {
  const a = actorOf(c, ref);
  return `${over ? "Changed" : a.you ? "Set" : "Reported"} by ${a.name}`;
};
/**
 * Provenance badge: glyph + words, never color alone. `reg` = the register's own value. The ref
 * (and, for a changed value, the register's value) rides in the hover title, not in the words.
 */
function badge(
  d: Derived<unknown> | undefined,
  c: Ctx,
  reg?: unknown,
  loud = false,
  compact = false,
): Raw {
  if (!d) return EMPTY;
  const ref = d.ref ?? "";
  let g = "▤";
  let label = "From the register file";
  let cls = "reg";
  let title = "";
  if (d.source === "reported") {
    const over = reg !== undefined && reg !== d.value;
    g = over ? "✎" : "◆";
    label = reportedWords(c, ref, over);
    cls = over ? "ov" : "rep";
    title = [over ? "register: " + plain(reg) : "", ref].filter(Boolean).join(" · ");
  } else if (d.source === "inferred") {
    g = "⟳";
    label = c.stale ? "Detected earlier — may be out of date" : "Detected from GitHub or Railway";
    cls = "inf";
    title = ref;
  } else if (!loud) return EMPTY;
  // compact (table cells): the glyph alone, the full words in title + aria-label
  if (compact) {
    const full = [label, title].filter(Boolean).join(" · ");
    return h`<span class="badge ${cls}" title="${full}" aria-label="${full}">${g}</span>`;
  }
  return h`<span class="badge ${cls}"${title ? h` title="${title}"` : EMPTY}><span aria-hidden="true">${g}</span> ${label}</span>`;
}

/** Where a task's values came from, in words: the drawer repeats every title=. */
function altText(t: TaskState, c: Ctx): string {
  const out: string[] = [];
  const one = (k: "status" | "priority" | "release", d: Derived<unknown> | undefined) => {
    if (!d || d.source === "register") return;
    const reg = regOf(t, k);
    const how =
      d.source === "inferred"
        ? "detected from GitHub or Railway"
        : lc(reportedWords(c, d.ref ?? "", reg !== undefined && reg !== d.value));
    out.push(`${k} ${how}${reg !== undefined ? ` (register: ${plain(reg)})` : ""}`);
  };
  one("status", t.status);
  one("priority", t.priority);
  one("release", t.release);
  return out.join(" · ");
}

/** A task id that opens the drawer; everything the drawer needs rides as data attributes. */
function taskBtn(c: Ctx, t: TaskState | undefined, id: string): Raw {
  if (!t) return mono(id);
  return h`<button type="button" class="tid mono" data-task="${t.id}" data-title="${t.title}" data-status="${val(t.status)}" data-priority="${val(t.priority)}" data-release="${val(t.release) ?? ""}" data-lane="${val(t.lane) ?? ""}" data-areas="${(val(t.areas) ?? []).join("\n")}" data-pr="${val(t.pr) ?? ""}" data-alt="${altText(t, c)}">${t.id}</button>`;
}
const linkTask = (id: string | null | undefined, c: Ctx): Raw =>
  id ? taskBtn(c, pick(c.v.tasks, id), id) : EMPTY;
/** The task id, muted: still the button that opens the drawer. */
const idTag = (c: Ctx, t: TaskState | undefined, id: string): Raw =>
  h`<span class="idtag">${taskBtn(c, t, id)}</span>`;
/** "Title id": the title first, the id second and muted. A task the page does not know shows its id. */
const titled = (c: Ctx, t: TaskState | undefined, id: string, max = 0): Raw =>
  t
    ? h`<span class="ttl">${max ? trunc(t.title, max) : t.title}</span> ${idTag(c, t, id)}`
    : idTag(c, undefined, id);

const laneTasks = (c: Ctx): TaskState[] => sortedIds(c.v.tasks).map((k) => c.v.tasks[k]);
/** A lane as people read it: its name, else its id; PRs no lane claimed read "No lane". */
const laneName = (c: Ctx, id: string): string => {
  if (id === "unattributed") return "No lane";
  const l = Object.hasOwn(c.v.lanes, id) ? c.v.lanes[id] : undefined;
  return typeof l?.name === "string" && l.name ? l.name : id;
};

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
    gh && typeof gh.rateRemaining === "number"
      ? `${thousands(gh.rateRemaining)} requests left`
      : "";
  return [one("GitHub", s.github, rate), one("Railway", s.railway, "")];
}
const isStale = (v: View, nowMs: number): boolean =>
  freshness({ v, nowMs, nowIso: "", stale: false, loading: false, writeback: true }).some(
    (f) => f.level === "red",
  );

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
  for (const t of open) bySev[pick(SEV_WORD, sev(t)) ? sev(t) : "low"]++;
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
      reason: dependents.has(t.id)
        ? `Unblocks ${dependents.get(t.id)}`
        : (pick(PRIO_WORD, val(t.priority)) ?? val(t.priority) ?? ""),
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
  /** Overrides the heading (default: PANEL_TITLES[key]). */
  title?: string;
  /** The one-sentence purpose line under the heading (default: PANEL_SUBS[key]). */
  sub?: string;
  count?: number;
  fold?: boolean;
}
function frame(c: Ctx, key: PanelKey, o: FrameOpts, body: Raw): string {
  const title = o.title ?? PANEL_TITLES[key];
  const n = o.count !== undefined ? h` <span class="count">${o.count}</span>` : EMPTY;
  const head = h`<h2 id="h-${key}">${title}${n}</h2><p class="panel-sub">${o.sub ?? PANEL_SUBS[key]}</p>`;
  const inner = c.loading
    ? h`<div class="skeleton row"></div><div class="skeleton row"></div><div class="skeleton row short"></div>`
    : body;
  // CSS owns which of Hide / Show is visible; the hidden title keeps every summary's name unique
  if (o.fold)
    return h`${head}<details class="fold" data-fold="${key}" open><summary><span class="when-open">Hide</span><span class="when-closed">Show</span> <span class="sr">${title}</span></summary>${inner}</details>`
      .s;
  return h`${head}${inner}`.s;
}

/* ------------------------------------------------------------------ P1 lane board */
const CI_GLYPH: Record<string, string> = {
  green: "✓",
  red: "✗",
  pending: "◌",
  stale: "⟳",
  none: "–",
};
/** A pull request's checks: a glyph for the eye (hidden from screen readers) and the words. */
const ciCell = (ci: unknown): Raw =>
  h`<span aria-hidden="true">${pick(CI_GLYPH, ci) ?? "?"}</span> ${ciWord(ci)}`;
const HB_GLYPH: Record<string, string> = { live: "●", stale: "◐", silent: "○" };

function prFor(c: Ctx, taskId: string | null | undefined): PrView | undefined {
  if (!taskId) return undefined;
  const open = c.v.prs.filter(
    (p) => p.state === "open" || p.state === "ready" || p.state === "draft",
  );
  return open.find(
    (p) => p.links?.task === taskId || p.links?.bug === taskId || p.links?.feature === taskId,
  );
}
function prChip(p: PrView): Raw {
  const conflict = p.mergeable === "conflicting";
  const merge = p.mergeable === "unknown" ? "Merge status not known yet" : mergeWord(p.mergeable);
  const title = `Review: ${reviewWord(p.review)} · ${plural(p.files, "file")} changed`;
  return h`<span class="chip pr ${conflict ? "bad" : ""}" title="${title}">PR #${p.pr} · ${ciWord(p.ci)} · ${merge}</span>`;
}
function releaseChip(t: TaskState, c: Ctx, compact = false): Raw {
  const rid = val(t.release);
  if (!rid) return EMPTY;
  return h`<span class="chip rel">${rid}</span> ${badge(t.release, c, regOf(t, "release"), false, compact)}`;
}

function laneCard(c: Ctx, l: LaneState): Raw {
  const cur = val(l.current);
  const curT = cur ? pick(c.v.tasks, cur) : undefined;
  const nx = laneNext(c, l);
  const pr = prFor(c, cur);
  const hot = c.v.overlap.filter((o) => o.level !== "none" && (o.a === l.id || o.b === l.id));
  const hb = val(l.stale) ?? "silent";
  const blockers = l.blockers ?? [];
  const current = cur
    ? h`<p class="cur"><span class="lbl">Doing now</span> ${titled(c, curT, cur)} ${curT ? statusPill(val(curT.status)) : EMPTY} ${curT ? badge(curT.status, c) : EMPTY}</p>`
    : h`<p class="cur"><span class="lbl">Doing now</span> <span class="mut">Nothing right now</span></p>`;
  const next = nx
    ? h`<p class="nxt"><span class="lbl">Next up</span> ${nx.explicit ? h`<span class="mut">Chosen next</span>` : h`<span aria-hidden="true">→</span>`} ${titled(c, nx.t, nx.t.id)} ${prioPill(val(nx.t.priority))} ${releaseChip(nx.t, c)}</p>`
    : h`<p class="nxt"><span class="lbl">Next up</span> <span class="mut">Nothing queued for this lane</span></p>`;
  const otherLane = (o: OverlapRow) => laneName(c, o.a === l.id ? o.b : o.a);
  const risk = hot.length
    ? h` ${chip(h`Collision risk with ${otherLane(hot[0])}${hot.length > 1 ? ` and ${hot.length - 1} more` : ""}`, "warn", levelWord(hot[0].level))}`
    : EMPTY;
  return h`<article class="lane" data-lane="${l.id}" data-hb="${hb}">
<div class="lane-h"><strong>${l.name || l.id}</strong> ${asText(l.machine) ? chip(machineWord(l.machine), "", "Machine") : EMPTY} <span class="hb"><span aria-hidden="true">${pick(HB_GLYPH, hb) ?? "○"}</span> ${pick(HB_WORD, hb) ?? hb}${val(l.heartbeat) ? h` · last update ${ago(val(l.heartbeat), c)}` : EMPTY}</span>${risk}</div>
${current}${pr ? h`<p class="prl">${prChip(pr)}</p>` : EMPTY}${next}${join(
    blockers.map(
      (b) =>
        h`<p class="blk"><span aria-hidden="true">⛔</span> Blocked: ${linkTask(b.task, c)} — <span>${b.reason}</span></p>`,
    ),
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
    : empty(
        h`No lanes yet. A lane appears when a Claude session registers it with the ctl tool. <span class="mut">${mono("npm run ctl -- lane register …")}</span>`,
      );
  return frame(c, "lanes", {}, body);
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
        h`<li${b.ref ? h` title="${b.ref}"` : EMPTY}><span aria-hidden="true">⛔</span> ${titled(c, pick(c.v.tasks, b.task), b.task)} (${laneName(c, id)}) — <span>${b.reason}</span></li>`,
      );
  const body = rows.length ? capped(rows, "rows") : empty(raw("Nothing is stuck."));
  return frame(c, "blockers", { count: rows.length || undefined }, body);
}

/** First PR number in a waste subject ("PR #12 + #34" gives 12). */
const prNum = (subject: string): string => /^PR #(\d+)/.exec(subject)?.[1] ?? "";
/** Per rule code: the headline, the noun for the header count (one / many) and the advice sentence. */
export const RULE_LABEL: Record<string, string> = {
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
};
export const RULE_NOUN: Record<string, [string, string]> = {
  W1: ["idle", "idle"],
  W2: ["stale draft", "stale drafts"],
  W3: ["without passing checks", "without passing checks"],
  W4: ["with conflicts", "with conflicts"],
  W5: ["closed without landing", "closed without landing"],
  W6: ["branch without a PR", "branches without a PR"],
  W7: ["merged but not live", "merged but not live"],
  W7b: ["missing docs follow-up", "missing docs follow-ups"],
  W8: ["done without a merge", "done without a merge"],
  W9: ["merged with no task", "merged with no task"],
  W10: ["overlapping", "overlapping"],
};
export const RULE_DO: Record<string, string> = {
  W1: "Update it from master and ask the lane to continue, or close it.",
  W2: "Mark it ready for review, or close it.",
  W3: "Fix the failure or re-run the checks.",
  W4: "Update the branch from master to clear the conflicts.",
  W5: "Rescue the work, or mark the pull request as replaced.",
  W6: "Open a pull request or delete the branch.",
  W7: "Watch the deploy, or redeploy.",
  W7b: "Open the follow-up docs pull request.",
  W8: "Link the merged pull request, or reopen the task.",
  W9: "Add the task link in the follow-up, or dismiss.",
  W10: "Agree who goes first, or rebase in order.",
};
/** Render-only text pass over a waste `why`: "262 d" gives "262 days", "5 h" "5 hours" ("min" stays). */
export function plainWhy(why: unknown): string {
  return (typeof why === "string" ? why : "").replace(/\b(\d+) (d|h)\b/g, (_m, n: string, u) =>
    plural(Number(n), u === "d" ? "day" : "hour"),
  );
}
/** The waste line as a sentence: plain durations, a capital first letter, a full stop at the end. */
export function whyLine(why: unknown): string {
  const t = plainWhy(why).trim();
  if (!t) return "";
  const cap1 = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(cap1) ? cap1 : cap1 + ".";
}
/** What Dismiss does, in the subject's own terms: the ack key holds until that thing changes. */
const dismissTitle = (rule: string): string =>
  `Hide this warning until the ${rule === "W6" ? "branch" : rule === "W8" ? "task" : "pull request"} changes`;
function wastePanel(c: Ctx): string {
  const sorted = [...c.v.waste].sort(
    (a, b) => naturalCompare(a.rule, b.rule) || naturalCompare(a.key, b.key),
  );
  const rows = sorted.map((w) => {
    const todo = pick(RULE_DO, w.rule) ?? w.action;
    const pn = prNum(w.subject);
    return h`<li class="waste" data-key="${w.key}"><span class="glyph" aria-hidden="true">⚠</span> <strong class="w-head"${w.rule ? h` title="${w.rule}"` : EMPTY}>${w.subject} — ${pick(RULE_LABEL, w.rule) ?? "Needs attention"}</strong> <span class="why">${whyLine(w.why)}</span>${w.since && !/\d+ (?:d|h|min)\b/.test(w.why) ? h` <span class="mut">first seen ${ago(w.since, c)}</span>` : EMPTY}${todo ? h` <span class="todo">What to do: ${todo}</span>` : EMPTY} <span class="acts"><button type="button" class="btn" data-act="ack" data-key="${w.key}"${lock(c, dismissTitle(w.rule))}>Dismiss</button>${pn && (w.rule === "W5" || w.rule === "W9") ? h` <button type="button" class="btn" data-act="superseded" data-pr="${pn}"${lock(c, "Say which pull request replaced this one")}>Mark as replaced</button>` : EMPTY}</span></li>`;
  });
  const body = rows.length
    ? capped(rows, "rows")
    : empty(raw("Nothing at risk — every open pull request is moving."));
  return frame(c, "waste", { count: rows.length || undefined }, body);
}

/* ------------------------------------------------------------------ P4 release bar */
const SEGS: { key: string; label: string; match: (s: string) => boolean }[] = [
  { key: "released", label: "released", match: (s) => s === "released" },
  { key: "cc", label: "code finished", match: (s) => s === "code-complete" },
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
  const shown = counts.filter((k) => k.n > 0);
  const label = shown.map((k) => `${k.n} ${k.g.label}`).join(" · ");
  // a keyed legend: each colour in the bar named, with its count
  const key = join(
    shown.map((k) => h`<span class="swatch ${k.g.key}"></span> ${k.n} ${k.g.label}`),
    " · ",
  );
  return h`<svg class="bar" viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label="${label || "No tasks yet"}">${total ? join(rects) : raw('<rect class="seg planned" x="0" y="0" width="100" height="6"></rect>')}</svg><p class="mut small">${total ? key : "No tasks yet"}</p>`;
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
  return `${plural(mine.length, "pull request")}${med ? ` · typically merged within ${med === "1.0" ? "1 day" : `${med} days`}` : ""}${closed ? ` · ${closed} closed without merging` : ""}`;
}
/** "1 of 5 tasks done" (or "no tasks yet"): a release's progress in words. */
const doneText = (rd: { done: number; total: number }): string =>
  rd.total === 0 ? "no tasks yet" : `${rd.done} of ${plural(rd.total, "task")} done`;
/** The ship-date chip of a moved release: the from/to values are DATES. */
const movedText = (m: { from: string | null; to: string | null }): string =>
  m.from && m.to
    ? `Moved from ${fmtDate(m.from)} to ${fmtDate(m.to)}`
    : m.to
      ? `Moved to ${fmtDate(m.to)}`
      : m.from
        ? `Moved from ${fmtDate(m.from)}`
        : "Ship date changed";
function releaseCard(c: Ctx, r: ReleaseState): Raw {
  const rd = readiness(c, r.id);
  const tasks = laneTasks(c).filter((t) => val(t.release) === r.id && val(t.status) !== "dropped");
  const date = val(r.shipDate);
  const metrics = prMetrics(c, r.id);
  return h`<article class="rel" data-release="${r.id}">
<p class="rel-h"><strong class="mono">${r.id}</strong>${r.name && r.name !== r.id ? h` · <span>${r.name}</span>` : EMPTY} · ${date ? h`ships <time datetime="${date}">${fmtDate(date)}</time> ${badge(r.shipDate, c)}` : raw("no ship date set")} · <span class="pill ${pick(READY_KIND, rd.state) ?? "wip"}">${pick(READY_WORD, rd.state) ?? rd.state}</span>${rd.moved ? h` ${chip(movedText(rd.moved), "warn")}` : EMPTY} · <span class="mut">${doneText(rd)}</span></p>
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
      : empty(h`No releases yet — add one in ${mono("releases.jsonl")}.`);
  return frame(c, "release", {}, body);
}

/* ------------------------------------------------------------------ P5 queue */
function queuePanel(c: Ctx): string {
  const all = queue(c);
  const rows = all.slice(0, 10).map(({ t, reason }) => {
    const lane = val(t.lane);
    const prev = lane ? (val(c.v.lanes[lane]?.next) ?? "") : "";
    const who = lane ? laneName(c, lane) : "any lane";
    return h`<tr><td>${prioPill(val(t.priority))}</td><th scope="row">${titled(c, t, t.id)}</th><td class="c-opt">${releaseChip(t, c, true)}</td><td class="c-opt">${pick(EFFORT_WORD, t.effort) ?? t.effort}</td><td>${lane ? laneName(c, lane) : "Any lane"}</td><td class="mut c-opt">${reason}</td><td><button type="button" class="btn" data-act="next" data-task="${t.id}" data-lane="${lane ?? ""}" data-prev="${prev}" aria-label="${`Make ${t.id} the next task for ${who}`}"${lock(c)}>Make next</button></td></tr>`;
  });
  const body = rows.length
    ? h`<div class="tw"><table class="tbl queue"><thead><tr><th scope="col">Priority</th><th scope="col">Task</th><th scope="col" class="c-opt">Release</th><th scope="col" class="c-opt">Size</th><th scope="col">Lane</th><th scope="col" class="c-opt">Why it is here</th><th scope="col"><span class="sr">Action</span></th></tr></thead><tbody>${join(rows)}</tbody></table></div>${all.length > 10 ? h`<p class="mut small">+${all.length - 10} more waiting</p>` : EMPTY}`
    : empty(raw("Nothing waiting — every planned task is already taken."));
  return frame(c, "queue", { count: all.length || undefined }, body);
}

/* ------------------------------------------------------------------ P6 bugs */
function bugsPanel(c: Ctx): string {
  const s = bugStats(c);
  const lag = lagging(c);
  if (s.open === 0 && lag.length === 0) return frame(c, "bugs", {}, empty(raw("No open bugs.")));
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
  const mix = order.map((k) => `${SEV_WORD[k]} ${s.bySev[k]}`).join(" · ");
  const body = h`<div class="tiles">${tile(s.open, "Open bugs")}${tile(s.critical, "Critical", s.critical ? "crit" : "")}${tile(s.flight, "Being fixed")}${tile(s.fixed7, "Fixed in the last 7 days")}</div>
<svg class="bar" viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label="${mix}">${join(rects)}</svg><p class="mut small">${mix}</p>
${lag.length ? h`<p>${chip(`Out of date records: ${lag.length}`, "warn")} <span class="mut">The register file and GitHub disagree about these:</span></p><ul class="rows">${join(lag.slice(0, 5).map((t) => h`<li>${titled(c, t, t.id)} — now ${lc(statusWord(val(t.status)))} (register file says ${lc(statusWord(regOf(t, "status")))}) ${badge(t.status, c)}</li>`))}</ul>` : EMPTY}`;
  return frame(c, "bugs", {}, body);
}

/* ------------------------------------------------------------------ P7 PR ledger */
const depText = (d: unknown): string =>
  d === true ? "Live" : d === false ? "Not live yet" : "Live status unknown";
function deployCell(p: PrView): string {
  if (p.state !== "merged") return "—";
  if (p.serviceDeployed) {
    const f = (n: string, d: unknown) =>
      `${n} ${d === true ? "live" : d === false ? "not live" : "status unknown"}`;
    return `${f("api", p.serviceDeployed.api)} · ${f("web", p.serviceDeployed.web)}`;
  }
  return depText(p.deployed);
}
function prsPanel(c: Ctx): string {
  const open = c.v.prs
    .filter((p) => p.state === "open" || p.state === "ready" || p.state === "draft")
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
      h`<tr><th scope="row" class="mono" title="${p.headRef}">#${p.pr}</th><td class="ttl">${trunc(p.title, 60)}</td><td>${laneName(c, p.lane)}</td><td>${ids(p)}</td><td>${prStateWord(p.state)}</td><td>${ciCell(p.ci)}</td><td class="c-opt">${reviewWord(p.review)}</td><td class="${p.mergeable === "conflicting" ? "bad" : ""}">${mergeWord(p.mergeable)}</td><td>${ago(p.createdAt, c)}</td><td class="c-opt">${p.files}</td></tr>`,
  );
  const list = (
    ps: PrView[],
    at: (p: PrView) => string | null,
    verb: "merged" | "closed",
    title: string,
  ) =>
    ps.length
      ? h`<details class="fold sub" data-fold="prs-${verb}"><summary>${title} · ${ps.length}</summary><ul class="rows">${join(ps.map((p) => h`<li><span class="mono">#${p.pr}</span> ${trunc(p.title, 60)} <span class="mut">— ${verb} ${ago(at(p), c)}</span>${verb === "merged" ? h` <span class="mut">· ${deployCell(p)}</span>` : EMPTY}</li>`))}</ul></details>`
      : EMPTY;
  const body = open.length
    ? h`<div class="tw"><table class="tbl prs"><thead><tr><th scope="col">PR</th><th scope="col">Title</th><th scope="col">Lane</th><th scope="col">Task</th><th scope="col">Status</th><th scope="col">Checks</th><th scope="col" class="c-opt">Review</th><th scope="col">Can merge?</th><th scope="col">Opened</th><th scope="col" class="c-opt">Files changed</th></tr></thead><tbody>${join(rows)}</tbody></table></div>`
    : empty(raw("No open pull requests."));
  return frame(
    c,
    "prs",
    { count: open.length || undefined, fold: true },
    h`${body}${list(merged, (p) => p.mergedAt, "merged", "Merged in the last 7 days")}${list(closed, (p) => p.closedAt, "closed", "Closed in the last 7 days")}`,
  );
}

/* ------------------------------------------------------------------ P8 overlap, P9 piggyback */
function overlapPanel(c: Ctx): string {
  const rows = c.v.overlap.filter((o) => o.level !== "none");
  const working = Object.values(c.v.lanes).filter((l) => val(l.current));
  const files = (n: unknown): string =>
    n === 1
      ? "the same file"
      : typeof n === "number" && n > 1
        ? `${n} of the same files`
        : "the same files";
  const sentence = (o: OverlapRow) =>
    `${laneName(c, o.a)} and ${laneName(c, o.b)} are both changing ${files(o.shared)}`;
  const list = h`<ul class="rows ov-list">${join(
    rows.map(
      (o) =>
        h`<li><span class="ttl">${sentence(o)}</span> — ${chip(levelWord(o.level), o.level === "HOT" ? "bad" : "warn")} <span class="mut">${/\bdiff\b/.test(o.source ?? "") ? "based on the real changes" : "based on planned file areas"}</span>${o.paths?.length ? h`<details class="more"><summary>Files</summary><ul>${join(o.paths.slice(0, 10).map((p) => h`<li class="mono">${p}</li>`))}</ul></details>` : EMPTY}</li>`,
    ),
  )}</ul>`;
  let matrix = EMPTY;
  if (rows.length && working.length >= 5) {
    const ids = working.map((l) => l.id).sort(naturalCompare);
    const cell = (a: string, b: string) => {
      const o = rows.find((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a));
      return o
        ? h`<td class="${o.level === "HOT" ? "bad" : "warn"}">${plural(o.shared, "file")} · ${pick(LEVEL_SHORT, o.level) ?? o.level}</td>`
        : h`<td>–</td>`;
    };
    matrix = h`<div class="tw ov-matrix"><table class="tbl"><thead><tr><th scope="col"><span class="sr">lane</span></th>${join(ids.map((i) => h`<th scope="col">${laneName(c, i)}</th>`))}</tr></thead><tbody>${join(ids.map((a) => h`<tr><th scope="row">${laneName(c, a)}</th>${join(ids.map((b) => (a === b ? h`<td>·</td>` : cell(a, b))))}</tr>`))}</tbody></table></div>`;
  }
  const body = rows.length
    ? h`${matrix}${list}`
    : empty(raw("No lanes are changing the same files."));
  return frame(c, "overlap", { count: rows.length || undefined, fold: true }, body);
}
/** An area as a place, never a pattern: "apps/api/src/invoices/**" reads "apps/api/src/invoices". */
const areaName = (a: unknown): string | undefined => {
  if (typeof a !== "string") return undefined;
  const segs = a.split("/");
  const glob = segs.findIndex((seg) => /[*?[\]{}]/.test(seg));
  return (glob < 0 ? segs : segs.slice(0, glob)).join("/") || undefined;
};
function piggybackPanel(c: Ctx): string {
  const lanes = sortedIds(c.v.piggyback).filter((l) => (c.v.piggyback[l] ?? []).length);
  const body = lanes.length
    ? join(
        lanes.map((l) => {
          const cur = val(c.v.lanes[l]?.current);
          const area = areaName(cur ? (val(c.v.tasks[cur]?.areas) ?? [])[0] : undefined);
          const who = laneName(c, l);
          return h`<div class="pig"><p><strong>${who}</strong>${area ? h` <span class="mut">(${area})</span>` : EMPTY} · ${plural(c.v.piggyback[l].length, "quick win")}</p><ul class="rows">${join(
            c.v.piggyback[l].map((p) => {
              const t = pick(c.v.tasks, p.id);
              const title = p.title ?? t?.title ?? "";
              return h`<li>${title ? h`<span class="ttl">${title}</span> ` : EMPTY}${idTag(c, t, p.id)} ${p.severity ? sevPill(p.severity) : EMPTY} <span class="mut">Value score ${p.score ?? "—"}</span> ${p.sensitive ? chip("Sensitive", "warn") : EMPTY} <button type="button" class="btn" data-act="assign" data-task="${p.id}" data-lane="${l}" data-prev-lane="${val(t?.lane) ?? ""}"${lock(c)}>Give to ${who}</button></li>`;
            }),
          )}</ul></div>`;
        }),
      )
    : empty(raw("No quick wins near current work."));
  return frame(c, "piggyback", { fold: true }, body);
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
          const step =
            idx >= 0
              ? `Step ${idx + 1} of ${PHASES.length} · ${pick(PHASE_WORD, ph) ?? ph}`
              : ph
                ? cap(ph)
                : "Not started";
          return h`<li class="phase"><span class="ttl">${t.title}</span> ${idTag(c, t, t.id)} <span class="mut">${step}</span><svg class="bar ticks" viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label="${step + " · " + pct + "%"}">${join(ticks)}</svg><span class="mono">${pct}%</span></li>`;
        }),
      )}</ul>`
    : empty(raw("No features are being built right now."));
  return frame(c, "phases", { fold: true }, body);
}
/**
 * What each timeline entry says happened, for every event type in the schema (plus the one the
 * inference layer adds). A trailing ":" means a task follows; with nothing to name it is dropped.
 */
export const VERB: Record<string, string> = {
  "lane.registered": "registered lane",
  "task.created": "created",
  "task.proposed": "proposed",
  "task.adopted": "adopted",
  "task.started": "started",
  "task.progress": "moved on to the next step of",
  "task.blocked": "blocked",
  "task.unblocked": "unblocked",
  "task.done": "finished",
  "task.released": "released",
  "task.reopened": "reopened",
  "task.priority": "changed the priority of",
  "task.release": "moved to another release:",
  "task.lane": "gave to another lane:",
  "task.next": "chose the next task:",
  "task.reconsider": "put up for reconsideration:",
  "task.areas": "changed the file areas of",
  "task.dropped": "dropped",
  "bug.filed": "filed bug",
  "bug.fixed": "fixed bug",
  "release.created": "created a release",
  "release.moved": "moved the ship date of a release",
  "release.shipped": "shipped a release",
  "pr.superseded": "marked a pull request as replaced",
  "waste.ack": "dismissed a warning:",
  "lane.note": "left a note in",
  "inferred.status": "had its status updated automatically:",
};
/** An event type this page has no sentence for reads as plain words: "foo.bar-baz" gives "foo bar baz". */
const humanize = (type: unknown): string => asText(type).replace(/[.-]/g, " ");
/** The verb with nothing to name after it: a trailing ":" or a dangling "of" / "in" is dropped. */
const bare = (verb: string): string => verb.replace(/:$/, "").replace(/ (?:of|in)$/, "");
/** Who did it: the owner is "You", the sync/server/inference layers are "An automatic check". */
const AUTO_BY = new Set(["sync", "server", "infer"]);
function timelineLine(c: Ctx, e: TimelineEntry): Raw {
  const verb = pick(VERB, e.type) ?? humanize(e.type);
  const t = e.task ? pick(c.v.tasks, e.task) : undefined;
  const when = ago(e.ts, c);
  const mark = e.by === "owner" ? "✎" : e.by === "sync" || e.by === "server" ? "⟳" : "◆";
  const glyph = h`<span class="glyph" aria-hidden="true">${mark}</span>`;
  // the one type whose verb names the task as its subject ("<task> had its status updated ...")
  if (e.type === "inferred.status")
    return h`<li>${glyph} ${when} — ${e.task ? titled(c, t, e.task, 60) : raw("A task")} ${bare(verb)}</li>`;
  const actor =
    e.by === "owner" ? "You" : AUTO_BY.has(e.by) ? "An automatic check" : laneName(c, e.lane);
  let object = EMPTY;
  if (e.task) object = titled(c, t, e.task, 60);
  else if (e.type === "lane.registered" || e.type === "lane.note") {
    const lane = laneName(c, e.lane);
    // a lane leaving a note in itself reads "Lane B left a note", not "... in Lane B"
    if (e.type === "lane.registered" || lane !== actor)
      object = h`<span class="ttl">${lane}</span>`;
  }
  const said = object === EMPTY ? bare(verb) : verb;
  return h`<li>${glyph} ${when} — ${actor} ${said}${object === EMPTY ? EMPTY : h` ${object}`}</li>`;
}
function timelinePanel(c: Ctx): string {
  const rows = [...c.v.timeline]
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
    .slice(0, 40);
  const body = rows.length
    ? h`<ol class="rows tl">${join(rows.map((e) => timelineLine(c, e)))}</ol>`
    : empty(raw("No activity yet. Changes appear here as lanes report them."));
  return frame(c, "timeline", { count: rows.length || undefined, fold: true }, body);
}

/* ------------------------------------------------------------------ P12 sources footer */
function sourcesPanel(c: Ctx): string {
  const s = c.v.sources;
  const fr = freshness(c);
  const rw = isObj(s.railway) ? s.railway : null;
  const fchip = (f: Fresh): Raw => {
    const age =
      f.min === null
        ? f.level === "off"
          ? "not connected"
          : "connected"
        : `updated ${agoMs(f.min * 60_000)}`;
    return h`<span class="chip src" data-fresh="${f.level}"><span aria-hidden="true">${f.level === "ok" ? "●" : f.level === "off" ? "○" : "◐"}</span> ${f.name} · ${age}${f.extra ? ` · ${f.extra}` : ""}</span>`;
  };
  const live = (up: boolean | undefined) =>
    up ? h`live <span aria-hidden="true">✓</span>` : h`not live <span aria-hidden="true">✗</span>`;
  const lastEvent =
    s.state?.lane !== undefined || s.state?.seq !== undefined
      ? `${s.state.lane !== undefined ? laneName(c, s.state.lane) : "—"} #${s.state.seq ?? "—"}`
      : "—";
  const body = c.loading
    ? h`<p class="foot">Warming up — loading GitHub and Railway data.</p>`
    : h`<p class="foot">${chip(h`Latest code on master: ${asText(s.master?.sha).slice(0, 7) || "—"}`)} ${chip(h`Last event written: ${lastEvent}`, "", "the newest line on the state branch")} ${join(fr.map(fchip), " ")}${rw ? h` ${chip(h`api ${live(rw.api)} · web ${live(rw.web)}`)}` : EMPTY} ${chip(h`Dashboard version ${c.v.version.slice(0, 7) || "—"}`)} <span id="live" class="chip" data-live="on">Live — updates automatically</span></p>`;
  // loading keeps the h2 and the warming-up line; the skeleton would hide it, so build directly
  return h`<h2 id="h-sources">${PANEL_TITLES.sources}</h2><p class="panel-sub">${PANEL_SUBS.sources}</p>${body}`
    .s;
}

/* ------------------------------------------------------------------ header lines + banners */
/** Lane counts shared by the header line and the attention headline. */
function laneFacts(c: Ctx) {
  const ls = Object.values(c.v.lanes);
  return {
    total: ls.length,
    working: ls.filter((l) => l.active && val(l.current)).length,
    blocked: ls.filter((l) => (l.blockers ?? []).length > 0).length,
    stale: ls.filter((l) => val(l.stale) === "stale").length,
  };
}
/** The one-sentence answer at the top: what, if anything, needs the owner's attention. */
function attention(c: Ctx): Raw {
  const f = laneFacts(c);
  const b = bugStats(c);
  const rel = nextRelease(c);
  const relRisk = rel !== null && readiness(c, rel.id).state === "AT RISK";
  const items: string[] = [];
  if (f.blocked) items.push(plural(f.blocked, "blocked lane"));
  if (b.critical) items.push(plural(b.critical, "critical bug"));
  if (rel && relRisk) items.push(`Release ${rel.id} at risk`);
  if (c.v.waste.length)
    items.push(`${plural(c.v.waste.length, "piece")} of work at risk of being wasted`);
  if (f.stale) items.push(plural(f.stale, "lane gone quiet", "lanes gone quiet"));
  for (const s of freshness(c)) if (s.level === "red") items.push(`${s.name} data is old`);
  const level = f.blocked || b.critical || relRisk ? "risk" : items.length ? "warn" : "ok";
  const sentence = items.length
    ? `Needs your attention: ${items.join(" · ")}.`
    : "All clear — nothing needs your attention.";
  return h`<p class="attn" data-level="${level}">${sentence}</p>`;
}
export function headerLines(c: Ctx): Raw[] {
  const line = (key: string, label: string, body: Raw) =>
    h`<p class="line" data-line="${key}"><span class="lbl">${label}</span> ${body}</p>`;
  if (c.loading)
    return [
      h`<p class="attn">Loading the latest numbers…</p>`,
      line("now", "Lanes", raw("—")),
      line("release", "Next release", raw("—")),
      line("broken", "Bugs", raw("—")),
      line("waste", "Work at risk", raw("—")),
    ];
  const f = laneFacts(c);
  const now = f.total
    ? h`${plural(f.total, "lane")} · ${f.working} working now · ${f.blocked ? tone("risk", `${f.blocked} blocked`) : raw("0 blocked")} · ${f.stale && !f.blocked ? tone("warn", `${f.stale} gone quiet`) : `${f.stale} gone quiet`}`
    : raw("No lanes yet");

  const rel = nextRelease(c);
  let relBody: Raw = raw("No releases yet");
  if (rel) {
    const rd = readiness(c, rel.id);
    const t: Tone | null = rd.state === "AT RISK" ? "risk" : rd.state === "READY" ? "ok" : null;
    const state = pick(READY_WORD, rd.state) ?? rd.state;
    const date = val(rel.shipDate);
    relBody = h`${rel.id} ${date ? h`ships ${fmtDate(date)}` : raw("has no ship date set")} · ${t ? tone(t, state) : state} · ${doneText(rd)}`;
  }
  const b = bugStats(c);
  const bro = h`${b.open} open · ${b.critical ? tone("crit", `${b.critical} critical`) : raw("0 critical")} · ${b.flight} being fixed`;
  const wn = c.v.waste.length;
  const rules = new Map<string, number>();
  for (const w of c.v.waste) rules.set(w.rule, (rules.get(w.rule) ?? 0) + 1);
  const noun = (r: string, n: number): string => {
    const forms = pick(RULE_NOUN, r);
    return forms ? forms[n === 1 ? 0 : 1] : "other";
  };
  const was = wn
    ? h`${tone("warn", `${wn} at risk`)} — ${[...rules].map(([r, n]) => `${n} ${noun(r, n)}`).join(", ")}`
    : raw("Nothing at risk");
  return [
    attention(c),
    line("now", "Lanes", now),
    line("release", "Next release", relBody),
    line("broken", "Bugs", bro),
    line("waste", "Work at risk", was),
  ];
}

export function banners(c: Ctx): Raw {
  const out: Raw[] = [];
  for (const f of freshness(c)) {
    if (f.level !== "red" || f.min === null) continue;
    out.push(
      h`<div class="banner red" data-banner="stale" role="status"><strong>${f.name} has not updated for ${plural(f.min, "minute")}, so the numbers below may be out of date.</strong></div>`,
    );
  }
  const w = c.v.warnings;
  if (w.length)
    out.push(
      h`<div class="banner warn" data-banner="warnings" role="status"><button type="button" class="btn dismiss" data-act="dismiss" aria-label="Dismiss">×</button><strong>${plural(w.length, "update")} from the lanes could not be read — the rest of the page is fine.</strong><ul>${join(w.slice(0, 10).map((x) => h`<li>${mono(`${x.lane} #${x.seq}`)}: ${x.reason}</li>`))}</ul>${w.length > 10 ? h`<p class="mut">+${w.length - 10} more</p>` : EMPTY}</div>`,
    );
  return join(out);
}

/* ------------------------------------------------------------------ public API */
export function ctx(state: unknown, opts: RenderOpts): Ctx {
  const v = view(state);
  const nowMs = Date.parse(opts.now);
  return {
    v,
    nowMs,
    nowIso: opts.now,
    stale: isStale(v, nowMs),
    loading: !!opts.loading,
    writeback: opts.writeback !== false,
  };
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

/** The heading of each panel (also what the page announces and names the folds by). */
export const PANEL_TITLES: Record<PanelKey, string> = {
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
};
/** The one-sentence purpose line under each heading. */
export const PANEL_SUBS: Record<PanelKey, string> = {
  lanes: "Each lane shows what it is working on now and what it will do next.",
  blockers: "Tasks that cannot move until something else happens.",
  waste:
    "Pull requests and branches that are going stale, conflicting or never reached production. Each row says why and what to do. Dismiss hides a warning until the pull request changes.",
  release: "How close each release is to its ship date.",
  queue:
    'The ten most important tasks nobody has started. "Make next" puts a task at the front of its lane.',
  bugs: "Open bugs by how serious they are.",
  prs: "Every open pull request, with its checks and whether it can merge.",
  overlap: "Two lanes changing the same files will collide when they merge.",
  piggyback:
    "Small tasks in the same files a lane is already changing, so they are cheap to do at the same time.",
  phases: "Where each feature that is being built is in the process.",
  timeline: "The latest changes, newest first.",
  sources: "If a source looks old, the numbers above may be behind.",
};
