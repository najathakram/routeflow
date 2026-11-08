// Train facts the pre-check prints before its steps (scripts/train-precheck.mjs), from two lead-log guards:
//   #3999  more than one merge base between the train head and master means GitHub's CONFLICTING is real even when a
//          local merge-tree is clean: trust GitHub and merge master up.
//   #3977  a member rode a train with its own Migration replay red; the train's DB lane caught it late. Each member's
//          latest Migration replay conclusion is printed, and one that did not prove the migrations is named.
// DARK (lane rule: a new gate ships dark): the facts print and a red one says "would hold", but the pre-check's exit
// is unchanged unless TRAIN_FACTS=enforce. The enforce flip is its own PR, backed by warn-run evidence.
// Pure functions take injected runners, so the self-test (train-facts.self-test.mjs) needs no git or gh.

/** The workflow whose check is read per member (.github/workflows/db-migrations.yml `name:`). */
export const REPLAY_WORKFLOW = "Migration replay";
// Anything but SUCCESS (or NEUTRAL) is unproven. SKIPPED is the common one: the replay job skips while the PR is a
// draft and the workflow has no ready_for_review trigger, so a PR opened as a draft keeps a SKIPPED replay on its head.
const PROVEN = new Set(["SUCCESS", "NEUTRAL"]);

/** `git merge-base --all <head> <base>` as a count; runGit(args) returns stdout and throws on a git error. */
export function mergeBaseCount(runGit, head = "HEAD", base = "origin/master") {
  return runGit(["merge-base", "--all", head, base]).split(/\s+/).filter(Boolean).length;
}

/**
 * The member's latest Migration replay check from `gh pr view --json statusCheckRollup` rows (the head commit's
 * checks only): { conclusion, name, completedAt } or null when the workflow never ran on the PR (its paths filter
 * skipped it). Latest = newest completedAt; a run not COMPLETED is newest of all and reads as PENDING. gh writes an
 * unfinished check's completedAt as the zero time "0001-01-01T00:00:00Z", never null, so status decides, not the date.
 */
export function latestReplay(rollup) {
  const rows = (Array.isArray(rollup) ? rollup : []).filter(
    (r) => r && r.workflowName === REPLAY_WORKFLOW,
  );
  if (!rows.length) return null;
  const done = (r) => String(r.status ?? "").toUpperCase() === "COMPLETED";
  const at = (r) => (done(r) ? Date.parse(r.completedAt) || 0 : Infinity);
  const newest = rows.reduce((a, b) => (at(b) >= at(a) ? b : a));
  if (!done(newest)) {
    return { conclusion: "PENDING", name: newest.name ?? REPLAY_WORKFLOW, completedAt: null };
  }
  return {
    conclusion: String(newest.conclusion ?? "").toUpperCase(),
    name: newest.name ?? REPLAY_WORKFLOW,
    completedAt: newest.completedAt ?? null,
  };
}

/** "--members 4101,#4102 4103" -> [4101, 4102, 4103]; a token that is not a PR number throws. */
export function parseMembers(text) {
  const tokens = String(text ?? "")
    .split(/[\s,]+/)
    .filter(Boolean);
  return tokens.map((t) => {
    const n = Number(t.replace(/^#/, ""));
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--members: "${t}" is not a PR number`);
    return n;
  });
}

/** Why a replay conclusion does not prove the member's migrations, or "" when it does. */
function unproven(conclusion) {
  if (PROVEN.has(conclusion)) return "";
  if (conclusion === "SKIPPED")
    return "  <- not proven: skipped (opened as a draft?); re-run it on the member before the train (#3977)";
  if (conclusion === "PENDING") return "  <- not finished: wait for it before the train (#3977)";
  return "  <- red: fix it on the member before the train (#3977)";
}

/**
 * The fact lines and whether any is red. runGh(args) returns stdout; a member gh cannot read is red ("unknown"):
 * nothing was proven, so it is never a pass.
 */
export function trainFacts({
  runGit,
  runGh,
  repo,
  members = [],
  head = "HEAD",
  base = "origin/master",
}) {
  const lines = [];
  let red = false;
  try {
    // The count is only as fresh as the local base ref: print its sha and date, so a stale one shows (fetch first).
    const [sha, when] = runGit(["log", "-1", "--format=%h %cI", base]).trim().split(" ");
    lines.push(`base: ${base} at ${sha} (${when}); run git fetch origin first if that is old`);
    const n = mergeBaseCount(runGit, head, base);
    if (n > 1) {
      red = true;
      lines.push(
        `merge bases: ${n} between ${head} and ${base}. GitHub's CONFLICTING is real even if a local merge-tree is clean (#3999): merge ${base} up.`,
      );
    } else lines.push(`merge bases: ${n} between ${head} and ${base}`);
  } catch (e) {
    red = true;
    lines.push(`merge bases: unknown (${firstLine(e)})`);
  }
  for (const pr of members) {
    let replay;
    try {
      const view = JSON.parse(
        runGh(["pr", "view", String(pr), "-R", repo, "--json", "statusCheckRollup"]),
      );
      replay = latestReplay(view.statusCheckRollup);
    } catch (e) {
      red = true;
      lines.push(`#${pr} ${REPLAY_WORKFLOW}: unknown (${firstLine(e)})`);
      continue;
    }
    if (!replay) {
      lines.push(`#${pr} ${REPLAY_WORKFLOW}: did not run (no migration or DB paths touched)`);
      continue;
    }
    const why = unproven(replay.conclusion);
    if (why) red = true;
    lines.push(
      `#${pr} ${REPLAY_WORKFLOW}: ${replay.conclusion}${replay.completedAt ? ` at ${replay.completedAt}` : ""}${why}`,
    );
  }
  return { lines, red };
}

/** TRAIN_FACTS=enforce makes a red fact fail the pre-check; anything else keeps it dark. */
export function factsEnforced(env = process.env) {
  return String(env.TRAIN_FACTS ?? "").toLowerCase() === "enforce";
}

function firstLine(e) {
  return String(e instanceof Error ? e.message : e)
    .split("\n")[0]
    .slice(0, 160);
}
