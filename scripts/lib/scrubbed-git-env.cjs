// The ONE definition of "the process environment WITHOUT git's own variables".
//
// A git hook (pre-push) exports GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE ... into everything it spawns,
// and those override the repository git would discover from a cwd, so a child asking "which repo is
// THIS directory?" (or a fixture running `git init` in a temp dir) is silently answered about the
// hook's repo instead (the B420 shape). Prefix filter, not a hand list: it also drops GIT_CONFIG*.
//
// CommonJS so BOTH loaders reach the same code: `.mjs` scripts via scripts/lib/check-git-hooks.mjs
// (which re-exports it), and ts-jest CJS specs via `require`. Never copy this body elsewhere;
// apps/api/src/common/fixture-git-env-scrub.spec.ts fails a fixture file that does not call it.
"use strict";

function scrubbedGitEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("GIT_")));
}

module.exports = { scrubbedGitEnv };
