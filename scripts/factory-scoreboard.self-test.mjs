#!/usr/bin/env node
// Self-test for scripts/factory-scoreboard.mjs. Plain node: `node scripts/factory-scoreboard.self-test.mjs`.
//
// Every case runs the script as a child process against a fixture directory under
// scripts/fixtures/factory-scoreboard/ (fixed "now" 2026-10-25T12:00:00Z, so ages are exact), so no
// `gh`, `git` or network is touched. Cases that write copy the fixture into the OS temp dir first.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "factory-scoreboard.mjs");
const FIX = path.join(HERE, "fixtures", "factory-scoreboard");

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
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 30_000 });
const json = (fixture, extra = []) => {
  const res = run(["--fixture", path.join(FIX, fixture), "--json", ...extra]);
  if (res.status !== 0) throw new Error(`exit ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout);
};
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

const tmpDirs = [];
const copyFixture = (name) => {
  const d = mkdtempSync(path.join(tmpdir(), "factory-scoreboard-"));
  tmpDirs.push(d);
  cpSync(path.join(FIX, name), d, { recursive: true });
  return d;
};

// 1. default 7-day window: feat/fix/other split, reverts and hotfix titles fail PRs, nothing is 14 days old yet
const base = json("base");
const w = base.verifiedMerges.window;
check(
  "A1 window is the 7 days before the fixed now",
  base.window.since,
  "2026-10-18T12:00:00.000Z",
);
check("A2 feat/fix/other split by title prefix", pick(w, ["total", "feat", "fix", "other"]), {
  total: 9,
  feat: 2,
  fix: 4,
  other: 3,
});
check(
  "A3 a revert by number (104), a 'hotfix:' title naming #105 and a 'fix(hotfix):' title naming #101 count as failed; the rest is pending",
  [w.failed, w.failedNumbers, w.pending, w.verified],
  [3, [101, 104, 105], 6, 0],
);
check(
  "A4 a hotfix PR (108, 109) is not failed by itself",
  w.failedNumbers.includes(108) || w.failedNumbers.includes(109),
  false,
);

// 2. the window that ended 14 days ago is verified by age; a title-only revert (no number) fails 203
const p = base.verifiedMerges.priorWindow;
check(
  "B1 prior window: verified by age, 203 failed by an exact-title revert",
  [p.from.slice(0, 10), p.to.slice(0, 10), p.verified, p.failed, p.failedNumbers],
  ["2026-10-04", "2026-10-11", 2, 1, [203]],
);
check("B2 a PR between the two windows (204) is in neither", [w.total, p.total], [9, 3]);

// 3. pending vs verified by age: a 30-day window reaches PRs older than 14 days
const wide = json("base", ["--since", "2026-09-25T12:00:00Z", "--usage-pct", "30"]);
const ww = wide.verifiedMerges.window;
check(
  "C1 30-day window: 201/202 verified by age, 203 failed, 204 (11 days) pending",
  [ww.verified, ww.failed, ww.total],
  [2, 4, 13],
);
check(
  "C2 usage-pct divides by the 14-day-old cohort's verified count (30 / 2)",
  wide.allowance.perVerifiedMerge,
  15,
);
const withPct = json("base", ["--usage-pct", "30"]);
check(
  "C3 the default 7-day window has 0 verified, yet the allowance divides by the older cohort (2), not n/a",
  [w.verified, withPct.allowance.verified, withPct.allowance.perVerifiedMerge],
  [0, 2, 15],
);
check(
  "C4 without --usage-pct the table says not supplied",
  [base.allowance.supplied, /not supplied/.test(run(["--fixture", path.join(FIX, "base")]).stdout)],
  [false, true],
);
const empty = json("base", ["--since", "2026-10-23", "--usage-pct", "30"]);
check(
  "C5 an empty cohort (no PR in the 14-day-old window) is n/a, not a division",
  [empty.allowance.verified, empty.allowance.perVerifiedMerge],
  [0, null],
);
const mdPct = run(["--fixture", path.join(FIX, "base"), "--usage-pct", "30"]).stdout;
check(
  "C6 the table labels the cohort the allowance was divided by",
  /\| 3 \| Allowance per verified merge \(usage % over the 14-day-old cohort\) \| 15% per verified merge \(30% used \/ 2 verified in the 14-day-old cohort, 2026-10-04 to 2026-10-11\)/.test(
    mdPct,
  ),
  true,
);

// 3b. train/* PRs are reported apart; "revert" inside a sentence is not a revert
check(
  "H1 train/* PRs (301, 302) are excluded from the counts and reported separately",
  [w.trains, p.trains, w.total, p.total],
  [1, 1, 9, 3],
);
check(
  "H2 'revert' mid-sentence (a commit) and 'hotfix' mid-sentence (PR 107) both naming #102 do not fail it",
  w.failedNumbers.includes(102),
  false,
);
for (const [limit, status] of [
  ["15", 1],
  ["16", 0],
]) {
  const ldir = copyFixture("base");
  writeFileSync(path.join(ldir, "limit.txt"), `${limit}\n`);
  const res = run(["--fixture", ldir]);
  check(
    `H3 a query returning exactly the limit (${limit} of 15 rows) ${status ? "fails loudly" : "does not fail when under it"}`,
    [res.status, status ? /truncated/.test(res.stderr) : /Factory scoreboard/.test(res.stdout)],
    [status, true],
  );
}

// 4. escapes
check("D1 no causedByPr field anywhere: not instrumented", base.escapes, {
  instrumented: false,
  reason: "no causedByPr field yet",
});
check(
  "D2 not instrumented text is printed in the table",
  /not instrumented \(no causedByPr field yet\)/.test(
    run(["--fixture", path.join(FIX, "base")]).stdout,
  ),
  true,
);
const inst = json("instrumented");
check(
  "D3 without risk-paths, escapes group by severity and skip rows outside the window",
  inst.escapes,
  {
    instrumented: true,
    groupedBy: "severity",
    total: 3,
    groups: { high: ["B901", "B903"], low: ["B902"] },
  },
);
const cls = json("classified");
check(
  "D4 with risk-paths.mjs ({ cls }), escapes take the max class over the causing PR's files, not the location; no diff = unclassified",
  cls.escapes.groups,
  { amber: ["B902"], red: ["B901"], unclassified: ["B903"] },
);
const out = [
  run(["--fixture", path.join(FIX, "instrumented")]).stdout,
  run(["--fixture", path.join(FIX, "instrumented"), "--json"]).stdout,
].join("\n");
check("D5 bug titles never appear in the output", /SECRET TITLE/.test(out), false);

// 5. unsourced numbers say so
check(
  "E1 owner-blocked hours and release ETA are not instrumented",
  [base.ownerBlockedHours, base.releaseEtaHitRate],
  ["not instrumented", "not instrumented"],
);

// 6. exposure
check(
  "F1 unclosed windows: bounded by a dead-man flip (50 min) or by the next start (1440 min), else duration unknown and kept out of longest",
  base.exposure.watchdog,
  {
    windows: 3,
    longestMinutes: 1440,
    unclosed: [
      { armedAt: "2026-10-21T06:00Z", boundMinutes: 50, boundedBy: "dead-man flip" },
      { armedAt: "2026-10-23T09:00Z", boundMinutes: 1440, boundedBy: "next watchdog start" },
      { armedAt: "2026-10-25T08:00Z", boundMinutes: null, boundedBy: null },
    ],
  },
);
const late = json("base", ["--since", "2026-10-24T00:00:00Z"]).exposure.watchdog;
check(
  "F5 only windows armed inside the report window count; an unbounded one never enters longest",
  [late.windows, late.longestMinutes, late.unclosed.map((u) => [u.armedAt, u.boundMinutes])],
  [1, 30, [["2026-10-25T08:00Z", null]]],
);
const rowF = run(["--fixture", path.join(FIX, "base")]).stdout;
check(
  "F6 the exposure row says 'duration unknown (armed ...)' for the unbounded window and gives bounds for the others",
  [
    /duration unknown \(armed 2026-10-25T08:00Z\)/.test(rowF),
    /armed 2026-10-21T06:00Z, up to 50 min \(dead-man flip\)/.test(rowF),
    /armed 2026-10-23T09:00Z, up to 1440 min \(next watchdog start\)/.test(rowF),
    /at least/.test(rowF),
  ],
  [true, true, true, false],
);
check(
  "F2 dead-man: flipped-private and flip-unconfirmed counted apart; not-admin is a health warning, not an incident",
  base.exposure.deadman,
  { flippedPrivate: 1, flipUnconfirmed: 1, otherIncidents: 1, notAdminPolls: 3, undated: 0 },
);
check(
  "F7 the row shows not-admin as a warning rather than adding it to incidents",
  [/1 flipped private, 1 flip unconfirmed/.test(rowF), /WARNING: 3 not-admin polls/.test(rowF)],
  [true, true],
);
const nolog = json("nologs");
check(
  "F3 missing logs are reported as missing, not zero",
  [nolog.exposure.watchdog, nolog.exposure.deadman],
  [null, null],
);
const nologMd = run(["--fixture", path.join(FIX, "nologs")]).stdout;
check(
  "F4 the table says both logs are missing",
  [/watchdog log missing/.test(nologMd), /dead-man log missing/.test(nologMd)],
  [true, true],
);

// 7. flags: validated before any side effect, and --write saves the table
const wdir = copyFixture("base");
for (const bad of [
  ["--bogus"],
  ["--usage-pct", "abc"],
  ["--usage-pct", "101"],
  ["--since", "not-a-date"],
  ["--since"],
  ["--since", "--json"],
]) {
  const res = run(["--fixture", wdir, "--write", ...bad]);
  check(
    `G1 ${bad.join(" ")} exits 2 with usage`,
    [res.status, /usage:/.test(res.stderr)],
    [2, true],
  );
}
check("G2 bad flags wrote nothing", existsSync(path.join(wdir, "local-assets")), false);
const help = run(["--help"]);
check("G3 --help exits 0", [help.status, /usage:/.test(help.stdout)], [0, true]);
const wrote = run(["--fixture", wdir, "--write"]);
const file = path.join(wdir, "local-assets", "scoreboard", "2026-10-25.md");
check(
  "G4 --write saves local-assets/scoreboard/<date>.md",
  [wrote.status, existsSync(file)],
  [0, true],
);
check(
  "G5 the saved file is the printed table",
  readFileSync(file, "utf8").trimEnd(),
  wrote.stdout.trimEnd(),
);

for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
console.log(`factory-scoreboard self-test: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
