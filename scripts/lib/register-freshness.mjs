// Is this tree's tracked register at least as new as origin/master? `bugs.mjs file` mints max+1 over
// THIS tree's catalogue, so a checkout that is behind master can mint an id master already used
// (B1291, B1292). Fail closed: a fetch or git error is "not fresh", never "assume fine".
//
// `git(args)` returns { status, stdout, stderr }; the default runs real git in `repoDir` with the
// same timeout cap as every other register git call. Clone mode never needs this (withRegistryWrite
// fetches and resets the clone).
import { spawnSync } from "node:child_process";
import { REGISTRY_GIT_TIMEOUT_MS } from "./registry-root.mjs";
import { scrubbedGitEnv } from "./check-git-hooks.mjs";

const MASTER = "refs/remotes/origin/master";

const defaultGit = (repoDir) => (args) => {
  const r = spawnSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    timeout: REGISTRY_GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: scrubbedGitEnv(),
  });
  return {
    status: r.status ?? (r.error ? 128 : 1),
    stdout: r.stdout ?? "",
    stderr: r.stderr || (r.error ? String(r.error.message) : ""),
  };
};

const firstLine = (s) =>
  String(s || "")
    .split(/\r?\n/)
    .find(Boolean) || "no output";

export function checkRegisterFresh({ repoDir, prefix, localIds, git = defaultGit(repoDir) }) {
  const fetch = git([
    "fetch",
    "-q",
    "--no-write-fetch-head",
    "origin",
    `+refs/heads/master:${MASTER}`,
  ]);
  if (fetch.status !== 0)
    return { ok: false, reason: `git fetch origin master failed: ${firstLine(fetch.stderr)}` };

  const anc = git(["merge-base", "--is-ancestor", MASTER, "HEAD"]);
  if (anc.status === 1) return { ok: false, reason: "HEAD does not contain origin/master" };
  if (anc.status !== 0)
    return { ok: false, reason: `git merge-base failed: ${firstLine(anc.stderr)}` };

  const show = git(["show", `${MASTER}:${prefix}/bugs.jsonl`]);
  if (show.status !== 0)
    return {
      ok: false,
      reason: `could not read ${prefix}/bugs.jsonl on origin/master: ${firstLine(show.stderr)}`,
    };
  const have = new Set(localIds);
  const missing = [];
  for (const line of show.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let id;
    try {
      id = JSON.parse(line).id;
    } catch {
      return { ok: false, reason: `origin/master ${prefix}/bugs.jsonl has an unreadable line` };
    }
    if (id && !have.has(id)) missing.push(id);
  }
  if (missing.length)
    return {
      ok: false,
      reason: `origin/master has ${missing.length} id(s) this tree lacks: ${missing.slice(0, 5).join(", ")}`,
    };
  return { ok: true };
}
