#!/usr/bin/env node
// from-git.mjs — a read-only report of what recent commits' roadmap trailers (Feature:/Bug:/Defers:)
// say against the registers, plus one bounded write: --apply merges proposed PR numbers into
// features.jsonl's "prs":[…] substring, working tree only. Never stages, never commits, never pushes.
//
// History walk: readCommits() runs `git log --first-parent`, so it sees only the mainline, which
// is one squash-merge commit per PR (where that PR's trailers live). A --since range that crosses
// a true merge commit reports the merge commit's own message but silently drops every trailer
// carried by commits reachable only through its second parent. This is deliberate: a feature
// branch's WIP commits must not double-count. Self-test T12m pins it.
//
// Usage:
//   node scripts/roadmap/from-git.mjs [--since <ref>]
//   node scripts/roadmap/from-git.mjs --apply
//   node scripts/roadmap/from-git.mjs --help
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { gitEnv } from "../campaign/plane-client.mjs";
import { regDir, loadRegisters, validate } from "./render.mjs";

const USAGE = "Usage: from-git.mjs [--since <ref>] [--apply] [--help]";
const ID_RE = /^(F-\d+|B\d+|D-\d+)$/;
// The PR template's unfilled placeholders — dropped silently, never "unknown", never "tagged".
const PLACEHOLDERS = new Set(["F-", "B", "D-"]);
const KIND = { Feature: "F", Bug: "B", Defers: "D" };

export function parseTrailers(body) {
  const out = { features: [], bugs: [], defers: [], unknown: [] };
  const push = (arr, v) => {
    if (!arr.includes(v)) arr.push(v);
  };
  for (const m of String(body ?? "").matchAll(/^(Feature|Bug|Defers):[ \t]*(.*)$/gm)) {
    const bucket = m[1] === "Feature" ? out.features : m[1] === "Bug" ? out.bugs : out.defers;
    for (const tok of m[2].split(/[,\s]+/).filter(Boolean)) {
      if (PLACEHOLDERS.has(tok)) continue;
      if (!ID_RE.test(tok) || tok[0] !== KIND[m[1]]) {
        push(out.unknown, tok.slice(0, 20));
        continue;
      }
      push(bucket, tok);
    }
  }
  return out;
}

