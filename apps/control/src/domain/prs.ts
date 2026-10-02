/**
 * PR normalization, the append-only PR ledger (spec 5.5) and per-release PR metrics (5.9).
 * Pure: plain objects in, plain objects out; no input is ever mutated.
 */
import { bookkeepingPending, links as parseLinks } from "./trailers";

export type PRState = "draft" | "merged" | "closed" | "ready" | "open";
export type CI = "green" | "red" | "pending" | "none" | "stale";
export type Review = "none" | "approved" | "changes" | "required";
export type Mergeable = "clean" | "conflicting" | "unknown";
export type Deployed = boolean | "unknown";

export interface PRLinks {
  task: string | null;
  bug: string | null;
  feature: string | null;
  defers: string | null;
  issue: number | null;
}

/** A normalized PR: the section 5.5 row fields plus what the waste rules need. */
export interface PR {
  pr: number;
  at: string;
  state: PRState;
  headSha: string;
  mergeSha: string | null;
  lane: string;
  links: PRLinks;
  ci: CI;
  ciSince?: string | null;
  review: Review;
  mergeable: Mergeable;
  files: number;
  /** True when GitHub reports more changed files than the 100 the detail query returns. */
  filesTruncated?: boolean;
  areas: string[];
  deployed: Deployed;
  deployedAt?: string;
  /** Which Railway services this PR's files touch (set by reconcile from injected watchPatterns). */
  touches?: { api: boolean; web: boolean };
  /** Per-service deploy state of the merge sha (set by reconcile). */
  serviceDeployed?: { api: Deployed; web: Deployed };
  deployFailed?: boolean;
  title: string;
  headRef: string;
  baseRef: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  headCommittedAt: string | null;
  filePaths: string[];
  body: string;
  bookkeepingPending: boolean;
  /** Head commit message (lets waste W7b read citations without a second fetch). */
  commitMessages?: string[];
}

export interface PRFile {
  path: string;
  additions?: number;
  deletions?: number;
}

export interface DeployLookup {
  deployed: Deployed;
  deployedAt?: string;
  failed?: boolean;
}

export interface NormalizeCtx {
  now: string;
  /** Files per PR number (string keys), from the per-PR detail query. */
  files: Record<string, PRFile[]>;
  /** Lane of the started task/bug/feature `id`, or null. */
  taskLane(id: string): string | null;
  /** Deploy state of a merge sha. Absent -> `deployed: false`. */
  deploy?(mergeSha: string): DeployLookup;
}

/** The section 5.5 row. */
export type LedgerRow = Pick<
  PR,
  | "pr"
  | "at"
  | "headRef"
  | "state"
  | "headSha"
  | "mergeSha"
  | "lane"
  | "links"
  | "ci"
  | "review"
  | "mergeable"
  | "files"
  | "areas"
  | "deployed"
  | "deployedAt"
>;

type Raw = Record<string, unknown>;

/** Safe path read into untyped JSON: `dig(n, "commits", "nodes", 0)`; undefined when any hop is absent. */
export const dig = (v: unknown, ...path: Array<string | number>): unknown => {
  let cur = v;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
};

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

const CI_MAP: Record<string, CI> = {
  SUCCESS: "green",
  FAILURE: "red",
  ERROR: "red",
  PENDING: "pending",
  EXPECTED: "pending",
};
const REVIEW_MAP: Record<string, Review> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes",
  REVIEW_REQUIRED: "required",
};
const MERGEABLE_MAP: Record<string, Mergeable> = {
  MERGEABLE: "clean",
  CONFLICTING: "conflicting",
  UNKNOWN: "unknown",
};
const pick = <T>(map: Record<string, T>, key: unknown, dflt: T): T =>
  typeof key === "string" && has(map, key) ? map[key] : dflt;

/** Top-level directory of a path; a root-level file is its own area marker ".". */
const areaOf = (p: string): string => {
  const i = p.indexOf("/");
  return i > 0 ? p.slice(0, i) : i === 0 ? "." : ".";
};

/** Only register-shaped ids may reach a caller-supplied lookup (`constructor` must not). */
const TASK_ID = /^(?:RF-\d+|B\d{1,4}|F-\d+|D-\d+)$/;
const safeId = (id: string | null): string | null => (id !== null && TASK_ID.test(id) ? id : null);

