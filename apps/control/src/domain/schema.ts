import type { EventType, LaneKind } from "./types";

export const MAX_LINE_BYTES = 1024;

export const LANE_KINDS: readonly LaneKind[] = [
  "feature",
  "bug",
  "test",
  "investigation",
  "release-prep",
  "lead",
  "sa",
  "coordinator",
  "owner",
];
export const TASK_KINDS = [
  "feature",
  "bug",
  "chore",
  "investigation",
  "release-prep",
  "customization",
  "deferred",
] as const;
export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export const PHASES = [
  "idea",
  "requirements",
  "design",
  "phase1",
  "phase2",
  "testing",
  "qa",
  "rc",
  "released",
] as const;
export const EFFORTS = ["S", "M", "L"] as const;
export const IMPACTS = ["none", "low", "high"] as const;
export const BY_VALUES = ["agent", "owner", "ctl", "sync", "server"] as const;

export const LANE_ID_RE = /^[a-z0-9][a-z0-9-]{1,23}$/;
export const TASK_ID_RE = /^(RF-\d+|F-\d+|B\d+|D-\d+)$/;
export const RF_ID_RE = /^RF-\d+$/;
export const TMP_ID_RE = /^[a-z0-9][a-z0-9-]{1,23}\.\d+$/;
export const BUG_ID_RE = /^B\d+$/;
export const RELEASE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,23}$/;
/** Canonical UTC ISO: seconds or milliseconds, always `Z` (the string-ordered ts compare relies on it). */
export const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
export const DATE_RE = /^\d{4}-\d\d-\d\d(T\d\d:\d\d(:\d\d)?Z?)?$/;
export const SHA_RE = /^[0-9a-f]{7,40}$/;
export const GLOB_RE = /^[A-Za-z0-9_./()[\]*?-]+$/;

/** Envelope keys present on every event line (segment header excepted). */
export const ENVELOPE_REQUIRED: readonly string[] = ["seq", "ts", "lane", "type", "by"];
export const ENVELOPE_OPTIONAL: readonly string[] = ["sha", "note"];

export const REQUIRED: Record<EventType, string[]> = {
  "lane.registered": ["laneId", "name", "machine", "kind", "active"],
  "task.created": ["id", "title", "kind"],
  "task.proposed": ["tmpId", "title", "kind", "areas"],
  "task.adopted": ["tmpId", "task"],
  "task.started": ["task"],
  "task.progress": ["task", "phase"],
  "task.blocked": ["task", "reason"],
  "task.unblocked": ["task"],
  "task.done": ["task"],
  "task.released": ["task", "release", "sha"],
  "task.reopened": ["task", "reason"],
  "task.priority": ["task", "priority"],
  "task.release": ["task", "release", "prev"],
  // spec names the payload key `lane`, which collides with the envelope `lane`; renamed `toLane`
  "task.lane": ["task", "toLane"],
  "task.next": ["task"],
  "task.reconsider": ["task", "why"],
  "task.areas": ["task", "areas"],
  "task.dropped": ["task", "why"],
  "bug.filed": ["bug"],
  "bug.fixed": ["bug", "pr"],
  "release.created": ["id", "name", "shipDate"],
  "release.moved": ["release", "shipDate", "prev", "why"],
  "release.shipped": ["release", "sha"],
  // spec names the payload key `by`, which collides with the envelope `by`; renamed `supersededBy`
  "pr.superseded": ["pr", "supersededBy"],
  "waste.ack": ["key"],
  "lane.note": ["note"],
};

