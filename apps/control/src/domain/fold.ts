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

// total order (spec §4): ts, then sync|server|infer after the rest, then lane, then seq
const rank = (by: string) => (by === "sync" || by === "server" || by === "infer" ? 1 : 0);
export const eventOrder = (
  a: Pick<ControlEvent, "ts" | "by" | "lane" | "seq">,
  b: Pick<ControlEvent, "ts" | "by" | "lane" | "seq">,
): number =>
  a.ts.localeCompare(b.ts) ||
  rank(a.by) - rank(b.by) ||
  a.lane.localeCompare(b.lane) ||
  a.seq - b.seq;

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
    const out: Record<string, unknown> = {};
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
    related: [...b.related],
    effort: b.effort ?? "M",
    importance: b.importance ?? 3,
    customerImpact: b.customerImpact ?? "none",
    ref: b.ref ?? null,
    notes: b.notes ?? null,
    pr: b.pr ?? null,
  };
}

/**
 * fold(base, eventsByLane, github, railway, now) -> state (spec §4). Deterministic: events are
 * applied in total order, output keys are sorted, `version` is the sha256 of the canonical JSON.
 * Never throws on identified data: an unapplicable event becomes a `warnings` entry. The inferred
 * layer (github/railway) lands with WP5; both are accepted and ignored here.
 */
export function fold(
  base: FoldBase,
  eventsByLane: Record<string, ControlEvent[]>,
  github: GithubSnapshot,
  railway: RailwaySnapshot,
  now: string,
): ControlState {
  const tasks: Record<string, TaskState> = {};
  const tracks = new Map<string, Track>();
  for (const b of base.tasks) {
    tasks[b.id] = taskFromBase(b);
    tracks.set(b.id, { status: b.status, prior: null, lane: null });
  }
  const releases: Record<string, ReleaseState> = {};
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
  const lanes: Record<string, LaneState> = {};
  const alias = new Map<string, string>();
  const warnings: Warning[] = [];
  const timeline: ControlState["timeline"] = [];
  const acks: ControlState["acks"] = {};
  const superseded: ControlState["superseded"] = {};

  const ensureLane = (id: string): LaneState => {
    let l = lanes[id];
    if (!l) {
      l = {
        id,
        name: id,
        machine: "",
        kind: "unregistered",
        active: true,
        current: { value: null, source: "register", ref: null },
        next: { value: null, source: "register", ref: null },
        blockers: [],
        heartbeat: { value: null, source: "register", ref: null },
        stale: { value: "live", source: "register", ref: null },
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
          if (res.track.status !== "blocked") dropBlockers(id);
          switch (ev.type) {
            case "task.started":
              t.lane = rep(ev.lane, ev);
              lane.current = rep(id, ev);
              break;
            case "task.done": {
              const pr = ev.pr;
              if (typeof pr === "number") t.pr = pr;
              clearCurrent(id, ev);
              break;
            }
            case "task.released": {
              const rel = str(ev, "release");
              if (rel !== null) t.release = rep(rel, ev);
              clearCurrent(id, ev);
              break;
            }
            case "task.blocked":
              dropBlockers(id);
              lane.blockers.push({ task: id, reason: str(ev, "reason") ?? "", ref: refOf(ev) });
              break;
            case "task.reopened":
              t.lane = rep(null, ev);
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
              related: strArr(ev, "related") ?? [],
              effort: str(ev, "effort") ?? "M",
              importance: typeof ev.importance === "number" ? ev.importance : 3,
              customerImpact: str(ev, "customerImpact") ?? "none",
              ref:
                ev.ref !== null && typeof ev.ref === "object"
                  ? (ev.ref as Record<string, unknown>)
                  : null,
              notes: str(ev, "notes"),
              pr: null,
            };
            tracks.set(id, { status: "planned", prior: null, lane: null });
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
              related: [],
              effort: "M",
              importance: 3,
              customerImpact: "none",
              ref: null,
              notes: null,
              pr: null,
            };
            tracks.set(id, { status: "proposed", prior: null, lane: null });
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
          } else tasks[id].phase = rep(phase, ev);
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
          } else tasks[id].priority = rep(p, ev);
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
          } else tasks[id].lane = rep(str(ev, "toLane"), ev);
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
          } else tasks[id].areas = rep(a, ev);
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
                if (!tasks[a].related.includes(b)) tasks[a].related = [...tasks[a].related, b];
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
          if (typeof ev.pr === "number") tasks[bug].pr = ev.pr;
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
          for (const t of Object.values(tasks)) {
            if (t.release.value === id && t.status.value === "code-complete") {
              const res = step(trackOf(t.id), "task.released", ev.by, ev.lane);
              if (res.ok) {
                tracks.set(t.id, res.track);
                t.status = rep<Status>("released", ev);
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
    acks,
    superseded,
    timeline: timeline.slice(-200),
    warnings,
    sources: {
      events: flat.length,
      lanes: Object.keys(lanes).length,
      github: github !== null,
      railway: railway !== null,
    },
  }) as Omit<ControlState, "version">;
  const version = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return { ...body, version };
}
