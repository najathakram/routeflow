// Refuses a push from a tree with no git hooks. Reuses checkGitHooks; reimplements nothing.
import { checkGitHooks } from "../check-git-hooks.mjs";
import { spawnSync } from "node:child_process";

const defaultGit = () => {
  const out = (a) => spawnSync("git", a, { encoding: "utf8" }).stdout.trim();
  return `${out(["rev-parse", "--abbrev-ref", "HEAD"])} ${out(["rev-parse", "--short", "HEAD"])}`;
};

export function run(_args, { check = checkGitHooks, git = defaultGit } = {}) {
  const r = check();
  if (r.status === 1)
    return {
      code: 1,
      lines: ["this tree has no hooks; run `node scripts/ensure-git-hooks.mjs`, then re-run"],
    };
  if (r.status !== 0) return { code: 2, lines: [r.message] };
  return { code: 0, lines: [r.skipped || /CI/.test(r.message) ? r.message : git()] };
}
