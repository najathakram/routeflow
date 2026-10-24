/** Read-through register adapters (spec §2/§3). Pure: never mutate input, never write. */
import type { BaseRelease, BaseTask, Status } from "./types";

export interface AdaptedTask extends BaseTask {
  sensitive?: boolean;
  sensitiveFor?: string[];
  /** All PRs named by a "Fixed" register row (`pr` is the first). */
  prs?: number[];
  /** Campaign shard says fixed while the register row still reads Open (WP5 §5.7). */
  registerLag?: boolean;
  source?: "register";
}

export interface RegisterTask {
  id: string;
  status: Status;
  release: string | null;
}

export type Row = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const nullMap = <T>(o: Record<string, T>): Record<string, T> =>
  Object.assign(Object.create(null) as Record<string, T>, o);

const FEATURE_STATUS = nullMap<Status>({
  done: "released",
  "in-progress": "in-progress",
  "at-risk": "in-progress",
  planned: "planned",
});

const SEVERITY = nullMap<string>({
  critical: "P0",
  high: "P1",
  medium: "P2",
  low: "P3",
});

const EXTENSIONLESS_FILES = new Set([
  "Dockerfile",
  "Makefile",
  "Procfile",
  "LICENSE",
  "CODEOWNERS",
  "Caddyfile",
]);

/** Spec §3 regex, verbatim. */
// eslint-disable-next-line no-useless-escape
const PATH_TOKEN = /(apps|packages|scripts)\/[A-Za-z0-9_.\/()\[\]-]+/g;

export function locationAreas(location: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of str(location).matchAll(PATH_TOKEN)) {
    let p = m[0]
      .replace(/\(~\d+\)$/, "")
      .replace(/\(+$/, "")
      .replace(/:\d+(-\d+)?$/, "");
    while (p.endsWith(")") && (p.match(/\)/g) ?? []).length > (p.match(/\(/g) ?? []).length) {
      p = p.slice(0, -1);
    }
    if (p.endsWith("/")) p += "**";
    else {
      const last = p.slice(p.lastIndexOf("/") + 1);
      if (!last.includes(".") && !EXTENSIONLESS_FILES.has(last)) p += "/**";
    }
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

export function featuresAsTasks(rows: Row[]): AdaptedTask[] {
  return rows.map((r) => {
    const s = str(r.status);
    return {
      id: str(r.id),
      title: str(r.name) || str(r.title),
      kind: "feature",
      status: Object.hasOwn(FEATURE_STATUS, s) ? FEATURE_STATUS[s] : "planned",
      priority: str(r.priority) || "P2",
      release: typeof r.release === "string" ? r.release : null,
      areas: str(r.area) ? [str(r.area)] : [],
      dependsOn: strArr(r.dependsOn),
      related: [],
      lane: null,
      phase: null,
      source: "register",
    };
  });
}

function bugStatus(register: string): { status: Status; pr?: number; prs?: number[] } {
  const t = register.trim().toLowerCase();
  const fixed = /^fixed\b/.exec(t);
  if (fixed) {
    const prs = [...register.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
    return prs.length ? { status: "code-complete", pr: prs[0], prs } : { status: "code-complete" };
  }
  if (/^(cleared|refuted|already|duplicate)/.test(t)) return { status: "dropped" };
  return { status: "planned" };
}

const SHARD_FIXED = new Set(["done", "already-fixed", "proven", "proven-pending-deploy"]);

export function bugsAsTasks(rows: Row[], shards?: ReadonlyMap<string, Row>): AdaptedTask[] {
  return rows.map((r) => {
    const sev = str(r.severity).toLowerCase();
    const { status, pr, prs } = bugStatus(str(r.register));
    const t: AdaptedTask = {
      id: str(r.id),
      title: str(r.title),
      kind: "bug",
      status,
      priority: Object.hasOwn(SEVERITY, sev) ? SEVERITY[sev] : "P3",
      release: null,
      areas: locationAreas(str(r.location)),
      dependsOn: [],
      related: [],
      lane: null,
      phase: null,
      sensitive: r.sensitive === true,
      sensitiveFor: strArr(r.sensitiveFor),
      source: "register",
    };
    if (pr !== undefined) t.pr = pr;
    if (prs !== undefined) t.prs = prs;
    const sh = shards?.get(t.id);
    if (sh) {
      const state = str(sh.state);
      if (state) t.phase = state;
      if (typeof sh.pr === "number" && t.pr === undefined) t.pr = sh.pr;
      if (t.status === "planned" && SHARD_FIXED.has(state)) {
        t.status = "code-complete";
        t.registerLag = true;
      }
    }
    return t;
  });
}

export function deferredAsTasks(rows: Row[]): AdaptedTask[] {
  return rows.map((r) => ({
    id: str(r.id),
    title: str(r.title),
    kind: "deferred",
    status: str(r.status) === "open" ? "reconsider" : "dropped",
    priority: "P3",
    release: null,
    areas: [],
    dependsOn: [],
    related: [r.fromFeature, r.fromBug].filter((x): x is string => typeof x === "string"),
    lane: null,
    phase: null,
    source: "register",
  }));
}

export function releasesFromRegister(rows: Row[]): BaseRelease[] {
  return rows.map((r) => ({
    id: str(r.id),
    name: str(r.name),
    shipDate: typeof r.shipDate === "string" ? r.shipDate : null,
    status: str(r.status),
    goal: typeof r.goal === "string" ? r.goal : null,
  }));
}

export function registerTasks(tasks: BaseTask[]): RegisterTask[] {
  return tasks.map((t) => ({ id: t.id, status: t.status, release: t.release ?? null }));
}
