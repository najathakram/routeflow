#!/usr/bin/env node
// Why: /bug-swarm step 2 was done by hand. Run 2026-10-23-bug-swarm-1 needed a manual merge of six
// disjoint singleton clusters down to four builders; run 2026-10-23-bug-swarm-2 re-did the same
// union-by-shared-file reasoning. This script makes clustering deterministic and testable.
//
//   node cluster.mjs <manifest.json> [--write]
//
// Pure core: clusterBugs(manifest, { ratchetFiles, maxClusters }) -> { clusters, excluded, overCap? }.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const RATCHET_SPEC = "apps/api/src/common/size-ratchet.spec.ts";

/** Workspace of a repo path: apps/<x>, packages/<x>, or "other". */
export function workspaceOf(file) {
  const m = /^(apps|packages)\/([^/]+)\//.exec(file);
  return m ? `${m[1]}/${m[2]}` : "other";
}

/** Keys of the `BASELINE` map in size-ratchet.spec.ts (comments are ignored). */
export function ratchetFilesFrom(specText) {
  const start = specText.indexOf("const BASELINE");
  if (start === -1) return [];
  const end = specText.indexOf("\n};", start);
  const body = specText.slice(start, end === -1 ? undefined : end);
  return [...body.matchAll(/^\s*"([^"]+)"\s*:\s*\d+/gm)].map((m) => m[1]);
}

// Numeric rows first (ascending), then W-ids and other strings; sub-ids break ties.
function bugOrder(a, b) {
  const na = /^\d+$/.test(a.row);
  const nb = /^\d+$/.test(b.row);
  if (na && nb && a.row !== b.row) return Number(a.row) - Number(b.row);
  if (na !== nb) return na ? -1 : 1;
  if (a.row !== b.row) return a.row < b.row ? -1 : 1;
  return String(a.sub ?? "") < String(b.sub ?? "")
    ? -1
    : String(a.sub ?? "") > String(b.sub ?? "")
      ? 1
      : 0;
}

function leadingSegments(a, b) {
  const sa = a.split("/");
  const sb = b.split("/");
  let n = 0;
  while (n < sa.length && n < sb.length && sa[n] === sb[n]) n++;
  return n;
}

// Best leading-path overlap between any file of x and any file of y.
function affinity(x, y) {
  let best = 0;
  for (const fx of x.files)
    for (const fy of y.files) best = Math.max(best, leadingSegments(fx, fy));
  return best;
}

function exclusionReason(b, avoid) {
  if (b.risk !== "LOW") return `risk ${b.risk}: HIGH-risk bugs never enter the swarm`;
  if (b.status !== "live") return `status ${b.status}: only live bugs enter`;
  if (!b.files || b.files.length === 0) return "no files: triage found no touched file";
  const hit = b.files.find((f) => avoid.has(f));
  if (hit) return `touches avoided file ${hit}`;
  return null;
}

