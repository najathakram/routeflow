/**
 * Glue between the pure domain modules and the HTTP layer: normalize the GitHub snapshot, reconcile
 * it with the folded state, derive waste / overlap / piggyback, and stamp the served `version`.
 * No I/O except the optional `git` facts the caller injects.
 */
import { createHash } from "node:crypto";
import { overlapPairs } from "../domain/overlap";
import type { LaneFiles } from "../domain/overlap";
import { piggyback } from "../domain/piggyback";
import type { PiggybackCandidate } from "../domain/piggyback";
import { ciSinceAll, ledgerRows, normalizePRs } from "../domain/prs";
import type { LedgerRow, PRFile } from "../domain/prs";
import { reconcile } from "../domain/reconcile";
import type { ReconciledState } from "../domain/reconcile";
import { isSafeGlob } from "../domain/schema";
import type { ControlState, TimelineEntry } from "../domain/types";
import { wasteItems } from "../domain/waste";
import type { WastePR, WasteTask } from "../domain/waste";
import { branchFacts } from "../sources/poller";
import type { Branch } from "../sources/poller";
import type { Deploys } from "../sources/railway";

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Key-sorted JSON, so the version hash does not depend on insertion order. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x !== null && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => cmp(a, b)))
      : x,
  );
}

/** The `watchPatterns = [...]` array of a railway.toml; never executes or fully parses TOML. */
export function parseWatchPatterns(toml: string): string[] | undefined {
  const m = /^[ \t]*watchPatterns[ \t]*=[ \t]*\[([^\]]*)\]/m.exec(toml);
  if (!m) return undefined;
  const out: string[] = [];
  for (const q of m[1].matchAll(/"([^"\\\n]*)"/g)) if (isSafeGlob(q[1])) out.push(q[1]);
  return out.length > 0 ? out : undefined;
}

export type Level = "ok" | "amber" | "red";
/** Coarse freshness bucket (same thresholds as the footer), so the version only moves on a flip. */
export function level(lastOk: string | null, now: string): Level {
  const t = lastOk === null ? NaN : Date.parse(lastOk);
  const n = Date.parse(now);
  if (!Number.isFinite(t) || !Number.isFinite(n)) return "ok";
  const min = (n - t) / 60_000;
  return min > 10 ? "red" : min > 2 ? "amber" : "ok";
}

export interface SourceFacts {
  githubOkAt: string | null;
  rateRemaining: number | null;
  railwayOkAt: string | null;
  masterSha: string | null;
  stateHead: { lane: string; seq: number } | null;
  warnings: string[];
}

export interface AssembleInput {
  /** `project()` output (no inferred layer yet). */
  projected: ControlState;
  now: string;
  poll: { prs: unknown[]; branches: unknown[]; files: Record<string, PRFile[]> } | null;
  deploys: Deploys | null;
  repoDir?: string;
  reportedAt: Record<string, string>;
  watchPatterns: { api?: string[]; web?: string[] };
  ledger: LedgerRow[];
  relanded: (pr: WastePR) => boolean;
  sensitive: ReadonlySet<string>;
  facts: SourceFacts;
}

export type ServedTask = ReconciledState["tasks"][string] & { history: TimelineEntry[] };
export type ServedState = Omit<ReconciledState, "sources" | "tasks"> & {
  sources: Record<string, unknown>;
  tasks: Record<string, ServedTask>;
};