function normalizeOne(n: Raw, ctx: NormalizeCtx): PR {
  const number = Number(n.number);
  const commit = (dig(n, "commits", "nodes", 0, "commit") ?? {}) as Raw;
  const rollup = dig(commit, "statusCheckRollup");
  const message = str(commit.message);
  const body = str(n.body);
  const headRef = str(n.headRefName);
  // body trailers first, then the head commit's; first wins inside `links` (body is scanned first)
  const l = parseLinks(`${body}\n${message}`, headRef);
  const links: PRLinks = {
    task: l.task,
    bug: l.bug,
    feature: l.feature,
    defers: l.defers,
    issue: l.issue,
  };
  const rawState = str(n.state).toUpperCase();
  const mergeSha = strOrNull(dig(n, "mergeCommit", "oid"));
  const ci = pick(CI_MAP, dig(rollup, "state"), rollup ? "pending" : "none");
  const review = pick(REVIEW_MAP, n.reviewDecision, "none");
  const mergeable = pick(MERGEABLE_MAP, n.mergeable, "unknown");
  let state: PRState;
  if (rawState === "MERGED" || (n.mergedAt && rawState !== "OPEN")) state = "merged";
  else if (rawState === "CLOSED") state = "closed";
  else if (n.isDraft === true) state = "draft";
  else if (review === "approved" && ci === "green" && mergeable === "clean") state = "ready";
  else state = "open";

  let lane: string | null = l.lane;
  if (!lane) {
    for (const id of [links.task, links.bug, links.feature]) {
      if (safeId(id)) {
        lane = ctx.taskLane(id as string);
        if (lane) break;
      }
    }
  }

  const files =
    has(ctx.files, String(number)) && Array.isArray(ctx.files[String(number)])
      ? ctx.files[String(number)]
      : [];
  const filePaths = [...new Set(files.map((f) => str(f.path)).filter((p) => p !== ""))].sort(cmp);
  const areas = [...new Set(filePaths.map(areaOf))].sort(cmp);
  const changed = typeof n.changedFiles === "number" ? n.changedFiles : null;
  const filesTruncated = changed !== null && changed > files.length;

  let deployed: Deployed = false;
  let deployedAt: string | undefined;
  let deployFailed = false;
  if (state === "merged" && mergeSha && ctx.deploy) {
    const d = ctx.deploy(mergeSha);
    deployed = d.deployed;
    if (d.deployed === true && d.deployedAt) deployedAt = d.deployedAt;
    deployFailed = d.failed === true;
  }

  const row: PR = {
    pr: number,
    at: ctx.now,
    state,
    headSha: str(n.headRefOid),
    mergeSha,
    lane: lane ?? "unattributed",
    links,
    ci,
    review,
    mergeable,
    files: changed !== null ? Math.max(changed, filePaths.length) : filePaths.length,
    filesTruncated,
    areas,
    deployed,
    title: str(n.title),
    headRef,
    baseRef: str(n.baseRefName),
    createdAt: str(n.createdAt),
    updatedAt: str(n.updatedAt),
    mergedAt: strOrNull(n.mergedAt),
    closedAt: strOrNull(n.closedAt),
    headCommittedAt: strOrNull(commit.committedDate),
    filePaths,
    body,
    bookkeepingPending: bookkeepingPending(body, message),
    deployFailed,
    commitMessages: message === "" ? [] : [message],
  };
  if (deployedAt) row.deployedAt = deployedAt;
  return row;
}

/** Raw GraphQL PR nodes -> normalized PRs sorted by PR number ascending. */
export function normalizePRs(raw: Raw[], ctx: NormalizeCtx): PR[] {
  return raw.map((n) => normalizeOne(n, ctx)).sort((a, b) => a.pr - b.pr);
}

/** Key-order-insensitive JSON, so a row re-read from disk compares equal to a fresh one. */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => cmp(a, b)))
      : x,
  );
const sameJson = (a: unknown, b: unknown): boolean => canon(a) === canon(b);

const LEDGER_FIELDS = [
  "state",
  "headSha",
  "mergeSha",
  "lane",
  "links",
  "ci",
  "review",
  "mergeable",
  "files",
  "areas",
  "deployed",
  "deployedAt",
] as const;

const toRow = (p: PR, at: string): LedgerRow => {
  const row: LedgerRow = {
    pr: p.pr,
    at,
    headRef: p.headRef,
    state: p.state,
    headSha: p.headSha,
    mergeSha: p.mergeSha ?? null,
    lane: p.lane,
    links: { ...p.links },
    ci: p.ci,
    review: p.review,
    mergeable: p.mergeable,
    files: p.files,
    areas: [...p.areas],
    deployed: p.deployed,
  };
  if (p.deployedAt) row.deployedAt = p.deployedAt;
  return row;
};

/**
 * NEW ledger rows only: a PR appends when any section 5.5 field differs from the LAST row of that
 * PR (`at` is not compared). A PR absent from `prs` appends nothing.
 */
export function ledgerRows(prev: LedgerRow[], prs: PR[], at: string): LedgerRow[] {
  const last = new Map<number, LedgerRow>();
  for (const r of prev) last.set(r.pr, r); // later rows overwrite: last row wins
  const out: LedgerRow[] = [];
  for (const p of [...prs].sort((a, b) => a.pr - b.pr)) {
    const row = toRow(p, at);
    const before = last.get(p.pr);
    // an "unknown" reading is a failed probe, not a fact: carry the last known value
    if (before) {
      if (row.mergeable === "unknown") row.mergeable = before.mergeable;
      if (row.deployed === "unknown") {
        row.deployed = before.deployed;
        if (before.deployedAt) row.deployedAt = before.deployedAt;
      }
    }
    const changed =
      !before ||
      LEDGER_FIELDS.some(
        (f) =>
          !sameJson(
            (before as Record<string, unknown>)[f] ?? null,
            (row as Record<string, unknown>)[f] ?? null,
          ),
      );
    if (changed) out.push(row);
  }
  return out;
}

