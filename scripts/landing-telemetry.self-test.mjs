#!/usr/bin/env node
// Self-test for scripts/landing-telemetry.mjs (R1-b). Plain node: `node scripts/landing-telemetry.self-test.mjs`.
// Runs the script against scripts/fixtures/landing-telemetry/base (gh PRs, board comments and a fake transcript dir),
// so no gh, git or network is touched and nothing is written.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { latestByPr, reviewOf, routeOf } from "./landing-telemetry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "landing-telemetry.mjs");
const FIX = path.join(HERE, "fixtures", "landing-telemetry", "base");

let failures = 0;
let passed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++;
  else failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
};
const run = (args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 60_000 });
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k]]));

const res = run(["--since", "2026-10-20", "--fixture", FIX, "--json"]);
check("fixture run exits 0", res.status, 0);
const rows = JSON.parse(res.stdout || "[]");
const row = (n) => rows.find((r) => r.pr === n);

check(
  "only merged PRs get a row",
  rows.map((r) => r.pr),
  [101, 102, 103],
);
check("L1 trailers win", pick(row(101), ["route", "routeBasis", "reworkOf", "reworkBasis"]), {
  route: "bug-swarm",
  routeBasis: "trailer",
  reworkOf: 3740,
  reworkBasis: "trailer",
});
check(
  "L2 route and rework inferred",
  pick(row(102), ["route", "routeBasis", "reworkOf", "reworkBasis"]),
  {
    route: "lane",
    routeBasis: "inferred",
    reworkOf: 3740,
    reworkBasis: "inferred",
  },
);
check(
  "L3 FAIL then PASS: two rounds, not first-pass",
  pick(row(101), ["reviewRounds", "firstPass", "verdicts", "reviewBasis"]),
  {
    reviewRounds: 2,
    firstPass: false,
    verdicts: { pass: 2, fail: 1 },
    reviewBasis: "board",
  },
);
check(
  "L4 no verdicts: null with basis none",
  pick(row(103), ["reviewRounds", "firstPass", "reviewBasis", "route"]),
  {
    reviewRounds: null,
    firstPass: null,
    reviewBasis: "none",
    route: "docs",
  },
);
check("L5 branch lines are costed", [row(102)?.costBasis, row(102)?.costUsd > 0], ["branch", true]);
check(
  "L5b a subagent naming the PR is costed",
  [row(101)?.costBasis, row(101)?.costUsd > 0],
  ["mention", true],
);
check("L6 no transcripts: null, never 0", [row(103)?.costUsd, row(103)?.costBasis], [null, "none"]);
check("lines, type and host", pick(row(102), ["lines", "files", "type", "host", "mergeSha"]), {
  lines: 650,
  files: 9,
  type: "fix",
  host: "pc",
  mergeSha: "bbbb222bbbb222bbbb222bbbb222bbbb222bbbb2",
});
{
  const two = run(["--since", "2026-10-20", "--fixture", FIX, "--json"]);
  const again = JSON.parse(two.stdout || "[]");
  check("L4b deterministic: a rerun gives the same rows", again, rows);
}
check(
  "L7 the newest row per PR wins",
  latestByPr([
    { pr: 1, computedAt: "2026-10-28T01:00:00Z", costUsd: null },
    { pr: 1, computedAt: "2026-10-28T02:00:00Z", costUsd: 3 },
    { pr: 2, computedAt: "2026-10-28T01:00:00Z" },
  ]).map((r) => [r.pr, r.costUsd ?? null]),
  [
    [1, 3],
    [2, null],
  ],
);
check(
  "L8 a missing source exits 1 and names it",
  run(["--pr", "1", "--fixture", path.join(FIX, "nope")]).status,
  1,
);
check(
  "usage: --pr and --since together exit 2",
  run(["--pr", "1", "--since", "2026-10-01"]).status,
  2,
);
check("usage: unknown flag exits 2", run(["--nope"]).status, 2);
check(
  "a board line for another PR is ignored",
  reviewOf(102, [{ body: "**#101 @ abc1234: PASS.**" }]).reviewRounds,
  null,
);
check(
  "an unknown trailer route falls back to the branch",
  routeOf({ headRefName: "bug/x", commits: [{ messageBody: "Factory-Route: vibes" }] }),
  {
    route: "bug-pipeline",
    routeBasis: "inferred",
  },
);

console.log(`landing-telemetry self-test: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
