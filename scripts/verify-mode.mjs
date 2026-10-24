#!/usr/bin/env node
// Prints the verify mode the pre-push hook should run: `fast` or `full`. One word on stdout, exit 0.
//
// FAST VERIFY (owner ruling 2026-10-10, "Fast local check, full in CI"): a feature-branch push runs
// check-types + lint for the affected workspaces and only the Jest tests related to the diff; CI runs
// the full suite on every train/PR. The policy lives in scripts/lib/verify-scope.mjs
// (`wantsFastVerify`): not CI, not FULL_VERIFY=1, not master/main/detached — and the merge-base with
// origin/master must be computable (the related-only filter hangs off it), otherwise `full`.
//
// .husky/pre-push calls this, exports RF_VERIFY_MODE=fast on `fast` (and unsets it otherwise), and
// suffixes the verified-tree marker with the mode. RF_VERIFY_MODE is the one explicit switch that
// verify-turbo.mjs, verify-scope.mjs `decideScope` and campaign-check.mjs read; this script is the
// only writer of the decision.
//
// usage: node scripts/verify-mode.mjs [--branch <name>]   (default: the checked-out branch)
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { currentBranch, mergeBaseSha, wantsFastVerify } from "./lib/verify-scope.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Pure core (the CLI below only feeds it git facts) so the self-test can pin every branch. */
export function resolveVerifyMode({ env, branch, mergeBase }) {
  return wantsFastVerify({ env, branch }) && mergeBase ? "fast" : "full";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf("--branch");
  const branch = i !== -1 ? process.argv[i + 1] : currentBranch(ROOT);
  console.log(resolveVerifyMode({ env: process.env, branch, mergeBase: mergeBaseSha(ROOT) }));
}
