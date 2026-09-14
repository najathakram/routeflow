#!/usr/bin/env node
/**
 * Self-test for the `--digest` support in scripts/validate-lessons.mjs
 * (generation of `.claude/lessons/LESSONS-DIGEST.md`, the plain-run
 * staleness check, and the nextId floor added in the F4 fix round). Same
 * standalone-script convention as its siblings — no node:test, no
 * root-level test runner: `  ok`/`  FAIL` lines, `process.exit(failures ? 1
 * : 0)`.
 *
 * Every case runs against a SANDBOXED COPY of `.claude/lessons/` in a
 * scratch temp dir (F3) — `validate-lessons.mjs` is pointed at it via the
 * `LESSONS_ROOT` env var it now supports. The real register is read-only
 * for this self-test: previously T4 wrote `nextId: 1` straight into the
 * real `.claude/lessons/_meta.json` (restored in a `finally`, but a SIGINT
 * or a concurrent `npm run verify` between the write and the restore could
 * corrupt the live register). Copying once up front and deleting the whole
 * scratch dir in `finally` removes that window entirely.
 *
 * T1: determinism — two `--digest` runs produce byte-identical content.
 * T2: a stale digest fails the plain run with the documented message.
 * T3: `--digest` repairs a stale digest, and the plain run then passes.
 * T4: (owner ruling 2026-09-14) `activeCount` is DERIVED from the register,
 *     not checked against `_meta.json` as ground truth — a stale stored
 *     value only WARNS on a plain run (never fails the build), and
 *     `--digest` re-stamps `_meta.json` back to the derived value. A
 *     RESERVED `nextId` (stored higher than max + 1 — an open branch
 *     already claimed those ids) WARNS the same way and `--digest`
 *     PRESERVES it rather than un-reserving it.
 * T5: (F4) a hand-LOWERED `nextId` (stored below max + 1) is a hard
 *     FAILURE, not a warning — a future duplicate id waiting to happen —
 *     and `--digest` refuses to write anything while it fails.
 */
import { readFileSync, existsSync, writeFileSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(__dirname, "validate-lessons.mjs");
const REAL_LESSONS_DIR = join(REPO_ROOT, ".claude", "lessons");
const PRETTIERIGNORE = join(REPO_ROOT, ".prettierignore");

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
};

