#!/usr/bin/env node
// CI gate: `prettier --check` on the PR's CHANGED files only — not the whole repo.
//
// WHY THIS EXISTS (#2413 / SA-422g)
// apps/api/src/billing/tenant-config-snapshot-admin.service.spec.ts reached master with a
// Prettier-3.9.7-under-printWidth-100 violation. `.husky/pre-commit`'s lint-staged only
// formats STAGED paths in the commit being made locally, so a squash merge on GitHub (or any
// hook-bypassed push) never runs it — a file that was clean in each individual PR commit can
// still land unformatted in the squashed tree, and CI's `verify` job never ran `prettier
// --check` at all. Traced: the line landed via 097762e05 ("chore(train): land merge train B
// (16 PRs) (#2395)", a squash merge), and every later commit that happened to touch the file
// (e.g. 826b5ac28 / #2376) picked up an incidental +N/-1 reflow as unrelated diff noise.
//
// This script is the cheap fix: it diffs the PR against its base, keeps only the paths
// lint-staged would have formatted (see lintStagedExtensions), and runs `prettier --check` on exactly those — no repo-wide reformat,
// no full-tree pass, no dependency on lint-staged or a local hook actually running.
//
// USAGE
//   node scripts/ci-prettier-changed.mjs <base-ref>
// <base-ref> is anything `git diff` accepts on the left of `...HEAD` — a branch name, a remote
// ref (origin/master), or a bare sha. It defaults to `origin/${GITHUB_BASE_REF}` when that env
// var is set (as GitHub Actions sets it for pull_request events), else "origin/master".
//
// The CALLER (ci.yml) is responsible for making the base ref resolvable — i.e. fetching enough
// history that `git merge-base` can find a common ancestor. This script does not fetch
// anything itself; it only reads what is already in the local repo.
//
// EXIT CODES
//   0  no changed files needed checking, or all checked files are already Prettier-clean
//   1  at least one changed file fails `prettier --check`
//   2  the diff itself could not be computed (bad base ref, no merge-base, etc.) — fails
//      closed, since a silent empty-list here would look identical to "nothing changed"
//
// TEST-ONLY OVERRIDE (see apps/api/src/common/ci-prettier-changed-script.spec.ts)
//   CI_PRETTIER_CWD   Directory to run `git diff` and `prettier --check` in, instead of this
//                     script's own repo root. Lets the spec drive a throwaway git repo with no
//                     risk to the real tree, the same isolation ci-freshness-guard-script.spec.ts
//                     uses. The prettier BINARY itself is always resolved from repoRoot() (see
//                     below), never from this override — a fixture repo needs no node_modules
//                     of its own, and this can never accidentally reach into another checkout.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The checked extensions are EXACTLY the ones .husky/pre-commit's lint-staged formats — read from
// .lintstagedrc.json, never a second hand-kept list. This gate exists to catch what lint-staged
// would have formatted had the commit gone through the hook (a squash merge or a hook-bypassed
// push); a type lint-staged never formats (.html, .scss, .mdx, .mts, .jsonc …) must not red a PR
// that lint-staged would have left alone — e.g. an apps/control PR regenerating its golden
// index.html (UPDATE_GOLDEN=1). Files .prettierignore covers are skipped by prettier itself.
// Anything else in the diff (images, .env, lockfiles, binaries, …) is skipped explicitly rather
// than left to `--ignore-unknown`, so a future unsupported extension can never start "passing"
// just because prettier shrugged at it.
//
// Fails closed (null) when the rc file is unreadable or a key is not the `*.ext` / `*.{a,b}` shape
// this understands: guessing a list there would silently change what CI enforces.
function lintStagedExtensions(root) {
  let rc;
  try {
    rc = JSON.parse(fs.readFileSync(path.join(root, ".lintstagedrc.json"), "utf8"));
  } catch {
    return null;
  }
  const exts = new Set();
  for (const glob of Object.keys(rc)) {
    const m = /^\*\.(?:\{([a-z0-9,]+)\}|([a-z0-9]+))$/i.exec(glob);
    if (!m) return null;
    for (const ext of (m[1] ?? m[2]).split(",")) exts.add(`.${ext.toLowerCase()}`);
  }
  return exts.size > 0 ? exts : null;
}

// scripts/ci-prettier-changed.mjs -> scripts/ -> repo root. Anchored to this file's own
// location (not process.cwd()) so it resolves the same way regardless of the caller's cwd —
// same convention as ci-audit-critical.mjs's repoRoot().
function repoRoot() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

// Files per prettier invocation (see the batching note in main()).
const BATCH = 100;

