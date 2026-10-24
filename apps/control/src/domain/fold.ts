import { createHash } from "node:crypto";
import { EVENT_OF, step, stepBugFixed } from "./transitions";
import type { Track } from "./transitions";
import type {
  BaseTask,
  ControlEvent,
  ControlState,
  Derived,
  FoldBase,
  GithubSnapshot,
  LaneKind,
  LaneState,
  RailwaySnapshot,
  ReleaseState,
  Status,
  TaskState,
  Warning,
} from "./types";

/** Code-unit comparison: locale-independent, so order and `version` never depend on ICU. */
export const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// total order (spec §4): ts, then sync|server|infer after the rest, then lane, then seq
const rank = (by: string) => (by === "sync" || by === "server" || by === "infer" ? 1 : 0);
export const eventOrder = (
  a: Pick<ControlEvent, "ts" | "by" | "lane" | "seq">,
  b: Pick<ControlEvent, "ts" | "by" | "lane" | "seq">,
): number =>
  cmpStr(a.ts, b.ts) || rank(a.by) - rank(b.by) || cmpStr(a.lane, b.lane) || a.seq - b.seq;

const HOUR_MS = 3_600_000;

const refOf = (ev: ControlEvent): string => `${ev.lane}#${ev.seq}`;
const rep = <T>(value: T, ev: ControlEvent): Derived<T> => ({
  value,
  source: "reported",
  ref: refOf(ev),
});
const reg = <T>(value: T, id: string): Derived<T> => ({
  value,
  source: "register",
  ref: `register:${id}`,
});

const str = (ev: ControlEvent, k: string): string | null => {
  const v = ev[k];
  return typeof v === "string" ? v : null;
};
const strArr = (ev: ControlEvent, k: string): string[] | null => {
  const v = ev[k];
  return Array.isArray(v) && (v as unknown[]).every((x) => typeof x === "string")
    ? (v as string[])
    : null;
};

/** Stable JSON: object keys sorted recursively, undefined dropped. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return (v as unknown[]).map(canonical);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out = Object.create(null) as Record<string, unknown>;
    for (const k of Object.keys(o).sort()) {
      if (o[k] !== undefined) out[k] = canonical(o[k]);
    }
    return out;
  }
  return v;
}

function taskFromBase(b: BaseTask): TaskState {
  return {
    id: b.id,
    title: b.title,
    kind: b.kind,
    status: reg(b.status, b.id),
    priority: reg(b.priority, b.id),
    release: reg(b.release, b.id),
    lane: reg(b.lane, b.id),
    phase: reg(b.phase, b.id),
    areas: reg([...b.areas], b.id),
    dependsOn: [...b.dependsOn],
    related: reg([...b.related], b.id),
    effort: b.effort ?? "M",
    importance: b.importance ?? 3,
    customerImpact: b.customerImpact ?? "none",
    ref: b.ref ?? null,
    notes: b.notes ?? null,
    pr: reg(b.pr ?? null, b.id),
  };
}

type TaskField = "status" | "priority" | "release" | "lane" | "phase" | "areas" | "related" | "pr";
type ReleaseField = "status" | "shipDate";
/** A provenance-wrapped value stored raw: [value, ref]; the source is always "reported". */
type Tup<T> = [T, string | null];
const wrap = <T>(t: Tup<T>): Derived<T> => ({ value: t[0], source: "reported", ref: t[1] });
const unwrap = <T>(d: Derived<T>): Tup<T> => [d.value, d.ref];

/** An event-minted task with raw values; defaults are omitted (spec §8 keeps the snapshot small). */
export interface CreatedRaw {
  t: string;
  k: string;
  s: Tup<Status>;
  p: Tup<string>;
  r: Tup<string | null>;
  l: Tup<string | null>;
  h: Tup<string | null>;
  a: Tup<string[]>;
  x: Tup<string[]>;
  q: Tup<number | null>;
  d?: string[];
  e?: string;
  i?: number;
  c?: string;
  f?: Record<string, unknown>;
  n?: string;
}