export function clusterBugs(
  manifest,
  { ratchetFiles = [], maxClusters = 4, avoidFiles = [], requestedRows } = {},
) {
  const avoid = new Set(avoidFiles);
  const excluded = [];
  const bugs = [];
  for (const b of manifest.bugs ?? []) {
    const reason = exclusionReason(b, avoid);
    if (reason) excluded.push({ row: b.row, ...(b.sub ? { sub: b.sub } : {}), reason });
    else bugs.push(b);
  }

  // Union-find over bug indexes, joined through shared files.
  const parent = bugs.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owner = new Map();
  bugs.forEach((b, i) => {
    for (const f of b.files) {
      if (owner.has(f)) parent[find(i)] = find(owner.get(f));
      else owner.set(f, i);
    }
  });
  const groups = new Map();
  bugs.forEach((b, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(b);
  });

  let work = [...groups.values()].map((members) => {
    const sorted = [...members].sort(bugOrder);
    const files = [...new Set(members.flatMap((m) => m.files))].sort();
    return { members: sorted, files };
  });
  const order = (x, y) => bugOrder(x.members[0], y.members[0]);
  work.sort(order);

  const wsOf = (c) => new Set(c.files.map(workspaceOf));
  let overCap = false;
  while (work.length > maxClusters) {
    // Smallest first (bug count, then first-bug order); take the first that has a same-workspace partner.
    const bySize = [...work].sort((x, y) => x.members.length - y.members.length || order(x, y));
    let merged = false;
    for (const small of bySize) {
      const sw = wsOf(small);
      let target = null;
      let score = -1;
      for (const other of [...work].sort(order)) {
        if (other === small) continue;
        if (![...wsOf(other)].some((w) => sw.has(w))) continue;
        const s = affinity(small, other);
        if (s > score) {
          score = s;
          target = other;
        }
      }
      if (target) {
        target.members = [...target.members, ...small.members].sort(bugOrder);
        target.files = [...new Set([...target.files, ...small.files])].sort();
        work = work.filter((c) => c !== small).sort(order);
        merged = true;
        break;
      }
    }
    if (!merged) {
      overCap = true;
      break;
    }
  }

  const ratchet = new Set(ratchetFiles);
  const toCluster = (c, i) => ({
    id: `c${i + 1}`,
    bugs: c.members.map((m) => ({ row: m.row, ...(m.sub ? { sub: m.sub } : {}) })),
    files: c.files,
    workspaces: [...wsOf(c)].sort(),
    needsDb: c.members.some((m) => m.needsDb),
    ui: c.members.some((m) => m.ui),
    extractionFirst: c.files.some((f) => ratchet.has(f)),
  });
  const all = work.map(toCluster);
  // Still over the cap after same-workspace merges: run the first N, park the rest (never run).
  const clusters = overCap ? all.slice(0, maxClusters) : all;
  const result = { clusters, excluded };
  if (overCap) {
    result.overCap = true;
    result.parked = all
      .slice(maxClusters)
      .map((cluster) => ({ cluster, reason: `over cap ${maxClusters}` }));
  }
  // Triage's own exclusions (raw `{row, why}` or a previous run's `source: "triage"`) are kept, one
  // entry per row ("7, 8" splits); entries this script derived itself are regenerated, not copied.
  const have = new Set(excluded.map((e) => `${e.row}|${e.sub ?? ""}|${e.reason}`));
  for (const e of manifest.excluded ?? []) {
    if (e.why === undefined && e.source !== "triage") continue;
    for (const row of String(e.row)
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean)) {
      const reason = e.why ?? e.reason;
      if (have.has(`${row}||${reason}`)) continue;
      have.add(`${row}||${reason}`);
      excluded.push({ row, reason, source: "triage" });
    }
  }
  if (requestedRows) {
    const seen = new Set((manifest.bugs ?? []).map((b) => String(b.row)));
    for (const e of excluded) seen.add(String(e.row));
    for (const p of result.parked ?? []) for (const b of p.cluster.bugs) seen.add(String(b.row));
    result.unaccounted = requestedRows.filter((r) => !seen.has(String(r)));
  }
  return result;
}

/** Parse CLI argv -> { file, write, maxClusters?, avoidFiles, requestedRows? }; throws on bad usage. */
export function parseCli(argv) {
  const o = { file: undefined, write: false, avoidFiles: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") o.write = true;
    else if (a === "--max") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error("--max needs a positive integer");
      o.maxClusters = n;
    } else if (a === "--avoid" && argv[i + 1]) o.avoidFiles.push(argv[++i]);
    else if (a === "--rows" && argv[i + 1]) {
      o.requestedRows = argv[++i]
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean);
    } else if (!a.startsWith("--") && !o.file) o.file = a;
    else throw new Error(`unknown or incomplete argument ${JSON.stringify(a)}`);
  }
  return o;
}

export function main(argv = process.argv.slice(2)) {
  let cli;
  try {
    cli = parseCli(argv);
    if (!cli.file) throw new Error("manifest path required");
  } catch (e) {
    console.error(
      `cluster: ${e.message}\nusage: node cluster.mjs <manifest.json> [--write] [--max N] [--avoid <file>]... [--rows a,b,c]`,
    );
    return 2;
  }
  const file = cli.file;
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  let ratchetFiles = [];
  try {
    ratchetFiles = ratchetFilesFrom(readFileSync(path.join(root, RATCHET_SPEC), "utf8"));
  } catch {
    console.error(`cluster: ${RATCHET_SPEC} not readable; extractionFirst will be false`);
  }
  const result = clusterBugs(manifest, {
    ratchetFiles,
    avoidFiles: cli.avoidFiles,
    requestedRows: cli.requestedRows,
    ...(cli.maxClusters ? { maxClusters: cli.maxClusters } : {}),
  });
  if (cli.write) {
    const next = { ...manifest, ...result };
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  }
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
