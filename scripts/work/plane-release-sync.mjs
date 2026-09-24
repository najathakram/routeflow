#!/usr/bin/env node
// plane-release-sync.mjs — updates RouteFlow's Plane ROAD project from the
// GitHub work board (milestones R1/R1.1/R2/R3 + `kind:feature` issues) a few
// times a day, ONLY when a release actually changed. Every Plane WRITE goes
// through the house scripts/campaign/plane-apply.mjs (`runApply`) — this
// file never calls a Plane POST/PATCH/DELETE itself, only GETs via the
// shared scripts/campaign/plane-client.mjs. Design notes are inline below —
// there is no separate spec doc for this tool.
//
// GITHUB SIDE: repo najathakram/routeflow. Releases are milestones titled
// "R1", "R1.1 — follow-ups", "R2 — Lite", "R3 — CRM + K-hub". Roadmap
// features are issues labelled `kind:feature` with a milestone, titled
// "F-01 · ...".
//
// PLANE SIDE: the ROAD project already holds Release 1's tracking item
// (ROAD-96 "Release 1 — compressed ...") and its children (ROAD-97..103).
// Nothing in Plane carries external_source/external_id back to GitHub yet
// (verified live 2026-09-24 — every ROAD-9x item has both null), and
// plane-apply's `update` op has no field to stamp them (only
// state/priority/target_date/name/description_html/labels/parent/assignee).
// So this tool resolves the GitHub<->Plane bridge two ways, in order:
//   1. RELEASES, automatically: a milestone titled exactly "R<N>" (no
//      suffix) is matched against ROAD's own TOP-LEVEL items (parent=null)
//      whose name starts with "Release <N>" — the one naming convention
//      already proven live (ROAD-96 for "R1"). A milestone with a suffix
//      ("R1.1 — follow-ups", "R2 — Lite", "R3 — CRM + K-hub") is NOT
//      auto-matched — there is no "Release 1.1"/"Release 2"/"Release 3" item
//      in ROAD yet, and guessing one from the major version number alone
//      would let two distinct milestones fight over one Plane item's
//      description/comments. `releaseOverrides` in plane-release-map.json
//      lets a human pin one explicitly once such an item exists.
//   2. FEATURES, by a human-curated map keyed by GitHub issue NUMBER, in
//      plane-release-map.json (checked into git, small, editable) — every
//      current ROAD-9x child's description was read and compared against
//      its matching GitHub issue's title/body by hand (2026-09-24) to seed
//      the 7 high-confidence entries that exist today. A feature with no
//      entry is reported as unmapped, never guessed, never used to create a
//      new Plane item (this tool never creates work items).
//
// CHANGE DETECTION: per release, compare the freshly computed snapshot
// against `local-assets/work/plane-release-state.json` — the state as of
// the LAST SUCCESSFUL REAL (`--apply`, non-dry-run) sync. A release counts
// as CHANGED when: its milestone state flipped, its %-done moved by >= 10
// points, its at-risk flag flipped, or any one feature closed/reopened.
// `--dry-run` (the default) NEVER writes this snapshot — only a completed
// `--apply` run advances the baseline for a release actually included in
// that run's plan — see runReleaseSync()'s "SNAPSHOT PERSISTENCE" comment
// for why (repeated dry-run previews must never suppress the eventual real
// sync, and a release that couldn't be synced — no Plane item, or
// throttled — must keep showing as "changed" until it can be).
//
// THROTTLE: at most 3 REAL syncs per UTC day (counted from
// local-assets/work/plane-release.log), gated on "something changed";
// bypassed entirely by a "major release" event (a milestone that just
// CLOSED) or by `--force`/`--force-all`. Nothing changed -> exit 0 quietly
// (one log line still gets written every run, per-run, regardless of
// decision — "quiet" means stdout, not the log).
//
// NEVER: creates a Plane work item, deletes anything, touches
// BUGS/OPS/DECIDE/CLIENT, or writes Plane any way other than through
// plane-apply's `runApply()`.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createClient, gitEnv, repoRoot } from "../campaign/plane-client.mjs";
import { runApply } from "../campaign/plane-apply.mjs";

