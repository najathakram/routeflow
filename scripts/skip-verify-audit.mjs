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
//   RF_PUSH_REFS        git's pre-push stdin, one `<local ref> <local sha> <remote ref> <remote sha>`
//                       per pushed ref (B892). When present it is authoritative: EACH pushed ref is
//                       gated on its OWN changed files and logged under its own ref and sha. The
//                       HEAD-derived RF_BRANCH / RF_HEAD / RF_CHANGED_FILES are only the fallback
//                       for an empty stdin (a skip push of a non-HEAD branch used to be recorded —
//                       and gated — as HEAD).
//
// Exit 0 and append/print the audit line when the push is docs-only, or a code push carries a
// non-blank SKIP_VERIFY_REASON. Exit 1 (stderr only, nothing recorded) when a code push has no
// reason, or when RF_CHANGED_FILES is empty — an unknown file list is NOT docs-only (the hook's
// two `git diff` attempts both fail silently in a clone with neither an upstream nor a fetched
// origin/master, and "I could not tell what changed" must never disarm the gate).
import { spawnSync } from "node:child_process";
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
const auditLog = process.env.RF_AUDIT_LOG ?? "";
const ZERO_SHA = /^0+$/;

function splitLines(text) {
  return (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function gitOut(args) {
  const res = spawnSync("git", args, { encoding: "utf8", shell: false });
  return res.status === 0 ? res.stdout : null;
}

/**
 * The files a pushed sha changes vs what the remote already has: its remote sha when that exists
 * locally, else origin/master. null = unknown (never read as docs-only).
 */
function changedFilesFor(localSha, remoteSha) {
  const base =
    remoteSha &&
    !ZERO_SHA.test(remoteSha) &&
    gitOut(["cat-file", "-e", `${remoteSha}^{commit}`]) !== null
      ? remoteSha
      : "origin/master";
  const out = gitOut(["diff", "--name-only", `${base}...${localSha}`]);
  return out === null ? null : splitLines(out);
}

/** One entry per ref being pushed, from RF_PUSH_REFS; deletions (a zero local sha) are skipped. */
function pushedRefs() {
  return splitLines(process.env.RF_PUSH_REFS)
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts.length >= 4 && !ZERO_SHA.test(parts[1]))
    .map(([localRef, localSha, remoteRef, remoteSha]) => ({
      name: localRef.replace(/^refs\/heads\//, ""),
      remote: remoteRef.replace(/^refs\/heads\//, ""),
      sha: localSha.slice(0, 7),
      files: changedFilesFor(localSha, remoteSha) ?? [],
    }));
}

// An empty list is unknown, not docs-only — `[].every(...)` is vacuously true, which would
// fail open on exactly the case this gate exists to catch.
const isDocsOnly = (files) => files.length > 0 && files.every(isDocsPath);

const refs = pushedRefs();
// Ref lines were handed over but none is a gateable push (all deletions or malformed): the HEAD
// values describe a different commit, so the push is unknown, never HEAD's docs-only verdict.
const refsUnparsed = refs.length === 0 && splitLines(process.env.RF_PUSH_REFS).length > 0;
const entries =
  refs.length > 0
    ? refs.map((r) => ({
        label: r.remote && r.remote !== r.name ? `${r.name} -> ${r.remote}` : r.name,
        sha: r.sha,
        files: r.files,
      }))
    : refsUnparsed
      ? [{ label: "(no gateable pushed ref)", sha: "", files: [] }]
      : [
          {
            label: process.env.RF_BRANCH ?? "",
            sha: process.env.RF_HEAD ?? "",
            files: splitLines(process.env.RF_CHANGED_FILES),
          },
        ];

for (const entry of entries) {
  if (!isDocsOnly(entry.files) && reason === "") {
    console.error(
      entry.files.length === 0
        ? `SKIP_VERIFY could not determine the changed files for ${entry.label || "HEAD"} — SKIP_VERIFY_REASON="<why>" is required`
        : 'SKIP_VERIFY needs SKIP_VERIFY_REASON="<why>" for a push that touches code (apps/, packages/, scripts/, .github/, .claude/hooks/, .claude/skills/)',
    );
    process.exit(1);
  }
}

const stamp = new Date().toISOString();
const lines = entries.map((entry) => {
  const docsOnly = isDocsOnly(entry.files);
  return `${stamp} | ${entry.label} | ${entry.sha} | docs-only=${docsOnly ? "yes" : "no"} | ${docsOnly ? "docs-only" : reason}`;
});

if (auditLog) {
  fs.mkdirSync(path.dirname(auditLog), { recursive: true });
  fs.appendFileSync(auditLog, lines.join("\n") + "\n");
}

for (const line of lines) console.log(`⚠ verify bypassed: ${line}`);
process.exit(0);
