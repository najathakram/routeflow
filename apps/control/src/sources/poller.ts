/**
 * Poll cadence (spec 5.6): a 30 s tick, the master fetch on every 5th tick (or on a webhook),
 * Railway on every 2nd, a back-off from the GitHub rate limit, and a relaxed 5 min cadence while
 * a webhook is fresh. Pure planning functions plus the git-backed branch facts (ahead / date).
 */
import type { PRFile } from "../domain/prs";
import { gitTry } from "./git";

export const TICK_MS = 30_000;
export const BACKOFF_TABLE: ReadonlyArray<readonly [number, number]> = [
  [500, 300_000],
  [1500, 60_000],
];
export const MAX_RESET_WAIT_MS = 3_600_000;
export const WEBHOOK_FRESH_MS = 10 * 60_000;
export const WEBHOOK_INTERVAL_MS = 300_000;

export interface PollBudget {
  remaining: number | null;
  lastWebhookAt: string | null;
  /** When the rate limit resets; honoured while the budget is exhausted (remaining 0). */
  resetAt?: string | null;
}

/** Interval until the next tick: the slower of the rate-limit back-off and the webhook relax. */
export function nextIntervalMs(budget: PollBudget, now: string): number {
  let ms = TICK_MS;
  const r = budget.remaining;
  if (typeof r === "number") {
    for (const [below, interval] of BACKOFF_TABLE) {
      if (r < below) {
        ms = Math.max(ms, interval);
        break;
      }
    }
  }
  const reset = budget.resetAt ? Date.parse(budget.resetAt) : NaN;
  const nowMs = Date.parse(now);
  if (r === 0 && Number.isFinite(reset) && Number.isFinite(nowMs) && reset > nowMs) {
    ms = Math.max(ms, Math.min(reset - nowMs, MAX_RESET_WAIT_MS));
  }
  const last = budget.lastWebhookAt ? Date.parse(budget.lastWebhookAt) : NaN;
  const t = Date.parse(now);
  if (Number.isFinite(last) && Number.isFinite(t) && t - last < WEBHOOK_FRESH_MS) {
    ms = Math.max(ms, WEBHOOK_INTERVAL_MS);
  }
  return ms;
}

export interface TickPlan {
  fetchState: boolean;
  fetchMaster: boolean;
  railway: boolean;
}

/** `tick` counts from 1: state every tick, master ticks 1, 6, 11 ... (or on a webhook), Railway 1, 3, 5 ... */
export function planTick(tick: number, opts: { webhook?: boolean } = {}): TickPlan {
  return {
    fetchState: true,
    fetchMaster: opts.webhook === true || (tick - 1) % 5 === 0,
    railway: (tick - 1) % 2 === 0,
  };
}

export interface Branch {
  name: string;
  oid: string;
  committedDate: string;
  ahead: number;
}

const SHA = /^[0-9a-f]{40}$/i;

/**
 * Branch facts from the server's clone: `ahead` = `rev-list --count <master>..<oid>` and the tip's
 * committer date. A branch whose commit the clone does not have is omitted (unknown, never guessed).
 */
export function branchFacts(
  repoDir: string,
  raw: Array<{ name: string; commit?: { sha?: string } }>,
  master = "origin/master",
): Branch[] {
  const out: Branch[] = [];
  for (const b of raw) {
    const oid = b.commit?.sha;
    if (typeof oid !== "string" || !SHA.test(oid) || typeof b.name !== "string") continue;
    const count = gitTry(repoDir, ["rev-list", "--count", "--end-of-options", `${master}..${oid}`]);
    const date = gitTry(repoDir, ["log", "-1", "--format=%cI", "--end-of-options", oid]);
    const ahead = Number(count.out.trim());
    const t = Date.parse(date.out.trim());
    if (!count.ok || !date.ok || !Number.isFinite(ahead) || !Number.isFinite(t)) continue;
    out.push({
      name: b.name,
      oid,
      committedDate: new Date(t).toISOString().replace(".000Z", "Z"),
      ahead,
    });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export interface TickDeps {
  github: {
    poll: () => Promise<{
      prs: unknown[];
      branches: unknown[];
      files: Record<string, PRFile[]>;
      rateLimited?: boolean;
      warnings?: string[];
    }>;
    state: { rateLimit: { remaining: number | null; resetAt?: string | null } };
  };
  fetchMaster?(): void | Promise<void>;
  fetchState?(): void | Promise<void>;
  railway?(): Promise<unknown>;
  lastWebhookAt?(): string | null;
  now(): string;
}

export interface TickResult {
  plan: TickPlan;
  github: Awaited<ReturnType<TickDeps["github"]["poll"]>> | null;
  railway: unknown;
  warnings: string[];
  nextMs: number;
}

/** One tick: run what the plan asks, never throw (a failing source becomes a warning). */
export async function runTick(
  deps: TickDeps,
  tick: number,
  opts: { webhook?: boolean } = {},
): Promise<TickResult> {
  const plan = planTick(tick, opts);
  const warnings: string[] = [];
  const guard = async (label: string, f?: () => unknown): Promise<void> => {
    if (!f) return;
    try {
      await f();
    } catch (e) {
      warnings.push(`${label}: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
    }
  };
  if (plan.fetchState) await guard("state fetch", deps.fetchState && (() => deps.fetchState?.()));
  if (plan.fetchMaster)
    await guard("master fetch", deps.fetchMaster && (() => deps.fetchMaster?.()));
  let github: TickResult["github"] = null;
  try {
    github = await deps.github.poll();
    warnings.push(...(github.warnings ?? []));
  } catch (e) {
    warnings.push(`github: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
  }
  let railway: unknown = null;
  if (plan.railway && deps.railway) {
    try {
      railway = await deps.railway();
    } catch (e) {
      warnings.push(`railway: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
    }
  }
  const nextMs = nextIntervalMs(
    {
      remaining: deps.github.state.rateLimit.remaining,
      resetAt: deps.github.state.rateLimit.resetAt ?? null,
      lastWebhookAt: deps.lastWebhookAt?.() ?? null,
    },
    deps.now(),
  );
  return { plan, github, railway, warnings, nextMs };
}