export const GITHUB_REPO = "najathakram/routeflow";
export const ROAD_PROJECT_IDENTIFIER = "ROAD";
export const DAILY_REAL_SYNC_CAP = 3;
export const PERCENT_CHANGE_THRESHOLD = 10;
export const AT_RISK_DUE_SOON_DAYS = 3;
export const AT_RISK_OPEN_PERCENT_THRESHOLD = 25;

// Titles this tool accepts as a "feature" issue, per the task's own
// convention ("their titles start `F-01 · ...`"). Guards against picking up
// the repo's OLDER, unrelated F01/F31-style issues (no hyphen, no
// milestone) that also carry `kind:feature` historically.
export const FEATURE_TITLE_RE = /^F-\d+\s*·/;
const FEATURE_KEY_RE = /^\s*(F-\d+)\s*·/;

// The one HTML marker this tool ever writes into a release item's
// description — upsertReleaseLine() finds and replaces ONLY a `<p>` element
// carrying this exact attribute, so re-syncing never duplicates the line and
// never touches anything a human wrote around it.
const MARKER_ATTR = 'data-plane-release-sync="1"';
const MARKER_RE = /<p[^>]*data-plane-release-sync="1"[^>]*>[\s\S]*?<\/p>/i;

// ── pure helpers (self-tested directly — no network, no fs) ────────────────

export function extractFeatureKey(title) {
  const m = FEATURE_KEY_RE.exec(String(title ?? ""));
  return m ? m[1] : null;
}

export function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}

export function formatDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// Past due with open items, OR due within AT_RISK_DUE_SOON_DAYS with more
// than AT_RISK_OPEN_PERCENT_THRESHOLD% still open. A milestone that is
// already closed, or carries no due date, is never at-risk.
export function computeAtRisk({ state, dueOn, open, total, now = new Date() }) {
  if (state !== "open" || !dueOn) return false;
  const due = new Date(dueOn).getTime();
  if (Number.isNaN(due)) return false;
  const daysUntilDue = (due - now.getTime()) / 86_400_000;
  if (daysUntilDue < 0) return open > 0;
  if (daysUntilDue <= AT_RISK_DUE_SOON_DAYS) {
    const openPercent = total === 0 ? 0 : (open / total) * 100;
    return openPercent > AT_RISK_OPEN_PERCENT_THRESHOLD;
  }
  return false;
}

// milestone: {number,title,state,due_on,html_url}. features: this
// milestone's own kind:feature issues, already filtered/normalized by
// defaultFetchFeatureIssues() (or a test fixture in the same shape).
export function computeReleaseSnapshot({ milestone, features, now = new Date() }) {
  const total = features.length;
  const closed = features.filter((f) => f.state === "CLOSED").length;
  const open = total - closed;
  const percentDone = total === 0 ? 0 : Math.round((closed / total) * 100);
  const state = milestone.state;
  const dueOn = milestone.due_on ?? null;
  const atRisk = computeAtRisk({ state, dueOn, open, total, now });
  const featureMap = {};
  for (const f of features) {
    const key = extractFeatureKey(f.title) ?? `#${f.number}`;
    featureMap[key] = {
      number: f.number,
      title: f.title,
      state: f.state,
      closedAt: f.closedAt ?? null,
    };
  }
  return {
    number: milestone.number,
    title: milestone.title,
    htmlUrl: milestone.html_url ?? null,
    state,
    dueOn,
    total,
    closed,
    open,
    percentDone,
    atRisk,
    features: featureMap,
  };
}

// The comparison baseline for a release this tool has never synced before —
// deliberately NOT "assume nothing to compare" (which would silently skip
// real, already-existing problems like a past-due milestone on the very
// first run). Starting every unseen release at {open, 0%, not-at-risk, no
// features} means a release that is ALREADY late or already partly done the
// first time this tool looks at it gets surfaced immediately, while a
// healthy on-schedule release stays quiet — see diffRelease()'s doc comment.
export const DEFAULT_PREVIOUS_RELEASE = {
  state: "open",
  percentDone: 0,
  atRisk: false,
  features: {},
};

