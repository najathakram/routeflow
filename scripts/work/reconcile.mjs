#!/usr/bin/env node
// reconcile.mjs — the work-board auto-updater ("reconciler").
//
// Status on the RouteFlow work board (GitHub Project v2 #3) is DERIVED from
// GitHub facts, never typed by hand (docs/work/WORKFLOW.md, rule 3). Every
// run: auto-adds open issues/PRs to the board, links PRs to issues, derives
// Status/Priority/Lane/Kind/Worker/Last activity for every board item, writes
// only the fields that changed, auto-closes issues GitHub itself didn't close
// on merge, flags/unassigns stale claims, and publishes a drift digest onto
// the single open `work-status` issue plus (at most once a day, or on change)
// a project status update.
//
// No npm dependencies — plain Node, ESM. Talks to GitHub entirely through the
// `gh` CLI (`execFileSync`): `gh issue`/`gh pr` subcommands for simple repo
// mutations (comment, close, edit, create), `gh api graphql` for everything
// Projects-v2-specific (item/field reads, field-value writes, status
// updates) that the CLI has no first-class command for.
//
// Field ids and single-select option ids are ALWAYS resolved at runtime by
// name (never hardcoded) — see resolveProjectFields(). Project owner/number/
// id and the repo are the only ids pinned, per the task's own Facts section.
//
// Usage:
//   node scripts/work/reconcile.mjs [--apply] [--dry-run] [--json] [--quiet] [--help]
// A bare run is a DRY RUN (#2284): only an explicit --apply writes to the board. An unknown
// argument (a typo, --dryrun, anything) exits 2 with the usage and writes nothing.
//
// Every exported function above the "── IO" marker is pure (no gh/fs/Date.now
// calls) and is what scripts/work/reconcile.self-test.mjs exercises directly.
// One exception: postStatusUpdateIfDue takes its gh/fs side effects
// (post/save) as injected callbacks rather than calling them directly, so
// its own body still has no gh/fs/Date.now call, and the self-test can
// assert call order with fakes instead of a live gh/GraphQL call.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REPO_OWNER = "najathakram";
const REPO_NAME = "routeflow";
const REPO = `${REPO_OWNER}/${REPO_NAME}`;
const PROJECT_OWNER = "najathakram";
const PROJECT_NUMBER = 3;
const PROJECT_URL = "https://github.com/users/najathakram/projects/3";
const FLEET_LOG_ISSUE = 938;
const WORK_STATUS_LABEL = "work-status";
const WORK_STATUS_TITLE = "Work board status (auto-updated)";

// PRs opened before the board went live predate the Closes-#N convention; never flag them as orphans.
const BOARD_EPOCH = "2026-09-25T00:00:00Z";

const STALE_FLAG_H = 24;
const STALE_UNASSIGN_H = 72;
const REVIEW_STALE_H = 48;
const INBOX_STALE_H = 24;
const MILESTONE_DUE_SOON_DAYS = 3;
const MILESTONE_RISK_OPEN_PCT = 25;
const RATE_LIMIT_FLOOR = 200;
const DIGEST_MAX_STALE_HOURS = 6;
const MUTATION_CHUNK = 20;

const DEFAULT_WORK_DIR = join(ROOT, "local-assets", "work");
// B973: `RECONCILE_WORK_DIR` relocates the lock/state/log (the self-test runs against a temp dir, never the real board's files).
// It is announced on stderr whenever it is in effect (see main), so a stray export cannot silently move the state.
const WORK_DIR = process.env.RECONCILE_WORK_DIR
  ? resolve(process.env.RECONCILE_WORK_DIR)
  : DEFAULT_WORK_DIR;
const STATE_FILE = join(WORK_DIR, "reconcile-state.json");
const LOG_FILE = join(WORK_DIR, "reconcile.log");
const RECONCILE_LOCK_FILE = join(WORK_DIR, "reconcile.lock");

// ════════════════════════════════════════════════════════════════════════
// PURE — label parsing
// ════════════════════════════════════════════════════════════════════════

export function labelNames(labels = []) {
  return (labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);
}

/** Splits an issue/PR's label set into the board's derived fields plus the raw flag set. */
export function parseLabels(labels = []) {
  const out = { priority: null, lane: null, kind: null, flags: new Set() };
  for (const name of labelNames(labels)) {
    if (name.startsWith("prio:")) out.priority = name.slice("prio:".length);
    else if (name.startsWith("lane:")) out.lane = name.slice("lane:".length);
    else if (name.startsWith("kind:")) out.kind = name.slice("kind:".length);
    else out.flags.add(name);
  }
  return out;
}

/** #938 (FLEET_LOG_ISSUE, the fleet-wide activity log) and any issue that
 * itself carries the `work-status` label (the board's own auto-generated
 * digest issue) are excluded from ALL board processing, not merely from
 * auto-add — field derivation, auto-close, stale-unassign, and every digest
 * count must never see them. If either is already a board item (added
 * before this rule existed, or added by hand), the caller removes it. */
export function isExcludedFromBoard(issue) {
  return issue.number === FLEET_LOG_ISSUE || labelNames(issue.labels).includes(WORK_STATUS_LABEL);
}

// ════════════════════════════════════════════════════════════════════════
// PURE — PR ↔ issue linking (all three methods)
// ════════════════════════════════════════════════════════════════════════

const CLOSES_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;

/** "Closes #12" / "Fixes #12, #13" / "resolved #12" anywhere in a PR body. */
export function extractClosesRefs(body = "") {
  const nums = new Set();
  for (const m of String(body ?? "").matchAll(CLOSES_RE)) nums.add(Number(m[1]));
  return [...nums];
}

const BRANCH_RE = /^[a-z][a-z0-9]*\/(\d+)-/;

/** `<kind>/<N>-slug` branch naming convention. */
export function extractBranchIssueNumber(headRefName = "") {
  const m = BRANCH_RE.exec(String(headRefName ?? ""));
  return m ? Number(m[1]) : null;
}

/** Every issue number a PR links to, by any of the three methods, deduped. */
export function resolveLinkedIssueNumbers(pr) {
  const nums = new Set();
  for (const n of pr?.closingIssuesReferences ?? []) nums.add(n);
  for (const n of extractClosesRefs(pr?.body)) nums.add(n);
  const branchNum = extractBranchIssueNumber(pr?.headRefName);
  if (branchNum != null) nums.add(branchNum);
  return [...nums];
}

/** issue number -> array of PR content objects linked to it. */
export function buildIssuePRIndex(prs = []) {
  const index = new Map();
  for (const pr of prs) {
    for (const issueNumber of resolveLinkedIssueNumbers(pr)) {
      if (!index.has(issueNumber)) index.set(issueNumber, []);
      index.get(issueNumber).push(pr);
    }
  }
  return index;
}

// ════════════════════════════════════════════════════════════════════════
// PURE — status derivation
// ════════════════════════════════════════════════════════════════════════

/** Status = closed→Done; blocked→Blocked; needs-triage→Inbox; linked open
 * non-draft PR→In review; linked open draft PR OR an assignee→In progress;
 * else Ready. Order matters — evaluated in exactly this precedence. */
export function deriveIssueStatus(issue, linkedPRs = []) {
  if (issue.state === "CLOSED") return "Done";
  const flags = parseLabels(issue.labels).flags;
  if (flags.has("blocked") || flags.has("blocked:owner")) return "Blocked";
  if (flags.has("needs-triage")) return "Inbox";
  if (linkedPRs.some((pr) => pr.state === "OPEN" && !pr.isDraft)) return "In review";
  const openDraft = linkedPRs.some((pr) => pr.state === "OPEN" && pr.isDraft);
  const hasAssignee = (issue.assignees ?? []).length > 0;
  if (openDraft || hasAssignee) return "In progress";
  return "Ready";
}

/** PR Status = merged or closed→Done; draft→In progress; open→In review. */
export function derivePRStatus(pr) {
  if (pr.merged || pr.state === "CLOSED") return "Done";
  if (pr.isDraft) return "In progress";
  return "In review";
}

// ════════════════════════════════════════════════════════════════════════
// PURE — worker derivation
// ════════════════════════════════════════════════════════════════════════

const CLAIMED_BY_RE = /^Claimed by (.+)$/m;
const WORKER_LINE_RE = /^Worker:\s*(.+)$/m;

