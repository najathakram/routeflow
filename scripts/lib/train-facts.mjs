// Train facts the pre-check prints before its steps (scripts/train-precheck.mjs), from two lead-log guards:
//   #3999  more than one merge base between the train head and master means GitHub's CONFLICTING is real even when a
//          local merge-tree is clean: trust GitHub and merge master up.
//   #3977  a member rode a train with its own Migration replay red; the train's DB lane caught it late. Each member's
//          latest Migration replay conclusion is printed, and a red one is named.
// DARK (lane rule: a new gate ships dark): the facts print and a red one says "would hold", but the pre-check's exit
// is unchanged unless TRAIN_FACTS=enforce. The enforce flip is its own PR, backed by warn-run evidence.
// Pure functions take injected runners, so the self-test (train-facts.self-test.mjs) needs no git or gh.

/** The workflow whose check is read per member (.github/workflows/db-migrations.yml `name:`). */
export const REPLAY_WORKFLOW = "Migration replay";
const RED = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

/** `git merge-base --all <head> <base>` as a count; runGit(args) returns stdout and throws on a git error. */
export function mergeBaseCount(runGit, head = "HEAD", base = "origin/master") {
  return runGit(["merge-base", "--all", head, base]).split(/\s+/).filter(Boolean).length;
}

/**
 * The member's latest Migration replay check from `gh pr view --json statusCheckRollup` rows:
 * { conclusion, name, completedAt } or null when the workflow never ran on the PR (its paths filter skipped it).
 * Latest = newest completedAt; a run still going (no completedAt) is newest of all and reads as PENDING.
 */
export function latestReplay(rollup) {
  const rows = (Array.isArray(rollup) ? rollup : []).filter(
    (r) => r && r.workflowName === REPLAY_WORKFLOW,
  );
  if (!rows.length) return null;
  const at = (r) => (r.completedAt ? Date.parse(r.completedAt) : Infinity);
  const newest = rows.reduce((a, b) => (at(b) >= at(a) ? b : a));
  const conclusion = newest.completedAt ? String(newest.conclusion ?? "").toUpperCase() : "PENDING";
  return {
    conclusion,
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
    const bad = RED.has(replay.conclusion) || replay.conclusion === "PENDING";
    if (bad) red = true;
    lines.push(
      `#${pr} ${REPLAY_WORKFLOW}: ${replay.conclusion}${replay.completedAt ? ` at ${replay.completedAt}` : ""}${bad ? "  <- red: fix it on the member before the train (#3977)" : ""}`,
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