// changed = state flipped, OR %-done moved by >= PERCENT_CHANGE_THRESHOLD
// points, OR at-risk flipped, OR any feature closed/reopened.
// majorRelease = the milestone just transitioned open -> closed this run —
// always bypasses the daily throttle (see decideThrottle()).
export function diffRelease(current, previous = DEFAULT_PREVIOUS_RELEASE) {
  const prev = previous ?? DEFAULT_PREVIOUS_RELEASE;
  const reasons = [];
  if (current.state !== prev.state) reasons.push(`state ${prev.state} -> ${current.state}`);
  const percentDelta = Math.abs((current.percentDone ?? 0) - (prev.percentDone ?? 0));
  if (percentDelta >= PERCENT_CHANGE_THRESHOLD) {
    reasons.push(
      `percentDone ${prev.percentDone ?? 0} -> ${current.percentDone} (${percentDelta}pt)`,
    );
  }
  if (Boolean(current.atRisk) !== Boolean(prev.atRisk)) {
    reasons.push(`atRisk ${Boolean(prev.atRisk)} -> ${Boolean(current.atRisk)}`);
  }
  const prevFeatures = prev.features ?? {};
  const closedOrReopened = [];
  for (const [key, feat] of Object.entries(current.features ?? {})) {
    const prevState = prevFeatures[key]?.state ?? "OPEN";
    if (prevState !== feat.state)
      closedOrReopened.push({ key, number: feat.number, from: prevState, to: feat.state });
  }
  if (closedOrReopened.length) {
    reasons.push(
      `features: ${closedOrReopened.map((c) => `${c.key} ${c.from}->${c.to}`).join(", ")}`,
    );
  }
  const majorRelease = prev.state !== "closed" && current.state === "closed";
  return { changed: reasons.length > 0, majorRelease, reasons, closedOrReopened };
}

// The whole-run throttle decision. `changed` = at least one release's
// diffRelease().changed; `majorRelease` = at least one release's
// diffRelease().majorRelease; `realSyncsToday` = count of REAL (non-dry-run)
// syncs already logged today (see countRealSyncsToday()).
export function decideThrottle({
  changed,
  majorRelease,
  force = false,
  forceAll = false,
  realSyncsToday = 0,
  dailyCap = DAILY_REAL_SYNC_CAP,
}) {
  if (!changed && !forceAll) return { proceed: false, reason: "no-change" };
  if (forceAll) return { proceed: true, reason: "force-all" };
  if (majorRelease) return { proceed: true, reason: "major-release" };
  if (force) return { proceed: true, reason: "force" };
  if (realSyncsToday >= dailyCap) return { proceed: false, reason: "throttled" };
  return { proceed: true, reason: "under-cap" };
}

// Counts log lines (already-parsed objects, one per prior run — see
// appendLogLine()/loadLogLines()) whose `ts` falls on `todayUtcDate`
// ("YYYY-MM-DD") AND that were a REAL (non-dry-run) sync attempt
// (`mode==="apply" && attempted===true`) — a dry-run preview, a no-change
// exit, or a throttled/no-op-unmapped run never counts against the cap.
export function countRealSyncsToday(lines, todayUtcDate) {
  let n = 0;
  for (const line of lines) {
    if (
      line?.mode === "apply" &&
      line?.attempted === true &&
      String(line?.ts ?? "").startsWith(todayUtcDate)
    )
      n++;
  }
  return n;
}

// "R<N>" (no suffix) -> a top-level (parent=null) ROAD item named
// "Release <N> ..." — see the file header comment for why this stops at
// bare "R<N>" titles only.
export function autoMatchReleaseRef(milestoneTitle, topLevelItems) {
  const m = /^R(\d+)$/.exec(String(milestoneTitle ?? "").trim());
  if (!m) return null;
  const re = new RegExp(`^Release\\s+${m[1]}\\b`, "i");
  const hit = (topLevelItems ?? []).find((it) => re.test(it.name ?? ""));
  return hit ? `ROAD-${hit.sequence_id}` : null;
}