const rowOf = (t: TaskState): CreatedRaw => {
  const row: CreatedRaw = {
    t: t.title,
    k: t.kind,
    s: unwrap(t.status),
    p: unwrap(t.priority),
    r: unwrap(t.release),
    l: unwrap(t.lane),
    h: unwrap(t.phase),
    a: unwrap(t.areas),
    x: unwrap(t.related),
    q: unwrap(t.pr),
  };
  if (t.dependsOn.length > 0) row.d = t.dependsOn;
  if (t.effort !== "M") row.e = t.effort;
  if (t.importance !== 3) row.i = t.importance;
  if (t.customerImpact !== "none") row.c = t.customerImpact;
  if (t.ref !== null) row.f = t.ref;
  if (t.notes !== null) row.n = t.notes;
  return row;
};

const taskOfRow = (id: string, w: CreatedRaw): TaskState => ({
  id,
  title: w.t,
  kind: w.k,
  status: wrap(w.s),
  priority: wrap(w.p),
  release: wrap(w.r),
  lane: wrap(w.l),
  phase: wrap(w.h),
  areas: wrap(w.a),
  dependsOn: w.d ?? [],
  related: wrap(w.x),
  effort: w.e ?? "M",
  importance: w.i ?? 3,
  customerImpact: w.c ?? "none",
  ref: w.f ?? null,
  notes: w.n ?? null,
  pr: wrap(w.q),
});

const ovFromRaw = (
  o: Partial<Record<TaskField, Tup<unknown>>>,
): Partial<Pick<TaskState, TaskField>> => {
  const out: Record<string, Derived<unknown>> = {};
  for (const f of Object.keys(o) as TaskField[]) {
    const v = o[f];
    if (v) out[f] = wrap(v);
  }
  return out;
};

const WARNINGS_CAP = 2000;
const TIMELINE_CAP = 200;

/**
 * Everything the events did, independent of register data (spec §8 resume contract). Plain JSON:
 * it round-trips through a snapshot. Register rows stay in `project()`; the acc holds only what an
 * event set (per-field overlays for register tasks, whole rows for event-minted ones).
 */
export interface FoldAcc {
  v: 1;
  /** Status-machine track, only for tasks an event touched. */
  tracks: Record<string, Track>;
  /** Fields an event set on a register task. */
  taskOv: Record<string, Partial<Record<TaskField, Tup<unknown>>>>;
  /** Tasks minted by events (task.created / task.proposed), as raw values (see CreatedRaw). */
  created: Record<string, CreatedRaw>;
  lanes: Record<string, LaneState>;
  alias: Record<string, string>;
  releaseOv: Record<string, Partial<Pick<ReleaseState, ReleaseField>>>;
  releaseHistory: Record<string, ReleaseState["history"]>;
  releasesCreated: Record<string, ReleaseState>;
  acks: ControlState["acks"];
  superseded: ControlState["superseded"];
  timeline: ControlState["timeline"];
  warnings: Warning[];
  eventCount: number;
  /** Validation resume: minted RF ids, proposed tmp ids, and each task's release. */
  mintedIds: string[];
  proposedIds: string[];
  taskRelease: Record<string, string | null>;
  lastByLane: Record<string, { seq: number; ts: string }>;
  maxTs: string;
}

const emptyAcc = (): FoldAcc => ({
  v: 1,
  tracks: {},
  taskOv: {},
  created: {},
  lanes: {},
  alias: {},
  releaseOv: {},
  releaseHistory: {},
  releasesCreated: {},
  acks: {},
  superseded: {},
  timeline: [],
  warnings: [],
  eventCount: 0,
  mintedIds: [],
  proposedIds: [],
  taskRelease: {},
  lastByLane: {},
  maxTs: "",
});

