// `rf event link` guard: does a PR's title read like the item it is being linked to? A wrong id
// looks like finished work on the wrong item, and nothing else in the monitor can tell.
import { spawnSync } from "node:child_process";
import { GITHUB_REPO } from "./config.mjs";

// Words most titles carry, so sharing one proves nothing: commit types, workspaces, small words.
const NOISE = new Set(
  (
    "feat fix chore docs doc test refactor perf build style revert " +
    "web api mobile app " +
    "the and for with from into that this not when add new use all per via out off also only " +
    "make get set show update change remove"
  ).split(" "),
);

/** A title's meaningful words, lower-cased, plurals folded. */
function words(title) {
  const out = new Set();
  for (const raw of String(title ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)) {
    const w = raw.length > 3 && raw.endsWith("s") ? raw.slice(0, -1) : raw;
    if (w.length >= 3 && !NOISE.has(w)) out.add(w);
  }
  return out;
}

/** True when the PR title names the item's id or shares a meaningful word with its title. */
export function linkMatches(item, prTitle) {
  const named = String(prTitle ?? "")
    .toLowerCase()
    .split(/[^a-z0-9-]+/);
  if (named.includes(item.id.toLowerCase())) return true;
  const theirs = words(prTitle);
  return [...words(item.title)].some((w) => theirs.has(w));
}

/** The PR's title from gh (RF_GH_CMD, a JSON argv, replaces it), or null when it cannot be read. */
export function readPrTitle(pr, { env = process.env, run = spawnSync } = {}) {
  const [cmd, ...base] = env.RF_GH_CMD ? JSON.parse(env.RF_GH_CMD) : ["gh"];
  const r = run(
    cmd,
    [...base, "pr", "view", String(pr), "--repo", GITHUB_REPO, "--json", "title", "--jq", ".title"],
    { encoding: "utf8", timeout: 20000, env },
  );
  if (r.error || r.status !== 0) return null;
  return String(r.stdout ?? "").trim() || null;
}