export function resolveReleaseRef({ milestoneTitle, topLevelItems, releaseOverrides = {} }) {
  return (
    releaseOverrides[milestoneTitle] ?? autoMatchReleaseRef(milestoneTitle, topLevelItems) ?? null
  );
}

export function formatDescriptionLine({ htmlUrl, closed, total, dueOn }) {
  const due = formatDate(dueOn) ?? "no due date";
  const url = htmlUrl ?? "";
  const linkText = url
    ? `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`
    : "(no milestone URL)";
  return `<p ${MARKER_ATTR}>GitHub: ${linkText} · ${closed}/${total} features done · due ${due}</p>`;
}

// Idempotent: replaces a PRIOR auto-line (found via MARKER_RE) in place, or
// appends when none exists yet — a human's own description content, above
// or below the marker line, is always left byte-identical.
export function upsertReleaseLine(currentHtml, lineHtml) {
  const base = String(currentHtml ?? "").trim();
  if (MARKER_RE.test(base)) return base.replace(MARKER_RE, lineHtml);
  return base ? `${base}\n${lineHtml}` : lineHtml;
}

// Builds the ops for ONE changed, Plane-mapped release: one `update` (the
// upserted description line, + target_date, + state:"Done" only when the
// milestone itself just closed — an OPEN release's Plane state is left
// alone so this never fights a human's own "move to In Progress"), one
// `comment` summarizing the diff, and one `update` per feature that just
// closed AND has a mapping (`mappingFeatures`, keyed by GitHub issue
// number). A closed feature with NO mapping is never guessed at — it goes
// into `unmappedFeatures` for the report instead, per the task's own rule
// ("if none can be found, don't create items, list them in the report").
export function buildReleaseOps({
  releaseRef,
  current,
  diff,
  currentDescriptionHtml,
  mappingFeatures = {},
}) {
  const lineHtml = formatDescriptionLine({
    htmlUrl: current.htmlUrl,
    closed: current.closed,
    total: current.total,
    dueOn: current.dueOn,
  });
  const set = { description_html: upsertReleaseLine(currentDescriptionHtml, lineHtml) };
  const targetDate = formatDate(current.dueOn);
  if (targetDate) set.target_date = targetDate;
  if (current.state === "closed") set.state = "Done";

  const ops = [{ op: "update", ref: releaseRef, set }];

  const summary = diff.reasons.length ? diff.reasons.join("; ") : "no material change";
  ops.push({
    op: "comment",
    ref: releaseRef,
    html: `<p>Release sync: ${escapeHtml(summary)}. Now ${current.closed}/${current.total} features done${current.atRisk ? " — AT RISK" : ""}.</p>`,
  });

  const unmappedFeatures = [];
  for (const change of diff.closedOrReopened) {
    if (change.to !== "CLOSED") continue;
    const mapped = mappingFeatures[String(change.number)];
    if (!mapped) {
      unmappedFeatures.push({
        key: change.key,
        number: change.number,
        reason: "no Plane item mapped",
      });
      continue;
    }
    ops.push({ op: "update", ref: mapped.road, set: { state: "Done" } });
  }
  return { ops, unmappedFeatures };
}

// Normalizes a parsed plane-release-map.json into {releaseOverrides,
// features} with both always present — a missing/malformed file degrades to
// {} for both rather than throwing (this map is a helpful accelerant, never
// a hard dependency: an empty map just means every feature reports
// unmapped, which is a correct, reportable state, not a crash).
export function loadMapping(raw) {
  const releaseOverrides =
    raw && typeof raw.releaseOverrides === "object" && raw.releaseOverrides
      ? raw.releaseOverrides
      : {};
  const features = raw && typeof raw.features === "object" && raw.features ? raw.features : {};
  return { releaseOverrides, features };
}

// ── I/O: GitHub reads ────────────────────────────────────────────────────

