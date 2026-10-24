/**
 * Waste rules W1-W10 (spec 5.8) and the W5 re-landed check (A17). Pure and deterministic: `now`
 * is injected, nothing is mutated, every threshold fires only when STRICTLY exceeded.
 */
import { git, gitTry } from "../sources/git";
import type { PR } from "./prs";

export interface WasteBranch {
  name: string;
  oid: string;
  committedDate: string;
  ahead: number;
}
export interface WasteTask {
  id: string;
  status: { value: string; source: string; ref: string | null };
  doneAt: string | null;
}
export interface WasteAck {
  key: string;
  until: string | null;
  why?: string | null;
  ref?: string | null;
}
export type WastePR = PR & {
  ciSince?: string | null;
  deployFailed?: boolean;
  commitMessages?: string[];
};

export interface WasteInput {
  prs: WastePR[];
  branches: WasteBranch[];
  tasks: WasteTask[];
  acks: Record<string, WasteAck>;
  superseded: Record<string, unknown>;
  /** PR ledger rows (all PRs ever seen); their head refs cover branches for W6. */
  ledger?: Array<{ pr: number; state: string; headRef?: string | null }>;
  /** W5 predicate: did this closed PR's work reach master? Absent -> W5 is not evaluated. */
  relanded?: (pr: WastePR) => boolean;
}

export interface WasteItem {
  key: string;
  rule: string;
  subject: string;
  why: string;
  action: string;
  since: string;
}

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
export const THRESHOLDS = {
  W1: 3 * D,
  W2: 5 * D,
  W3_RED: 24 * H,
  W3_NONE: 2 * H,
  W6: 2 * D,
  W7: 2 * H,
  W7b: 24 * H,
  W8: 24 * H,
} as const;

const SERVICES = ["api", "web"] as const;
const TIER: Record<string, number> = {
  W4: 0,
  W3: 0,
  W5: 0,
  W7: 0,
  W7b: 0,
  W1: 1,
  W2: 1,
  W6: 1,
  W8: 1,
  W9: 2,
  W10: 2,
};
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const time = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);
const isOpen = (p: PR): boolean => p.state === "open" || p.state === "ready" || p.state === "draft";
const unlinked = (p: PR): boolean => !p.links.task && !p.links.bug && !p.links.feature;
const SUPERSEDED_BODY = /\bsuperseded by #\d+/i;

/** Git facts `relanded` needs; `masterPatchIds` is an optional one-shot fast path. */
export interface Git {
  lines(args: string[]): string[];
  patchId(commit: string): string;
  patchIdOfDiff(base: string, head: string): string;
  masterPatchIds?(master: string, limit: number): Set<string>;
}

/**
 * W5: a closed-unmerged PR whose work reached master anyway (cherry-picked commit, or the whole
 * range squashed). Empty patch-ids (merge commits, empty ranges) never count as a match.
 */
export function relanded(g: Git, base: string, head: string, master = "origin/master"): boolean {
  const ids = new Set(g.lines(["log", "--format=%H", `${base}..${head}`]).map((h) => g.patchId(h)));
  ids.delete("");
  const onMaster =
    g.masterPatchIds?.(master, 2000) ??
    new Set(g.lines(["log", "--format=%H", "-n", "2000", master]).map((h) => g.patchId(h)));
  if ([...ids].some((id) => onMaster.has(id))) return true; // cherry-picked
  const rangeId = g.patchIdOfDiff(base, head); // squash of the whole range
  return rangeId !== "" && onMaster.has(rangeId);
}

const SHA = /^[0-9a-f]{40}$/i;