export const OPTIONAL: Record<EventType, string[]> = {
  "lane.registered": [],
  "task.created": [
    "priority",
    "release",
    "areas",
    "effort",
    "importance",
    "customerImpact",
    "dependsOn",
    "related",
    "ref",
    "notes",
  ],
  "task.proposed": ["priority"],
  "task.adopted": [],
  "task.started": [],
  "task.progress": [],
  "task.blocked": [],
  "task.unblocked": [],
  "task.done": ["pr"],
  "task.released": [],
  "task.reopened": [],
  "task.priority": ["prev"],
  "task.release": ["why"],
  "task.lane": [],
  "task.next": ["targetLane"],
  "task.reconsider": [],
  "task.areas": [],
  "task.dropped": [],
  "bug.filed": ["task"],
  "bug.fixed": [],
  "release.created": ["goal"],
  "release.moved": [],
  "release.shipped": [],
  "pr.superseded": ["why"],
  "waste.ack": ["until", "why"],
  "lane.note": [],
};

export const EVENT_TYPES = Object.keys(REQUIRED) as EventType[];

const LEAD_LIKE: LaneKind[] = ["lead", "coordinator", "owner"];
const ALL: readonly LaneKind[] = LANE_KINDS;

/** Which lane kinds may emit each type (spec §1.1 / §1.3 fold-effect column). */
export const EMITTERS: Record<EventType, readonly LaneKind[]> = {
  "lane.registered": LEAD_LIKE,
  "task.created": LEAD_LIKE,
  "task.proposed": ALL,
  "task.adopted": LEAD_LIKE,
  "task.started": ALL,
  "task.progress": ALL,
  "task.blocked": ALL,
  "task.unblocked": ALL,
  "task.done": ALL,
  "task.released": LEAD_LIKE,
  "task.reopened": ALL,
  "task.priority": LEAD_LIKE,
  "task.release": LEAD_LIKE,
  "task.lane": LEAD_LIKE,
  "task.next": ALL,
  "task.reconsider": ALL,
  "task.areas": LEAD_LIKE,
  "task.dropped": LEAD_LIKE,
  "bug.filed": ALL,
  "bug.fixed": ALL,
  "release.created": LEAD_LIKE,
  "release.moved": LEAD_LIKE,
  "release.shipped": LEAD_LIKE,
  "pr.superseded": LEAD_LIKE,
  "waste.ack": LEAD_LIKE,
  "lane.note": ALL,
};

export function isEventType(t: unknown): t is EventType {
  return typeof t === "string" && Object.prototype.hasOwnProperty.call(REQUIRED, t);
}

/** A glob is safe when it matches the charset, has no `..`, and is <= 200 chars (spec §1.2). */
export function isSafeGlob(g: unknown): g is string {
  return (
    typeof g === "string" && g.length > 0 && g.length <= 200 && GLOB_RE.test(g) && !g.includes("..")
  );
}

type Check = (v: unknown, fileLane: string) => string | null;
const isStr = (v: unknown): v is string => typeof v === "string";
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const str: Check = (v) => (isStr(v) ? null : "must be a string");
const re =
  (r: RegExp, what: string): Check =>
  (v) =>
    isStr(v) && r.test(v) ? null : `must be ${what}`;
const oneOf =
  (list: readonly string[]): Check =>
  (v) =>
    isStr(v) && list.includes(v) ? null : `must be one of ${list.join("|")}`;
const nullable =
  (c: Check): Check =>
  (v, l) =>
    v === null ? null : c(v, l);
const taskRef: Check = (v) =>
  isStr(v) && (TASK_ID_RE.test(v) || TMP_ID_RE.test(v)) ? null : "must be a task id";
const release: Check = re(RELEASE_ID_RE, "a release id");
const laneId: Check = re(LANE_ID_RE, "a lane id");
const date: Check = re(DATE_RE, "an ISO date");
const globs: Check = (v) => {
  if (!Array.isArray(v)) return "must be an array of globs";
  for (const g of v as unknown[]) {
    if (!isSafeGlob(g)) return `unsafe glob ${JSON.stringify(g)}`;
  }
  return null;
};
const refList: Check = (v) =>
  Array.isArray(v) && (v as unknown[]).every((x) => isStr(x) && TASK_ID_RE.test(x))
    ? null
    : "must be an array of task ids";