export interface Assembled {
  state: ServedState;
  ledgerAdds: LedgerRow[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Only objects whose `number` is a positive safe integer ever become a PR (it may reach git). */
export function cleanPrs(raw: unknown[]): Record<string, unknown>[] {
  return raw.filter(
    (n): n is Record<string, unknown> =>
      isObj(n) && typeof n.number === "number" && Number.isSafeInteger(n.number) && n.number > 0,
  );
}

function branchesOf(raw: unknown[], repoDir: string | undefined): Branch[] {
  const ready: Branch[] = [];
  const todo: Array<{ name: string; commit?: { sha?: string } }> = [];
  for (const b of raw) {
    if (!isObj(b) || typeof b.name !== "string") continue;
    if (
      typeof b.oid === "string" &&
      typeof b.committedDate === "string" &&
      typeof b.ahead === "number"
    ) {
      ready.push({ name: b.name, oid: b.oid, committedDate: b.committedDate, ahead: b.ahead });
    } else if (repoDir !== undefined) {
      todo.push(b as { name: string; commit?: { sha?: string } });
    }
  }
  const facts = todo.length > 0 && repoDir !== undefined ? branchFacts(repoDir, todo) : [];
  return [...ready, ...facts].sort((a, b) => cmp(a.name, b.name));
}

const OPEN = new Set(["open", "draft", "ready"]);

export function assemble(i: AssembleInput): Assembled {
  const { projected, now } = i;
  const taskLane = (id: string): string | null =>
    has(projected.tasks, id) ? projected.tasks[id].lane.value : null;
  const normalized: WastePR[] = normalizePRs(cleanPrs(i.poll?.prs ?? []), {
    now,
    files: i.poll?.files ?? {},
    taskLane,
  });
  const ledgerAdds = ledgerRows(i.ledger, normalized, now);
  const fullLedger = [...i.ledger, ...ledgerAdds];
  const since = ciSinceAll(fullLedger);
  const lastAt = new Map<number, string>();
  for (const r of fullLedger) lastAt.set(r.pr, r.at);
  for (const p of normalized) {
    p.ciSince = since.get(p.pr) ?? now;
    p.at = lastAt.get(p.pr) ?? now; // when this PR last changed, so a quiet poll never moves the version
  }

  const branches = branchesOf(i.poll?.branches ?? [], i.repoDir);
  const rec = reconcile(
    projected,
    {
      prs: normalized,
      branches: branches.map((b) => ({ name: b.name, committedDate: b.committedDate })),
      deploys: i.deploys,
      repoDir: i.repoDir,
      reportedAt: i.reportedAt,
      watchPatterns: i.watchPatterns,
    },
    now,
  );

  const doneAt = new Map<string, string>();
  for (const e of rec.timeline) {
    if (
      e.type === "task.done" &&
      e.task &&
      (!doneAt.has(e.task) || e.ts > (doneAt.get(e.task) ?? ""))
    ) {
      doneAt.set(e.task, e.ts);
    }
  }
  const wasteTasks: WasteTask[] = Object.values(rec.tasks).map((t) => ({
    id: t.id,
    status: t.status,
    doneAt: doneAt.get(t.id) ?? null,
  }));
  const waste = wasteItems(
    {
      prs: rec.prs,
      branches,
      tasks: wasteTasks,
      acks: rec.acks,
      superseded: rec.superseded,
      ledger: fullLedger,
      relanded: i.relanded,
    },
    now,
  );

  // overlap + piggyback: a lane's files are its open PRs' diff when it has one, else its declared areas
  const laneFiles = (lane: string): LaneFiles | null => {
    const diff = new Set<string>();
    for (const p of rec.prs) {
      if (p.lane === lane && OPEN.has(p.state)) for (const f of p.filePaths ?? []) diff.add(f);
    }
    if (diff.size > 0) return { lane, files: diff, source: "diff" };
    const l = rec.lanes[lane];
    const cur = l.current.value ?? l.next.value;
    if (cur === null || !has(rec.tasks, cur)) return null;
    const areas = rec.tasks[cur].areas.value;
    return areas.length > 0 ? { lane, files: new Set(areas), source: "declared" } : null;
  };
  const lanesActive = Object.values(rec.lanes)
    .filter((l) => l.active)
    .map((l) => l.id)
    .sort(cmp);
  const files = new Map<string, LaneFiles>();
  for (const id of lanesActive) {
    const f = laneFiles(id);
    if (f) files.set(id, f);
  }
  const overlap = overlapPairs([...files.values()]);
  const candidates: PiggybackCandidate[] = Object.values(rec.tasks).map((t) => ({
    id: t.id,
    kind: t.kind,
    status: t.status.value,
    lane: t.lane.value,
    priority: t.priority.value,
    effort: t.effort,
    severity: t.priority.value === "P3" ? "low" : t.priority.value === "P2" ? "medium" : "high",
    sensitive: i.sensitive.has(t.id),
    files: new Set(t.areas.value),
  }));
  const pig: Record<string, unknown[]> = Object.create(null) as Record<string, unknown[]>;
  for (const [lane, lf] of files) {
    const r = piggyback(lf.files, candidates);
    if (r.items.length === 0) continue;
    pig[lane] = r.items.map((it) => ({
      id: it.id,
      severity: candidates.find((c) => c.id === it.id)?.severity,
      score: it.score,
      sensitive: it.sensitive,
      title: has(rec.tasks, it.id) ? rec.tasks[it.id].title : "",
      ...(it.tag ? { tag: it.tag } : {}),
    }));
  }

  // drawer history: the last 20 timeline entries that name each task (both halves of an undo stay)
  const byTask = new Map<string, TimelineEntry[]>();
  for (const e of rec.timeline) {
    if (e.task) byTask.set(e.task, [...(byTask.get(e.task) ?? []), e]);
  }
  const tasks = Object.create(null) as Record<string, ServedTask>;
  for (const id of Object.keys(rec.tasks)) {
    tasks[id] = { ...rec.tasks[id], history: (byTask.get(id) ?? []).slice(-20) };
  }

  const f = i.facts;
  const sources: Record<string, unknown> = {
    events: projected.sources.events,
    lanes: projected.sources.lanes,
    github: f.githubOkAt ? { lastOk: f.githubOkAt, rateRemaining: f.rateRemaining } : false,
    railway: f.railwayOkAt
      ? { lastOk: f.railwayOkAt, api: i.deploys?.api != null, web: i.deploys?.web != null }
      : false,
    master: { sha: f.masterSha ? f.masterSha.slice(0, 7) : null },
    state: f.stateHead ?? {},
    warnings: f.warnings,
  };
  const withoutVersion: Omit<ServedState, "version"> = {
    ...rec,
    tasks,
    waste,
    overlap,
    piggyback: pig,
    sources,
  };
  const hashable = {
    ...withoutVersion,
    sources: {
      ...sources,
      github: f.githubOkAt ? { level: level(f.githubOkAt, now) } : false,
      railway: f.railwayOkAt
        ? {
            level: level(f.railwayOkAt, now),
            api: i.deploys?.api != null,
            web: i.deploys?.web != null,
          }
        : false,
    },
  };
  const { version: _drop, ...hashBody } = hashable as typeof hashable & { version?: string };
  void _drop;
  const version = createHash("sha256").update(canonicalJson(hashBody)).digest("hex");
  return { state: { ...withoutVersion, version }, ledgerAdds };
}
