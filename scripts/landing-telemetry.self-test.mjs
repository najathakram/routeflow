#!/usr/bin/env node
// Self-test for scripts/landing-telemetry.mjs (R1-b). Plain node: `node scripts/landing-telemetry.self-test.mjs`.
// Runs the script against scripts/fixtures/landing-telemetry/base (gh PRs, board comments and a fake transcript dir),
// so no gh, git or network is touched and nothing is written.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { latestByPr, reviewOf, reworkOf, routeOf, verdictOf } from "./landing-telemetry.mjs";

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
check(
  "L5 branch lines inside the window are costed; a line 1 h after the merge is not ($5 of Haiku left out)",
  [row(102)?.costBasis, row(102)?.costUsd],
  ["branch", 0.204],
);
check(
  "L5b subagents naming exactly #101 (or its branch) are costed, a builder before the PR opened included ($1); " +
    "one naming #1010 ($7) or #101 and #102 together ($9) is not",
  [row(101)?.costBasis, row(101)?.costUsd],
  ["mention", 1.102],
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
{
  const r = run(["--pr", "1", "--fixture", path.join(FIX, "nope")]);
  check(
    "L8 a missing source exits 1, says so and writes nothing",
    [r.status, /a source failed, nothing written/.test(r.stderr)],
    [1, true],
  );
}
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

// Real board head shapes (numbers and shas changed), review MUST 1.
const V = (body) => {
  const v = verdictOf(body);
  return v && [v.pr, v.sha, v.pass];
};
check(
  "V1 slot then verdict",
  V("**PASS 2 · #3770 @ 02eb434bcfd3d5ff · PASS WITH NOTES** — reviewer"),
  [3770, "02eb434", true],
);
check(
  "V2 slot (re-run), FAIL last",
  V("**PASS 2 (re-run) · #3768 @ d8b28bbffbad4356 · FAIL** (gates run at fd1474fe0)"),
  [3768, "d8b28bb", false],
);
check("V3 reviewer prefix, backticked sha", V("**review-a · #3874 re-pin · PASS @ `38308c1…`**"), [
  3874,
  "38308c1",
  true,
]);
check(
  "V4 heading form",
  V("## PASS 2 of 2 · #3791 (row 380) @ 0b1689bbaf52 · **PASS WITH NOTES**"),
  [3791, "0b1689b", true],
);
check(
  "V5 'at' instead of @",
  V("**PASS 1 of 2 — #3806 at 478062630938: PASS WITH NOTES** (review-b)"),
  [3806, "4780626", true],
);
check("V6 no sha: still a verdict", V("## T2 review PASS — PR #3899"), [3899, null, true]);
check("V7 a slot name alone is no verdict", V("**#3701 PASS 1 delta re-pin @ abc1234**"), null);
check(
  "V8 a delta re-read with its verdict after it",
  V("**#3819 @ 99e28362e — PASS 1 delta re-read (from 15147456e) — code + mutation: PASS.**"),
  [3819, "99e2836", true],
);
check(
  "V9 DB lane, UX score, SA ruling and follow-ups are not code reviews",
  [
    V("**DB lane: #3821 @ 575bbdbb662d (`src/orders`): PASS, exit 0**"),
    V("**#3767 @8f154e10c66b · W-806 copy · apple-ux + W-785 (mm-ux, judge-only): PASS, 96.5%**"),
    V("**SA-995 · #3726 @ 26186d5c3 (row 632): the fix shape for PASS 2's MUST.**"),
    V("**#3821 @ 575bbdbb6 — MacBook main follow-up:** the DB lane closes my PENDING"),
  ],
  [null, null, null, null],
);
check(
  "V9b verdict in bold on the next line, after a heading that names the PR and sha",
  V(
    "## review-c verdict: #3762 at `c70d92b3f5aa` (tier 1, PASS 1)\n\n**PASS WITH NOTES.** The PR changes two files.",
  ),
  [3762, "c70d92b", true],
);
check(
  "V9c bold FAIL on line 3, after an intro line",
  V(
    "## review-c delta verdict: #3756 at `d70bbcf70a11`\nRe-read after the fix commit.\n**FAIL.** Both prior MUSTs stand.",
  ),
  [3756, "d70bbcf", false],
);
check(
  "V9d HOLD is a verdict that did not pass",
  V("**#3790 @ 1234abcd · HOLD** until the DB lane runs"),
  [3790, "1234abc", false],
);
check(
  "V9e a heading with no verdict anywhere is no verdict",
  V("## review-c notes: #3762 at `c70d92b3f5aa`\nStill reading."),
  null,
);
check(
  "V10 #3874 is read whole, never as #387",
  reviewOf(387, [{ body: "**PASS 2 · #3874 @ abcdef12 · PASS**" }]).reviewRounds,
  null,
);
check(
  "V11 two reviewers at one sha are one round; first round all PASS",
  pick(
    reviewOf(3770, [
      { body: "**PASS 1 · #3770 @ 02eb434bc · PASS**" },
      { body: "**PASS 2 · #3770 @ 02eb434bc · PASS WITH NOTES**" },
    ]),
    ["reviewRounds", "firstPass"],
  ),
  { reviewRounds: 1, firstPass: true },
);
check(
  "V12 a FAIL in the first round is not first-pass even if another reviewer passed it",
  pick(
    reviewOf(3770, [
      { body: "**PASS 1 · #3770 @ 02eb434bc · PASS**" },
      { body: "**PASS 2 · #3770 @ 02eb434bc · FAIL**" },
      { body: "**PASS 2 · #3770 @ 9999aaa11 · PASS**" },
    ]),
    ["reviewRounds", "firstPass"],
  ),
  { reviewRounds: 2, firstPass: false },
);

// Rework inference, review SHOULD: a stacked feature, an issue fix and a trailer are not rework.
check(
  "W1 'from the #3869 review', 'Fixes #2554' and Bookkeeping-Follow-Up are not rework",
  reworkOf({
    number: 3874,
    title: "feat(ops): next step",
    body: "Fix from the #3869 review.\nFixes #2554\nBookkeeping-Follow-Up: pending",
  }),
  { reworkOf: null, reworkBasis: "none" },
);
check(
  "W2 a body that says it reverts #3800 is rework",
  reworkOf({ number: 3900, title: "chore: x", body: "Reverts #3800." }),
  { reworkOf: 3800, reworkBasis: "inferred" },
);

// Per-host cost merge, review MUST 4.
{
  const merged = latestByPr([
    {
      pr: 7,
      host: "pc",
      computedAt: "2026-10-28T01:00:00Z",
      costUsd: 8.53,
      costBasis: "branch",
      lines: 10,
    },
    {
      pr: 7,
      host: "macmini",
      computedAt: "2026-10-28T02:00:00Z",
      costUsd: 2,
      costBasis: "mention",
      lines: 10,
    },
    {
      pr: 7,
      host: "pc",
      computedAt: "2026-10-29T01:00:00Z",
      costUsd: null,
      costBasis: "none",
      lines: 12,
    },
  ])[0];
  check(
    "M1 a later null re-run keeps the measured cost; hosts add up; gh facts from the newest row",
    pick(merged, ["costUsd", "costHosts", "lines", "costBasis"]),
    { costUsd: 10.53, costHosts: { macmini: 2, pc: 8.53 }, lines: 12, costBasis: "mention" },
  );
  check(
    "M2 no costed row: cost stays null",
    latestByPr([{ pr: 8, computedAt: "x", costUsd: null }])[0].costUsd ?? null,
    null,
  );
}

console.log(`landing-telemetry self-test: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
