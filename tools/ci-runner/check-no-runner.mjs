#!/usr/bin/env node
// A public repo lets a fork PR reach a self-hosted runner, so a public flip waits until none is
// registered. It runs straight before the flip, and only a reading of 0 lets the flip go. Exit 1 is
// a runner still registered; exit 2 is no reading. Routine: docs/runbooks/self-hosted-runner.md.
//
//   node tools/ci-runner/check-no-runner.mjs && gh repo edit <repo> --visibility public ...
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO, gh } from "./launch-once.mjs";

export const EXIT_LIVE_RUNNER = 1;
export const EXIT_UNREADABLE = 2;

export function checkNoRunner(ghFn = gh, error = console.error) {
  let total;
  let runners;
  try {
    ({ total_count: total, runners } = JSON.parse(ghFn(["api", `repos/${REPO}/actions/runners`])));
  } catch (e) {
    error(`refusing the flip: can't read ${REPO}'s runners: ${e instanceof Error ? e.message : e}`);
    return EXIT_UNREADABLE;
  }
  if (!Number.isInteger(total) || total < 0) {
    error(`refusing the flip: ${REPO}'s runner count reads ${JSON.stringify(total)}`);
    return EXIT_UNREADABLE;
  }
  if (total === 0) return 0;
  const names = (runners ?? []).map((r) => `${r.name} (id ${r.id})`).join(", ");
  error(`refusing the flip: ${total} runner(s) registered on ${REPO}: ${names}`);
  error("Finish or stop it first: docs/runbooks/self-hosted-runner.md, Stopping it.");
  return EXIT_LIVE_RUNNER;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(checkNoRunner());
}
