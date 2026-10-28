// The one PR-size counting rule, shared by pre-push, CI and `scripts/pr-size.mjs --since`.
//
// Why: the only size control was the per-file ratchet (how big one file may grow), not how much one PR
// changes, and 46% of recently merged PRs were over 600 lines. A raw additions + deletions count punishes
// the wrong things (lockfiles, fixtures, snapshots, bookkeeping ledgers), so the count skips the paths in
// SIZE_EXCLUDE (checked in, with a reason each). Every size number in the repo must come from countLines.
//
// Pure functions: no git, no gh. The CLI feeds them rows ({ path, added, deleted }) from
// `git diff --numstat` or gh's PR `files`; both sources give the same result (see the self-test).
//
// PR_SIZE_MODE is the dark/enforced switch. Dark never fails anything; flipping it to "enforced" is its own
// diff, after the `--since` report. Verdicts: ok | warn (> WARN_AT) | block (> BLOCK_AT) | warn-override.
import { registrySource } from "./registry-root.mjs";
import { matchGlob } from "./risk-paths.mjs";

export const WARN_AT = 400;
export const BLOCK_AT = 600;
export const PR_SIZE_MODE = "dark";

/** Paths that do not add review load. A new entry needs a reason. */
export const SIZE_EXCLUDE = [
  { glob: "**/package-lock.json", why: "lockfile churn" },
  { glob: "**/yarn.lock", why: "lockfile churn" },
  { glob: "**/pnpm-lock.yaml", why: "lockfile churn" },
  { glob: "**/fixtures/**", why: "fixture data" },
  { glob: "**/__snapshots__/**", why: "snapshot output" },
  { glob: "**/*.snap", why: "snapshot output" },
  { glob: "**/generated/**", why: "generated code" },
  { glob: "**/dist/**", why: "build output" },
  { glob: ".claude/code-map/**", why: "bookkeeping ledger (code map)" },
  { glob: ".claude/lessons/**", why: "bookkeeping ledger (lessons)" },
  // Named through the register contract (B1-a), never as a literal path.
  { glob: `${registrySource().prefix}/**`, why: "bookkeeping ledger (bug register)" },
  { glob: ".claude/pipeline/**", why: "bookkeeping ledger (pipeline logs)" },
];

const norm = (p) =>
  String(p)
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "");

export const isExcluded = (p) => SIZE_EXCLUDE.some((e) => matchGlob(e.glob, norm(p)));

const isBinaryRow = (r) =>
  r.added === "-" || r.deleted === "-" || r.added == null || r.deleted == null;

/**
 * rows: [{ path, added, deleted }] (added/deleted "-" or null = binary).
 * Returns { counted, excluded, files, binary }: lines that count, lines skipped by SIZE_EXCLUDE, the
 * number of rows, and the binary paths (they count 0 and are listed).
 */
export function countLines(rows) {
  let counted = 0;
  let excluded = 0;
  const binary = [];
  for (const r of rows) {
    if (isBinaryRow(r)) {
      binary.push(norm(r.path));
      continue;
    }
    const n = Number(r.added) + Number(r.deleted);
    if (isExcluded(r.path)) excluded += n;
    else counted += n;
  }
  return { counted, excluded, files: rows.length, binary };
}

/**
 * counted: a number, or the object countLines returns. greenOnly: every touched path is risk class
 * green (docs, e2e), which is ok at any size. override: a non-empty reason turns block into warn-override.
 */
export function sizeVerdict(counted, { greenOnly = false, override = null } = {}) {
  const n = typeof counted === "number" ? counted : counted.counted;
  if (greenOnly || n <= WARN_AT) return "ok";
  if (n <= BLOCK_AT) return "warn";
  return override ? "warn-override" : "block";
}

/** The `PR-Size-Override: <reason>` trailer of a commit message, or null. */
export function parseOverride(message) {
  const m = /^PR-Size-Override:[ \t]*(\S.*?)[ \t]*$/m.exec(String(message ?? ""));
  return m ? m[1] : null;
}

/**
 * Rows from `git diff --numstat -z` output. Plain records are `added\tdeleted\tpath\0`; a rename or copy is
 * `added\tdeleted\t\0old\0new\0` (the new path is used).
 */
export function parseNumstatZ(text) {
  const parts = String(text).split("\0");
  const rows = [];
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    let p = m[3];
    if (p === "") {
      p = parts[i + 2] ?? "";
      i += 2;
    }
    if (p)
      rows.push({
        path: p,
        added: m[1] === "-" ? "-" : Number(m[1]),
        deleted: m[2] === "-" ? "-" : Number(m[2]),
      });
  }
  return rows;
}

/** Rows from gh's PR `files` ([{ path, additions, deletions }]). */
export const rowsFromGhFiles = (files) =>
  (files ?? []).map((f) => ({ path: f.path, added: f.additions, deleted: f.deletions }));
