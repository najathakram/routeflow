/** Next eligible task for a lane (spec 5.1). Pure and deterministic; code-unit comparisons only. */
import type { ControlState, TaskState } from "./types";

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const rank = (m: Record<string, number>, k: string, dflt: number) => (has(m, k) ? m[k] : dflt);
const PRIO: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const IMPACT: Record<string, number> = { high: 0, medium: 1, low: 2, none: 3 };
const EFFORT: Record<string, number> = { S: 0, M: 1, L: 2 };
const DEP_OK = new Set(["code-complete", "released", "dropped"]);
const MAX = Number.POSITIVE_INFINITY;
const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

/** Natural id order: non-numeric prefix by code unit, then trailing number numerically. */
export function naturalCompare(x: string, y: string): number {
  const mx = /^(.*?)(\d+)$/.exec(x);
  const my = /^(.*?)(\d+)$/.exec(y);
  if (mx && my) {
    const p = cmp(mx[1], my[1]);
    if (p) return p;
    const nx = mx[2].replace(/^0+(?=\d)/, "");
    const ny = my[2].replace(/^0+(?=\d)/, "");
    return nx.length - ny.length || cmp(nx, ny) || cmp(x, y);
  }
  return cmp(x, y);
}

export interface NextItem {
  id: string;
  title: string;
  priority: string;
  release: string | null;
  explicit: boolean;
}
export interface NextResult {
  items: NextItem[];
  held: { id: string; by: string[] }[];
}

export function nextEligible(
  state: Pick<ControlState, "tasks" | "lanes" | "releases">,
  lane: string,
): NextResult {
  const tasks = Object.values(state.tasks);
  const lanes = Object.values(state.lanes);
  const takenByOthers = new Set<string>();
  for (const l of lanes) if (l.id !== lane && l.current.value) takenByOthers.add(l.current.value);

  const shipDate = (t: TaskState): number => {
    const rid = t.release.value;
    if (rid === null || !has(state.releases, rid)) return MAX;
    const ms = Date.parse(state.releases[rid].shipDate.value ?? "");
    return Number.isNaN(ms) ? MAX : ms;
  };
  const shipped = (t: TaskState) => {
    const rid = t.release.value;
    return (
      rid !== null && has(state.releases, rid) && state.releases[rid].status.value === "shipped"
    );
  };
  const key = (t: TaskState): number[] => [
    rank(PRIO, t.priority.value, 9),
    shipDate(t),
    rank(IMPACT, t.customerImpact, 3),
    rank(EFFORT, t.effort, 3),
    -(Number.isFinite(t.importance) ? t.importance : 0),
  ];
  const sorter = (a: TaskState, b: TaskState) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    }
    return naturalCompare(a.id, b.id);
  };

  const eligible: TaskState[] = [];
  const held: { id: string; by: string[] }[] = [];
  for (const t of tasks) {
    if (t.status.value !== "planned") continue;
    const assigned = t.lane.value;
    if (assigned !== null && assigned !== lane) continue;
    if (shipped(t) || takenByOthers.has(t.id)) continue;
    const by = t.dependsOn.filter(
      (d) => !has(state.tasks, d) || !DEP_OK.has(state.tasks[d].status.value),
    );
    if (by.length) held.push({ id: t.id, by });
    else eligible.push(t);
  }
  eligible.sort(sorter);
  held.sort((a, b) => naturalCompare(a.id, b.id));

  const explicit = has(state.lanes, lane) ? state.lanes[lane].next.value : null;
  const first = explicit === null ? undefined : eligible.find((t) => t.id === explicit);
  const ordered = first ? [first, ...eligible.filter((t) => t !== first)] : eligible;
  const items = ordered.slice(0, 5).map((t) => ({
    id: t.id,
    title: t.title,
    priority: t.priority.value,
    release: t.release.value,
    explicit: t === first,
  }));
  return { items, held };
}
