#!/usr/bin/env node
/**
 * Self-test for the branch-aware `mappedSha` staleness check and the
 * `--stamp` flag added to scripts/validate-code-map.mjs (owner ruling
 * 2026-09-14: a stale `mappedSha` is a WARNING everywhere except `master`,
 * where it stays an ERROR, and `--stamp` is the one-command fix). Same
 * standalone-script convention as its siblings
 * (validate-lessons.digest.self-test.mjs et al.) — no node:test, no
 * root-level test runner: `  ok`/`  FAIL` lines, `process.exit(failures ? 1 : 0)`.
 *
 * T1: on THIS repo's current (non-master) branch, an intentionally stale
 *     `mappedSha` WARNS and still exits 0 — mutates the real
 *     `.claude/code-map/_meta.json` only inside a try/finally that restores
 *     the original content, same discipline as the lessons digest self-test.
 * T2: `--stamp` sets `mappedSha` to HEAD and `generatedAt` to a fresh
 *     timestamp; a plain run right after reports no staleness warning.
 * T3: the SAME staleness is a hard failure on a repo whose branch is
 *     `master` — built as a genuinely separate throwaway git repo (never a
 *     checkout of this one) so it can't mutate real state or depend on which
 *     branch this session happens to be on. The script is copied into that
 *     repo's own `scripts/` because `validate-code-map.mjs` resolves its
 *     `.claude/code-map/` relative to its OWN file location, not `cwd`.
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(__dirname, "validate-code-map.mjs");
const META = join(REPO_ROOT, ".claude", "code-map", "_meta.json");

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
};

const run = (scriptPath, args, cwd) =>
  spawnSync(process.execPath, [scriptPath, ...args], { cwd, encoding: "utf8" });

const git = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" });

const main = () => {
  // ── T1 + T2: against the REAL repo, on whatever non-master branch this
  // session happens to be on. ──────────────────────────────────────────────
  const originalMeta = readFileSync(META, "utf8");
  try {
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], REPO_ROOT).stdout.trim();
    check(
      "setup: self-test runs off master (T1/T2 need a non-master branch)",
      branch !== "master",
      true,
    );

    const meta = JSON.parse(originalMeta);
    const staleSha = "0".repeat(40);
    writeFileSync(META, `${JSON.stringify({ ...meta, mappedSha: staleSha }, null, 2)}\n`);

    const t1 = run(SCRIPT, [], REPO_ROOT);
    check("T1: stale mappedSha off master exits 0", t1.status, 0);
    check(
      "T1: stale mappedSha off master WARNS",
      (t1.stdout + t1.stderr).includes("STALE SHA"),
      true,
    );

    const head = git(["rev-parse", "HEAD"], REPO_ROOT).stdout.trim();
    const t2stamp = run(SCRIPT, ["--stamp"], REPO_ROOT);
    check("T2: --stamp exits 0", t2stamp.status, 0);
    const restamped = JSON.parse(readFileSync(META, "utf8"));
    check("T2: --stamp sets mappedSha to HEAD", restamped.mappedSha, head);
    check(
      "T2: --stamp sets generatedAt to a fresh ISO timestamp",
      typeof restamped.generatedAt === "string" && restamped.generatedAt !== meta.generatedAt,
      true,
    );

    const t2clean = run(SCRIPT, [], REPO_ROOT);
    check(
      "T2: plain run right after --stamp has no STALE SHA warning",
      (t2clean.stdout + t2clean.stderr).includes("STALE SHA"),
      false,
    );
  } finally {
    // Leave the working tree exactly as found, regardless of pass/fail above.
    writeFileSync(META, originalMeta);
  }

  // ── T3: the same staleness IS a hard failure on a repo whose branch is
  // literally named "master" — an independent throwaway git repo. ─────────
  let scratch;
  try {
    scratch = mkdtempSync(join(tmpdir(), "code-map-stamp-self-test-"));
    const mapDir = join(scratch, ".claude", "code-map");
    const scriptsDir = join(scratch, "scripts");
    mkdirSync(mapDir, { recursive: true });
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(mapDir, "INDEX.md"), "# Code Map\n");
    writeFileSync(join(mapDir, "CHANGELOG.md"), "# Changelog\n");
    writeFileSync(
      join(mapDir, "_meta.json"),
      `${JSON.stringify({ mappedSha: "0".repeat(40) }, null, 2)}\n`,
    );
    // Copy the real script under test — it resolves .claude/code-map/
    // relative to ITS OWN file location, not `cwd`, so it must live at
    // <scratch>/scripts/validate-code-map.mjs to see the scratch map dir.
    const scratchScript = join(scriptsDir, "validate-code-map.mjs");
    cpSync(SCRIPT, scratchScript);

    check("T3 setup: git init", git(["init"], scratch).status, 0);
    git(["config", "user.email", "self-test@example.invalid"], scratch);
    git(["config", "user.name", "self-test"], scratch);
    git(["add", "-A"], scratch);
    check("T3 setup: git commit", git(["commit", "-m", "seed"], scratch).status, 0);
    // Force-rename whatever the init default was ("main" or "master")
    // to "master" — portable across git versions without relying on
    // `init --initial-branch` or global init.defaultBranch config.
    check("T3 setup: git branch -M master", git(["branch", "-M", "master"], scratch).status, 0);
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], scratch).stdout.trim();
    check("T3 setup: scratch repo branch is master", branch, "master");

    const t3 = run(scratchScript, [], scratch);
    check("T3: stale mappedSha on master is a hard failure (exit 1)", t3.status, 1);
    check(
      "T3: failure names it as a master-only error",
      (t3.stdout + t3.stderr).includes("branch is master"),
      true,
    );
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }

  console.log(
    failures
      ? `\nvalidate-code-map.stamp.self-test: ${failures} FAILURE(S)`
      : "\nvalidate-code-map.stamp.self-test: all checks passed",
  );
  process.exit(failures ? 1 : 0);
};

main();