const RESERVED = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
]);
export const ACK_KEY_RE = /^[A-Za-z0-9._:#/-]{1,120}$/;
const ackKey: Check = (v) =>
  isStr(v) && ACK_KEY_RE.test(v) && !RESERVED.has(v)
    ? null
    : "must match [A-Za-z0-9._:#/-]{1,120} and not be a reserved name";
/** `ref` is exactly {feature?, bug?, issue?, deferred?} (spec §1.2). */
const refCheck: Check = (v) => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return "must be an object";
  const o = v as Record<string, unknown>;
  const pat: Record<string, (x: unknown) => boolean> = {
    feature: (x) => isStr(x) && /^F-\d+$/.test(x),
    bug: (x) => isStr(x) && BUG_ID_RE.test(x),
    issue: (x) => isInt(x) && x > 0,
    deferred: (x) => isStr(x) && /^D-\d+$/.test(x),
  };
  for (const k of Object.keys(o)) {
    if (!Object.hasOwn(pat, k)) return `unknown key ${k} (allowed: feature|bug|issue|deferred)`;
    if (o[k] !== null && !pat[k](o[k])) return `bad value for ${k}`;
  }
  return null;
};
const posInt: Check = (v) => (isInt(v) && v > 0 ? null : "must be a positive integer");

/** Per-field value checks; `type.field` overrides the bare `field` entry. */
const FIELD: Record<string, Check> = {
  laneId,
  name: str,
  machine: str,
  active: (v) => (typeof v === "boolean" ? null : "must be a boolean"),
  "lane.registered.kind": oneOf(LANE_KINDS),
  "task.created.kind": oneOf(TASK_KINDS),
  "task.proposed.kind": oneOf(TASK_KINDS),
  id: release,
  "task.created.id": re(RF_ID_RE, "an RF-n id"),
  title: (v) => (isStr(v) && v.length > 0 ? null : "must be a non-empty string"),
  tmpId: (v, l) =>
    isStr(v) && new RegExp(`^${l.replace(/[-]/g, "\\-")}\\.\\d+$`).test(v)
      ? null
      : "must be <lane>.<n>",
  "task.adopted.tmpId": re(TMP_ID_RE, "a tmp id"),
  task: taskRef,
  "task.next.task": nullable(taskRef),
  "bug.filed.task": taskRef,
  bug: re(BUG_ID_RE, "a bug id"),
  phase: oneOf(PHASES),
  reason: str,
  why: str,
  goal: str,
  key: ackKey,
  notes: str,
  note: str,
  priority: oneOf(PRIORITIES),
  prev: str,
  "task.priority.prev": nullable(oneOf(PRIORITIES)),
  "task.release.prev": nullable(release),
  "release.moved.prev": date,
  release,
  "task.created.release": nullable(release),
  "task.release.release": nullable(release),
  areas: globs,
  effort: oneOf(EFFORTS),
  importance: (v) => (isInt(v) && v >= 1 && v <= 5 ? null : "must be an integer 1-5"),
  customerImpact: oneOf(IMPACTS),
  dependsOn: refList,
  related: refList,
  ref: refCheck,
  pr: posInt,
  sha: re(SHA_RE, "a hex sha"),
  shipDate: date,
  until: date,
  toLane: nullable(laneId),
  targetLane: laneId,
  supersededBy: (v) =>
    (isInt(v) && v > 0) || (isStr(v) && TASK_ID_RE.test(v))
      ? null
      : "must be a pr number or task id",
};

/** Validate one payload/envelope value; null = ok, else the reason. */
export function checkField(
  type: string,
  key: string,
  value: unknown,
  fileLane: string,
): string | null {
  const o = `${type}.${key}`;
  const c = Object.hasOwn(FIELD, o) ? FIELD[o] : Object.hasOwn(FIELD, key) ? FIELD[key] : undefined;
  return c ? c(value, fileLane) : null;
}