/** Copy into a prototype-less map (keys are validated ids; defineProperty never hits __proto__). */
function toMap<T>(src: Record<string, T>): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  for (const k of Object.keys(src)) {
    Object.defineProperty(out, k, {
      value: src[k],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * foldEvents(acc|null, base, eventsByLane) -> acc. Pure: no clock, no github/railway. Applies the
 * given events (in total order) on top of `acc`; events must sort after everything already in it.
 * `base` is read only to decide whether an event applies (existence, starting status).
 */
export function foldEvents(
  prev: FoldAcc | null,
  base: FoldBase,
  eventsByLane: Record<string, ControlEvent[]>,
): FoldAcc {
  const acc: FoldAcc = prev ? structuredClone(prev) : emptyAcc();
  const tasks = Object.create(null) as Record<string, TaskState>;
  const tracks = new Map<string, Track>();
  const dirtyTracks = new Set<string>(Object.keys(acc.tracks));
  for (const b of base.tasks) {
    tasks[b.id] = taskFromBase(b);
    tracks.set(b.id, { status: b.status, prior: null, lane: null });
  }
  const createdIds = new Set<string>(Object.keys(acc.created));
  for (const id of Object.keys(acc.taskOv)) {
    if (tasks[id]) Object.assign(tasks[id], ovFromRaw(acc.taskOv[id]));
  }
  for (const id of Object.keys(acc.created)) tasks[id] = taskOfRow(id, acc.created[id]);
  for (const id of Object.keys(acc.tracks)) tracks.set(id, acc.tracks[id]);
  const marks = new Map<string, Set<TaskField>>();
  for (const id of Object.keys(acc.taskOv)) {
    marks.set(id, new Set(Object.keys(acc.taskOv[id]) as TaskField[]));
  }
  const mk = (id: string, f: TaskField) => {
    let m = marks.get(id);
    if (!m) marks.set(id, (m = new Set()));
    m.add(f);
    dirtyTracks.add(id);
  };
  const setTrack = tracks.set.bind(tracks);
  tracks.set = (k: string, v: Track) => {
    dirtyTracks.add(k);
    return setTrack(k, v);
  };

  const releases = Object.create(null) as Record<string, ReleaseState>;
  for (const r of base.releases) {
    releases[r.id] = {
      id: r.id,
      name: r.name,
      status: reg(r.status, r.id),
      shipDate: reg(r.shipDate, r.id),
      goal: r.goal ?? null,
      history: [],
    };
  }
  const rmarks = new Map<string, Set<ReleaseField>>();
  for (const id of Object.keys(acc.releaseOv)) {
    if (releases[id]) Object.assign(releases[id], acc.releaseOv[id]);
    rmarks.set(id, new Set(Object.keys(acc.releaseOv[id]) as ReleaseField[]));
  }
  for (const id of Object.keys(acc.releaseHistory)) {
    if (releases[id]) releases[id].history = acc.releaseHistory[id];
  }
  const createdRel = new Set<string>(Object.keys(acc.releasesCreated));
  for (const id of createdRel) releases[id] = acc.releasesCreated[id];
  const rmk = (id: string, f: ReleaseField) => {
    let m = rmarks.get(id);
    if (!m) rmarks.set(id, (m = new Set()));
    m.add(f);
  };

  const lanes = toMap(acc.lanes);
  const alias = new Map<string, string>(Object.entries(acc.alias));
  const warnings: Warning[] = acc.warnings;
  const timeline: ControlState["timeline"] = acc.timeline;
  const acks = toMap(acc.acks);
  const superseded = toMap(acc.superseded);
  const minted = new Set<string>(acc.mintedIds);
  const proposedSet = new Set<string>(acc.proposedIds);

  const ensureLane = (id: string): LaneState => {
    let l = lanes[id];
    if (!l) {
      l = {
        id,
        name: id,
        machine: "",
        kind: "unregistered",
        active: true,
        current: { value: null, source: "reported", ref: null },
        next: { value: null, source: "reported", ref: null },
        blockers: [],
        heartbeat: { value: null, source: "reported", ref: null },
        stale: { value: "live", source: "reported", ref: null },
      };
      lanes[id] = l;
    }
    return l;
  };
  const clearCurrent = (id: string, ev: ControlEvent) => {
    for (const l of Object.values(lanes)) if (l.current.value === id) l.current = rep(null, ev);
  };
  const dropBlockers = (id: string) => {
    for (const l of Object.values(lanes)) l.blockers = l.blockers.filter((b) => b.task !== id);
  };
  const trackOf = (id: string): Track =>
    tracks.get(id) ?? { status: tasks[id].status.value, prior: null, lane: null };

  const flat: ControlEvent[] = [];
  for (const evs of Object.values(eventsByLane)) {
    for (const e of evs) if (e.type !== "segment") flat.push(e);
  }
  flat.sort(eventOrder);

  for (const ev of flat) {
    const warn = (reason: string) => warnings.push({ lane: ev.lane, seq: ev.seq, reason });
    const lane = ensureLane(ev.lane);
    lane.heartbeat = rep(ev.ts, ev);
    const seen = acc.lastByLane[ev.lane];
    if (!seen || ev.seq >= seen.seq) acc.lastByLane[ev.lane] = { seq: ev.seq, ts: ev.ts };
    if (ev.ts > acc.maxTs) acc.maxTs = ev.ts;
    const find = (key: string): string | null => {
      const raw = str(ev, key);
      if (raw === null) {
        warn(`missing ${key}`);
        return null;
      }
      const id = alias.get(raw) ?? raw;
      if (!tasks[id]) {
        warn(`unknown task ${raw}`);
        return null;
      }
      return id;
    };
    let subject: string | null = null;
    let applied = true;

    if (ev.type in EVENT_OF) {
      const id = find("task");
      subject = id;
      if (id === null) {
        applied = false;
      } else {
        const res = step(trackOf(id), ev.type, ev.by, ev.lane);
        if (!res.ok) {
          warn(res.reason);
          applied = false;
        } else {
          const t = tasks[id];
          tracks.set(id, res.track);
          t.status = rep<Status>(res.track.status, ev);
          mk(id, "status");
          if (res.track.status !== "blocked") dropBlockers(id);
          switch (ev.type) {
            case "task.started":
              t.lane = rep(ev.lane, ev);
              mk(id, "lane");
              lane.current = rep(id, ev);
              break;
            case "task.done": {
              const pr = ev.pr;
              if (typeof pr === "number") {
                t.pr = rep<number | null>(pr, ev);
                mk(id, "pr");
              }
              clearCurrent(id, ev);
              break;
            }
            case "task.released": {
              const rel = str(ev, "release");
              if (rel !== null) {
                t.release = rep(rel, ev);
                mk(id, "release");
              }
              clearCurrent(id, ev);
              break;
            }
            case "task.blocked":
              dropBlockers(id);
              lane.blockers.push({ task: id, reason: str(ev, "reason") ?? "", ref: refOf(ev) });
              break;
            case "task.reopened":
              t.lane = rep(null, ev);
              mk(id, "lane");
              clearCurrent(id, ev);
              break;
            case "task.reconsider":
            case "task.dropped":
              clearCurrent(id, ev);
              break;
            default:
              break;
          }
        }
      }
    } else {
      switch (ev.type) {
        case "lane.registered": {
          const laneId = str(ev, "laneId");
          if (laneId === null) {
            warn("missing laneId");
            applied = false;
            break;
          }
          const l = ensureLane(laneId);
          l.name = str(ev, "name") ?? l.name;
          l.machine = str(ev, "machine") ?? l.machine;
          l.kind = (str(ev, "kind") as LaneKind | null) ?? l.kind;
          l.active = ev.active === false ? false : true;
          break;
        }
        case "task.created": {
          const id = str(ev, "id");
          if (id === null) {
            warn("missing id");
            applied = false;
          } else if (tasks[id]) {
            warn(`duplicate task ${id}`);
            applied = false;
          } else {
            subject = id;
            tasks[id] = {
              id,
              title: str(ev, "title") ?? id,
              kind: str(ev, "kind") ?? "chore",
              status: rep<Status>("planned", ev),
              priority: rep(str(ev, "priority") ?? "P2", ev),
              release: rep(str(ev, "release"), ev),
              lane: rep(null, ev),
              phase: rep(null, ev),
              areas: rep(strArr(ev, "areas") ?? [], ev),
              dependsOn: strArr(ev, "dependsOn") ?? [],
              related: rep(strArr(ev, "related") ?? [], ev),
              effort: str(ev, "effort") ?? "M",
              importance: typeof ev.importance === "number" ? ev.importance : 3,
              customerImpact: str(ev, "customerImpact") ?? "none",
              ref:
                ev.ref !== null && typeof ev.ref === "object"
                  ? (ev.ref as Record<string, unknown>)
                  : null,
              notes: str(ev, "notes"),
              pr: rep<number | null>(null, ev),
            };
            tracks.set(id, { status: "planned", prior: null, lane: null });
            createdIds.add(id);
            minted.add(id);
          }
          break;
        }
        case "task.proposed": {
          const id = str(ev, "tmpId");
          if (id === null) {
            warn("missing tmpId");
            applied = false;
          } else if (tasks[id]) {
            warn(`duplicate task ${id}`);
            applied = false;
          } else {
            subject = id;
            tasks[id] = {
              id,
              title: str(ev, "title") ?? id,
              kind: str(ev, "kind") ?? "chore",
              status: rep<Status>("proposed", ev),
              priority: rep(str(ev, "priority") ?? "P2", ev),
              release: rep(null, ev),
              lane: rep(ev.lane, ev),
              phase: rep(null, ev),
              areas: rep(strArr(ev, "areas") ?? [], ev),
              dependsOn: [],
              related: rep<string[]>([], ev),
              effort: "M",
              importance: 3,
              customerImpact: "none",
              ref: null,
              notes: null,
              pr: rep<number | null>(null, ev),
            };
            tracks.set(id, { status: "proposed", prior: null, lane: null });
            createdIds.add(id);
            proposedSet.add(id);
          }
          break;
        }
        case "task.adopted": {
          const tmp = str(ev, "tmpId");
          const id = find("task");
          if (tmp === null || !tasks[tmp] || tasks[tmp].status.value !== "proposed") {
            warn(`unknown task ${String(tmp)}`);
            applied = false;
          } else if (id !== null) {
            subject = id;
            alias.set(tmp, id);
            delete tasks[tmp];
            tracks.delete(tmp);
            dirtyTracks.delete(tmp);
            createdIds.delete(tmp);
            marks.delete(tmp);
          } else applied = false;
          break;
        }
        case "task.progress": {
          const id = find("task");
          subject = id;
          const phase = str(ev, "phase");
          if (id === null) applied = false;
          else if (phase === null) {
            warn("missing phase");
            applied = false;
          } else {
            tasks[id].phase = rep(phase, ev);
            mk(id, "phase");
          }
          break;
        }
        case "task.priority": {
          const id = find("task");
          subject = id;
          const p = str(ev, "priority");
          if (id === null) applied = false;
          else if (p === null) {
            warn("missing priority");
            applied = false;
          } else {
            tasks[id].priority = rep(p, ev);
            mk(id, "priority");
          }
          break;
        }
        case "task.release": {
          const id = find("task");
          subject = id;
          if (id === null) {
            applied = false;
            break;
          }
          const to = str(ev, "release");
          const from = tasks[id].release.value;
          tasks[id].release = rep(to, ev);
          mk(id, "release");
          for (const rid of new Set([from, to])) {
            if (rid !== null && releases[rid]) {
              releases[rid].history.push({
                ref: refOf(ev),
                ts: ev.ts,
                type: ev.type,
                task: id,
                from,
                to,
              });
            }
          }
          break;
        }
        case "task.lane": {
          const id = find("task");
          subject = id;
          if (id === null) applied = false;
          else if (!("toLane" in ev)) {
            warn("missing toLane");
            applied = false;
          } else {
            const to = str(ev, "toLane");
            tasks[id].lane = rep(to, ev);
            mk(id, "lane");
            tracks.set(id, { ...trackOf(id), lane: to });
          }
          break;
        }
        case "task.next": {
          const target = ensureLane(str(ev, "targetLane") ?? ev.lane);
          if (ev.task === null) target.next = rep(null, ev);
          else {
            const id = find("task");
            subject = id;
            if (id === null) applied = false;
            else target.next = rep(id, ev);
          }
          break;
        }
        case "task.areas": {
          const id = find("task");
          subject = id;
          const a = strArr(ev, "areas");
          if (id === null) applied = false;
          else if (a === null) {
            warn("missing areas");
            applied = false;
          } else {
            tasks[id].areas = rep(a, ev);
            mk(id, "areas");
          }
          break;
        }
        case "bug.filed": {
          const bug = find("bug");
          subject = bug;
          if (bug === null) applied = false;
          else if (ev.task !== undefined) {
            const other = find("task");
            if (other === null) applied = false;
            else {
              const link = (a: string, b: string) => {
                if (!tasks[a].related.value.includes(b)) {
                  tasks[a].related = rep([...tasks[a].related.value, b], ev);
                  mk(a, "related");
                }
              };
              link(bug, other);
              link(other, bug);
            }
          }
          break;
        }
        case "bug.fixed": {
          const bug = find("bug");
          subject = bug;
          if (bug === null) {
            applied = false;
            break;
          }
          const res = stepBugFixed(trackOf(bug));
          if (!res.ok) {
            warn(res.reason);
            applied = false;
            break;
          }
          tracks.set(bug, res.track);
          tasks[bug].status = rep<Status>("code-complete", ev);
          mk(bug, "status");
          if (typeof ev.pr === "number") {
            tasks[bug].pr = rep<number | null>(ev.pr, ev);
            mk(bug, "pr");
          }
          dropBlockers(bug);
          clearCurrent(bug, ev);
          break;
        }
        case "release.created": {
          const id = str(ev, "id");
          if (id === null) {
            warn("missing id");
            applied = false;
          } else if (releases[id]) {
            warn(`duplicate release ${id}`);
            applied = false;
          } else {
            releases[id] = {
              id,
              name: str(ev, "name") ?? id,
              status: rep("planned", ev),
              shipDate: rep(str(ev, "shipDate"), ev),
              goal: str(ev, "goal"),
              history: [],
            };
            createdRel.add(id);
          }
          break;
        }
        case "release.moved": {
          const id = str(ev, "release");
          if (id === null || !releases[id]) {
            warn(`unknown release ${String(id)}`);
            applied = false;
            break;
          }
          const from = releases[id].shipDate.value;
          const to = str(ev, "shipDate");
          releases[id].shipDate = rep(to, ev);
          rmk(id, "shipDate");
          releases[id].history.push({
            ref: refOf(ev),
            ts: ev.ts,
            type: ev.type,
            task: null,
            from,
            to,
          });
          break;
        }
        case "release.shipped": {
          const id = str(ev, "release");
          if (id === null || !releases[id]) {
            warn(`unknown release ${String(id)}`);
            applied = false;
            break;
          }
          releases[id].status = rep("shipped", ev);
          rmk(id, "status");
          for (const t of Object.values(tasks)) {
            if (t.release.value === id && t.status.value === "code-complete") {
              const res = step(trackOf(t.id), "task.released", ev.by, ev.lane);
              if (res.ok) {
                tracks.set(t.id, res.track);
                t.status = rep<Status>("released", ev);
                mk(t.id, "status");
              }
            }
          }
          break;
        }
        case "pr.superseded": {
          const pr = ev.pr;
          if (typeof pr !== "number") {
            warn("missing pr");
            applied = false;
          } else {
            superseded[String(pr)] = {
              by: ev.supersededBy ?? null,
              why: str(ev, "why"),
              ref: refOf(ev),
            };
          }
          break;
        }
        case "waste.ack": {
          const key = str(ev, "key");
          if (key === null) {
            warn("missing key");
            applied = false;
          } else acks[key] = { key, until: str(ev, "until"), why: str(ev, "why"), ref: refOf(ev) };
          break;
        }
        case "lane.note":
          break;
        default:
          warn(`unknown type ${ev.type}`);
          applied = false;
      }
    }
    if (applied) {
      timeline.push({
        ts: ev.ts,
        lane: ev.lane,
        seq: ev.seq,
        type: ev.type,
        task: subject,
        by: ev.by,
      });
    }
  }

  // dehydrate: only what events set; register data is never frozen in
  const taskOv: Record<string, Partial<Pick<TaskState, TaskField>>> = {};
  for (const [id, fields] of marks) {
    if (!tasks[id] || createdIds.has(id)) continue;
    const o: Record<string, unknown> = {};
    for (const f of [...fields].sort()) o[f] = tasks[id][f];
    taskOv[id] = o;
  }
  const created: Record<string, TaskState> = {};
  for (const id of createdIds) if (tasks[id]) created[id] = tasks[id];
  const outTracks: FoldAcc["tracks"] = {};
  for (const id of dirtyTracks) {
    const t = tracks.get(id);
    if (t) outTracks[id] = t;
  }
  const releaseOv: FoldAcc["releaseOv"] = {};
  for (const [id, fields] of rmarks) {
    if (!releases[id] || createdRel.has(id)) continue;
    const o: Record<string, unknown> = {};
    for (const f of [...fields].sort()) o[f] = releases[id][f];
    releaseOv[id] = o;
  }
  const releaseHistory: FoldAcc["releaseHistory"] = {};
  const releasesCreated: FoldAcc["releasesCreated"] = {};
  for (const id of Object.keys(releases)) {
    if (createdRel.has(id)) releasesCreated[id] = releases[id];
    else if (releases[id].history.length > 0) releaseHistory[id] = releases[id].history;
  }
  const taskRelease: FoldAcc["taskRelease"] = {};
  for (const id of Object.keys(taskOv)) {
    if (taskOv[id].release) taskRelease[id] = taskOv[id].release.value;
  }
  for (const id of Object.keys(created)) taskRelease[id] = created[id].release.value;

  acc.tracks = outTracks;
  acc.taskOv = {};
  for (const id of Object.keys(taskOv)) {
    const o: Partial<Record<TaskField, Tup<unknown>>> = {};
    for (const f of Object.keys(taskOv[id]) as TaskField[]) {
      const d = taskOv[id][f] as Derived<unknown> | undefined;
      if (d) o[f] = unwrap(d);
    }
    acc.taskOv[id] = o;
  }
  acc.created = {};
  for (const id of Object.keys(created)) acc.created[id] = rowOf(created[id]);
  acc.lanes = { ...lanes };
  acc.alias = Object.fromEntries(alias);
  acc.releaseOv = releaseOv;
  acc.releaseHistory = releaseHistory;
  acc.releasesCreated = releasesCreated;
  acc.acks = { ...acks };
  acc.superseded = { ...superseded };
  acc.timeline = timeline.slice(-TIMELINE_CAP);
  acc.warnings = warnings.slice(-WARNINGS_CAP);
  acc.eventCount += flat.length;
  acc.mintedIds = [...minted].sort(cmpStr);
  acc.proposedIds = [...proposedSet].sort(cmpStr);
  acc.taskRelease = taskRelease;
  return acc;
}

/**
 * project(acc, base, github, railway, now) -> state (spec §4). Adds the register layer and the
 * clock: stale calculation and the `version` hash. The acc is not modified.
 */
export function project(
  prev: FoldAcc,
  base: FoldBase,
  github: GithubSnapshot,
  railway: RailwaySnapshot,
  now: string,
): ControlState {
  const acc = structuredClone(prev);
  const tasks = Object.create(null) as Record<string, TaskState>;
  for (const b of base.tasks) {
    const t = taskFromBase(b);
    const ov = acc.taskOv[b.id];
    if (ov) Object.assign(t, ovFromRaw(ov));
    tasks[b.id] = t;
  }
  for (const id of Object.keys(acc.created)) tasks[id] = taskOfRow(id, acc.created[id]);
  const releases = Object.create(null) as Record<string, ReleaseState>;
  for (const r of base.releases) {
    const rel: ReleaseState = {
      id: r.id,
      name: r.name,
      status: reg(r.status, r.id),
      shipDate: reg(r.shipDate, r.id),
      goal: r.goal ?? null,
      history: acc.releaseHistory[r.id] ?? [],
    };
    const ov = acc.releaseOv[r.id];
    if (ov) Object.assign(rel, ov);
    releases[r.id] = rel;
  }
  for (const id of Object.keys(acc.releasesCreated)) releases[id] = acc.releasesCreated[id];
  const lanes = toMap(acc.lanes);
  const nowMs = Date.parse(now);
  for (const l of Object.values(lanes)) {
    const hb = l.heartbeat.value === null ? NaN : Date.parse(l.heartbeat.value);
    const age = Number.isNaN(hb) || Number.isNaN(nowMs) ? 0 : nowMs - hb;
    const value = age > 72 * HOUR_MS ? "silent" : age > 24 * HOUR_MS ? "stale" : "live";
    l.stale = { value, source: "reported", ref: l.heartbeat.ref };
  }

  const body = canonical({
    tasks,
    lanes,
    releases,
    prs: [],
    branches: [],
    waste: [],
    overlap: [],
    piggyback: {},
    acks: acc.acks,
    superseded: acc.superseded,
    timeline: acc.timeline.slice(-TIMELINE_CAP),
    warnings: acc.warnings,
    sources: {
      events: acc.eventCount,
      lanes: Object.keys(lanes).length,
      github: github !== null,
      railway: railway !== null,
    },
  }) as Omit<ControlState, "version">;
  const version = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return { ...body, version };
}

/**
 * fold(base, eventsByLane, github, railway, now) -> state (spec §4): project(foldEvents(null)).
 * Deterministic: events are applied in total order, output keys are sorted, `version` is the
 * sha256 of the canonical JSON. Never throws on identified data: an unapplicable event becomes a
 * `warnings` entry. The inferred layer (github/railway) lands with WP5; both are ignored here.
 */
export function fold(
  base: FoldBase,
  eventsByLane: Record<string, ControlEvent[]>,
  github: GithubSnapshot,
  railway: RailwaySnapshot,
  now: string,
): ControlState {
  return project(foldEvents(null, base, eventsByLane), base, github, railway, now);
}

const INFERRED_EMITTERS = new Set(["infer", "sync", "server"]);

/**
 * Newest agent-reported status-event `ts` per task (status events and `bug.fixed`). Reconciliation
 * uses it so a decision reported AFTER a PR merged (e.g. `task.reopened`) is never overridden by
 * inference. Additive: it does not touch the fold output.
 */
export function reportedStatusAt(
  eventsByLane: Record<string, ControlEvent[]>,
): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const evs of Object.values(eventsByLane)) {
    for (const e of evs) {
      if (INFERRED_EMITTERS.has(e.by)) continue;
      const key = e.type === "bug.fixed" ? "bug" : e.type in EVENT_OF ? "task" : null;
      const id = key === null ? null : str(e, key);
      if (id !== null && typeof e.ts === "string" && (out[id] === undefined || e.ts > out[id])) {
        out[id] = e.ts;
      }
    }
  }
  return out;
}
