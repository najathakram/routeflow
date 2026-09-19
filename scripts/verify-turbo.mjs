#!/usr/bin/env node
// The turbo step of `npm run verify`: check-types + lint + Jest (+ the api repo-truth tripwire).
//
// Full by default. The pre-push hook sets VERIFY_SCOPE=affected on a non-master branch, and then
// only the workspaces the diff reaches (scripts/lib/verify-scope.mjs) are checked — printed as
// "AFFECTED SCOPE: <workspaces>". master pushes, FULL_VERIFY=1 (the coordinator's landing run),
// CI and a hand-run `npm run verify` always run every workspace. CI's full run is the authority.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decideScope } from "./lib/verify-scope.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TURBO_FLAGS = ["--concurrency=2", "--continue=dependencies-successful"];

function turbo(args) {
  const r = spawnSync("npx", ["turbo", "run", ...args, ...TURBO_FLAGS], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return r.status ?? 1;
}

const scope = decideScope(ROOT);

if (scope.mode === "full") {
  console.log(`FULL SCOPE (${scope.reason}) — every workspace`);
  process.exit(turbo(["check-types", "lint", "test", "test:repo-truth"]));
}

console.log(
  `AFFECTED SCOPE: ${scope.workspaces.join(", ")} (changed: ${scope.changed.join(", ") || "none"}; ` +
    `always-run tripwires: @routeflow/pricing tests, @routeflow/api test:repo-truth). ` +
    `FULL_VERIFY=1 runs everything.`,
);
const filters = scope.workspaces.map((w) => `--filter=${w}`);
const first = turbo(["check-types", "lint", "test", ...filters]);
// Keep going after a failure so one push reports every red workspace, like the full chain does.
// Only apps/api defines test:repo-truth today; a second workspace adding one must be added here.
const second = turbo(["test:repo-truth", "--filter=@routeflow/api"]);
process.exit(first || second);
