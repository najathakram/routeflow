/** Shared types for the control-system domain (spec §1-§4). Pure types, no runtime code. */

export type Status =
  | "proposed"
  | "planned"
  | "in-progress"
  | "blocked"
  | "code-complete"
  | "released"
  | "reconsider"
  | "dropped";

export type LaneKind =
  | "feature"
  | "bug"
  | "test"
  | "investigation"
  | "release-prep"
  | "lead"
  | "sa"
  | "coordinator"
  | "owner";

export type EventType =
  | "lane.registered"
  | "task.created"
  | "task.proposed"
  | "task.adopted"
  | "task.started"
  | "task.progress"
  | "task.blocked"
  | "task.unblocked"
  | "task.done"
  | "task.released"
  | "task.reopened"
  | "task.priority"
  | "task.release"
  | "task.lane"
  | "task.next"
  | "task.reconsider"
  | "task.areas"
  | "task.dropped"
  | "bug.filed"
  | "bug.fixed"
  | "release.created"
  | "release.moved"
  | "release.shipped"
  | "pr.superseded"
  | "waste.ack"
  | "lane.note";

/**
 * Provenance rule: every value an event can change is a `Derived` ({value, source, ref}).
 * Static registration metadata (lane name/machine/kind/active, release name/goal) is EXEMPT:
 * it is set once by `lane.registered` / `release.created` and carries no provenance.
 */
export type Source = "register" | "reported" | "inferred";

/** Every derived value carries where it came from (spec §4). */
export interface Derived<T> {
  value: T;
  source: Source;
  ref: string | null;
}

/** One line of `events/<lane>.jsonl`; payload keys vary by `type`. */
export interface ControlEvent {
  seq: number;
  ts: string;
  lane: string;
  type: string;
  by: string;
  sha?: string;
  note?: string;
  [key: string]: unknown;
}

export interface BaseTask {
  id: string;
  title: string;
  kind: string;
  status: Status;
  priority: string;
  release: string | null;
  areas: string[];
  dependsOn: string[];
  related: string[];
  lane: string | null;
  phase: string | null;
  pr?: number | null;
  notes?: string | null;
  ref?: Record<string, unknown> | null;
  effort?: string;
  importance?: number;
  customerImpact?: string;
}

export interface BaseRelease {
  id: string;
  name: string;
  shipDate: string | null;
  status: string;
  goal?: string | null;
}

/** Registers already adapted to tasks/releases (spec §3). */
export interface FoldBase {
  tasks: BaseTask[];
  releases: BaseRelease[];
}

/** Placeholder for the inferred layer (GitHub/Railway, WP5); fold ignores it in WP1. */
export type GithubSnapshot = unknown;
export type RailwaySnapshot = unknown;

export interface TaskState {
  id: string;
  title: string;
  kind: string;
  status: Derived<Status>;
  priority: Derived<string>;
  release: Derived<string | null>;
  lane: Derived<string | null>;
  phase: Derived<string | null>;
  areas: Derived<string[]>;
  dependsOn: string[];
  related: Derived<string[]>;
  effort: string;
  importance: number;
  customerImpact: string;
  ref: Record<string, unknown> | null;
  notes: string | null;
  pr: Derived<number | null>;
}

export interface Blocker {
  task: string;
  reason: string;
  ref: string;
}

export interface LaneState {
  id: string;
  name: string;
  machine: string;
  kind: LaneKind | "unregistered";
  active: boolean;
  current: Derived<string | null>;
  next: Derived<string | null>;
  blockers: Blocker[];
  heartbeat: Derived<string | null>;
  stale: Derived<"live" | "stale" | "silent">;
}

export interface ReleaseChange {
  ref: string;
  ts: string;
  type: string;
  task: string | null;
  from: string | null;
  to: string | null;
}

export interface ReleaseState {
  id: string;
  name: string;
  status: Derived<string>;
  shipDate: Derived<string | null>;
  goal: string | null;
  history: ReleaseChange[];
}

export interface TimelineEntry {
  ts: string;
  lane: string;
  seq: number;
  type: string;
  task: string | null;
  by: string;
}

export interface Warning {
  lane: string;
  seq: number;
  reason: string;
}

export interface ControlState {
  tasks: Record<string, TaskState>;
  lanes: Record<string, LaneState>;
  releases: Record<string, ReleaseState>;
  prs: unknown[];
  branches: unknown[];
  waste: unknown[];
  overlap: unknown[];
  piggyback: Record<string, unknown[]>;
  acks: Record<string, { key: string; until: string | null; why: string | null; ref: string }>;
  superseded: Record<string, { by: unknown; why: string | null; ref: string }>;
  timeline: TimelineEntry[];
  warnings: Warning[];
  sources: { events: number; lanes: number; github: boolean; railway: boolean };
  version: string;
}

export interface ValidationError {
  file: string;
  line: number;
  reason: string;
}