function git(args, cwd) {
  const r = spawnSync("git", ["-C", cwd, ...args], { env: gitEnv(), encoding: "utf8" });
  if (r.status !== 0)
    throw new Error(
      `git ${args[0]} failed: ${String(r.stderr || "")
        .trim()
        .slice(0, 200)}`,
    );
  return r.stdout;
}
export const gitRootOf = (dir) => git(["rev-parse", "--show-toplevel"], dir).trim();
export function defaultSince(root) {
  const shas = git(
    ["log", "--diff-filter=A", "--format=%H", "--", ".claude/roadmap/README.md"],
    root,
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  if (!shas.length)
    throw new Error("no commit adds .claude/roadmap/README.md — pass --since <ref>");
  return shas[shas.length - 1];
}
export function readCommits(root, since) {
  const raw = git(
    ["log", "--first-parent", "--reverse", "--format=%H%x00%s%x00%B%x1e", `${since}..HEAD`],
    root,
  );
  return raw
    .split("\x1e")
    .map((r) => r.replace(/^\n/, ""))
    .filter((r) => r.trim())
    .map((rec) => {
      const [sha, subject, body] = rec.split("\x00");
      const pr = /\(#(\d+)\)\s*$/.exec(subject);
      return {
        sha,
        sha7: sha.slice(0, 7),
        subject,
        body,
        pr: pr ? Number(pr[1]) : null,
        trailers: parseTrailers(body),
      };
    });
}

export function buildReport({ commits, features, since7 }) {
  const rows = new Map(features.map((f) => [f.id, f]));
  const proposals = new Map(); // featureId -> [{pr, sha7, subject}]
  const unknown = [];
  const seen = [];
  const untagged = [];
  let tagged = 0;
  for (const c of commits) {
    const t = c.trailers;
    if (t.features.length + t.bugs.length + t.defers.length > 0) tagged++;
    else untagged.push(c);
    for (const id of t.features) {
      const row = rows.get(id);
      if (!row) {
        unknown.push({ id, c });
        continue;
      }
      if (c.pr && !(row.prs ?? []).includes(c.pr)) {
        const list = proposals.get(id) ?? [];
        if (!list.some((p) => p.pr === c.pr))
          list.push({ pr: c.pr, sha7: c.sha7, subject: c.subject });
        proposals.set(id, list);
      }
    }
    for (const b of t.bugs) seen.push({ id: `Bug: ${b}`, c });
    for (const d of t.defers) seen.push({ id: `Defers: ${d}`, c });
    for (const u of t.unknown) unknown.push({ id: u, c });
  }
  const pct = commits.length ? Math.round((tagged / commits.length) * 100) : 0;
  const lines = ["Proposed prs[] appends"];
  if (!proposals.size) lines.push("  none");
  for (const [id, list] of [...proposals].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    for (const p of list.sort((a, b) => a.pr - b.pr))
      lines.push(`  ${id}: #${p.pr}  ${p.sha7}  ${p.subject}`);
  }
  lines.push("Unknown ids");
  if (!unknown.length) lines.push("  none");
  for (const u of unknown) lines.push(`  ${u.id}  ${u.c.sha7}  ${u.c.subject}`);
  lines.push("Bug/Defers trailers seen");
  if (!seen.length) lines.push("  none");
  for (const s of seen) lines.push(`  ${s.id}  ${s.c.sha7}  ${s.c.subject}`);
  lines.push(
    "Coverage",
    `  ${tagged} of ${commits.length} commits since ${since7} carry a roadmap trailer (${pct}%)`,
    "  untagged:",
  );
  for (const c of untagged.slice(0, 20)) lines.push(`    ${c.sha7}  ${c.subject}`);
  if (untagged.length > 20) lines.push(`    +${untagged.length - 20} more`);
  return { lines, proposals };
}

// Rewrites ONLY the `"prs":[…]` substring of a proposed row; every other byte of every line is kept.
export function applyPrs({ dir, proposals }) {
  const path = join(dir, "features.jsonl");
  const lines = readFileSync(path, "utf8").split("\n");
  const changed = [];
  const manual = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const list = proposals.get(row.id);
    if (!list) continue;
    const m = /"prs":\[([^\]]*)\]/.exec(line);
    if (!m) {
      manual.push(row.id);
      continue;
    }
    const have = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
    const merged = [...new Set([...have, ...list.map((p) => p.pr)])].sort((a, b) => a - b);
    const next = `${line.slice(0, m.index)}"prs":[${merged.join(",")}]${line.slice(m.index + m[0].length)}`;
    if (next !== line) {
      lines[i] = next;
      changed.push(row.id);
    }
  }
  if (changed.length) writeFileSync(path, lines.join("\n"), "utf8");
  return { changed, manual };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 0;
    return;
  }
  let since = null;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--since") since = argv[++i];
    else if (argv[i] === "--apply") apply = true;
    else {
      process.stderr.write(`${USAGE}\n`);
      process.exitCode = 2;
      return;
    }
  }
  const dir = regDir();
  let root, commits, since7;
  try {
    root = gitRootOf(dir);
    const sinceSha = since ?? defaultSince(root);
    since7 = git(["rev-parse", "--short=7", sinceSha], root).trim();
    commits = readCommits(root, sinceSha);
  } catch (err) {
    process.stderr.write(`from-git: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }
  const regs = loadRegisters(dir);
  const { lines, proposals } = buildReport({ commits, features: regs.features, since7 });
  process.stdout.write(lines.join("\n") + "\n");
  if (!apply) {
    process.exitCode = 0;
    return;
  }
  if (validate(regs.features, regs.deferred, regs.releases).length) {
    process.stderr.write("from-git: refusing --apply — registers fail validation\n");
    process.exitCode = 1;
    return;
  }
  if (git(["status", "--porcelain", "--", dir], root).trim()) {
    process.stderr.write("from-git: refusing --apply — .claude/roadmap has uncommitted changes\n");
    process.exitCode = 1;
    return;
  }
  if (!proposals.size) {
    process.stdout.write("--apply: nothing to write\n");
    process.exitCode = 0;
    return;
  }
  const { changed, manual } = applyPrs({ dir, proposals });
  process.stdout.write(git(["diff", "--stat", "--", dir], root));
  for (const id of changed)
    process.stdout.write(
      `--apply: ${id} prs[] updated (working tree only — commit it in your bookkeeping PR)\n`,
    );
  for (const id of manual)
    process.stdout.write(`--apply: ${id} has no "prs" key — add it by hand\n`);
  process.exitCode = 0;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