function spawnGh(args) {
  const res = spawnSync("gh", args, {
    cwd: repoRoot(),
    env: gitEnv(),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (res.error) throw new Error(`gh ${args.join(" ")} failed to start: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(
      `gh ${args.join(" ")} -> exit ${res.status}: ${(res.stderr || "").trim().slice(0, 500)}`,
    );
  }
  return res.stdout;
}

export function defaultFetchMilestones() {
  const stdout = spawnGh(["api", `repos/${GITHUB_REPO}/milestones?state=all`]);
  const parsed = JSON.parse(stdout);
  return parsed.map((m) => ({
    number: m.number,
    title: m.title,
    state: m.state,
    due_on: m.due_on ?? null,
    html_url: m.html_url ?? null,
  }));
}

export function defaultFetchFeatureIssues() {
  const stdout = spawnGh([
    "issue",
    "list",
    "--repo",
    GITHUB_REPO,
    "--label",
    "kind:feature",
    "--state",
    "all",
    "--json",
    "number,title,state,milestone,closedAt",
    "--limit",
    "500",
  ]);
  const parsed = JSON.parse(stdout);
  return parsed
    .filter((it) => it.milestone && FEATURE_TITLE_RE.test(it.title))
    .map((it) => ({
      number: it.number,
      title: it.title,
      state: it.state,
      milestoneTitle: it.milestone.title,
      closedAt: it.closedAt ?? null,
    }));
}

// ── I/O: local state ─────────────────────────────────────────────────────
// Deliberately anchored on THIS tree's own repoRoot(), NOT plane-client.mjs's
// machineRoot() (which resolves to the MAIN checkout's directory via `git
// rev-parse --git-common-dir`, shared across every worktree — the L-116 /
// reference_git_worktreeconfig_bare_trap_2026-09-04 fix the rest of this
// harness uses on purpose). This tool was built inside its own throwaway
// worktree under an explicit "never touch the main checkout" instruction —
// machineRoot() would have written this tool's log/snapshot straight into
// it. Once this branch merges and runs from one canonical checkout,
// repoRoot() and machineRoot() are the same path anyway; a future session
// that genuinely needs this tool's throttle state to stay consistent across
// several concurrent worktrees can switch this one `join(...)` line to
// machineRoot() (already how plane-client.mjs's own ledger/telemetry work).
//
// PLANE_RELEASE_WORK_DIR is a TEST-ONLY override, gated like every other
// override in this harness (PLANE_SYNC_SELF_TEST=1 required alongside it).
export function workDir() {
  if (process.env.PLANE_SYNC_SELF_TEST === "1" && process.env.PLANE_RELEASE_WORK_DIR) {
    return process.env.PLANE_RELEASE_WORK_DIR;
  }
  return join(repoRoot(), "local-assets", "work");
}

export function snapshotPath() {
  return join(workDir(), "plane-release-state.json");
}

export function logPath() {
  return join(workDir(), "plane-release.log");
}

function loadSnapshot() {
  try {
    const parsed = JSON.parse(readFileSync(snapshotPath(), "utf8"));
    return parsed && typeof parsed.releases === "object" && parsed.releases
      ? parsed
      : { releases: {} };
  } catch {
    return { releases: {} };
  }
}

function loadLogLines() {
  try {
    return readFileSync(logPath(), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function appendLogLine(record) {
  mkdirSync(workDir(), { recursive: true });
  appendFileSync(logPath(), `${JSON.stringify(record)}\n`);
}

function defaultMappingPath() {
  return join(repoRoot(), "scripts", "work", "plane-release-map.json");
}

function loadMappingFile(path) {
  try {
    return loadMapping(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return loadMapping(null);
  }
}

// ── orchestration (impure — not exercised by the self-test file; the live
// dry-run proof is run separately per the task's own instructions) ────────

export async function runReleaseSync({
  dryRun = true,
  force = false,
  forceAll = false,
  apiKey = process.env.PLANE_API_KEY,
  now = new Date(),
  fetchMilestones = defaultFetchMilestones,
  fetchFeatureIssues = defaultFetchFeatureIssues,
  mappingPath = defaultMappingPath(),
} = {}) {
  if (!apiKey) throw new Error("missing PLANE_API_KEY (refusing to run without a key)");

  const mapping = loadMappingFile(mappingPath);
  const milestones = fetchMilestones();
  const features = fetchFeatureIssues();
  const featuresByMilestone = new Map();
  for (const f of features) {
    if (!featuresByMilestone.has(f.milestoneTitle)) featuresByMilestone.set(f.milestoneTitle, []);
    featuresByMilestone.get(f.milestoneTitle).push(f);
  }

  const client = createClient({ apiKey, tool: "plane-release-sync-read" });
  const project = await client.resolveProject(ROAD_PROJECT_IDENTIFIER);
  const items = await client.listAll(`projects/${project.id}/work-items/`, {
    query: { per_page: "100" },
  });
  const topLevelItems = items.filter((it) => !it.parent);
  const itemBySeq = new Map(items.map((it) => [it.sequence_id, it]));

  const snapshot = loadSnapshot();
  const releases = {};
  let anyChanged = false;
  let anyMajorRelease = false;

  for (const milestone of milestones) {
    const current = computeReleaseSnapshot({
      milestone,
      features: featuresByMilestone.get(milestone.title) ?? [],
      now,
    });
    const diff = diffRelease(current, snapshot.releases?.[milestone.title]);
    const releaseRef = resolveReleaseRef({
      milestoneTitle: milestone.title,
      topLevelItems,
      releaseOverrides: mapping.releaseOverrides,
    });
    releases[milestone.title] = { current, diff, releaseRef };
    if (diff.changed) anyChanged = true;
    if (diff.majorRelease) anyMajorRelease = true;
  }

  const todayUtcDate = now.toISOString().slice(0, 10);
  const realSyncsToday = countRealSyncsToday(loadLogLines(), todayUtcDate);
  const throttle = decideThrottle({
    changed: anyChanged,
    majorRelease: anyMajorRelease,
    force,
    forceAll,
    realSyncsToday,
  });

  const result = {
    decision: throttle.reason,
    mode: dryRun ? "dry-run" : "apply",
    changedReleases: Object.entries(releases)
      .filter(([, r]) => r.diff.changed)
      .map(([title]) => title),
    majorRelease: anyMajorRelease,
    releases,
    plan: { ops: [], unmappedFeatures: [] },
    unmappedReleases: [],
    applyResult: null,
    exitCode: 0,
  };

  if (!throttle.proceed) return result;

  // Build the combined plan across every changed (or force-all'd), mapped
  // release. A changed release with NO Plane item found is reported, never
  // guessed — see resolveReleaseRef()/autoMatchReleaseRef().
  const ops = [];
  const unmappedFeatures = [];
  const consideredReleases = forceAll
    ? Object.keys(releases)
    : Object.entries(releases)
        .filter(([, r]) => r.diff.changed)
        .map(([title]) => title);

  for (const title of consideredReleases) {
    const { current, diff, releaseRef } = releases[title];
    if (!releaseRef) {
      result.unmappedReleases.push({
        title,
        reason: "no Plane item found (see autoMatchReleaseRef / releaseOverrides)",
      });
      continue;
    }
    const seq = Number(releaseRef.split("-")[1]);
    const item = itemBySeq.get(seq);
    const built = buildReleaseOps({
      releaseRef,
      current,
      diff,
      currentDescriptionHtml: item?.description_html ?? "",
      mappingFeatures: mapping.features,
    });
    ops.push(...built.ops);
    unmappedFeatures.push(...built.unmappedFeatures.map((u) => ({ ...u, release: title })));
  }

  result.plan = { ops, unmappedFeatures };

  const attempted = ops.length > 0;
  let applyResult = null;
  if (attempted) {
    mkdirSync(join(workDir(), "plans"), { recursive: true });
    const opsFilePath = join(
      workDir(),
      "plans",
      `${now.toISOString().replace(/[:.]/g, "-")}-${dryRun ? "dry-run" : "apply"}.json`,
    );
    writeFileSync(opsFilePath, JSON.stringify({ ops }, null, 2));
    applyResult = await runApply({ opsPath: opsFilePath, dryRun, apiKey });
    result.applyResult = applyResult;
    result.exitCode = applyResult.exitCode;

    // SNAPSHOT PERSISTENCE: only a REAL (`dryRun===false`), successful
    // (`exitCode===0`) apply advances the baseline, and only for the
    // releases actually included in this run's plan (mapped + changed). A
    // dry-run preview, a throttled/no-op skip, or a failed apply all leave
    // the snapshot untouched, so the SAME change keeps showing as "changed"
    // (and keeps getting reported) on every future run until it is actually
    // synced — see the file header comment for why this reads "last SYNCED
    // snapshot" literally rather than "last observed".
    if (!dryRun && applyResult.exitCode === 0) {
      const nextReleases = { ...(snapshot.releases ?? {}) };
      for (const title of consideredReleases) {
        if (releases[title].releaseRef) nextReleases[title] = releases[title].current;
      }
      mkdirSync(workDir(), { recursive: true });
      writeFileSync(
        snapshotPath(),
        JSON.stringify(
          { version: 1, updatedAt: now.toISOString(), releases: nextReleases },
          null,
          2,
        ),
      );
    }
  }

  appendLogLine({
    ts: now.toISOString(),
    tool: "plane-release-sync",
    mode: result.mode,
    decision: throttle.reason,
    attempted,
    changedReleases: result.changedReleases,
    majorRelease: anyMajorRelease,
    opsCount: ops.length,
    unmappedReleases: result.unmappedReleases.map((r) => r.title),
    unmappedFeatures: unmappedFeatures.map((u) => u.key),
    applyExitCode: applyResult?.exitCode ?? null,
  });

  return result;
}

// ── CLI ─────────────────────────────────────────────────────────────────
const USAGE =
  "Usage: plane-release-sync.mjs [--dry-run] [--apply] [--force] [--force-all] [--json] [--help]";

function printHumanReport(result) {
  console.log(`plane-release-sync: decision=${result.decision} mode=${result.mode}`);
  for (const [title, r] of Object.entries(result.releases)) {
    const c = r.current;
    console.log(
      `  ${title}: ${c.closed}/${c.total} done (${c.percentDone}%) state=${c.state} atRisk=${c.atRisk} ` +
        `changed=${r.diff.changed}${r.diff.reasons.length ? " [" + r.diff.reasons.join("; ") + "]" : ""} ` +
        `ref=${r.releaseRef ?? "UNMAPPED"}`,
    );
  }
  if (result.unmappedReleases.length) {
    console.log("  unmapped releases (changed, no Plane item found):");
    for (const u of result.unmappedReleases) console.log(`    - ${u.title}: ${u.reason}`);
  }
  if (result.plan.ops.length) {
    console.log(`  plan (${result.plan.ops.length} op(s)):`);
    for (const op of result.plan.ops) console.log(`    - ${op.op} ${op.ref}`);
  }
  if (result.plan.unmappedFeatures.length) {
    console.log("  unmapped features (closed, no Plane item):");
    for (const u of result.plan.unmappedFeatures)
      console.log(`    - ${u.release} ${u.key} (#${u.number}): ${u.reason}`);
  }
  if (result.applyResult) {
    console.log(
      `  plane-apply: exitCode=${result.applyResult.exitCode} applied=${result.applyResult.applied} deferred=${result.applyResult.deferred}`,
    );
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 0;
    return;
  }
  const unknown = argv.find(
    (a) =>
      a.startsWith("--") &&
      !["--dry-run", "--apply", "--force", "--force-all", "--json"].includes(a),
  );
  if (unknown) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const apply = argv.includes("--apply");
  const dryRun = !apply;
  const force = argv.includes("--force");
  const forceAll = argv.includes("--force-all");
  const json = argv.includes("--json");

  let result;
  try {
    result = await runReleaseSync({ dryRun, force, forceAll });
  } catch (err) {
    process.stderr.write(`plane-release-sync: ${err?.message ?? err}\n`);
    process.exitCode = 1;
    return;
  }
  if (json) console.log(JSON.stringify(result, null, 2));
  else printHumanReport(result);
  process.exitCode = result.exitCode ?? 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
