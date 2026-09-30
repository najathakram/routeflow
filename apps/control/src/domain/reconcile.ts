/**
 * Reconciliation of inferred facts (GitHub / Railway) against folded reported state (spec 5.7).
 * `FIELD_WINNER` is the section 5.7 table; `reconcile` applies it and returns a NEW state: the
 * folded input is never mutated. Everything inferred carries `{source: "inferred", ref}`.
 */
import { gitTry } from "../sources/git";
import type { Deploy, Deploys } from "../sources/railway";
import type { PR } from "./prs";
import type { ControlState, Derived, LaneState, Status, TaskState, TimelineEntry } from "./types";

export const FIELD_WINNER = {
  prState: "inferred",
  taskCodeComplete: "inferred-if-linked",
  taskReleased: "inferred",
  decisions: "reported",
  heartbeat: "latest",
  bug: "register",
} as const;

export type ServiceDeployed = boolean | "unknown";

export interface InferredTask extends TaskState {
  verified?: boolean;
  badges: string[];
  deployed?: { api: ServiceDeployed; web: ServiceDeployed };
}

export interface Nudge {
  lane: string;
  task: string;
  pr: number;
  message: string;
}

export interface InferredInput {
  prs: PR[];
  branches: Array<{ name: string; committedDate: string }>;
  deploys: Deploys | null;
  /** Clone used for `git merge-base --is-ancestor`; absent -> every deploy reads `unknown`. */
  repoDir?: string;
}

export type ReconciledState = Omit<ControlState, "tasks" | "prs"> & {
  tasks: Record<string, InferredTask>;
  prs: PR[];
  nudges: Nudge[];
};

const H = 3_600_000;
const STALE_MS = 24 * H;
const SILENT_MS = 72 * H;
const SHA = /^[0-9a-f]{40}$/i;
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const DECISION: ReadonlySet<Status> = new Set<Status>(["blocked", "reconsider", "dropped"]);
const ADVANCEABLE: ReadonlySet<Status> = new Set<Status>(["proposed", "planned", "in-progress"]);

/** `git merge-base --is-ancestor`: true / false, or "unknown" when a commit is not in the clone. */
function isAncestor(
  repoDir: string | undefined,
  sha: string,
  service: string | null,
): ServiceDeployed {
  if (!repoDir || !service || !SHA.test(sha) || !SHA.test(service)) return "unknown";
  const r = gitTry(repoDir, ["merge-base", "--is-ancestor", "--end-of-options", sha, service]);
  if (r.ok) return true;
  const both = [sha, service].every((c) => gitTry(repoDir, ["cat-file", "-e", `${c}^{commit}`]).ok);
  return both ? false : "unknown";
}

const onService = (
  d: Deploys | null,
  svc: "api" | "web",
  sha: string,
  repoDir?: string,
): ServiceDeployed => {
  if (d === null) return "unknown";
  const live: Deploy | null = d[svc];
  if (live === null) return false; // no successful deploy on this service
  return isAncestor(repoDir, sha, live.sha);
};

const combine = (xs: ServiceDeployed[]): ServiceDeployed =>
  xs.some((x) => x === false) ? false : xs.every((x) => x === true) ? true : "unknown";

const toMs = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);
const stamp = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");
const isBug = (t: TaskState): boolean => t.kind === "bug" || /^B\d+$/.test(t.id);
const derived = <T>(value: T, ref: string | null): Derived<T> => ({
  value,
  source: "inferred",
  ref,
});

