#!/usr/bin/env node
// fleet-status.mjs — read-only "where are we" snapshot for RouteFlow.
//
// Prints a compact markdown report (~120 lines) covering: master HEAD +
// recent merges, repo visibility, open PRs + CI rollup, the board's (#2554)
// recent comments, local worktree hygiene, bug-registry counts, and the
// newest handoff pointers. Every section fails soft — a section that can't
// be gathered prints "unavailable: <reason>" and the script keeps going.
//
// Never writes anything except the optional --out <file> (the same report
// this prints to stdout). Safe to run from any cwd inside the repo.
//
// Usage:
//   node .claude/skills/fleet-lead/scripts/fleet-status.mjs [--json] [--out <file>]

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeProc } from "../../../../scripts/lib/proc.mjs";

const args = process.argv.slice(2);
const wantJson = args.includes("--json");
const outIdx = args.indexOf("--out");
const outFile = outIdx !== -1 ? args[outIdx + 1] : null;

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..", "..");
const OWNER_REPO = "najathakram/routeflow";
// The live board of record. #938 hit GitHub's 2,500-comment cap on 2026-09-27; its successor is
// #2554. Roll to a new board at ~2,300 comments (L-240) and change this one constant.
const BOARD_ISSUE = Number(process.env.FLEET_BOARD_ISSUE || 2554);

const report = {}; // machine-readable accumulator for --json

// run / tryRun / tryRunAsync live in scripts/lib/proc.mjs (shared with scripts/lead-status.mjs).
const { run, tryRun, tryRunAsync } = makeProc(REPO_ROOT);

// Runs `fn(item)` over `items` with at most `limit` in flight at once.
async function pooled(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function trunc(s, n) {
  const flat = String(s)
    .replace(/\r?\n+/g, " ")
    .trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}

const lines = [];
function h(text) {
  lines.push(text);
}

h(`# RouteFlow fleet status`);
h(``);
h(`Generated: ${new Date().toISOString()}`);
h(``);

// ---------------------------------------------------------------------------
// Master
// ---------------------------------------------------------------------------
h(`## Master`);
{
  const section = {};
  const sha = tryRun("git", ["ls-remote", "origin", "refs/heads/master"]);
  if (sha.ok) {
    const shaVal = sha.out.split("\t")[0]?.trim() || sha.out.trim();
    section.sha = shaVal;
    h(`- HEAD sha: \`${shaVal}\``);
  } else {
    h(`- HEAD sha: unavailable: ${sha.error}`);
  }

  const merged = tryRun("gh", [
    "pr",
    "list",
    "--repo",
    OWNER_REPO,
    "--state",
    "merged",
    "--limit",
    "8",
    "--json",
    "number,title,mergedAt",
  ]);
  if (merged.ok) {
    try {
      const prs = JSON.parse(merged.out);
      section.recentMerges = prs;
      h(`- Last ${prs.length} merged PRs:`);
      for (const pr of prs) {
        h(`  - #${pr.number} ${trunc(pr.title, 90)} (${pr.mergedAt})`);
      }
    } catch (err) {
      h(`- Last merged PRs: unavailable: parse error (${err.message})`);
    }
  } else {
    h(`- Last merged PRs: unavailable: ${merged.error}`);
  }
  report.master = section;
}
h(``);

// ---------------------------------------------------------------------------
// Repo visibility
// ---------------------------------------------------------------------------
h(`## Repo visibility`);
{
  const vis = tryRun("gh", ["repo", "view", OWNER_REPO, "--json", "visibility"]);
  if (vis.ok) {
    try {
      const parsed = JSON.parse(vis.out);
      report.visibility = parsed.visibility;
      h(`- ${parsed.visibility}`);
    } catch (err) {
      h(`- unavailable: parse error (${err.message})`);
    }
  } else {
    h(`- unavailable: ${vis.error}`);
  }
}
h(``);

// ---------------------------------------------------------------------------
// Open PRs
// ---------------------------------------------------------------------------
h(`## Open PRs`);
{
  const open = tryRun("gh", [
    "pr",
    "list",
    "--repo",
    OWNER_REPO,
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,title,headRefOid,isDraft,mergeable,statusCheckRollup",
  ]);
  if (open.ok) {
    try {
      const prs = JSON.parse(open.out).sort((a, b) => a.number - b.number);
      report.openPrs = [];
      h(`| # | title | head | draft | mergeable | checks (pass/fail/pending) |`);
      h(`|---|---|---|---|---|---|`);
      for (const pr of prs) {
        const rollup = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
        let pass = 0,
          fail = 0,
          pending = 0;
        for (const c of rollup) {
          const state = (c.conclusion || c.state || "").toUpperCase();
          if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(state)) pass++;
          else if (
            ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "STARTUP_FAILURE"].includes(state)
          )
            fail++;
          else pending++;
        }
        const row = {
          number: pr.number,
          title: pr.title,
          head: (pr.headRefOid || "").slice(0, 9),
          draft: !!pr.isDraft,
          mergeable: pr.mergeable,
          checks: { pass, fail, pending },
        };
        report.openPrs.push(row);
        h(
          `| #${pr.number} | ${trunc(pr.title, 60)} | \`${row.head}\` | ${row.draft ? "yes" : "no"} | ${pr.mergeable} | ${pass}/${fail}/${pending} |`,
        );
      }
      if (prs.length === 0) h(`(none open)`);
    } catch (err) {
      h(`unavailable: parse error (${err.message})`);
    }
  } else {
    h(`unavailable: ${open.error}`);
  }
}
h(``);

