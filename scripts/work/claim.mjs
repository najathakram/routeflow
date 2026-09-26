#!/usr/bin/env node
// claim.mjs — claim (or release) one work-board issue.
//
// Enforces docs/work/WORKFLOW.md's claiming rules the reconciler itself can't:
// no claiming a closed/untriaged/already-assigned issue, and the lane lock
// (one assigned open issue per `lane:*` at a time). On success it assigns
// @me, comments `Claimed by <worker>`, and prints the branch name + draft-PR
// command to run next — it never creates the branch or PR itself.
//
// Usage:
//   node scripts/work/claim.mjs <issue#> --worker "<person> · <machine> · <session title>"
//   node scripts/work/claim.mjs <issue#> --release --note "<where it stands>"
import { execFileSync, spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildIssuePRIndex } from "./reconcile.mjs";

const REPO_OWNER = "najathakram";
const REPO_NAME = "routeflow";
const REPO = `${REPO_OWNER}/${REPO_NAME}`;
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const TRIGGER_PATH = join(ROOT, "scripts", "work", "trigger.mjs");

// ════════════════════════════════════════════════════════════════════════
// PURE
// ════════════════════════════════════════════════════════════════════════

export function labelNames(labels = []) {
  return (labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);
}

export function laneOf(labels = []) {
  const name = labelNames(labels).find((l) => l.startsWith("lane:"));
  return name ? name.slice("lane:".length) : null;
}

export function kindOf(labels = []) {
  const name = labelNames(labels).find((l) => l.startsWith("kind:"));
  return name ? name.slice("kind:".length) : "chore";
}

export function slugify(title) {
  return (
    String(title ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "task"
  );
}

export function branchName(kind, number, title) {
  return `${kind || "chore"}/${number}-${slugify(title)}`;
}

/**
 * Whether an assigned open issue currently holds its `lane:*` lock. An issue
 * holds its lane only while its work is In progress: closed -> never; no
 * assignee -> never; assigned with a linked OPEN, non-draft ("ready for
 * review") PR -> no longer (that's In review, per docs/work/WORKFLOW.md rule
 * 4 and reconcile.mjs's deriveIssueStatus); assigned with only a draft PR, or
 * no linked PR yet, -> yes. `linkedPRs` is every PR linked to this issue by
 * any of reconcile.mjs's three methods (see resolveLinkedIssueNumbers /
 * buildIssuePRIndex), each { state, isDraft }.
 */
export function issueHoldsLane(issue, linkedPRs = []) {
  if (issue.state === "CLOSED") return false;
  if (!(issue.assignees ?? []).length) return false;
  const hasOpenReadyPR = linkedPRs.some((pr) => pr.state === "OPEN" && !pr.isDraft);
  return !hasOpenReadyPR;
}

/**
 * issue: { number, state, labels, assignees }. laneHolders: every OTHER open
 * issue that carries the same lane label, each { number, holdsLane } (see
 * issueHoldsLane). Returns { ok: true } or { ok: false, reason }.
 */
export function canClaim(issue, laneHolders = []) {
  if (issue.state === "CLOSED") return { ok: false, reason: `#${issue.number} is closed` };
  if (labelNames(issue.labels).includes("needs-triage")) {
    return { ok: false, reason: `#${issue.number} still needs triage` };
  }
  if ((issue.assignees ?? []).length) {
    return { ok: false, reason: `#${issue.number} is already assigned` };
  }
  const holder = laneHolders.find((h) => h.number !== issue.number && h.holdsLane);
  if (holder) return { ok: false, reason: `lane held by #${holder.number}` };
  return { ok: true };
}

export function draftPrCommand(number, worker) {
  return `gh pr create --draft --repo ${REPO} --body "Closes #${number}\\n\\nWorker: ${worker}"`;
}

// ════════════════════════════════════════════════════════════════════════
// ── IO ─────────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════

function gh(args) {
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    const msg = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || String(e.message ?? e);
    console.error(`work claim: gh ${args.slice(0, 3).join(" ")} failed: ${msg}`);
    process.exitCode = 1;
    throw e;
  }
}