function cwd() {
  return process.env.CI_PRETTIER_CWD || repoRoot();
}

function defaultBaseRef() {
  if (process.env.GITHUB_BASE_REF) return `origin/${process.env.GITHUB_BASE_REF}`;
  return "origin/master";
}

function parseArgs(argv) {
  const base = argv[2] || defaultBaseRef();
  return { base };
}

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    cwd: cwd(),
    shell: false,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

// Splits a git diff's NUL-separated `--name-only -z` output into a clean array of paths — `-z`
// (rather than newline splitting) is what makes a path containing a literal newline or other
// odd byte safe to handle; a filename WITH SPACES already round-trips fine through argv
// (spawnSync never goes through a shell), so no separate quoting logic is needed for that case.
function changedFiles(base) {
  const result = run("git", ["diff", "--name-only", "-z", "--diff-filter=ACMR", `${base}...HEAD`]);
  if (result.error || typeof result.status !== "number" || result.status !== 0) {
    const detail = result.error ? result.error.message : (result.stderr || "").trim();
    return { ok: false, files: [], detail: detail || `git diff exited ${result.status}` };
  }
  const files = (result.stdout || "")
    .split("\0")
    .map((f) => f.trim())
    .filter(Boolean);
  return { ok: true, files };
}

function filterPrettierable(files, root, extensions) {
  return files.filter((f) => {
    if (!extensions.has(path.extname(f).toLowerCase())) return false;
    // A path git reports may no longer exist on disk in an edge case this script does not need
    // to special-case (e.g. a rename chain outside --diff-filter's coverage) — skip rather than
    // hand prettier a path it will itself fail to read.
    return fs.existsSync(path.join(root, f));
  });
}

function main() {
  const { base } = parseArgs(process.argv);
  const root = cwd();

  const diff = changedFiles(base);
  if (!diff.ok) {
    console.log(`::error::ci-prettier-changed: could not diff against ${base} — ${diff.detail}`);
    return 2;
  }

  const extensions = lintStagedExtensions(repoRoot());
  if (!extensions) {
    console.log(
      "::error::ci-prettier-changed: could not derive the checked extensions from " +
        ".lintstagedrc.json (missing, unparsable, or a key that is not `*.ext` / `*.{a,b}`)",
    );
    return 2;
  }

  const targets = filterPrettierable(diff.files, root, extensions);
  if (targets.length === 0) {
    console.log(
      `ci-prettier-changed: ${diff.files.length} changed file(s) vs ${base}, none Prettier-formattable — skipping.`,
    );
    return 0;
  }

  console.log(
    `ci-prettier-changed: checking ${targets.length} changed file(s) vs ${base}:\n` +
      targets.map((f) => `  ${f}`).join("\n"),
  );

  // Always this script's OWN repo (repoRoot()), never `root`/CI_PRETTIER_CWD — the binary is
  // this checkout's installed dependency, not something a diff-only fixture repo should ever
  // need to provide.
  const prettierBin = path.join(repoRoot(), "node_modules", "prettier", "bin", "prettier.cjs");
  if (!fs.existsSync(prettierBin)) {
    console.log(`::error::ci-prettier-changed: prettier binary not found at ${prettierBin}`);
    return 2;
  }

  // process.execPath + the .cjs entrypoint directly, never `npx`/`npx.cmd` — the same
  // Windows-safe pattern ci-audit-critical.mjs uses for npm-cli.js, and it sidesteps any
  // shell:true requirement spawnSync would otherwise need for a .cmd shim.
  // Batched: one argv for a huge PR (a rename sweep, a merge train) would pass Windows' ~32 KB
  // command-line limit (ENAMETOOLONG, found running this over the whole tree) and a failure to
  // launch is exit 2, never a silent pass.
  let failed = false;
  for (let i = 0; i < targets.length; i += BATCH) {
    const result = run(process.execPath, [
      prettierBin,
      "--check",
      "--ignore-unknown",
      ...targets.slice(i, i + BATCH),
    ]);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);

    if (result.error) {
      console.log(
        `::error::ci-prettier-changed: failed to launch prettier — ${result.error.message}`,
      );
      return 2;
    }
    if (result.status !== 0) failed = true;
  }
  if (failed) {
    console.log(
      "::error::ci-prettier-changed: one or more of the files listed above failed " +
        "`prettier --check` (see the warnings above for which) — run " +
        "`npx prettier --write <file>` locally.",
    );
    return 1;
  }
  console.log(`ci-prettier-changed: all ${targets.length} changed file(s) are Prettier-clean.`);
  return 0;
}

process.exit(main());