/** A `Git` over a clone, via the WP3 helpers (argv arrays, no shell); patch-ids are cached. */
export function repoGit(dir: string): Git & { mergeBase(a: string, b: string): string | null } {
  const cache = new Map<string, string>();
  const patchIdOf = (diff: string): string =>
    (git(dir, ["patch-id", "--stable"], { input: diff }).split(/\s+/)[0] ?? "").trim();
  const masterCache = new Map<string, Set<string>>();
  return {
    lines: (args) =>
      git(dir, args)
        .split("\n")
        .filter((l) => l !== ""),
    patchId: (commit) => {
      if (!SHA.test(commit)) throw new Error("bad commit id");
      let v = cache.get(commit);
      if (v === undefined) {
        v = patchIdOf(git(dir, ["show", "--format=", "--end-of-options", commit]));
        cache.set(commit, v);
      }
      return v;
    },
    patchIdOfDiff: (base, head) => patchIdOf(git(dir, ["diff", "--end-of-options", base, head])),
    masterPatchIds: (master, limit) => {
      // keyed on master's CURRENT tip, so a fetch that advances master can never reuse stale ids
      const tip = git(dir, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${master}^{commit}`,
      ]).trim();
      const k = `${tip}\0${limit}`;
      let s = masterCache.get(k);
      if (!s) {
        masterCache.clear();
        const out = git(
          dir,
          ["log", "-p", "--format=%H", "-n", String(limit), "--end-of-options", tip],
          { timeoutMs: 120_000 },
        );
        const ids = git(dir, ["patch-id", "--stable"], { input: out, timeoutMs: 120_000 });
        s = new Set(
          ids
            .split("\n")
            .map((l) => l.split(/\s+/)[0] ?? "")
            .filter((x) => x !== ""),
        );
        masterCache.set(k, s);
      }
      return s;
    },
    mergeBase: (a, b) => {
      const r = gitTry(dir, ["merge-base", "--end-of-options", a, b]);
      const sha = r.out.trim();
      return r.ok && SHA.test(sha) ? sha : null;
    },
  };
}

/**
 * The W5 predicate for `wasteItems`: base = the merge-base of master and the PR head. A head the
 * clone does not hold (or any git error) reads as re-landed, so an unknown is never flagged.
 */
export function relandedFor(
  g: ReturnType<typeof repoGit>,
  master = "origin/master",
): (pr: { headSha: string }) => boolean {
  return (pr) => {
    try {
      if (!SHA.test(pr.headSha)) return true;
      const base = g.mergeBase(master, pr.headSha);
      return base === null ? true : relanded(g, base, pr.headSha, master);
    } catch {
      return true;
    }
  };
}

const tsOf = (...cands: Array<string | null | undefined>): string =>
  cands.find((c) => typeof c === "string" && c !== "" && Number.isFinite(Date.parse(c))) ??
  "1970-01-01T00:00:00Z";

/** Waste items for the panel: acked items hidden, sorted by severity tier then age descending. */
export function wasteItems(input: WasteInput, now: string): WasteItem[] {
  const nowMs = Date.parse(now);
  const items: WasteItem[] = [];
  const older = (since: string | null | undefined, threshold: number): boolean => {
    const t = time(since);
    return Number.isFinite(t) && nowMs - t > threshold;
  };
  const add = (
    rule: string,
    subject: string,
    sha: string,
    why: string,
    action: string,
    since: string,
  ): void => {
    items.push({ key: `${rule}:${subject}:${sha}`, rule, subject, why, action, since });
  };
  const prs = [...input.prs].sort((a, b) => a.pr - b.pr);
  const prSubject = (p: PR): string => `PR #${p.pr}`;
  const dur = (ms: number): string =>
    ms >= D
      ? `${Math.floor(ms / D)} d`
      : ms >= H
        ? `${Math.floor(ms / H)} h`
        : `${Math.floor(ms / MIN)} min`;
  const ago = (since: string): string => dur(nowMs - Date.parse(since));

  for (const p of prs) {
    const open = isOpen(p);
    // W1 idle PR
    if ((p.state === "open" || p.state === "ready") && older(p.updatedAt, THRESHOLDS.W1)) {
      add(
        "W1",
        prSubject(p),
        p.headSha,
        `no activity for ${ago(p.updatedAt)}`,
        "rebase + ping the lane, or close",
        p.updatedAt,
      );
    }
    // W2 stale draft
    if (p.state === "draft" && older(p.createdAt, THRESHOLDS.W2)) {
      add(
        "W2",
        prSubject(p),
        p.headSha,
        `draft for ${ago(p.createdAt)}, never marked ready`,
        "mark ready or close",
        p.createdAt,
      );
    }
    // W3 red or stale CI
    if (p.state === "open" || p.state === "ready") {
      if (p.ci === "red" && p.ciSince && older(p.ciSince, THRESHOLDS.W3_RED)) {
        add(
          "W3",
          prSubject(p),
          p.headSha,
          `CI red for ${ago(p.ciSince)}`,
          "fix or re-run",
          p.ciSince,
        );
      } else if (
        (p.ci === "none" || p.ci === "stale") &&
        p.headCommittedAt &&
        older(p.headCommittedAt, THRESHOLDS.W3_NONE)
      ) {
        add(
          "W3",
          prSubject(p),
          p.headSha,
          `no check run on the head for ${ago(p.headCommittedAt)}`,
          "fix or re-run",
          p.headCommittedAt,
        );
      }
    }
    // W4 conflicting
    if (open && p.mergeable === "conflicting") {
      add(
        "W4",
        prSubject(p),
        p.headSha,
        "merge conflict with master",
        "rebase",
        tsOf(p.updatedAt, p.createdAt),
      );
    }
    // W5 closed, unmerged, work never re-landed
    if (p.state === "closed" && !p.mergedAt && input.relanded) {
      const supersededByEvent = has(input.superseded, String(p.pr));
      if (!supersededByEvent && !SUPERSEDED_BODY.test(p.body ?? "")) {
        let landed = true; // an error while asking is an unknown, and an unknown is never waste
        try {
          landed = input.relanded(p);
        } catch {
          landed = true;
        }
        if (!landed) {
          add(
            "W5",
            prSubject(p),
            p.headSha,
            "closed without merge and its work never reached master",
            "salvage, or `ctl pr superseded`",
            tsOf(p.closedAt, p.updatedAt, p.createdAt),
          );
        }
      }
    }
    if (p.state === "merged") {
      const mergeSha = p.mergeSha ?? p.headSha;
      // W7 merged, not deployed: only the services the PR's files touch count (F2)
      const svcs = p.touches && p.serviceDeployed ? SERVICES.filter((x) => p.touches?.[x]) : null;
      let notDeployed: boolean;
      if (svcs && p.serviceDeployed) {
        const st = svcs.map((x) => p.serviceDeployed?.[x]);
        notDeployed =
          svcs.length > 0 &&
          (st.some((x) => x === false) ||
            (p.deployFailed === true && !st.every((x) => x === true)));
      } else {
        notDeployed = p.deployed === false || (p.deployFailed === true && p.deployed !== true);
      }
      if (notDeployed && older(p.mergedAt, THRESHOLDS.W7)) {
        add(
          "W7",
          prSubject(p),
          mergeSha,
          p.deployFailed
            ? `a deploy failed; merged ${ago(tsOf(p.mergedAt))} ago`
            : `merged ${ago(tsOf(p.mergedAt))} ago and not deployed`,
          "watch the deploy or redeploy",
          tsOf(p.mergedAt),
        );
      }
      // W7b bookkeeping follow-up missing
      if (p.bookkeepingPending && p.mergeSha && older(p.mergedAt, THRESHOLDS.W7b)) {
        const full = p.mergeSha.toLowerCase();
        const cites = (text: string): boolean =>
          (text.match(/\b[0-9a-f]{7,40}\b/gi) ?? []).some((tok) =>
            full.startsWith(tok.toLowerCase()),
          );
        const covered = prs.some(
          (q) =>
            q.pr !== p.pr &&
            q.state !== "closed" &&
            (cites(q.body ?? "") || (q.commitMessages ?? []).some(cites)),
        );
        if (!covered) {
          add(
            "W7b",
            prSubject(p),
            mergeSha,
            `bookkeeping follow-up pending for ${ago(tsOf(p.mergedAt))}`,
            "open the docs follow-up",
            tsOf(p.mergedAt),
          );
        }
      }
      // W9 orphan PR
      if (unlinked(p) && p.lane === "unattributed") {
        add(
          "W9",
          prSubject(p),
          mergeSha,
          "merged with no task/bug/feature link and no Lane trailer",
          "add trailers in the follow-up (or `waste.ack`)",
          tsOf(p.mergedAt, p.closedAt, p.updatedAt),
        );
      }
    }
  }

  // W6 orphan branch
  const covered = new Set<string>();
  for (const p of prs) if (isOpen(p) || p.state === "merged") covered.add(p.headRef);
  const lastRow = new Map<number, { state: string; headRef?: string | null }>();
  for (const r of input.ledger ?? []) lastRow.set(r.pr, r);
  for (const r of lastRow.values()) {
    if (
      r.headRef &&
      (r.state === "open" || r.state === "ready" || r.state === "draft" || r.state === "merged")
    ) {
      covered.add(r.headRef);
    }
  }
  for (const b of [...input.branches].sort((x, y) => cmp(x.name, y.name))) {
    if (b.name.startsWith("ctl/") || b.name === "master" || b.name === "main") continue;
    if (b.ahead >= 1 && !covered.has(b.name) && older(b.committedDate, THRESHOLDS.W6)) {
      add(
        "W6",
        b.name,
        b.oid,
        `ahead of master with no open or merged PR, last push ${ago(b.committedDate)} ago`,
        "open a PR or delete the branch",
        b.committedDate,
      );
    }
  }

  // W8 done without a merged PR
  const mergedLinks = new Set<string>();
  for (const p of prs) {
    if (p.state !== "merged") continue;
    for (const id of [p.links.task, p.links.bug, p.links.feature]) if (id) mergedLinks.add(id);
  }
  for (const t of [...input.tasks].sort((x, y) => cmp(x.id, y.id))) {
    if (
      t.status.value === "code-complete" &&
      t.status.source === "reported" &&
      older(t.doneAt, THRESHOLDS.W8) &&
      !mergedLinks.has(t.id)
    ) {
      add(
        "W8",
        t.id,
        t.status.ref ?? tsOf(t.doneAt),
        `reported done ${ago(tsOf(t.doneAt))} ago with no merged PR linking it`,
        "link the PR (`Task:` trailer) or reopen",
        tsOf(t.doneAt),
      );
    }
  }

  // W10 overlapping open PRs from different lanes
  const byFile = new Map<string, WastePR[]>();
  for (const p of prs) {
    if (!isOpen(p)) continue;
    for (const f of new Set(p.filePaths ?? [])) {
      const l = byFile.get(f);
      if (l) l.push(p);
      else byFile.set(f, [p]);
    }
  }
  const pairs = new Map<string, { a: WastePR; b: WastePR; shared: number }>();
  for (const list of byFile.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.lane === b.lane) continue;
        const k = `${a.pr}+${b.pr}`;
        const cur = pairs.get(k);
        if (cur) cur.shared++;
        else pairs.set(k, { a, b, shared: 1 });
      }
    }
  }
  for (const { a, b, shared } of pairs.values()) {
    const since =
      [a.createdAt, b.createdAt]
        .filter((c) => Number.isFinite(Date.parse(c)))
        .sort((x, y) => Date.parse(y) - Date.parse(x))[0] ?? tsOf(a.updatedAt);
    add(
      "W10",
      `PR #${a.pr} + #${b.pr}`,
      `${a.headSha}+${b.headSha}`,
      `lanes ${a.lane} and ${b.lane} share ${shared} file${shared === 1 ? "" : "s"}`,
      "coordinate or rebase order",
      since,
    );
  }

  const visible = items.filter((i) => {
    if (!has(input.acks, i.key)) return true;
    const until = input.acks[i.key].until;
    if (until === null || until === undefined) return false; // holds while the sha is unchanged
    const u = Date.parse(until);
    return !(Number.isFinite(u) && nowMs < u);
  });
  const age = (i: WasteItem): number => nowMs - Date.parse(i.since);
  return visible.sort(
    (x, y) =>
      TIER[x.rule] - TIER[y.rule] || age(y) - age(x) || cmp(x.rule, y.rule) || cmp(x.key, y.key),
  );
}

/** Source warnings for rules that could not be evaluated (W5 needs the `relanded` predicate). */
export function wasteWarnings(input: WasteInput): string[] {
  const closed = input.prs.some((p) => p.state === "closed" && !p.mergedAt);
  return closed && !input.relanded
    ? ["W5 skipped: no relanded predicate (is the clone missing or master unfetched?)"]
    : [];
}