/** One pass: PR number -> `at` of the first row of its trailing run with the current ci. */
export function ciSinceAll(
  rows: Array<{ pr: number; at: string; ci: string }>,
): Map<number, string> {
  const run = new Map<number, { ci: string; since: string }>();
  for (const r of rows) {
    const cur = run.get(r.pr);
    if (!cur || cur.ci !== r.ci) run.set(r.pr, { ci: r.ci, since: r.at });
  }
  return new Map([...run].map(([k, v]) => [k, v.since]));
}

/** `at` of the first row of the trailing run of rows (of this PR) with the PR's current ci. */
export function ciSince(
  rows: Array<{ pr: number; at: string; ci: string }>,
  pr: number,
): string | null {
  const mine = rows.filter((r) => r.pr === pr);
  if (mine.length === 0) return null;
  const cur = mine[mine.length - 1].ci;
  let since = mine[mine.length - 1].at;
  for (let i = mine.length - 2; i >= 0 && mine[i].ci === cur; i--) since = mine[i].at;
  return since;
}

/* ------------------------------------------ metrics ------------------------------------------ */

export interface Leg {
  median: number | null;
  p90: number | null;
}
export interface Metrics {
  merged: number;
  closedUnmerged: number;
  count: number;
  closedUnmergedRate: number | null;
  openToMerge: Leg;
  mergeToDeploy: Leg;
  openToDeploy: Leg;
}
export interface ReleaseWindow {
  id: string;
  from: string | null;
  to: string | null;
}

/** Nearest-rank quantile over a numerically sorted series; null when empty. */
const quantile = (xs: number[], q: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
};
const leg = (xs: number[]): Leg => ({ median: quantile(xs, 0.5), p90: quantile(xs, 0.9) });

const inWindow = (iso: string | null, w: ReleaseWindow): boolean => {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return false;
  const from = w.from ? Date.parse(w.from) : -Infinity;
  const to = w.to ? Date.parse(w.to) : Infinity;
  return t >= from && t < to;
};

type MetricPR = Pick<
  PR,
  "pr" | "state" | "createdAt" | "mergedAt" | "closedAt" | "deployed" | "links"
> &
  Partial<Pick<PR, "deployedAt">>;

/**
 * Per-release PR metrics. A PR belongs to a release through its task/bug/feature link's release;
 * without a resolvable link, through `mergedAt` (merged) or `closedAt` (closed unmerged) in the
 * `[from, to)` window. Open and draft PRs count only by link, and never enter rate or lead times.
 */
export function prMetrics(
  prs: MetricPR[],
  releases: ReleaseWindow[],
  taskRelease: (id: string) => string | null,
): Record<string, Metrics> {
  const out: Record<string, Metrics> = Object.create(null) as Record<string, Metrics>;
  const buckets = new Map<string, MetricPR[]>();
  for (const w of releases) buckets.set(w.id, []);

  for (const p of prs) {
    let rel: string | null = null;
    for (const id of [p.links.task, p.links.bug, p.links.feature]) {
      const r = safeId(id) ? taskRelease(id as string) : null;
      if (r && buckets.has(r)) {
        rel = r;
        break;
      }
    }
    if (!rel && (p.state === "merged" || p.state === "closed")) {
      const at = p.state === "merged" ? p.mergedAt : p.closedAt;
      rel = releases.find((w) => inWindow(at, w))?.id ?? null;
    }
    if (rel) buckets.get(rel)?.push(p);
  }

  for (const w of releases) {
    const mine = buckets.get(w.id) ?? [];
    const merged = mine.filter((p) => p.state === "merged");
    const closed = mine.filter((p) => p.state === "closed");
    const o2m: number[] = [];
    const m2d: number[] = [];
    const o2d: number[] = [];
    for (const p of merged) {
      const c = Date.parse(p.createdAt);
      const m = p.mergedAt ? Date.parse(p.mergedAt) : NaN;
      if (Number.isFinite(c) && Number.isFinite(m)) o2m.push(m - c);
      if (p.deployed === true && p.deployedAt && Number.isFinite(m)) {
        const d = Date.parse(p.deployedAt);
        if (Number.isFinite(d)) {
          m2d.push(d - m);
          if (Number.isFinite(c)) o2d.push(d - c);
        }
      }
    }
    const count = merged.length + closed.length;
    out[w.id] = {
      merged: merged.length,
      closedUnmerged: closed.length,
      count,
      closedUnmergedRate: count === 0 ? null : closed.length / count,
      openToMerge: leg(o2m),
      mergeToDeploy: leg(m2d),
      openToDeploy: leg(o2d),
    };
  }
  return out;
}