/** Newest "Claimed by <worker>" comment; else a "Worker:" line in a linked PR body. */
export function deriveWorkerForIssue(issue, linkedPRs = []) {
  const comments = [...(issue.comments ?? [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  for (const c of comments) {
    const m = CLAIMED_BY_RE.exec(c.body ?? "");
    if (m) return m[1].trim();
  }
  for (const pr of linkedPRs) {
    const w = deriveWorkerForPR(pr);
    if (w) return w;
  }
  return null;
}

export function deriveWorkerForPR(pr) {
  const m = WORKER_LINE_RE.exec(pr?.body ?? "");
  return m ? m[1].trim() : null;
}

// ════════════════════════════════════════════════════════════════════════
// PURE — last activity
// ════════════════════════════════════════════════════════════════════════

function prLastCommitDate(pr) {
  const nodes = pr?.commits?.nodes ?? [];
  const dates = nodes.map((c) => c?.commit?.committedDate).filter(Boolean);
  return dates.length ? dates.sort().at(-1) : null;
}

function maxISO(...isos) {
  const valid = isos.filter(Boolean);
  if (!valid.length) return null;
  return valid.reduce((a, b) => (new Date(a).getTime() > new Date(b).getTime() ? a : b));
}

/** Full-precision ISO instant — max(issue updatedAt, every linked PR's last commit date). */
export function lastActivityInstant(issue, linkedPRs = []) {
  return maxISO(issue.updatedAt, ...linkedPRs.map(prLastCommitDate));
}

/** PR: last commit date, falling back to updatedAt if it somehow has no commits. */
export function lastActivityInstantForPR(pr) {
  return prLastCommitDate(pr) ?? pr.updatedAt ?? null;
}

/** The Project "Last activity" field is a date, so truncate only at write time. */
export function toDateValue(iso) {
  return iso ? String(iso).slice(0, 10) : null;
}

// ════════════════════════════════════════════════════════════════════════
// PURE — stale claims (section 6)
// ════════════════════════════════════════════════════════════════════════

/**
 * now/lastActivity are Date/ISO. Returns null (nothing to do), or
 * { action: "flag" | "unassign", hours, reason }.
 */
export function staleClaimAction(issue, linkedPRs = [], now) {
  if (issue.state !== "OPEN") return null;
  if (!(issue.assignees ?? []).length) return null;
  const instant = lastActivityInstant(issue, linkedPRs);
  const hours = instant ? (now.getTime() - new Date(instant).getTime()) / 3_600_000 : Infinity;
  const hasOpenLinkedPR = linkedPRs.some((pr) => pr.state === "OPEN");
  if (hours > STALE_UNASSIGN_H) {
    if (hasOpenLinkedPR) return { action: "flag", hours, reason: "stale-72h-open-pr" };
    return { action: "unassign", hours, reason: "stale-72h" };
  }
  if (hours > STALE_FLAG_H) return { action: "flag", hours, reason: "stale-24h" };
  return null;
}

// ════════════════════════════════════════════════════════════════════════
// PURE — auto-close (section 5)
// ════════════════════════════════════════════════════════════════════════

/**
 * An open issue with a merged linked PR that GitHub's own auto-close did NOT
 * already fire for (i.e. the link came only from branch name or PR-body text
 * that closingIssuesReferences doesn't carry) should be closed by us.
 * Returns the PR to cite, or null.
 */
export function shouldAutoCloseIssue(issue, linkedPRs = []) {
  if (issue.state !== "OPEN") return null;
  for (const pr of linkedPRs) {
    if (!pr.merged) continue;
    const githubClosedIt = (pr.closingIssuesReferences ?? []).includes(issue.number);
    if (!githubClosedIt) return pr;
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════
// PURE — idempotent close/unassign (overlapping-reconcile dedupe, fix 2b)
// ════════════════════════════════════════════════════════════════════════

/** `live` is a freshly re-read { state, assignees } (or null when the gh
 * read itself failed). true = a close is no longer needed — some other,
 * overlapping reconcile already closed this issue. A failed read (null)
 * never skips the action; we'd rather attempt a close gh can safely no-op
 * on than silently drop one that's still needed. */
export function shouldSkipClose(live) {
  return !!live && live.state === "CLOSED";
}

/** Same shape as shouldSkipClose: true = already unassigned (zero live
 * assignees), so the unassign-with-comment is no longer needed. */
export function shouldSkipUnassign(live) {
  return !!live && (live.assignees ?? []).length === 0;
}

/** Runs `attempt()` (the actual gh mutation). A gh failure on a close/
 * unassign path must not abort the whole reconcile run — it's converted to
 * a skip-with-reason the caller logs and moves past, instead of letting the
 * exception propagate out of main()'s per-issue loop. */
export function attemptGhAction(attempt) {
  try {
    attempt();
    return { acted: true };
  } catch (e) {
    return { acted: false, reason: `gh failed: ${e?.message ?? e}` };
  }
}

// ════════════════════════════════════════════════════════════════════════
// PURE — lane conflicts (section 7)
// ════════════════════════════════════════════════════════════════════════

/** issueRows: [{ number, lane, status }]. Lanes with more than one In progress issue. */
export function findLaneConflicts(issueRows = []) {
  const byLane = new Map();
  for (const row of issueRows) {
    if (row.status !== "In progress" || !row.lane) continue;
    if (!byLane.has(row.lane)) byLane.set(row.lane, []);
    byLane.get(row.lane).push(row.number);
  }
  const conflicts = [];
  for (const [lane, issues] of byLane) {
    if (issues.length > 1) conflicts.push({ lane, issues: [...issues].sort((a, b) => a - b) });
  }
  return conflicts.sort((a, b) => a.lane.localeCompare(b.lane));
}

// ════════════════════════════════════════════════════════════════════════
// PURE — milestone risk (section 7 + 9)
// ════════════════════════════════════════════════════════════════════════

/** items: [{ state: "OPEN" | "CLOSED" }] — every board issue in this milestone. */
export function milestoneStats(title, dueOn, items = [], now) {
  const total = items.length;
  const closed = items.filter((i) => i.state === "CLOSED").length;
  const open = total - closed;
  const percentDone = total ? Math.round((closed / total) * 100) : 0;
  const openPct = total ? Math.round((open / total) * 100) : 0;
  const dueDate = dueOn ? new Date(dueOn) : null;
  const pastDue = !!dueDate && now.getTime() > dueDate.getTime();
  const dueSoon =
    !!dueDate &&
    !pastDue &&
    (dueDate.getTime() - now.getTime()) / 86_400_000 <= MILESTONE_DUE_SOON_DAYS;
  // section 7: AT RISK when past due with open items, or due within 3 days with >25% open.
  const atRisk = (pastDue && open > 0) || (dueSoon && openPct > MILESTONE_RISK_OPEN_PCT);
  // section 9's stronger OFF_TRACK condition: past due AND >25% still open.
  const offTrack = pastDue && openPct > MILESTONE_RISK_OPEN_PCT;
  return {
    title,
    dueOn: dueOn ?? null,
    total,
    open,
    closed,
    percentDone,
    openPct,
    atRisk,
    offTrack,
  };
}

/** section 9: AT_RISK if any milestone at risk or any P0 open; OFF_TRACK if a
 * milestone is past due with >25% open (checked first — it's the worse state). */
export function overallProjectStatus(milestoneStatsList = [], openP0Count = 0) {
  if (milestoneStatsList.some((m) => m.offTrack)) return "OFF_TRACK";
  if (milestoneStatsList.some((m) => m.atRisk) || openP0Count > 0) return "AT_RISK";
  return "ON_TRACK";
}

// ════════════════════════════════════════════════════════════════════════
// PURE — change detection (write only what changed)
// ════════════════════════════════════════════════════════════════════════

/**
 * current/desired: { FieldName: value | null }. Returns { changed: {field:
 * value}, cleared: [field] } — only fields that actually differ. A field
 * absent from `desired` is left untouched (not cleared).
 */
export function diffFieldValues(current = {}, desired = {}) {
  const changed = {};
  const cleared = [];
  for (const field of Object.keys(desired)) {
    const want = desired[field] ?? null;
    const have = current[field] ?? null;
    if (want === have) continue;
    if (want === null) cleared.push(field);
    else changed[field] = want;
  }
  return { changed, cleared };
}

// ════════════════════════════════════════════════════════════════════════
// PURE — per-item derivation (composes the above)
// ════════════════════════════════════════════════════════════════════════

/** Full desired-field set for a board ISSUE. */
export function deriveIssueFields(issue, linkedPRs = []) {
  const { priority, lane, kind } = parseLabels(issue.labels);
  return {
    Status: deriveIssueStatus(issue, linkedPRs),
    Priority: priority,
    Lane: lane,
    Kind: kind,
    Worker: deriveWorkerForIssue(issue, linkedPRs),
    "Last activity": toDateValue(lastActivityInstant(issue, linkedPRs)),
  };
}

/** Full desired-field set for a board PULL REQUEST. Priority/Lane/Kind copy
 * from its linked issue (first one found on the board), if any. */
export function derivePRFields(pr, linkedIssue) {
  const fromIssue = linkedIssue
    ? parseLabels(linkedIssue.labels)
    : { priority: null, lane: null, kind: null };
  return {
    Status: derivePRStatus(pr),
    Priority: fromIssue.priority,
    Lane: fromIssue.lane,
    Kind: fromIssue.kind,
    // A PR without its own Worker: line is worked by whoever claimed its linked issue.
    Worker: deriveWorkerForPR(pr) ?? (linkedIssue ? deriveWorkerForIssue(linkedIssue, []) : null),
    "Last activity": toDateValue(lastActivityInstantForPR(pr)),
  };
}

// ════════════════════════════════════════════════════════════════════════
// PURE — digest rendering (section 8)
// ════════════════════════════════════════════════════════════════════════

/** Ignore the timestamp line so a same-content republish never counts as changed. */
export function digestBodyChanged(oldBody, newBody) {
  const strip = (s) =>
    String(s ?? "")
      .split("\n")
      .slice(1)
      .join("\n")
      .trim();
  return strip(oldBody) !== strip(newBody);
}

function fmtHours(h) {
  return Number.isFinite(h) ? `${Math.round(h)}h` : "—";
}

/**
 * data = {
 *   generatedAtLabel: string,          // already UTC-formatted
 *   releases: [milestoneStats() rows],
 *   staleClaims: [{ number, worker, hours, reason }],
 *   laneConflicts: [{ lane, issues }],
 *   orphanPRs: [number],
 *   reviewStalePRs: [{ number, reason }],
 *   inboxStale: [number],
 *   inFlight: [{ number, status, worker, title }],
 *   inboxCount: number,
 *   recentlyDone: [{ number, title }],
 * }
 */
export function renderDigestBody(d) {
  const lines = [];
  lines.push(`Updated ${d.generatedAtLabel} by the reconciler`);
  lines.push("");
  lines.push("## Releases");
  lines.push("");
  lines.push("| Release | Progress | Due | Status |");
  lines.push("| --- | --- | --- | --- |");
  if (!d.releases.length) lines.push("| — | no milestones tracked | — | — |");
  for (const r of d.releases) {
    const status = r.offTrack ? "OFF TRACK" : r.atRisk ? "AT RISK" : "on track";
    lines.push(
      `| ${r.title} | ${r.percentDone}% (${r.closed}/${r.total}, ${r.open} open) | ${r.dueOn ? r.dueOn.slice(0, 10) : "—"} | ${status} |`,
    );
  }
  lines.push("");
  lines.push("## Needs attention");
  lines.push("");
  const anyDrift =
    d.staleClaims.length ||
    d.laneConflicts.length ||
    d.orphanPRs.length ||
    d.reviewStalePRs.length ||
    d.inboxStale.length;
  if (!anyDrift) {
    lines.push("Nothing outstanding.");
  } else {
    if (d.staleClaims.length) {
      lines.push("**Stale claims**");
      for (const c of d.staleClaims) {
        lines.push(
          `- #${c.number} — ${c.worker ?? "unknown worker"} — ${fmtHours(c.hours)} since last activity`,
        );
      }
      lines.push("");
    }
    if (d.laneConflicts.length) {
      lines.push("**Lane conflicts**");
      for (const c of d.laneConflicts) {
        lines.push(`- ${c.lane}: ${c.issues.map((n) => `#${n}`).join(", ")}`);
      }
      lines.push("");
    }
    if (d.orphanPRs.length) {
      lines.push("**Open PRs with no linked issue**");
      lines.push(d.orphanPRs.map((n) => `#${n}`).join(", "));
      lines.push("");
    }
    if (d.reviewStalePRs.length) {
      lines.push("**Stuck in review**");
      for (const p of d.reviewStalePRs) lines.push(`- #${p.number} — ${p.reason}`);
      lines.push("");
    }
    if (d.inboxStale.length) {
      lines.push("**Inbox > 24h**");
      lines.push(d.inboxStale.map((n) => `#${n}`).join(", "));
      lines.push("");
    }
  }
  lines.push("## In flight");
  lines.push("");
  lines.push("| # | Status | Worker |");
  lines.push("| --- | --- | --- |");
  if (!d.inFlight.length) lines.push("| — | — | — |");
  for (const it of d.inFlight) lines.push(`| #${it.number} | ${it.status} | ${it.worker ?? "—"} |`);
  lines.push("");
  lines.push(`## Inbox: ${d.inboxCount}`);
  lines.push("");
  lines.push("## Recently done (last 24h)");
  lines.push("");
  if (!d.recentlyDone.length) lines.push("Nothing closed in the last 24h.");
  else for (const it of d.recentlyDone) lines.push(`- #${it.number} ${it.title}`);
  lines.push("");
  return lines.join("\n");
}

/** section 9: 5–8 line project status update body. */
export function renderStatusUpdateBody(status, d) {
  const lines = [];
  lines.push(`Overall: ${status}.`);
  const atRiskReleases = d.releases.filter((r) => r.atRisk || r.offTrack);
  if (atRiskReleases.length) {
    lines.push(
      `Releases needing attention: ${atRiskReleases.map((r) => `${r.title} (${r.percentDone}% done, due ${r.dueOn ? r.dueOn.slice(0, 10) : "—"})`).join("; ")}.`,
    );
  } else {
    lines.push("All tracked releases are on track.");
  }
  lines.push(
    `${d.staleClaims.length} stale claim(s), ${d.laneConflicts.length} lane conflict(s), ${d.orphanPRs.length} unlinked PR(s), ${d.reviewStalePRs.length} PR(s) stuck in review.`,
  );
  lines.push(`${d.inboxCount} issue(s) in Inbox, ${d.inFlight.length} in flight.`);
  lines.push(`Full digest: ${d.digestIssueUrl}`);
  return lines.join("\n");
}

// ════════════════════════════════════════════════════════════════════════
// PURE — rate limit circuit breaker
// ════════════════════════════════════════════════════════════════════════

export function shouldHaltWrites(remaining) {
  return typeof remaining === "number" && remaining < RATE_LIMIT_FLOOR;
}

// ════════════════════════════════════════════════════════════════════════
// PURE — reconcile's own overlap lock (fix 2a)
// ════════════════════════════════════════════════════════════════════════

export const RECONCILE_LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * lock: { pid, startedAt } or null/undefined. now: Date. Mirrors run.mjs's
 * own isLockStale — true = no lock, or one old enough (>= 10 min) to be
 * considered abandoned (a crashed run never releases it) and safe to
 * reclaim. Gives reconcile.mjs its own lock file independent of run.mjs's
 * run.lock, so a trigger.mjs-spawned reconcile (which never takes
 * run.lock) and a run.mjs-spawned reconcile can never run concurrently and
 * post duplicate comments.
 */
export function isReconcileLockStale(lock, now = new Date()) {
  if (!lock || !lock.startedAt) return true;
  const age = now.getTime() - new Date(lock.startedAt).getTime();
  return !(age < RECONCILE_LOCK_STALE_MS);
}

// ════════════════════════════════════════════════════════════════════════
// PURE — GraphQL mutation builders (string-building only, no network)
// ════════════════════════════════════════════════════════════════════════

function gqlStr(s) {
  return JSON.stringify(String(s));
}

const FIELD_KIND = {
  Status: "singleSelect",
  Priority: "singleSelect",
  Lane: "singleSelect",
  Kind: "singleSelect",
  Worker: "text",
  "Last activity": "date",
};

function fieldValueLiteral(kind, value) {
  if (kind === "singleSelect") return `{ singleSelectOptionId: ${gqlStr(value)} }`;
  if (kind === "date") return `{ date: ${gqlStr(value)} }`;
  return `{ text: ${gqlStr(value)} }`;
}

/** writes: [{ projectId, itemId, fieldId, kind, value }] or [{ ..., clear: true }]. */
export function buildFieldUpdateMutation(writes) {
  const parts = writes.map((w, i) => {
    const alias = `m${i}`;
    if (w.clear) {
      return `${alias}: clearProjectV2ItemFieldValue(input: { projectId: ${gqlStr(w.projectId)}, itemId: ${gqlStr(w.itemId)}, fieldId: ${gqlStr(w.fieldId)} }) { clientMutationId }`;
    }
    return `${alias}: updateProjectV2ItemFieldValue(input: { projectId: ${gqlStr(w.projectId)}, itemId: ${gqlStr(w.itemId)}, fieldId: ${gqlStr(w.fieldId)}, value: ${fieldValueLiteral(w.kind, w.value)} }) { projectV2Item { id } }`;
  });
  return `mutation {\n${parts.join("\n")}\n}`;
}

export function buildAddItemsMutation(projectId, contentIds) {
  const parts = contentIds.map(
    (id, i) =>
      `a${i}: addProjectV2ItemById(input: { projectId: ${gqlStr(projectId)}, contentId: ${gqlStr(id)} }) { item { id } }`,
  );
  return `mutation {\n${parts.join("\n")}\n}`;
}

/**
 * Splits one addProjectV2ItemById batch result into added items, contents that
 * are ALREADY on the board (GitHub answers "Content already exists in this
 * project", e.g. after the Project's own auto-add-sub-issues workflow put them
 * there first; not an error for us), and genuine failures.
 */
export function classifyAddResults(contentIds, data = {}, errors = []) {
  const added = new Map();
  const existing = [];
  const fatal = [];
  contentIds.forEach((contentId, i) => {
    const alias = `a${i}`;
    const id = data?.[alias]?.item?.id;
    if (id) return added.set(contentId, id);
    const err = errors.find((e) => Array.isArray(e.path) && e.path[0] === alias);
    if (err && /already exists/i.test(err.message ?? "")) return existing.push(contentId);
    fatal.push(err?.message ?? `no item returned for ${alias}`);
  });
  return { added, existing, fatal };
}

/** Removes board items outright (fix 1: #938 / work-status issues that were
 * already on the board before the exclusion rule fired). itemIds are
 * ProjectV2Item ids, not content ids. */
export function buildDeleteItemsMutation(projectId, itemIds) {
  const parts = itemIds.map(
    (id, i) =>
      `d${i}: deleteProjectV2Item(input: { projectId: ${gqlStr(projectId)}, itemId: ${gqlStr(id)} }) { deletedItemId }`,
  );
  return `mutation {\n${parts.join("\n")}\n}`;
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Turns a diffFieldValues() result + field/option id maps into the write list
 * buildFieldUpdateMutation() consumes, skipping any field whose desired option
 * name has no matching live option (warns instead of writing garbage). */
export function planWrites({ projectId, itemId, current, desired, fieldsByName }) {
  const { changed, cleared } = diffFieldValues(current, desired);
  const writes = [];
  const skipped = [];
  for (const [field, value] of Object.entries(changed)) {
    const def = fieldsByName[field];
    if (!def) {
      skipped.push({ field, reason: "unknown field" });
      continue;
    }
    const kind = FIELD_KIND[field];
    if (kind === "singleSelect") {
      const opt = (def.options ?? []).find((o) => o.name === value);
      if (!opt) {
        skipped.push({ field, value, reason: "no matching option" });
        continue;
      }
      writes.push({ projectId, itemId, fieldId: def.id, kind, value: opt.id });
    } else {
      writes.push({ projectId, itemId, fieldId: def.id, kind, value });
    }
  }
  for (const field of cleared) {
    const def = fieldsByName[field];
    if (!def) {
      skipped.push({ field, reason: "unknown field" });
      continue;
    }
    writes.push({ projectId, itemId, fieldId: def.id, clear: true });
  }
  return { writes, skipped };
}

// ════════════════════════════════════════════════════════════════════════
// PURE (dependency-injected) — status-update persistence ordering (fix 5)
// ════════════════════════════════════════════════════════════════════════

/**
 * Decides whether to post the project status update and, when it does,
 * saves the state file IMMEDIATELY after a successful post — before any
 * other step — so a later failure elsewhere in the run can never cause the
 * same status to be re-posted on a subsequent run. `post`/`save` are
 * injected (rather than calling postProjectStatusUpdate/saveState
 * directly) so this ordering is exercised by the self-test without a live
 * gh/GraphQL call.
 */
export function postStatusUpdateIfDue({
  shouldPostStatus,
  halted,
  dryRun,
  now,
  state,
  overallStatus,
  statusBody,
  post,
  save,
}) {
  if (!shouldPostStatus || halted) return { posted: false, state };
  post(statusBody);
  const nextState = {
    ...state,
    lastStatusPostedAt: now.toISOString(),
    lastStatusValue: overallStatus,
  };
  if (!dryRun) save(nextState);
  return { posted: true, state: nextState };
}

/**
 * Decides which single open `work-status` issue ensureWorkStatusIssue()
 * should use (and which other open ones, if any, to close as duplicates) —
 * or whether the evidence gathered so far isn't enough to safely create a
 * new one. Fixes #2043: a `gh issue list --label work-status` call that came
 * back empty in one run, even though #1507 existed and carried the label,
 * caused a duplicate to be created. This function never returns "create"
 * from a single empty label read.
 *
 * persisted: the state file's remembered issue number re-verified via
 *   `gh issue view` this run — { number, state, labels } — or null when
 *   nothing is persisted yet (or the view call failed, e.g. deleted issue).
 *   Used as-is only while still OPEN and still carrying the work-status
 *   label; otherwise treated the same as no persisted issue.
 * labelRows: the rows from the most recent `--label work-status --state
 *   open` list call, each { number, title, body }.
 * labelAttemptsCount: how many label-list attempts have been made so far
 *   (1, or 2 after the one 5s retry on an empty first attempt).
 * titleRows: rows from the `in:title` search fallback, each { number,
 *   title, body } — or null when that search hasn't been run yet (it's
 *   only run once both label attempts came back empty).
 *
 * Returns one of:
 *   { action: "use", number, closeDuplicates: number[] }
 *   { action: "create", number: null, closeDuplicates: [] }
 *   { action: "insufficient-evidence", number: null, closeDuplicates: [] }
 *     — caller must gather more (retry the label lookup, then the title
 *     search) before deciding; never create on this.
 */
export function decideWorkStatusIssue({
  persisted = null,
  labelRows = [],
  labelAttemptsCount = 0,
  titleRows = null,
}) {
  if (
    persisted &&
    persisted.state === "OPEN" &&
    labelNames(persisted.labels).includes(WORK_STATUS_LABEL)
  ) {
    return { action: "use", number: persisted.number, closeDuplicates: [] };
  }

  const pickLowest = (rows) => {
    const sorted = [...rows].sort((a, b) => a.number - b.number);
    return {
      action: "use",
      number: sorted[0].number,
      closeDuplicates: sorted.slice(1).map((r) => r.number),
    };
  };

  if (labelRows.length) return pickLowest(labelRows);
  if (titleRows && titleRows.length) return pickLowest(titleRows);
  if (labelAttemptsCount >= 2 && titleRows !== null && titleRows.length === 0) {
    return { action: "create", number: null, closeDuplicates: [] };
  }
  return { action: "insufficient-evidence", number: null, closeDuplicates: [] };
}

// ════════════════════════════════════════════════════════════════════════
// ── CLI arguments (#2284) ──────────────────────────────────────────────
// `--help` once ran a LIVE apply: the old parser only looked for three flags, ignored anything
// else, and defaulted to writing. Now every argument must be known, writing needs an explicit
// `--apply`, and the verdict is decided before the lock, the log or any gh call.
export const RECONCILE_USAGE =
  "usage: node scripts/work/reconcile.mjs [--apply] [--dry-run] [--json] [--quiet] [--help]\n" +
  "  a bare run is a dry run; only --apply writes to the board\n" +
  "  RECONCILE_WORK_DIR=<absolute dir> relocates the lock/state/log (for tests); announced on stderr, and --apply is refused while it is set";
const RECONCILE_FLAGS = new Set(["--apply", "--dry-run", "--json", "--quiet", "--help", "-h"]);

/**
 * Pure. `{ ok: true, help, apply, dryRun, json, quiet }`, or `{ ok: false, error }` for an
 * unknown argument or `--apply` together with `--dry-run`. `dryRun` is true unless `--apply`.
 */
export function parseArgs(argv) {
  const unknown = argv.filter((a) => !RECONCILE_FLAGS.has(a));
  if (unknown.length) return { ok: false, error: `unknown argument(s): ${unknown.join(" ")}` };
  const apply = argv.includes("--apply");
  if (apply && argv.includes("--dry-run"))
    return { ok: false, error: "--apply and --dry-run are mutually exclusive" };
  return {
    ok: true,
    help: argv.includes("--help") || argv.includes("-h"),
    apply,
    dryRun: !apply,
    json: argv.includes("--json"),
    quiet: argv.includes("--quiet"),
  };
}

// ── IO ─────────────────────────────────────────────────────────────────
// Everything below here talks to `gh` or the filesystem/clock.
// ════════════════════════════════════════════════════════════════════════

function gh(args, { allowFail = false, input } = {}) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      input: input ?? "",
    }).trim();
  } catch (e) {
    if (allowFail) return null;
    const msg = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || String(e.message ?? e);
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${msg}`);
  }
}

function ghJson(args, opts) {
  const out = gh(args, opts);
  if (out === null) return null;
  return JSON.parse(out);
}

function graphql(query, vars = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) {
    if (v === null || v === undefined) continue;
    args.push("-F", `${k}=${v}`);
  }
  const out = gh(args);
  const parsed = JSON.parse(out);
  if (parsed.errors?.length) {
    throw new Error(`GraphQL error: ${parsed.errors.map((e) => e.message).join("; ")}`);
  }
  return parsed.data;
}

const FIELDS_QUERY = `
query($org: String!, $number: Int!) {
  rateLimit { remaining resetAt }
  user(login: $org) {
    projectV2(number: $number) {
      id
      fields(first: 50) {
        nodes {
          __typename
          ... on ProjectV2FieldCommon { id name }
          ... on ProjectV2SingleSelectField { id name options { id name } }
        }
      }
    }
  }
}`;

function resolveProjectFields() {
  const data = graphql(FIELDS_QUERY, { org: PROJECT_OWNER, number: PROJECT_NUMBER });
  const project = data.user?.projectV2;
  if (!project) throw new Error(`project ${PROJECT_OWNER}/${PROJECT_NUMBER} not found`);
  const fieldsByName = {};
  for (const f of project.fields.nodes) {
    if (!f?.name) continue;
    fieldsByName[f.name] = { id: f.id, options: f.options ?? null };
  }
  return { projectId: project.id, fieldsByName, rateRemaining: data.rateLimit?.remaining };
}

// Field selections for the two concrete content types. Used directly when the
// GraphQL type is already known (repository.issues / repository.pullRequests
// nodes are concretely typed), and wrapped in `... on Issue { }` / `... on
// PullRequest { }` inline fragments only where `content` is the ProjectV2Item
// union (spreading a PullRequest fragment inside a concrete Issue selection
// set is a GraphQL error, not merely redundant).
// fix 3: 100 (not 30) so deriveWorkerForIssue's "newest Claimed by" scan
// reaches far enough back on an issue with a long comment history. Exported
// (string constant, no gh/fs call of its own) so the self-test can assert
// the fetch width directly instead of only exercising it indirectly.
export const ISSUE_FIELDS = `
id number title state
labels(first: 20) { nodes { name } }
assignees(first: 10) { nodes { login } }
milestone { title dueOn }
createdAt updatedAt closedAt
comments(last: 100) { nodes { body createdAt } }`;

const PR_FIELDS = `
id number title state isDraft merged mergedAt headRefName body createdAt updatedAt
commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
mergeable
closingIssuesReferences(first: 10) { nodes { number } }`;

const ITEM_CONTENT_FRAGMENT = `
__typename
... on Issue { ${ISSUE_FIELDS} }
... on PullRequest { ${PR_FIELDS} }`;

const ITEMS_QUERY = `
query($org: String!, $number: Int!, $cursor: String) {
  rateLimit { remaining resetAt }
  user(login: $org) {
    projectV2(number: $number) {
      items(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isArchived
          fieldValues(first: 20) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } }
            }
          }
          content { ${ITEM_CONTENT_FRAGMENT} }
        }
      }
    }
  }
}`;

// GraphQL connections come back as `{ nodes: [...] }`, not flat arrays — the
// pure derivation layer above (and its self-test fixtures) expects flat
// arrays, so every raw content node is normalized once, right here at the
// query boundary, before anything else touches it.
function normalizeIssueNode(n) {
  return {
    ...n,
    labels: (n.labels?.nodes ?? []).map((l) => l.name),
    assignees: (n.assignees?.nodes ?? []).map((a) => ({ login: a.login })),
    comments: (n.comments?.nodes ?? []).map((c) => ({ body: c.body, createdAt: c.createdAt })),
  };
}
function normalizePRNode(n) {
  return {
    ...n,
    closingIssuesReferences: (n.closingIssuesReferences?.nodes ?? []).map((r) => r.number),
  };
}
function normalizeContent(node) {
  if (node.__typename === "Issue") return normalizeIssueNode(node);
  if (node.__typename === "PullRequest") return normalizePRNode(node);
  return node;
}

function fetchProjectItems() {
  const items = [];
  let cursor = null;
  let rateRemaining;
  for (;;) {
    const data = graphql(ITEMS_QUERY, { org: PROJECT_OWNER, number: PROJECT_NUMBER, cursor });
    rateRemaining = data.rateLimit?.remaining;
    const page = data.user.projectV2.items;
    for (const node of page.nodes) {
      if (node.isArchived) continue;
      if (!node.content?.__typename) continue; // draft issue / redacted
      const current = {};
      for (const fv of node.fieldValues.nodes) {
        const fieldName = fv.field?.name;
        if (!fieldName) continue;
        current[fieldName] = fv.name ?? fv.text ?? fv.date ?? null;
      }
      items.push({
        itemId: node.id,
        type: node.content.__typename,
        content: normalizeContent(node.content),
        current,
      });
    }
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return { items, rateRemaining };
}

function repoOpenQuery(kind) {
  const typeFilter = kind === "issue" ? "issues(states: OPEN" : "pullRequests(states: OPEN";
  const fields = kind === "issue" ? ISSUE_FIELDS : PR_FIELDS;
  return `
query($owner: String!, $name: String!, $cursor: String) {
  rateLimit { remaining resetAt }
  repository(owner: $owner, name: $name) {
    ${typeFilter}, first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { ${fields} }
    }
  }
}`;
}

function fetchOpenRepoNodes(kind) {
  const query = repoOpenQuery(kind);
  const field = kind === "issue" ? "issues" : "pullRequests";
  const normalize = kind === "issue" ? normalizeIssueNode : normalizePRNode;
  const nodes = [];
  let cursor = null;
  let rateRemaining;
  for (;;) {
    const data = graphql(query, { owner: REPO_OWNER, name: REPO_NAME, cursor });
    rateRemaining = data.rateLimit?.remaining;
    const page = data.repository[field];
    nodes.push(...page.nodes.map(normalize));
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return { nodes, rateRemaining };
}

// Like graphql(), but returns partial data + errors instead of throwing, because
// gh exits non-zero whenever ANY alias in a batched mutation errors.
function graphqlPartial(query) {
  let out;
  try {
    out = execFileSync("gh", ["api", "graphql", "-f", `query=${query}`], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    out = e.stdout;
    if (!out) throw new Error(`gh api graphql failed: ${e.stderr ?? e.message}`);
  }
  const parsed = JSON.parse(out);
  return { data: parsed.data ?? {}, errors: parsed.errors ?? [] };
}

function lookupExistingItemIds(projectId, contentIds) {
  const found = new Map();
  for (const group of chunk(contentIds, 50)) {
    const data = graphql(
      `query { nodes(ids: [${group.map(gqlStr).join(", ")}]) {
        ... on Issue { id projectItems(first: 20) { nodes { id project { id } } } }
        ... on PullRequest { id projectItems(first: 20) { nodes { id project { id } } } } } }`,
    );
    for (const n of data.nodes ?? []) {
      const item = n?.projectItems?.nodes?.find((pi) => pi.project?.id === projectId);
      if (item) found.set(n.id, item.id);
    }
  }
  return found;
}

function addItemsToProject(projectId, contentIds) {
  const idByContentId = new Map();
  const alreadyThere = [];
  for (const group of chunk(contentIds, MUTATION_CHUNK)) {
    const { data, errors } = graphqlPartial(buildAddItemsMutation(projectId, group));
    const { added, existing, fatal } = classifyAddResults(group, data, errors);
    if (fatal.length) throw new Error(`adding board items failed: ${fatal.join("; ")}`);
    for (const [c, id] of added) idByContentId.set(c, id);
    alreadyThere.push(...existing);
  }
  for (const [c, id] of lookupExistingItemIds(projectId, alreadyThere)) idByContentId.set(c, id);
  return idByContentId;
}

/** fix 1: removes already-on-the-board #938 / work-status items outright. */
function removeItemsFromProject(projectId, itemIds) {
  for (const group of chunk(itemIds, MUTATION_CHUNK)) {
    graphql(buildDeleteItemsMutation(projectId, group));
  }
}

function applyFieldWrites(writes) {
  for (const group of chunk(writes, MUTATION_CHUNK)) {
    graphql(buildFieldUpdateMutation(group));
  }
}

function nowUtcLabel(now) {
  return `${now.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function appendLog(line) {
  mkdirSync(WORK_DIR, { recursive: true });
  appendFileSync(LOG_FILE, `${JSON.stringify(line)}\n`, "utf8");
}

// fix 2a: reconcile.mjs's own overlap lock, independent of run.mjs's
// run.lock — see isReconcileLockStale() above.
function loadReconcileLock() {
  if (!existsSync(RECONCILE_LOCK_FILE)) return null;
  try {
    return JSON.parse(readFileSync(RECONCILE_LOCK_FILE, "utf8"));
  } catch {
    return null; // corrupt lock file -> treated as absent
  }
}

function writeReconcileLock(lock) {
  mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(RECONCILE_LOCK_FILE, JSON.stringify(lock, null, 2) + "\n", "utf8");
}

function releaseReconcileLockIfOwned(pid) {
  const lock = loadReconcileLock();
  if (lock && lock.pid === pid) {
    try {
      unlinkSync(RECONCILE_LOCK_FILE);
    } catch {
      // already gone — fine.
    }
  }
}

/** Synchronous sleep with no npm dependency — Atomics.wait on the main
 * thread works fine in Node (unlike browsers). Used only for the one
 * label-lookup retry in ensureWorkStatusIssue(). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function fetchIssueByNumber(number) {
  return ghJson(
    ["issue", "view", String(number), "--repo", REPO, "--json", "number,title,body,state,labels"],
    { allowFail: true },
  );
}

function fetchWorkStatusByLabel() {
  return (
    ghJson([
      "issue",
      "list",
      "--repo",
      REPO,
      "--label",
      WORK_STATUS_LABEL,
      "--state",
      "open",
      "--json",
      "number,title,body",
      "--limit",
      "10",
    ]) ?? []
  );
}

function fetchWorkStatusByTitle() {
  return (
    ghJson([
      "issue",
      "list",
      "--repo",
      REPO,
      "--search",
      `"${WORK_STATUS_TITLE}" in:title`,
      "--state",
      "open",
      "--json",
      "number,title,body",
      "--limit",
      "10",
    ]) ?? []
  );
}

function closeDuplicateWorkStatusIssues(numbers) {
  for (const n of numbers) {
    gh([
      "issue",
      "comment",
      String(n),
      "--repo",
      REPO,
      "--body",
      `Duplicate of the work board status issue — closing. The live digest stays on the other open \`${WORK_STATUS_LABEL}\` issue.`,
    ]);
    gh(["issue", "close", String(n), "--repo", REPO, "--reason", "not planned"]);
  }
}

/**
 * Finds (or creates) the single open work-status issue, preferring the
 * number persisted in state from a prior run — see decideWorkStatusIssue()
 * for the pure decision this wraps. Mutates `state.workStatusIssueNumber`
 * on every non-dry-run outcome so the next run starts from the persisted
 * fast path instead of a label lookup.
 */
function ensureWorkStatusIssue(dryRun, state) {
  const persistedNumber = state.workStatusIssueNumber;
  const persisted = persistedNumber ? fetchIssueByNumber(persistedNumber) : null;

  let labelRows = [];
  let labelAttemptsCount = 0;
  let titleRows = null;
  let decision = decideWorkStatusIssue({ persisted });

  if (decision.action === "insufficient-evidence") {
    labelRows = fetchWorkStatusByLabel();
    labelAttemptsCount = 1;
    decision = decideWorkStatusIssue({ persisted, labelRows, labelAttemptsCount });
  }
  if (decision.action === "insufficient-evidence") {
    // The label-search index can lag a beat behind a just-created issue —
    // exactly how #2043 got created as a duplicate of #1507. Retry once
    // before concluding the label really has nothing open.
    sleepSync(5000);
    labelRows = fetchWorkStatusByLabel();
    labelAttemptsCount = 2;
    decision = decideWorkStatusIssue({ persisted, labelRows, labelAttemptsCount });
  }
  if (decision.action === "insufficient-evidence") {
    titleRows = fetchWorkStatusByTitle();
    decision = decideWorkStatusIssue({ persisted, labelRows, labelAttemptsCount, titleRows });
  }

  if (decision.action === "use") {
    if (decision.closeDuplicates.length) {
      console.error(
        `work reconcile: warn — closing ${decision.closeDuplicates.length} duplicate ${WORK_STATUS_LABEL} issue(s) [${decision.closeDuplicates.join(", ")}], keeping #${decision.number}.`,
      );
      if (!dryRun) closeDuplicateWorkStatusIssues(decision.closeDuplicates);
    }
    const known =
      (persisted && persisted.number === decision.number ? persisted : null) ??
      [...labelRows, ...(titleRows ?? [])].find((r) => r.number === decision.number) ??
      fetchIssueByNumber(decision.number);
    if (!dryRun) state.workStatusIssueNumber = decision.number;
    return {
      number: known.number,
      title: known.title ?? WORK_STATUS_TITLE,
      body: known.body ?? "",
    };
  }

  // decision.action === "create"
  if (dryRun) return { number: null, title: WORK_STATUS_TITLE, body: "" };
  const url = gh([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    WORK_STATUS_TITLE,
    "--label",
    WORK_STATUS_LABEL,
    "--body",
    "Updated (pending first run) by the reconciler\n",
  ]);
  const number = Number(url.trim().split("/").pop());
  state.workStatusIssueNumber = number;
  return { number, title: WORK_STATUS_TITLE, body: "" };
}

function updateWorkStatusIssueBody(number, body, dryRun) {
  if (dryRun) return;
  const tmpFile = join(WORK_DIR, ".work-status-body.md");
  mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(tmpFile, body, "utf8");
  gh(["issue", "edit", String(number), "--repo", REPO, "--body-file", tmpFile]);
}

/** Re-reads an issue's live state right before a close/unassign mutation —
 * fix 2b's idempotency check, guarding against an overlapping reconcile
 * having already acted on the same issue. `allowFail` -> null on any gh
 * error, which shouldSkipClose/shouldSkipUnassign both treat as "not
 * confirmed done, go ahead". */
function fetchLiveIssueState(number) {
  return ghJson(["issue", "view", String(number), "--repo", REPO, "--json", "state,assignees"], {
    allowFail: true,
  });
}

function closeIssueWithComment(number, prNumber, dryRun) {
  const comment = `Closed by #${prNumber} (merged).`;
  if (dryRun) return { comment, acted: true };
  if (shouldSkipClose(fetchLiveIssueState(number))) {
    return { comment, acted: false, reason: "already closed" };
  }
  return {
    comment,
    ...attemptGhAction(() =>
      gh(["issue", "close", String(number), "--repo", REPO, "--comment", comment]),
    ),
  };
}

function unassignWithComment(number, logins, dryRun) {
  const comment = "Returned to Ready: no activity for 72 h. Branch kept.";
  if (dryRun) return { comment, acted: true };
  if (shouldSkipUnassign(fetchLiveIssueState(number))) {
    return { comment, acted: false, reason: "already unassigned" };
  }
  return {
    comment,
    ...attemptGhAction(() => {
      if (logins.length)
        gh([
          "issue",
          "edit",
          String(number),
          "--repo",
          REPO,
          "--remove-assignee",
          logins.join(","),
        ]);
      gh(["issue", "comment", String(number), "--repo", REPO, "--body", comment]);
    }),
  };
}

const STATUS_UPDATE_MUTATION = `
mutation($projectId: ID!, $status: ProjectV2StatusUpdateStatus!, $body: String!) {
  createProjectV2StatusUpdate(input: { projectId: $projectId, status: $status, body: $body }) {
    statusUpdate { id }
  }
}`;

function postProjectStatusUpdate(projectId, status, body, dryRun) {
  if (dryRun) return;
  graphql(STATUS_UPDATE_MUTATION, { projectId, status, body: JSON.stringify(body) });
}

// ════════════════════════════════════════════════════════════════════════
// main
// ════════════════════════════════════════════════════════════════════════

async function main() {
  // B973: a relocated work dir is always announced (stderr, before any verdict), so a stray export is visible.
  if (WORK_DIR !== DEFAULT_WORK_DIR) {
    console.error(`work reconcile: RECONCILE_WORK_DIR in effect: ${WORK_DIR}`);
  }
  const args = parseArgs(process.argv.slice(2));
  // #2284: decided before the lock, the log or any gh call, so a bad argument writes nothing.
  if (!args.ok) {
    console.error(`work reconcile: ${args.error}\n${RECONCILE_USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(RECONCILE_USAGE);
    process.exitCode = 0;
    return;
  }
  // B973 (lead Opus): a relocated work dir must never WRITE to the board. The real scheduler's callers (run.mjs swallows
  // stderr, trigger.mjs is stdio:ignore) would otherwise silently use a lock that no other reconcile can see: a double apply.
  if (args.apply && WORK_DIR !== DEFAULT_WORK_DIR) {
    console.error(
      "work reconcile: refusing --apply while RECONCILE_WORK_DIR is set (it relocates the lock, so a second reconcile could run alongside). Unset it to apply.",
    );
    process.exitCode = 2;
    return;
  }
  const now = new Date();
  const started = Date.now();
  let exitCode = 0;

  // fix 2a: reconcile's own overlap lock — a trigger.mjs-spawned reconcile
  // and a run.mjs-spawned reconcile never take run.mjs's run.lock (trigger
  // deliberately doesn't), so without this, the two can run concurrently
  // and double-post comments. Held & fresh -> skip this run entirely,
  // without writing anything.
  const existingLock = loadReconcileLock();
  if (existingLock && !isReconcileLockStale(existingLock, now)) {
    console.log(
      `work reconcile: lock held (pid ${existingLock.pid}, started ${existingLock.startedAt}) — skipping this run.`,
    );
    process.exitCode = 0;
    return;
  }
  writeReconcileLock({ pid: process.pid, startedAt: now.toISOString() });

  const summary = {
    addedIssues: 0,
    addedPRs: 0,
    fieldWrites: 0,
    cleared: 0,
    skipped: 0,
    closed: 0,
    unassigned: 0,
    flagged: 0,
    excludedRemoved: 0,
  };

  try {
    const { projectId, fieldsByName } = resolveProjectFields();
    const { items: boardItems, rateRemaining: r1 } = fetchProjectItems();
    const { nodes: openIssueNodes, rateRemaining: r2 } = fetchOpenRepoNodes("issue");
    const { nodes: openPRNodes, rateRemaining: r3 } = fetchOpenRepoNodes("pr");
    let rateRemaining = Math.min(...[r1, r2, r3].filter((n) => typeof n === "number"));

    const boardIssueNums = new Set(
      boardItems.filter((i) => i.type === "Issue").map((i) => i.content.number),
    );
    const boardPRNums = new Set(
      boardItems.filter((i) => i.type === "PullRequest").map((i) => i.content.number),
    );

    const missingIssues = openIssueNodes.filter(
      (n) =>
        n.number !== FLEET_LOG_ISSUE &&
        !labelNames(n.labels).includes(WORK_STATUS_LABEL) &&
        !boardIssueNums.has(n.number),
    );
    const missingPRs = openPRNodes.filter((n) => !boardPRNums.has(n.number));

    let addedIdByContentId = new Map();
    if (
      !args.dryRun &&
      (missingIssues.length || missingPRs.length) &&
      !shouldHaltWrites(rateRemaining)
    ) {
      addedIdByContentId = addItemsToProject(
        projectId,
        [...missingIssues, ...missingPRs].map((n) => n.id),
      );
    }
    summary.addedIssues = missingIssues.length;
    summary.addedPRs = missingPRs.length;

    // Unified board content: existing items + newly (would-be) added ones.
    let issueRows = boardItems.filter((i) => i.type === "Issue");
    const prRows = boardItems.filter((i) => i.type === "PullRequest");
    for (const n of missingIssues) {
      issueRows.push({
        itemId: addedIdByContentId.get(n.id) ?? null,
        type: "Issue",
        content: n,
        current: {},
      });
    }
    for (const n of missingPRs) {
      prRows.push({
        itemId: addedIdByContentId.get(n.id) ?? null,
        type: "PullRequest",
        content: n,
        current: {},
      });
    }

    // fix 1: #938 / work-status issues are excluded from ALL processing
    // below, not merely from auto-add above — filter them out of
    // issueRows right here so no downstream derivation, auto-close,
    // stale-unassign, or digest count ever sees them. If either was
    // already a board item, remove it from the project outright.
    const excludedRows = issueRows.filter((r) => isExcludedFromBoard(r.content));
    issueRows = issueRows.filter((r) => !isExcludedFromBoard(r.content));
    const excludedItemIdsToRemove = excludedRows.map((r) => r.itemId).filter((id) => id != null);
    if (!args.dryRun && excludedItemIdsToRemove.length && !shouldHaltWrites(rateRemaining)) {
      removeItemsFromProject(projectId, excludedItemIdsToRemove);
    }
    summary.excludedRemoved = excludedItemIdsToRemove.length;

    const allPRContents = prRows.map((r) => r.content);
    const issuePRIndex = buildIssuePRIndex(allPRContents);

    // Section 6: stale claims — mutate a local copy of assignees so the rest
    // of the pipeline (status derivation, field writes) sees the effect of an
    // unassign in the SAME run, through the one normal write path.
    const staleClaims = [];
    for (const row of issueRows) {
      const issue = row.content;
      const linkedPRs = issuePRIndex.get(issue.number) ?? [];
      const action = staleClaimAction(issue, linkedPRs, now);
      if (!action) continue;
      if (action.action === "unassign") {
        const logins = (issue.assignees ?? []).map((a) => a.login);
        const result = unassignWithComment(issue.number, logins, args.dryRun);
        // Either we just unassigned it, or the live re-read already found it
        // unassigned — both leave zero assignees. A gh failure leaves the
        // live (still-assigned) state alone so the rest of THIS run's
        // derivation stays accurate.
        if (result.acted || result.reason === "already unassigned") issue.assignees = [];
        if (result.acted) summary.unassigned++;
        else
          console.log(
            `work reconcile: issue #${issue.number} — unassign skipped (${result.reason})`,
          );
        staleClaims.push({
          number: issue.number,
          worker: deriveWorkerForIssue(issue, linkedPRs),
          hours: action.hours,
          reason: action.reason,
          comment: result.comment,
          ...(result.acted ? {} : { skipped: result.reason }),
        });
      } else {
        summary.flagged++;
        staleClaims.push({
          number: issue.number,
          worker: deriveWorkerForIssue(issue, linkedPRs),
          hours: action.hours,
          reason: action.reason,
        });
      }
    }

    // Section 5: auto-close.
    const closedNotices = [];
    for (const row of issueRows) {
      const issue = row.content;
      const linkedPRs = issuePRIndex.get(issue.number) ?? [];
      const prToCite = shouldAutoCloseIssue(issue, linkedPRs);
      if (!prToCite) continue;
      const result = closeIssueWithComment(issue.number, prToCite.number, args.dryRun);
      if (result.acted || result.reason === "already closed") issue.state = "CLOSED";
      if (result.acted) summary.closed++;
      else console.log(`work reconcile: issue #${issue.number} — close skipped (${result.reason})`);
      closedNotices.push({
        number: issue.number,
        pr: prToCite.number,
        comment: result.comment,
        ...(result.acted ? {} : { skipped: result.reason }),
      });
    }

    // Derive desired fields + plan writes for every board item.
    const writes = [];
    const skippedWrites = [];
    const issueDerivedRows = [];
    for (const row of issueRows) {
      const issue = row.content;
      const linkedPRs = issuePRIndex.get(issue.number) ?? [];
      const desired = deriveIssueFields(issue, linkedPRs);
      issueDerivedRows.push({
        number: issue.number,
        title: issue.title,
        ...desired,
        closedAt: issue.closedAt,
      });
      if (!row.itemId) continue;
      const { writes: w, skipped } = planWrites({
        projectId,
        itemId: row.itemId,
        current: row.current,
        desired,
        fieldsByName,
      });
      writes.push(...w);
      skippedWrites.push(...skipped.map((s) => ({ number: issue.number, ...s })));
    }
    const prDerivedRows = [];
    for (const row of prRows) {
      const pr = row.content;
      const linkedIssueNums = resolveLinkedIssueNumbers(pr);
      const linkedIssue = issueRows.find((r) =>
        linkedIssueNums.includes(r.content.number),
      )?.content;
      const desired = derivePRFields(pr, linkedIssue);
      prDerivedRows.push({
        number: pr.number,
        title: pr.title,
        ...desired,
        mergedAt: pr.mergedAt,
        linkedIssueNums,
      });
      if (!row.itemId) continue;
      const { writes: w, skipped } = planWrites({
        projectId,
        itemId: row.itemId,
        current: row.current,
        desired,
        fieldsByName,
      });
      writes.push(...w);
      skippedWrites.push(...skipped.map((s) => ({ number: pr.number, ...s })));
    }
    summary.skipped = skippedWrites.length;

    if (!args.dryRun && writes.length && !shouldHaltWrites(rateRemaining)) {
      applyFieldWrites(writes);
    }
    summary.fieldWrites = writes.filter((w) => !w.clear).length;
    summary.cleared = writes.filter((w) => w.clear).length;

    // Drift digest inputs.
    const laneConflicts = findLaneConflicts(
      issueDerivedRows.map((r) => ({ number: r.number, lane: r.Lane, status: r.Status })),
    );
    const orphanPRs = prRows
      .filter(
        (r) =>
          r.content.state === "OPEN" &&
          !(r.content.createdAt && r.content.createdAt < BOARD_EPOCH) &&
          resolveLinkedIssueNumbers(r.content).length === 0,
      )
      .map((r) => r.content.number)
      .sort((a, b) => a - b);
    const reviewStalePRs = [];
    for (const row of prRows) {
      const pr = row.content;
      if (derivePRStatus(pr) !== "In review") continue;
      const commitDate = lastActivityInstantForPR(pr);
      const hoursSinceCommit = commitDate
        ? (now.getTime() - new Date(commitDate).getTime()) / 3_600_000
        : Infinity;
      const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
      const reasons = [];
      if (hoursSinceCommit > REVIEW_STALE_H)
        reasons.push(`no commit in ${fmtHours(hoursSinceCommit)}`);
      if (rollup === "FAILURE") reasons.push("failing checks");
      if (pr.mergeable === "CONFLICTING") reasons.push("conflicting");
      if (reasons.length) reviewStalePRs.push({ number: pr.number, reason: reasons.join(", ") });
    }
    const inboxStale = issueRows
      .filter((r) => {
        if (r.content.state !== "OPEN") return false;
        if (deriveIssueStatus(r.content, issuePRIndex.get(r.content.number) ?? []) !== "Inbox")
          return false;
        const created = r.content.createdAt;
        return created && (now.getTime() - new Date(created).getTime()) / 3_600_000 > INBOX_STALE_H;
      })
      .map((r) => r.content.number)
      .sort((a, b) => a - b);

    const milestoneMap = new Map();
    for (const row of issueRows) {
      const m = row.content.milestone;
      if (!m) continue;
      if (!milestoneMap.has(m.title)) milestoneMap.set(m.title, { dueOn: m.dueOn, items: [] });
      milestoneMap.get(m.title).items.push({ state: row.content.state });
    }
    const releases = [...milestoneMap.entries()]
      .map(([title, { dueOn, items }]) => milestoneStats(title, dueOn, items, now))
      .sort((a, b) => (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999"));

    const openP0Count = issueDerivedRows.filter(
      (r) =>
        r.Priority === "P0" &&
        !issueRows.find((ir) => ir.content.number === r.number)?.content.closedAt,
    ).length;

    const inFlight = [
      ...issueDerivedRows
        .filter((r) => r.Status === "In progress" || r.Status === "In review")
        .map((r) => ({ number: r.number, status: r.Status, worker: r.Worker, title: r.title })),
      ...prDerivedRows
        .filter((r) => r.Status === "In progress" || r.Status === "In review")
        .map((r) => ({ number: r.number, status: r.Status, worker: r.Worker, title: r.title })),
    ].sort((a, b) => a.number - b.number);

    const inboxCount = issueDerivedRows.filter((r) => r.Status === "Inbox").length;

    const recentlyDone = [
      ...issueDerivedRows
        .filter(
          (r) => r.closedAt && (now.getTime() - new Date(r.closedAt).getTime()) / 3_600_000 <= 24,
        )
        .map((r) => ({ number: r.number, title: r.title })),
      ...prDerivedRows
        .filter(
          (r) => r.mergedAt && (now.getTime() - new Date(r.mergedAt).getTime()) / 3_600_000 <= 24,
        )
        .map((r) => ({ number: r.number, title: r.title })),
    ].sort((a, b) => a.number - b.number);

    const digestData = {
      generatedAtLabel: nowUtcLabel(now),
      releases,
      staleClaims,
      laneConflicts,
      orphanPRs,
      reviewStalePRs,
      inboxStale,
      inFlight,
      inboxCount,
      recentlyDone,
    };
    const digestBody = renderDigestBody(digestData);

    let state = loadState();
    const workStatusIssue = ensureWorkStatusIssue(args.dryRun, state);
    const bodyChanged = digestBodyChanged(workStatusIssue.body, digestBody);
    const hoursSinceDigest = state.lastDigestUpdatedAt
      ? (now.getTime() - new Date(state.lastDigestUpdatedAt).getTime()) / 3_600_000
      : Infinity;
    const shouldPublishDigest = bodyChanged || hoursSinceDigest >= DIGEST_MAX_STALE_HOURS;
    if (shouldPublishDigest && !shouldHaltWrites(rateRemaining)) {
      updateWorkStatusIssueBody(workStatusIssue.number, digestBody, args.dryRun);
      state.lastDigestUpdatedAt = now.toISOString();
    }

    const overallStatus = overallProjectStatus(releases, openP0Count);
    const lastPostedDay = state.lastStatusPostedAt ? state.lastStatusPostedAt.slice(0, 10) : null;
    const today = now.toISOString().slice(0, 10);
    const statusChanged = state.lastStatusValue !== overallStatus;
    const shouldPostStatus = statusChanged || lastPostedDay !== today;
    // fix 5: postStatusUpdateIfDue saves the state file IMMEDIATELY after a
    // successful post (before anything else below runs), so a later
    // failure in this run can never cause the same status to be re-posted
    // next time.
    const statusResult = postStatusUpdateIfDue({
      shouldPostStatus,
      halted: shouldHaltWrites(rateRemaining),
      dryRun: args.dryRun,
      now,
      state,
      overallStatus,
      statusBody: renderStatusUpdateBody(overallStatus, {
        ...digestData,
        digestIssueUrl: `https://github.com/${REPO}/issues/${workStatusIssue.number ?? "?"}`,
      }),
      post: (body) => postProjectStatusUpdate(projectId, overallStatus, body, args.dryRun),
      save: saveState,
    });
    state = statusResult.state;
    if (!args.dryRun) saveState(state);

    const output = {
      dryRun: args.dryRun,
      rateRemaining,
      halted: shouldHaltWrites(rateRemaining),
      summary,
      overallStatus,
      digestIssue: workStatusIssue.number,
      digestPublished: shouldPublishDigest,
      statusPosted: shouldPostStatus,
      skippedWrites,
      closedNotices,
      staleClaims,
      laneConflicts,
      orphanPRs,
      reviewStalePRs,
      inboxStale,
      inboxCount,
      releases,
    };

    if (args.json) {
      console.log(JSON.stringify(output, null, 2));
    } else if (!args.quiet) {
      console.log(`Work board reconcile ${args.dryRun ? "(dry-run) " : ""}— ${nowUtcLabel(now)}`);
      console.log(
        `  board: +${summary.addedIssues} issues, +${summary.addedPRs} PRs added; ${summary.fieldWrites} field value(s) set, ${summary.cleared} cleared, ${summary.skipped} skipped`,
      );
      console.log(
        `  claims: ${summary.flagged} flagged, ${summary.unassigned} unassigned (72h, no open PR)`,
      );
      console.log(`  closed by merge: ${summary.closed}`);
      if (summary.excludedRemoved) {
        console.log(
          `  excluded from board (#938 / work-status) removed: ${summary.excludedRemoved}`,
        );
      }
      console.log(
        `  drift: ${laneConflicts.length} lane conflict(s), ${orphanPRs.length} orphan PR(s), ${reviewStalePRs.length} stuck-in-review, ${inboxStale.length} stale-inbox`,
      );
      console.log(`  overall status: ${overallStatus}`);
      console.log(
        `  digest issue: #${workStatusIssue.number ?? "(would create)"} — ${shouldPublishDigest ? "published" : "unchanged, skipped"}`,
      );
      console.log(
        `  status update: ${shouldPostStatus ? "posted" : "skipped (already posted today, unchanged)"}`,
      );
      if (args.dryRun) {
        console.log("");
        console.log(digestBody);
      }
    }

    appendLog({
      ts: now.toISOString(),
      dryRun: args.dryRun,
      exitCode,
      summary,
      overallStatus,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    exitCode = 1;
    console.error(`work reconcile: FAILED — ${err?.message ?? err}`);
    appendLog({
      ts: now.toISOString(),
      dryRun: args.dryRun,
      exitCode,
      error: String(err?.message ?? err),
      durationMs: Date.now() - started,
    });
  } finally {
    releaseReconcileLockIfOwned(process.pid);
  }
  process.exitCode = exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
