#!/usr/bin/env node
// B642 guard CLI. `node scripts/check-git-hooks.mjs`: exit 0 hooks installed (or nothing to check: CI,
// or not inside a git work tree), 1 hooks missing, 2 inside a work tree but the state is unreadable.
// `--warn` is the session-start diagnostic: read-only, ALWAYS exits 0 (it can never block or fail a
// session), prints NOTHING when healthy, skipped (CI / not a work tree), and one line only when there
// is a problem.
// Wired into: `npm run verify` (first step), the SessionStart hook in .claude/settings.json (`--warn`),
// and the worktree-setup steps in .claude/commands/dispatch.md. Deliberately NOT wired into `prepare`
// or any lifecycle script: `npm ci` runs those inside Docker builds with no .git, and a guard must
// never sit on a production build path.
import { checkGitHooks } from "./lib/check-git-hooks.mjs";

const { status, message } = checkGitHooks();
if (process.argv.includes("--warn")) {
  if (status !== 0) console.error(`\u26a0 ${message}`);
  process.exit(0);
}
console.log(message);
process.exit(status);