function ghJson(args) {
  return JSON.parse(gh(args));
}

/** Fires scripts/work/trigger.mjs (its own debounced, detached spawn of
 * reconcile.mjs) so the board reflects a claim/release right away instead
 * of waiting for the next 5-minute poll. Best-effort — never lets a
 * refresh-scheduling problem fail the claim/release that already
 * succeeded. */
function fireTrigger() {
  try {
    const child = spawn(process.execPath, [TRIGGER_PATH], {
      cwd: ROOT,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // best-effort only.
  }
}

function fetchIssue(number) {
  return ghJson([
    "issue",
    "view",
    String(number),
    "--repo",
    REPO,
    "--json",
    "number,title,state,labels,assignees",
  ]);
}

/** Open PRs repo-wide, with just the fields resolveLinkedIssueNumbers/
 * buildIssuePRIndex (from reconcile.mjs) need to link them to issues. */
function fetchOpenPRs() {
  return ghJson([
    "pr",
    "list",
    "--repo",
    REPO,
    "--state",
    "open",
    "--json",
    "number,state,isDraft,body,headRefName,closingIssuesReferences",
    "--limit",
    "100",
  ]);
}

function fetchLaneHolders(lane, excludeNumber) {
  if (!lane) return [];
  const rows = ghJson([
    "issue",
    "list",
    "--repo",
    REPO,
    "--label",
    `lane:${lane}`,
    "--state",
    "open",
    "--json",
    "number,state,assignees",
    "--limit",
    "100",
  ]).filter((r) => r.number !== excludeNumber);
  if (!rows.length) return rows;
  const prIndex = buildIssuePRIndex(fetchOpenPRs());
  return rows.map((r) => ({
    ...r,
    holdsLane: issueHoldsLane(r, prIndex.get(r.number) ?? []),
  }));
}

function parseArgs(argv) {
  const out = { number: null, worker: null, release: false, note: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--worker") out.worker = argv[++i];
    else if (a === "--release") out.release = true;
    else if (a === "--note") out.note = argv[++i];
    else rest.push(a);
  }
  out.number = rest[0] ? Number(rest[0]) : null;
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.number) {
    console.error(
      'usage: node scripts/work/claim.mjs <issue#> --worker "<worker>" [--release [--note "..."]]',
    );
    process.exitCode = 1;
    return;
  }

  if (args.release) {
    const note = args.note ?? "released";
    gh(["issue", "edit", String(args.number), "--repo", REPO, "--remove-assignee", "@me"]);
    gh(["issue", "comment", String(args.number), "--repo", REPO, "--body", `Released: ${note}`]);
    fireTrigger();
    console.log(`Released #${args.number}: ${note}`);
    return;
  }

  if (!args.worker) {
    console.error('claim requires --worker "<person> · <machine> · <session title>"');
    process.exitCode = 1;
    return;
  }

  const issue = fetchIssue(args.number);
  const lane = laneOf(issue.labels);
  const laneHolders = fetchLaneHolders(lane, issue.number);
  const verdict = canClaim(issue, laneHolders);
  if (!verdict.ok) {
    console.error(`work claim: refused — ${verdict.reason}`);
    process.exitCode = 1;
    return;
  }

  gh(["issue", "edit", String(args.number), "--repo", REPO, "--add-assignee", "@me"]);
  gh([
    "issue",
    "comment",
    String(args.number),
    "--repo",
    REPO,
    "--body",
    `Claimed by ${args.worker}`,
  ]);

  fireTrigger();

  const kind = kindOf(issue.labels);
  const branch = branchName(kind, issue.number, issue.title);
  console.log(`Claimed #${issue.number} — ${issue.title}`);
  console.log(`Branch:  git checkout -b ${branch} origin/master`);
  console.log(`Draft PR: ${draftPrCommand(issue.number, args.worker)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
