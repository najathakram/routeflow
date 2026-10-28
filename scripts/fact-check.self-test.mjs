#!/usr/bin/env node
// Self-test for scripts/fact-check.mjs. Plain node: `node scripts/fact-check.self-test.mjs`.
//
// Every case in scripts/fixtures/fact-check/cases.json is a real lead failure (LEAD-LOG line in its `log`), checked
// against the gh/git/clock truth stored beside it, so no gh, git or network is touched. Three cases also run the CLI as
// a child process to pin the exit codes.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkFacts, fixtureSources, prsFromGraphql } from "./fact-check.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "fact-check.mjs");
const FIXTURE = path.join(HERE, "fixtures", "fact-check", "cases.json");
const DATA = JSON.parse(readFileSync(FIXTURE, "utf8"));

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

for (const c of DATA.cases) {
  const { hits, unverified } = checkFacts(c.message, fixtureSources(DATA, c));
  check(
    `${c.id} ${c.log}`,
    hits.map((h) => [h.kind, h.token]),
    c.hits,
  );
  if (c.unverified)
    check(
      `${c.id} unverified`,
      unverified.map((u) => [u.kind, u.token]),
      c.unverified,
    );
}

// Every hit names the truth, so the lead's correction is a copy, not a search.
{
  const t1 = DATA.cases.find((c) => c.id === "T1");
  const [hit] = checkFacts(t1.message, fixtureSources(DATA, t1)).hits;
  check(
    "T1 truth names the head and the pending checks",
    /4ab859771/.test(hit?.truth) && /Verify/.test(hit?.truth),
    true,
  );
}

// gh exits 1 when one number does not exist but still returns the others: that answer is used (code review M1).
{
  const partial = JSON.stringify({
    data: {
      repository: {
        p3740: {
          __typename: "PullRequest",
          state: "MERGED",
          headRefOid: "a1b2c3d",
          mergeCommit: { oid: "2cc4f3e15" },
          commits: { nodes: [] },
        },
        p99999: null,
      },
    },
    errors: [{ type: "NOT_FOUND", path: ["repository", "p99999"] }],
  });
  const prs = prsFromGraphql(partial, ["3740", "99999"]);
  check("partial NOT_FOUND keeps the found PR", prs?.["3740"]?.mergeCommit, "2cc4f3e15");
  check("partial NOT_FOUND marks the missing number absent", prs && !("99999" in prs), true);
  const live = { ...fixtureSources(DATA, { now: "2026-10-28T05:05:00Z" }), prs };
  check(
    "so a missing number is a mismatch",
    checkFacts("#3740 and #99999 landed", live).hits.map((h) => h.token),
    ["#99999"],
  );
  check(
    "any other gh error is unavailable",
    prsFromGraphql(JSON.stringify({ errors: [{ type: "RATE_LIMITED" }] }), ["1"]),
    null,
  );
}

const cli = (args, input) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: "utf8", timeout: 30_000 });
{
  const r = cli(["--fixture", FIXTURE, "--case", "T1"]);
  check("CLI T1 exits 1", r.status, 1);
  check("CLI T1 prints the bad token", /MISMATCH ready #3893/.test(r.stdout), true);
}
check("CLI T5 exits 0", cli(["--fixture", FIXTURE, "--case", "T5"]).status, 0);
check("CLI unknown flag exits 2", cli(["--nope"]).status, 2);
{
  const r = cli(["--fixture", FIXTURE, "--case", "T8", "--json"]);
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    parsed = null;
  }
  check(
    "CLI --json carries the hits",
    parsed?.hits?.map((h) => h.token),
    ["631d718de"],
  );
}

console.log(`fact-check self-test: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
