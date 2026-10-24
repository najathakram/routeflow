import type { Status } from "./types";

export type { Status } from "./types";

export type Ev =
  "started" | "done" | "released" | "blocked" | "unblocked" | "reconsider" | "reopened" | "dropped";

// The spec §2 matrix as data; the test carries its own copy (never import this into the spec).
const M: Record<Status, Partial<Record<Ev, Status | "prior">>> = {
  proposed: { reconsider: "reconsider", dropped: "dropped" },
  planned: {
    started: "in-progress",
    released: "released",
    blocked: "blocked",
    reconsider: "reconsider",
    dropped: "dropped",
  },
  "in-progress": {
    started: "in-progress",
    done: "code-complete",
    released: "released",
    blocked: "blocked",
    reconsider: "reconsider",
    reopened: "planned",
    dropped: "dropped",
  },
  blocked: {
    blocked: "blocked",
    unblocked: "prior",
    reconsider: "reconsider",
    reopened: "planned",
    dropped: "dropped",
  },
  "code-complete": {
    done: "code-complete",
    released: "released",
    reconsider: "reconsider",
    reopened: "planned",
    dropped: "dropped",
  },
  released: { reopened: "planned" },
  reconsider: { reopened: "planned", dropped: "dropped" },
  dropped: {},
};

export function transition(from: Status, ev: Ev, prior?: Status): Status | null {
  const to = M[from][ev];
  if (!to) return null;
  return to === "prior" ? (prior ?? "planned") : to;
}

/** Event type -> matrix column. */
export const EVENT_OF: Record<string, Ev> = Object.assign(
  Object.create(null) as Record<string, Ev>,
  {
    "task.started": "started",
    "task.done": "done",
    "task.released": "released",
    "task.blocked": "blocked",
    "task.unblocked": "unblocked",
    "task.reconsider": "reconsider",
    "task.reopened": "reopened",
    "task.dropped": "dropped",
  },
);

/** `released` via the `started`/`planned` rows is legal ONLY for these emitters (spec §2). */
const INFERRED_BY = new Set(["infer", "sync", "server"]);

/** Per-task tracking needed to apply the matrix (prior status for `blocked`, who started it). */
export interface Track {
  status: Status;
  prior: Status | null;
  lane: string | null;
}

export type StepResult = { ok: true; track: Track } | { ok: false; reason: string };

/** Apply one status event to a task's track; shared by the validator and the fold. */
export function step(track: Track, eventType: string, by: string, lane: string): StepResult {
  const ev = EVENT_OF[eventType];
  if (!ev) return { ok: false, reason: `not a status event: ${eventType}` };
  const from = track.status;
  const to = transition(from, ev, track.prior ?? undefined);
  if (to === null) return { ok: false, reason: `illegal transition ${from}→${ev}` };
  if (ev === "released" && (from === "planned" || from === "in-progress") && !INFERRED_BY.has(by)) {
    return { ok: false, reason: `illegal transition ${from}→${ev}` };
  }
  if (ev === "started" && from === "in-progress" && track.lane !== null && track.lane !== lane) {
    return {
      ok: false,
      reason: `illegal transition ${from}→${ev} (held by lane ${track.lane})`,
    };
  }
  return {
    ok: true,
    track: {
      status: to,
      prior: to === "blocked" ? (from === "blocked" ? track.prior : from) : null,
      lane: ev === "started" ? lane : ev === "reopened" ? null : track.lane,
    },
  };
}

/** `bug.fixed` moves an open bug task to code-complete (spec §1.3); null = allowed. */
export function stepBugFixed(track: Track): StepResult {
  const from = track.status;
  if (
    from === "planned" ||
    from === "in-progress" ||
    from === "blocked" ||
    from === "code-complete"
  ) {
    return { ok: true, track: { status: "code-complete", prior: null, lane: track.lane } };
  }
  return { ok: false, reason: `illegal transition ${from}→fixed` };
}
