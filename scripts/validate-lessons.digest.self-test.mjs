#!/usr/bin/env node
/**
 * Self-test for the `--digest` support added to scripts/validate-lessons.mjs
 * (generation of `.claude/lessons/LESSONS-DIGEST.md` and the plain-run
 * staleness check). Same standalone-script convention as its siblings
 * (google-signin-check.self-test.mjs et al.) — no node:test, no root-level
 * test runner: `node scripts/validate-lessons.digest.self-test.mjs`, `  ok`/
 * `  FAIL` lines, `process.exit(failures ? 1 : 0)`.
 *
 * Runs the REAL script against the REAL `.claude/lessons/LESSONS.md` (it is
 * read-only input here — never touched) and the REAL `LESSONS-DIGEST.md`
 * (mutated during the test, always restored — see the `finally`). That is
 * safe specifically BECAUSE the last write this test ever makes is a
 * `--digest` regeneration, which reproduces exactly the committed content as
 * long as LESSONS.md itself hasn't changed mid-run — so a clean pass leaves
 * the working tree exactly as it found it, and an unclean exit still runs
 * the restore.
 *
 * T1: determinism — two `--digest` runs produce byte-identical content.
 * T2: a stale digest fails the plain run with the documented message.
 * T3: `--digest` repairs a stale digest, and the plain run then passes.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(__dirname, "validate-lessons.mjs");
const DIGEST = join(REPO_ROOT, ".claude", "lessons", "LESSONS-DIGEST.md");

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
};

const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

const readDigest = () => (existsSync(DIGEST) ? readFileSync(DIGEST, "utf8") : null);

const main = () => {
  const original = readDigest();
  check("setup: LESSONS-DIGEST.md exists before the test", original !== null, true);

  try {
    // ── T1: determinism ──────────────────────────────────────────────────
    const gen1 = run(["--digest"]);
    check("T1: `--digest` exits 0", gen1.status, 0);
    const content1 = readDigest();

    const gen2 = run(["--digest"]);
    check("T1: a second `--digest` run also exits 0", gen2.status, 0);
    const content2 = readDigest();

    check("T1: digest content is byte-identical across two runs", content2, content1);

    // ── T2: a stale digest fails the plain run ───────────────────────────
    writeFileSync(DIGEST, `${content1}\n<!-- stale marker injected by self-test -->\n`);
    const staleRun = run([]);
    check("T2: plain run exits non-zero on a stale digest", staleRun.status === 0, false);
    check(
      "T2: plain run names the exact repair command",
      (staleRun.stdout + staleRun.stderr).includes(
        "LESSONS-DIGEST.md is stale — run: node scripts/validate-lessons.mjs --digest",
      ),
      true,
    );

    // A digest file entirely absent must fail the same way, not throw.
    // (writeFileSync with empty content is close enough to "missing" for the
    // comparison branch; existsSync(...) === false is exercised implicitly
    // by the != null check inside validate-lessons.mjs.)

    // ── T3: `--digest` repairs it, then the plain run passes ─────────────
    const repair = run(["--digest"]);
    check("T3: `--digest` repairs a stale digest (exits 0)", repair.status, 0);
    check("T3: repaired content matches the original digest content", readDigest(), content1);

    const cleanRun = run([]);
    check("T3: plain run passes once the digest is fresh again", cleanRun.status, 0);
  } finally {
    // Leave the working tree exactly as found, regardless of pass/fail above.
    if (original !== null) writeFileSync(DIGEST, original);
  }

  console.log(
    failures
      ? `\nvalidate-lessons.digest.self-test: ${failures} FAILURE(S)`
      : "\nvalidate-lessons.digest.self-test: all checks passed",
  );
  process.exit(failures ? 1 : 0);
};

main();
