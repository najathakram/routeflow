/** Read-through register adapters (spec §2/§3). Pure: never mutate input, never write. */
import type { BaseRelease, BaseTask, Status } from "./types";

export interface AdaptedTask extends BaseTask {
  sensitive?: boolean;
  sensitiveFor?: string[];
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

function bugStatus(register: string): { status: Status; pr?: number } {
  const t = register.trim().toLowerCase();
  const fixed = /^fixed\b/.exec(t);
  if (fixed) {
    const n = /#(\d+)/.exec(register);
    return n ? { status: "code-complete", pr: Number(n[1]) } : { status: "code-complete" };
  }
  if (/^(cleared|refuted|already|duplicate)/.test(t)) return { status: "dropped" };
  return { status: "planned" };
}

export function bugsAsTasks(rows: Row[]): AdaptedTask[] {
  return rows.map((r) => {
    const sev = str(r.severity).toLowerCase();
    const { status, pr } = bugStatus(str(r.register));
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
      phase: typeof r.state === "string" ? r.state : null,
      sensitive: r.sensitive === true,
      sensitiveFor: strArr(r.sensitiveFor),
      source: "register",
    };
    if (pr !== undefined) t.pr = pr;
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