const main = () => {
  // Guard against the generated digest going back under lint-staged's
  // `prettier --write` — checked against the REAL .prettierignore (read
  // only, never mutated) since that file lives at the repo root regardless
  // of which lessons directory is under test.
  const prettierIgnore = existsSync(PRETTIERIGNORE) ? readFileSync(PRETTIERIGNORE, "utf8") : "";
  check(
    "setup: .prettierignore lists .claude/lessons/LESSONS-DIGEST.md",
    prettierIgnore.split("\n").some((line) => line.trim() === ".claude/lessons/LESSONS-DIGEST.md"),
    true,
  );

  let scratchRoot;
  try {
    // Sandbox: a disposable copy of .claude/lessons/, never the real one.
    scratchRoot = mkdtempSync(join(tmpdir(), "validate-lessons-self-test-"));
    const lessonsDir = join(scratchRoot, "lessons");
    cpSync(REAL_LESSONS_DIR, lessonsDir, { recursive: true });

    const env = { ...process.env, LESSONS_ROOT: lessonsDir };
    const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
    const DIGEST = join(lessonsDir, "LESSONS-DIGEST.md");
    const META = join(lessonsDir, "_meta.json");
    const readDigest = () => (existsSync(DIGEST) ? readFileSync(DIGEST, "utf8") : null);

    const original = readDigest();
    check("setup: LESSONS-DIGEST.md exists before the test", original !== null, true);
    const originalMeta = readFileSync(META, "utf8");
    const meta = JSON.parse(originalMeta);

    // ── T1: determinism ────────────────────────────────────────────────
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

    // ── T3: `--digest` repairs it, then the plain run passes ─────────────
    const repair = run(["--digest"]);
    check("T3: `--digest` repairs a stale digest (exits 0)", repair.status, 0);
    check("T3: repaired content matches the original digest content", readDigest(), content1);

    const cleanRun = run([]);
    check("T3: plain run passes once the digest is fresh again", cleanRun.status, 0);

    // ── T4a: stale activeCount ALONE only WARNS (never fails) ────────────
    // active.length (derived) drives the digest's "entries" count, not the
    // stored meta.activeCount, so this alone never disturbs the digest.
    const staleActiveMeta = { ...meta, activeCount: meta.activeCount + 1 };
    writeFileSync(META, `${JSON.stringify(staleActiveMeta, null, 2)}\n`);

    const staleActive = run([]);
    check(
      "T4a: stale activeCount alone still exits 0 (warning, not failure)",
      staleActive.status,
      0,
    );
    check(
      "T4a: plain run WARNS about the stale activeCount",
      (staleActive.stdout + staleActive.stderr).includes("STALE ACTIVECOUNT"),
      true,
    );

    const restampActive = run(["--digest"]);
    check("T4a: --digest exits 0 while re-stamping activeCount", restampActive.status, 0);
    check(
      "T4a: --digest restores activeCount to the derived value",
      JSON.parse(readFileSync(META, "utf8")).activeCount,
      meta.activeCount,
    );

    // ── T4b: a RESERVED nextId (stored above max + 1) WARNS. Unlike
    // activeCount, the derived nextId IS embedded in the digest's counts
    // line, so reserving also makes the existing digest legitimately stale
    // — `--digest` is the one command that repairs the digest AND preserves
    // the reservation, rather than un-reserving it. ─────────────────────
    const reservedNextId = meta.nextId + 5;
    const reservedMeta = { ...meta, nextId: reservedNextId };
    writeFileSync(META, `${JSON.stringify(reservedMeta, null, 2)}\n`);

    const reservedRun = run([]);
    check(
      "T4b: plain run WARNS that nextId reserves ids beyond max",
      (reservedRun.stdout + reservedRun.stderr).includes("nextId reserves"),
      true,
    );
    check(
      "T4b: reserving nextId also makes the existing digest stale (exit 1)",
      reservedRun.status === 0,
      false,
    );

    const restampReserved = run(["--digest"]);
    check("T4b: --digest exits 0 while repairing the digest", restampReserved.status, 0);
    check(
      "T4b: --digest PRESERVES the reserved nextId rather than un-reserving it",
      JSON.parse(readFileSync(META, "utf8")).nextId,
      reservedNextId,
    );

    const cleanAfterReserve = run([]);
    check(
      "T4b: plain run passes once the digest reflects the reservation",
      cleanAfterReserve.status,
      0,
    );

    // ── T5: (F4) a hand-LOWERED nextId is a hard FAILURE, not a warning ───
    const lowMeta = { ...meta, nextId: 1 };
    writeFileSync(META, `${JSON.stringify(lowMeta, null, 2)}\n`);

    const lowRun = run([]);
    check("T5: nextId below max+1 fails the plain run (exit 1)", lowRun.status === 0, false);
    check(
      "T5: failure is reported as NEXTID TOO LOW",
      (lowRun.stdout + lowRun.stderr).includes("NEXTID TOO LOW"),
      true,
    );

    const lowDigest = run(["--digest"]);
    check(
      "T5: --digest also refuses to write on a hand-lowered nextId (exit 1)",
      lowDigest.status === 0,
      false,
    );
    check(
      "T5: --digest left _meta.json untouched (still the hand-lowered value)",
      JSON.parse(readFileSync(META, "utf8")).nextId,
      1,
    );
  } finally {
    if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
  }

  console.log(
    failures
      ? `\nvalidate-lessons.digest.self-test: ${failures} FAILURE(S)`
      : "\nvalidate-lessons.digest.self-test: all checks passed",
  );
  process.exit(failures ? 1 : 0);
};

main();
