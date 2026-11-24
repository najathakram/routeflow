#!/usr/bin/env node
/**
 * Self-test for scripts/ci-lanes.mjs (SA-1250, PR-1): the lane table, the parity rule, the exclusion list
 * derived from the db/smtp jest configs, and the parity job beside today's single Verify.
 * Pure: no jest, no network (the parity input is injected).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LANES, NOT_IN_VERIFY, parityCheck } from "./ci-lanes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const ci = readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
const ciCode = ci.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
let total = 0;
let failures = 0;
const check = (name, got, want) => {
  total++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
};
const has = (r, s) => r.problems.join("|").includes(s);

// -- parity: a spec file must be in exactly one lane (T4, P3) ------------------------------------
const expected = ["a.spec.ts", "b.spec.ts", "c.spec.ts", "d.spec.ts"];
const lanes = { u1: ["a.spec.ts", "b.spec.ts"], u2: ["c.spec.ts", "d.spec.ts"] };
check("PA1 every file in exactly one lane is green", parityCheck({ expected, lanes }).ok, true);
const lost = parityCheck({ expected: [...expected, "x.check.ts"], lanes });
check(
  "PA2 T4: a file no lane lists is red and named",
  [lost.ok, has(lost, "x.check.ts")],
  [false, true],
);
const dropShard = parityCheck({ expected, lanes: { u1: lanes.u1 } });
check(
  "PA3 P3: a removed shard leaves its files in zero lanes, named",
  [dropShard.ok, has(dropShard, "c.spec.ts"), has(dropShard, "d.spec.ts")],
  [false, true, true],
);
const twice = parityCheck({
  expected,
  lanes: { u1: ["a.spec.ts", "b.spec.ts", "c.spec.ts"], u2: ["c.spec.ts", "d.spec.ts"] },
});
check(
  "PA4 a file in two lanes is red and names both lanes",
  [twice.ok, has(twice, "c.spec.ts"), has(twice, "u1"), has(twice, "u2")],
  [false, true, true, true],
);
check(
  "PA5 a lane file that nothing expects is red (stale config)",
  parityCheck({ expected, lanes: { ...lanes, u3: ["zz.spec.ts"] } }).ok,
  false,
);

// -- M1 (R-24): a file the exclusion matches may not be expected or run by any lane ------------------
const widened = [new RegExp(".*\.(db|service)\.spec\.ts$")]; // a db config widened to eat service specs
const probe = ["a.spec.ts", "orders.service.spec.ts"];
const wide = parityCheck({ expected: probe, lanes: { u1: probe }, excluded: widened });
check(
  "EX1 a widened exclusion that also matches a lane's file is red and names the file",
  [wide.ok, has(wide, "orders.service.spec.ts")],
  [false, true],
);
check(
  "EX2 a widened exclusion that matches a file only expected (no lane runs it) is red too",
  parityCheck({ expected: probe, lanes: { u1: ["a.spec.ts"] }, excluded: widened }).ok,
  false,
);
check(
  "EX3 the real exclusion regexes leave a clean lane set green",
  parityCheck({ expected: ["a.spec.ts"], lanes: { u1: ["a.spec.ts"] }, excluded: NOT_IN_VERIFY })
    .ok,
  true,
);

// -- the lane table --------------------------------------------------------------------------------
check("LT1 eight lanes, ids unique", [LANES.length, new Set(LANES.map((l) => l.id)).size], [8, 8]);
check(
  "LT2 one chain lane, three api-unit shards of 3",
  [
    LANES.filter((l) => l.id === "chain").length,
    LANES.filter((l) => /^api-unit-\d\/3$/.test(l.id)).length,
  ],
  [1, 3],
);

// -- NOT_IN_VERIFY is derived from the db and smtp configs, never typed (A1-3 a) -------------------
const cfgRegex = (f) => require(path.join(ROOT, "apps", "api", f)).testRegex;
check(
  "ND1 the exclusion regexes are the db and smtp configs' own testRegex, in that order",
  NOT_IN_VERIFY.map((r) => r.source),
  [cfgRegex("jest.db.config.js"), cfgRegex("jest.smtp.config.js")],
);
const tracked = spawnSync("git", ["ls-files", "apps/api/src"], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 1 << 26,
})
  .stdout.split(/\r?\n/)
  .filter(Boolean);
const excludedCount = tracked.filter((f) => NOT_IN_VERIFY.some((r) => r.test(f))).length;
check(
  "ND2 the derived exclusion matches the suffix rule's files (no derived-only or typed-only file)",
  excludedCount,
  tracked.filter((f) => /\.(db|smtp)\.spec\.ts$/.test(f)).length,
);
// Moves only with the db/smtp spec set: update it in the same PR that adds or removes one of those specs.
check(
  "ND3 count pin: 550 spec files are outside Verify by the db/smtp configs",
  excludedCount,
  550,
);

// -- ci.yml wiring: a parity job BESIDE today's single Verify, nothing else moved ------------------
const job = (name) => {
  const s = ciCode.findIndex((l) => new RegExp(`^  ${name}:\\s*$`).test(l));
  if (s < 0) return "";
  let e = s + 1;
  while (e < ciCode.length && (ciCode[e].trim() === "" || /^ {3,}/.test(ciCode[e]))) e++;
  return ciCode.slice(s, e).join("\n");
};
check(
  "WI1 parity installs and runs --parity",
  [/npm ci/.test(job("parity")), /ci-lanes\.mjs --parity/.test(job("parity"))],
  [true, true],
);
check(
  "WI2 today's single Verify job is untouched (still named Verify, still runs npm run verify)",
  [/^\s{4}name: Verify\s*$/m.test(job("verify")), /npm run verify/.test(job("verify"))],
  [true, true],
);
check(
  "WI3 PR-1 changes no trigger: paths-ignore is still there",
  ciCode.filter((l) => /^\s+paths-ignore:/.test(l)).length,
  1,
);
check(
  "WI4 parity carries the same drafts-and-dependabot skip as Verify",
  [/draft != true/.test(job("parity")), /dependabot\[bot\]/.test(job("parity"))],
  [true, true],
);

console.log(`ci-lanes self-test: ${total - failures} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