export function reconcile(
  state: ControlState,
  inferred: InferredInput,
  now: string,
): ReconciledState {
  const nowMs = Date.parse(now);

  // Row 1: PR state, CI, mergeable, review, merged sha and deployed are inferred only.
  const perPrServices = new Map<number, { api: ServiceDeployed; web: ServiceDeployed }>();
  const prs: PR[] = [...inferred.prs]
    .sort((a, b) => a.pr - b.pr)
    .map((p) => {
      if (p.state !== "merged" || !p.mergeSha) return { ...p, deployed: false };
      const api = onService(inferred.deploys, "api", p.mergeSha, inferred.repoDir);
      const web = onService(inferred.deploys, "web", p.mergeSha, inferred.repoDir);
      perPrServices.set(p.pr, { api, web });
      const deployed = combine([api, web]);
      const next: PR = { ...p, deployed };
      delete next.deployedAt;
      if (deployed === true) {
        const at = Math.max(
          toMs(inferred.deploys?.api?.at),
          toMs(inferred.deploys?.web?.at),
          toMs(p.mergedAt),
        );
        if (Number.isFinite(at)) next.deployedAt = stamp(at);
      }
      next.deployFailed =
        deployed !== true && inferred.deploys?.failedShas.includes(p.mergeSha) === true;
      return next;
    });
  const mergedPrs = prs.filter((p) => p.state === "merged");

  const tasks = Object.create(null) as Record<string, InferredTask>;
  const timeline: TimelineEntry[] = [...state.timeline];
  const extraTimeline: Array<TimelineEntry & { text: string }> = [];
  const nudgeTask = new Map<string, { pr: PR }>();

  for (const id of Object.keys(state.tasks).sort(cmp)) {
    const t = state.tasks[id];
    const own = t.pr?.value ?? null;
    const linked = mergedPrs
      .filter(
        (p) =>
          p.links.task === id ||
          p.links.bug === id ||
          p.links.feature === id ||
          (own !== null && p.pr === own),
      )
      .sort((a, b) => (toMs(a.mergedAt) || 0) - (toMs(b.mergedAt) || 0) || a.pr - b.pr);
    const latest = linked.length ? linked[linked.length - 1] : null;
    const cur = t.status.value;
    let status: Derived<Status> = t.status;
    const badges: string[] = [];
    let deployed: InferredTask["deployed"];

    if (latest) {
      const svc = linked.map(
        (p) => perPrServices.get(p.pr) ?? { api: "unknown" as const, web: "unknown" as const },
      );
      deployed = { api: combine(svc.map((s) => s.api)), web: combine(svc.map((s) => s.web)) };
    }
    const everywhere = latest !== null && deployed?.api === true && deployed.web === true;
    const registerBug = isBug(t) && t.status.source === "register";

    if (latest && !DECISION.has(cur) && cur !== "released") {
      if (registerBug && !(cur === "code-complete")) {
        // the register says open: inference never writes it; only a badge (row 6)
        if (linked.some((p) => p.links.bug === id || p.pr === own))
          badges.push("fixed · register lag");
      } else if (everywhere) {
        status = derived<Status>("released", `#${latest.pr}`);
      } else if (ADVANCEABLE.has(cur)) {
        status = derived<Status>("code-complete", `#${latest.pr}`);
      }
    }
    if (status !== t.status) {
      const at = status.value === "released" ? toMs(latest?.deployedAt) : toMs(latest?.mergedAt);
      const ts = Number.isFinite(at) ? stamp(at) : now;
      extraTimeline.push({
        ts,
        lane: t.lane.value ?? "infer",
        seq: 0,
        type: "inferred.status",
        task: id,
        by: "infer",
        text: `${id} ${status.value} inferred from #${latest?.pr}`,
      });
    }

    const out: InferredTask = { ...t, status, badges };
    if (deployed) out.deployed = deployed;
    if (status.value === "code-complete" && t.status.source === "reported") {
      out.verified = latest !== null;
      if (latest === null) out.badges = [...badges, "unverified"];
    } else if (status.value === "code-complete" || status.value === "released") {
      if (latest !== null) out.verified = true;
    }
    tasks[id] = out;
    if (latest && !DECISION.has(cur) && cur !== "code-complete" && cur !== "released") {
      nudgeTask.set(id, { pr: latest });
    }
  }
  for (const e of extraTimeline) timeline.push(e);
  const order = new Map(timeline.map((e, i) => [e, i]));
  timeline.sort(
    (a, b) => (toMs(a.ts) || 0) - (toMs(b.ts) || 0) || (order.get(a) ?? 0) - (order.get(b) ?? 0),
  );

  // Row 4: lane pointers stay reported; a lane whose current task's PR merged gets a nudge.
  // Row 5: heartbeat = max(last event, last push on a branch attributed to the lane).
  const lanes = Object.create(null) as Record<string, LaneState>;
  const nudges: Nudge[] = [];
  const pushes = new Map<string, { ms: number; at: string; ref: string }>();
  const branchAt = new Map(inferred.branches.map((b) => [b.name, b.committedDate]));
  for (const p of [...prs].sort((a, b) => a.pr - b.pr)) {
    const at = branchAt.get(p.headRef);
    const ms = toMs(at);
    if (at === undefined || !Number.isFinite(ms) || p.lane === "unattributed") continue;
    const best = pushes.get(p.lane);
    if (!best || ms > best.ms) pushes.set(p.lane, { ms, at, ref: `branch:${p.headRef}` });
  }
  for (const id of Object.keys(state.lanes).sort(cmp)) {
    const l = state.lanes[id];
    let heartbeat = l.heartbeat;
    const push = pushes.get(id);
    const hbMs = toMs(heartbeat.value);
    if (push && (!Number.isFinite(hbMs) || push.ms > hbMs))
      heartbeat = derived<string | null>(push.at, push.ref);
    let stale = l.stale;
    const beat = toMs(heartbeat.value);
    if (Number.isFinite(beat) && Number.isFinite(nowMs)) {
      const age = nowMs - beat;
      stale = {
        value: age > SILENT_MS ? "silent" : age > STALE_MS ? "stale" : "live",
        source: heartbeat.source,
        ref: heartbeat.ref,
      };
    }
    lanes[id] = { ...l, heartbeat, stale };
    const cur = l.current.value;
    const n = cur !== null && has(state.tasks, cur) ? nudgeTask.get(cur) : undefined;
    if (cur !== null && n) {
      nudges.push({
        lane: id,
        task: cur,
        pr: n.pr.pr,
        message: `${cur} merged as #${n.pr.pr} - run \`ctl done\`? or start next`,
      });
    }
  }

  return {
    ...state,
    tasks,
    lanes,
    prs,
    branches: inferred.branches,
    timeline,
    nudges,
  };
}
