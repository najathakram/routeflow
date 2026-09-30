#!/usr/bin/env node
// SKIP_VERIFY audit gate for .husky/pre-push.
//
// WHY: `SKIP_VERIFY=1 git push` is the emergency escape hatch for when `npm run verify`
// itself is broken — it must stay available. But an unrecorded, unreasoned bypass on a push
// that touches code is a check that quietly enforces nothing. This script keeps the hatch for
// docs-only pushes (no reason needed) and for code pushes with a stated reason, and refuses a
// code push with no reason at all — recording every bypass to a local, per-clone audit log.
//
// Env contract (all set by .husky/pre-push before invoking this script):
//   SKIP_VERIFY_REASON  optional human reason for the bypass
//   RF_BRANCH           current branch name
//   RF_HEAD             short commit sha being pushed
//   RF_CHANGED_FILES    newline-separated paths changed vs the push target (may be empty)
//   RF_AUDIT_LOG        path to append the audit line to (created if absent)
//
// Exit 0 and append/print the audit line when the push is docs-only, or a code push carries a
// non-blank SKIP_VERIFY_REASON. Exit 1 (stderr only, nothing recorded) when a code push has no
// reason, or when RF_CHANGED_FILES is empty — an unknown file list is NOT docs-only (the hook's
// two `git diff` attempts both fail silently in a clone with neither an upstream nor a fetched
// origin/master, and "I could not tell what changed" must never disarm the gate).
import fs from "node:fs";
import path from "node:path";

// Inert paths only. `.claude/` is NOT documentation wholesale: `npm run verify` itself executes
// `.claude/skills/bug-hunt/scripts/scan-signatures.mjs` and `.claude/hooks/stop.mjs` gates turns,
// so those subtrees are code. Only the registry/notes subtrees count as docs, and only for
// non-executable files inside them.
const CLAUDE_DOCS_SUBTREE_RE = /^\.claude\/(code-map|lessons|campaign|pipeline)\//i;
const EXECUTABLE_EXT_RE = /\.(mjs|js|cjs|ts|sh)$/i;

function isDocsPath(file) {
  if (/^docs\//i.test(file)) return true;
  if (/\.md$/i.test(file)) return true;
  const base = file.split("/").pop() ?? "";
  if (/^(CHANGELOG|README)/i.test(base)) return true;
  if (CLAUDE_DOCS_SUBTREE_RE.test(file) && !EXECUTABLE_EXT_RE.test(file)) return true;
  return false;
}

const reason = (process.env.SKIP_VERIFY_REASON ?? "").trim();
const branch = process.env.RF_BRANCH ?? "";
const head = process.env.RF_HEAD ?? "";
const changedFiles = (process.env.RF_CHANGED_FILES ?? "")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);
const auditLog = process.env.RF_AUDIT_LOG ?? "";

// An empty list is unknown, not docs-only — `[].every(...)` is vacuously true, which would
// fail open on exactly the case this gate exists to catch.
const docsOnly = changedFiles.length > 0 && changedFiles.every(isDocsPath);

if (!docsOnly && reason === "") {
  console.error(
    changedFiles.length === 0
      ? 'SKIP_VERIFY could not determine the changed files (empty RF_CHANGED_FILES) — SKIP_VERIFY_REASON="<why>" is required'
      : 'SKIP_VERIFY needs SKIP_VERIFY_REASON="<why>" for a push that touches code (apps/, packages/, scripts/, .github/, .claude/hooks/, .claude/skills/)',
  );
  process.exit(1);
}

const line = `${new Date().toISOString()} | ${branch} | ${head} | docs-only=${docsOnly ? "yes" : "no"} | ${docsOnly ? "docs-only" : reason}`;

if (auditLog) {
  fs.mkdirSync(path.dirname(auditLog), { recursive: true });
  fs.appendFileSync(auditLog, line + "\n");
}

console.log(`⚠ verify bypassed: ${line}`);
process.exit(0);