// ---------------------------------------------------------------------------
// board (#BOARD_ISSUE)
// ---------------------------------------------------------------------------
h(`## #${BOARD_ISSUE} board (last 12 comments)`);
{
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const comments = tryRun("gh", [
    "api",
    "--paginate",
    `repos/${OWNER_REPO}/issues/${BOARD_ISSUE}/comments?per_page=100&since=${since}`,
  ]);
  if (comments.ok) {
    try {
      // --paginate concatenates one JSON array per page back-to-back; gh
      // actually merges pages into one array for a top-level array response,
      // but guard for concatenated arrays just in case.
      const raw = comments.out.trim();
      let items = [];
      if (raw.length === 0) {
        items = [];
      } else {
        // Attempt straightforward parse first.
        try {
          items = JSON.parse(raw);
        } catch {
          // Fall back: concatenated arrays like "[...][...]" — split and merge.
          const chunks = raw.match(/\[[\s\S]*?\](?=\s*(\[|$))/g) || [raw];
          items = chunks.flatMap((c) => {
            try {
              return JSON.parse(c);
            } catch {
              return [];
            }
          });
        }
      }
      items.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      const last12 = items.slice(-12);
      report.board = last12.map((c) => ({
        id: c.id,
        created_at: c.created_at,
        excerpt: trunc(c.body || "", 140),
      }));
      if (last12.length === 0) {
        h(`(no comments in the last 24h — widen the window manually if needed)`);
      }
      for (const c of last12) {
        h(`- [${c.id}] ${c.created_at} — ${trunc(c.body || "", 140)}`);
      }
    } catch (err) {
      h(`unavailable: parse error (${err.message})`);
    }
  } else {
    h(`unavailable: ${comments.error}`);
  }
}
h(``);

// ---------------------------------------------------------------------------
// Local worktrees
// ---------------------------------------------------------------------------
h(`## Local worktrees`);
{
  const wt = tryRun("git", ["worktree", "list", "--porcelain"]);
  if (wt.ok) {
    const blocks = wt.out.split(/\n\n+/).filter(Boolean);
    const worktrees = [];
    for (const block of blocks) {
      const m = block.match(/^worktree (.+)$/m);
      if (m) worktrees.push(m[1].trim());
    }
    h(`- Count: ${worktrees.length}`);
    report.worktreeCount = worktrees.length;

    // Run status checks concurrently (a serial pass over ~90 worktrees on
    // Windows can take minutes); a bounded pool keeps this fast without
    // hammering disk I/O.
    const statuses = await pooled(worktrees, 12, async (path) => {
      const status = await tryRunAsync("git", ["-C", path, "status", "--porcelain"]);
      if (!status.ok) return null;
      const n = status.out.split("\n").filter((l) => l.trim().length > 0).length;
      return n > 0 ? { path, count: n } : null;
    });
    const dirty = statuses.filter(Boolean);
    report.dirtyWorktrees = dirty;
    const shown = dirty.slice(0, 30);
    if (dirty.length === 0) {
      h(`- All worktrees are clean.`);
    } else {
      h(`- Uncommitted changes (${dirty.length}${dirty.length > 30 ? ", showing first 30" : ""}):`);
      for (const d of shown) h(`  - ${d.path} (${d.count} changed)`);
    }
  } else {
    h(`- unavailable: ${wt.error}`);
  }
}
h(``);

// ---------------------------------------------------------------------------
// Bug registry counts
// ---------------------------------------------------------------------------
h(`## Bug registry counts`);
{
  const registryPath = join(REPO_ROOT, ".claude", "campaign", "bugs.jsonl");
  if (!existsSync(registryPath)) {
    h(`- registry file absent`);
  } else {
    try {
      const raw = readFileSync(registryPath, "utf8");
      const recs = raw
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const isOpen = (r) => /^open$/i.test(String(r.register ?? r.status ?? "").trim());
      const openRecs = recs.filter(isOpen);
      const bySeverity = {};
      for (const r of openRecs) {
        const sev = String(r.severity ?? "unknown").toLowerCase();
        bySeverity[sev] = (bySeverity[sev] || 0) + 1;
      }
      report.bugRegistry = { total: recs.length, open: openRecs.length, bySeverity };
      h(`- Total records: ${recs.length}, open: ${openRecs.length}`);
      const order = ["critical", "high", "medium", "low"];
      const seen = new Set();
      for (const sev of order) {
        if (bySeverity[sev] !== undefined) {
          h(`  - ${sev}: ${bySeverity[sev]}`);
          seen.add(sev);
        }
      }
      for (const [sev, n] of Object.entries(bySeverity)) {
        if (!seen.has(sev)) h(`  - ${sev}: ${n}`);
      }
    } catch (err) {
      h(`- unavailable: ${err.message}`);
    }
  }
}
h(``);

// ---------------------------------------------------------------------------
// Pointers
// ---------------------------------------------------------------------------
h(`## Pointers`);
{
  // Newest file in .claude/handoffs/
  const handoffsDir = join(REPO_ROOT, ".claude", "handoffs");
  try {
    const entries = readdirSync(handoffsDir)
      .filter((f) => statSync(join(handoffsDir, f)).isFile())
      .map((f) => ({ f, mtime: statSync(join(handoffsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (entries.length > 0) {
      report.newestHandoff = entries[0].f;
      h(
        `- Newest .claude/handoffs/ file: ${entries[0].f} (${new Date(entries[0].mtime).toISOString()})`,
      );
    } else {
      h(`- .claude/handoffs/: empty`);
    }
  } catch (err) {
    h(`- .claude/handoffs/: unavailable: ${err.message}`);
  }

  // Today's local-assets/handoff/<today>/
  const today = new Date().toISOString().slice(0, 10);
  const todayDir = join(REPO_ROOT, "local-assets", "handoff", today);
  try {
    if (existsSync(todayDir)) {
      const files = readdirSync(todayDir);
      report.todayHandoffDir = { path: `local-assets/handoff/${today}`, files };
      h(`- local-assets/handoff/${today}/: ${files.length ? files.join(", ") : "(empty)"}`);
    } else {
      h(`- local-assets/handoff/${today}/: does not exist yet`);
    }
  } catch (err) {
    h(`- local-assets/handoff/${today}/: unavailable: ${err.message}`);
  }
}
h(``);

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const markdown = lines.join("\n");

if (wantJson) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  process.stdout.write(markdown + "\n");
}

if (outFile) {
  writeFileSync(resolve(outFile), markdown + "\n", "utf8");
}
