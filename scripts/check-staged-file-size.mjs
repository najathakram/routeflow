#!/usr/bin/env node
// Pre-commit gate: refuse to commit any staged file over the size limit.
//
// The repo is code; heavy assets belong in Railway storage (the uploads
// volume / R2), not git — a committed blob stays in history forever and every
// clone pays for it. The 26MB generated fuzz PDF that was 84% of the entire
// pack is the cautionary tale. Legitimate large binaries should be produced
// by a script (commit the script) or uploaded to storage (commit the URL).
//
// Escape hatch for a deliberate exception: SKIP_SIZE_CHECK=1 git commit ...
import { execSync } from "node:child_process";

const LIMIT_KB = 1024; // 1 MiB — generous for icons/fonts/screenshots, far below asset territory

if (process.env.SKIP_SIZE_CHECK === "1") {
  console.log("⚠ SKIP_SIZE_CHECK=1 — staged-file size gate skipped.");
  process.exit(0);
}

// Staged blobs only (ACMR = added/copied/modified/renamed); deletions are free.
const files = execSync("git diff --cached --name-only --diff-filter=ACMR -z", {
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

// lockfile is text and always committed; the gate is for binaries (owner ruling 2026-09-03)
const EXEMPT = new Set(["package-lock.json"]);

const offenders = [];
for (const f of files) {
  if (EXEMPT.has(f)) continue;
  // Size of the STAGED blob (not the working-tree file, which may differ).
  const out = execSync(`git cat-file -s ":${f.replaceAll('"', '\\"')}"`, { encoding: "utf8" });
  const kb = Number(out.trim()) / 1024;
  if (kb > LIMIT_KB) offenders.push({ f, kb });
}

if (offenders.length > 0) {
  console.error(`\n✖ Commit blocked: staged file(s) over ${LIMIT_KB} KiB:\n`);
  for (const { f, kb } of offenders)
    console.error(`   ${Math.round(kb).toLocaleString()} KiB  ${f}`);
  console.error(
    "\nHeavy assets belong in Railway storage, not git. If this file is genuinely" +
      "\nmeant to be committed, re-run with SKIP_SIZE_CHECK=1.\n",
  );
  process.exit(1);
}
