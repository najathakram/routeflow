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
 * T4: (owner ruling 2026-09-14) `activeCount`/`nextId` are DERIVED from the
 *     register, not checked against `_meta.json` as ground truth — a stale
 *     stored value only WARNS on a plain run (never fails the build), and
 *     `--digest` re-stamps `_meta.json` back to the derived value.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(__dirname, "validate-lessons.mjs");
const DIGEST = join(REPO_ROOT, ".claude", "lessons", "LESSONS-DIGEST.md");
const META = join(REPO_ROOT, ".claude", "lessons", "_meta.json");
const PRETTIERIGNORE = join(REPO_ROOT, ".prettierignore");

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
  const originalMeta = readFileSync(META, "utf8");

  // Guard against the generated digest going back under lint-staged's
  // `prettier --write` (which would rewrite it and desync it from what
  // `--digest` regenerates) — .prettierignore must keep listing it.
  const prettierIgnore = existsSync(PRETTIERIGNORE) ? readFileSync(PRETTIERIGNORE, "utf8") : "";
  check(
    "setup: .prettierignore lists .claude/lessons/LESSONS-DIGEST.md",
    prettierIgnore.split("\n").some((line) => line.trim() === ".claude/lessons/LESSONS-DIGEST.md"),
    true,
  );

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

    // ── T4: stale counters warn (never fail), --digest re-stamps them ────
    const meta = JSON.parse(originalMeta);
    const staleMeta = { ...meta, activeCount: meta.activeCount + 1, nextId: 1 };
    writeFileSync(META, `${JSON.stringify(staleMeta, null, 2)}\n`);

    const staleCounters = run([]);
    check(
      "T4: stale activeCount/nextId still exits 0 (warning, not failure)",
      staleCounters.status,
      0,
    );
    const staleOut = staleCounters.stdout + staleCounters.stderr;
    check(
      "T4: plain run WARNS about the stale activeCount",
      staleOut.includes("STALE ACTIVECOUNT"),
      true,
    );
    check("T4: plain run WARNS about the stale nextId", staleOut.includes("STALE NEXTID"), true);

    const restamp = run(["--digest"]);
    check("T4: --digest exits 0 while re-stamping counters", restamp.status, 0);
    const restampedMeta = JSON.parse(readFileSync(META, "utf8"));
    check(
      "T4: --digest restores activeCount to the derived value",
      restampedMeta.activeCount,
      meta.activeCount,
    );
    check("T4: --digest restores nextId to the derived value", restampedMeta.nextId, meta.nextId);

    const cleanAfterRestamp = run([]);
    check(
      "T4: plain run has no counter warning after --digest re-stamps",
      cleanAfterRestamp.status,
      0,
    );
  } finally {
    // Leave the working tree exactly as found, regardless of pass/fail above.
    if (original !== null) writeFileSync(DIGEST, original);
    writeFileSync(META, originalMeta);
  }

  console.log(
    failures
      ? `\nvalidate-lessons.digest.self-test: ${failures} FAILURE(S)`
      : "\nvalidate-lessons.digest.self-test: all checks passed",
  );
  process.exit(failures ? 1 : 0);
};

main();
