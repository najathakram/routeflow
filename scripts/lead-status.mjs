#!/usr/bin/env node
// lead-status.mjs — one read-only command that prints the fleet lead's facts (ruling SA-754).
//
// Sections (each fails soft: a section that cannot be gathered prints `UNKNOWN: <reason>`):
//   1 master      origin/master sha + last 3 merged PR subjects
//   2 visibility  repo visibility; PUBLIC prints a banner ("runner minter must be off")
//   3 trains      origin train/* branches: sha + whether merged into master
//   4 prs         open PRs joined with local-assets/lead/verdicts.jsonl (latest verdict per PR;
//                 STALE when the verdict sha is not the PR head; NO VERDICT when none)
//   5 ledger      local-assets/lead/branches.json vs origin: FOUND / MOVED / MISSING / LOCAL-ONLY
//   6 migrations  repo vs open PRs vs local-assets/lead/prod-migrations.json (offline diffs);
//                 `--prod` only PRINTS the read-only drift command, it never runs it
//   7 board       (`--board`) last 5 comments on the board issue
//
// Exit 0 always, except: `--strict` exits 3 when any section is UNKNOWN or STALE; a run with no
// sections selected is an error (exit 2), never a silent pass. Writes nothing except `--out <file>`.
//
// Usage:
//   node scripts/lead-status.mjs [--json] [--strict] [--board] [--prod] [--only a,b] [--out <file>]
//   node scripts/lead-status.mjs --self-test
//
// local-assets/ is gitignored; templates for the three input files are in
// scripts/lead-status.examples/. LEAD_ASSETS_DIR overrides the directory (a linked worktree has
// no local-assets of its own, so the main checkout's is used as a fallback).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeProc } from "./lib/proc.mjs";

const REPO = "najathakram/routeflow";
const BOARD_ISSUE = Number(process.env.FLEET_BOARD_ISSUE || 2554);
const MIGRATIONS_PATH = "apps/api/prisma/migrations";
const DRIFT_CMD = "railway run --service postgres node apps/api/scripts/schema-drift.mjs";
const VERDICT_VALUES = ["PASS", "PASS-WITH-NITS", "FAIL", "HOLD"];

export const ALL_SECTION_IDS = ["master", "visibility", "trains", "prs", "ledger", "migrations"];
const SECTION_IDS = [...ALL_SECTION_IDS, "board"];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const trunc = (s, n) => {
  const flat = String(s)
    .replace(/\r?\n+/g, " ")
    .trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
};
const short = (sha) => String(sha || "").slice(0, 9);

// Runs `fn(item)` over `items` with at most `limit` in flight; results keep input order.
async function pooled(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function shaEq(a, b) {
  if (!a || !b || a.length < 7 || b.length < 7) return false;
  return a.startsWith(b) || b.startsWith(a);
}

function section(id, title, status, lines, data = {}) {
  return { id, title, status, lines, data };
}
const unknown = (id, title, reason) => section(id, title, "UNKNOWN", [`UNKNOWN: ${reason}`]);

function parseJson(text, what) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: `${what}: parse error (${err.message})` };
  }
}

// `git ls-remote` output -> [{ sha, ref }]
function parseLsRemote(out) {
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [sha, ref] = l.split("\t");
      return { sha: (sha || "").trim(), ref: (ref || "").trim() };
    });
}

// Reads a required local-assets file; returns { ok, text } or { ok:false, error }.
function readAsset(ctx, name) {
  const text = ctx.readText(name);
  if (text == null) {
    return {
      ok: false,
      error: `local-assets/lead/${name} missing (see scripts/lead-status.examples/)`,
    };
  }
  return { ok: true, text };
}

// ---------------------------------------------------------------------------
// 1 master
// ---------------------------------------------------------------------------

async function sectionMaster(ctx) {
  const title = "Master";
  const lines = [];
  let status = "OK";
  const data = {};
  const sha = await ctx.exec("git", ["ls-remote", "origin", "refs/heads/master"]);
  if (sha.ok) {
    const first = parseLsRemote(sha.out)[0];
    data.sha = first?.sha || null;
    lines.push(first ? `origin/master: ${first.sha}` : "UNKNOWN: origin has no refs/heads/master");
    if (!first) status = "UNKNOWN";
  } else {
    lines.push(`UNKNOWN: ${sha.error}`);
    status = "UNKNOWN";
  }
  const merged = await ctx.exec("gh", [
    "pr",
    "list",
    "--repo",
    REPO,
    "--state",
    "merged",
    "--limit",
    "3",
    "--json",
    "number,title",
  ]);
  if (merged.ok) {
    const parsed = parseJson(merged.out, "merged PRs");
    if (parsed.ok) {
      data.recentMerges = parsed.value;
      lines.push("last 3 merged PRs:");
      for (const pr of parsed.value) lines.push(`  #${pr.number} ${trunc(pr.title, 90)}`);
    } else {
      lines.push(`UNKNOWN: ${parsed.error}`);
      status = "UNKNOWN";
    }
  } else {
    lines.push(`UNKNOWN: ${merged.error}`);
    status = "UNKNOWN";
  }
  return section("master", title, status, lines, data);
}

// ---------------------------------------------------------------------------
// 2 visibility
// ---------------------------------------------------------------------------

async function sectionVisibility(ctx) {
  const title = "Visibility";
  const res = await ctx.exec("gh", ["repo", "view", REPO, "--json", "visibility"]);
  if (!res.ok) return unknown("visibility", title, res.error);
  const parsed = parseJson(res.out, "repo view");
  if (!parsed.ok) return unknown("visibility", title, parsed.error);
  const vis = String(parsed.value.visibility || "").toUpperCase();
  if (!vis) return unknown("visibility", title, "gh returned no visibility");
  const lines = [vis];
  if (vis === "PUBLIC") {
    lines.unshift("*** REPO IS PUBLIC ***");
    lines.push("runner minter must be off while the repo is public");
  }
  return section("visibility", title, "OK", lines, { visibility: vis });
}

// ---------------------------------------------------------------------------
// 3 trains
// ---------------------------------------------------------------------------

async function sectionTrains(ctx) {
  const title = "Trains";
  const res = await ctx.exec("git", ["ls-remote", "origin", "refs/heads/train/*"]);
  if (!res.ok) return unknown("trains", title, res.error);
  const trains = parseLsRemote(res.out);
  if (trains.length === 0)
    return section("trains", title, "OK", ["(no train/* branches on origin)"]);
  const lines = [];
  let status = "OK";
  const data = [];
  for (const t of trains) {
    const name = t.ref.replace(/^refs\/heads\//, "");
    const anc = await ctx.exec("git", ["merge-base", "--is-ancestor", t.sha, "origin/master"]);
    let verdict;
    if (anc.ok) verdict = "merged into master";
    else if (anc.code === 1) verdict = "NOT merged";
    else {
      verdict = `UNKNOWN: ${anc.error || "merge-base failed"} (git fetch origin?)`;
      status = "UNKNOWN";
    }
    data.push({ name, sha: t.sha, merged: anc.ok ? true : anc.code === 1 ? false : null });
    lines.push(`${name} @${short(t.sha)}  ${verdict}`);
  }
  return section("trains", title, status, lines, { trains: data });
}

// ---------------------------------------------------------------------------
// 4 open PRs x verdicts
// ---------------------------------------------------------------------------

function latestVerdicts(text) {
  const byPr = new Map();
  let bad = 0;
  text.split(/\r?\n/).forEach((line, idx) => {
    if (!line.trim()) return;
    let v;
    try {
      v = JSON.parse(line);
    } catch {
      bad++;
      return;
    }
    if (!v || v.pr == null || !v.sha || !VERDICT_VALUES.includes(v.verdict)) {
      bad++;
      return;
    }
    const key = Number(v.pr);
    const cur = byPr.get(key);
    const at = Date.parse(v.at) || 0;
    // later `at` wins; ties go to the later line in the file
    if (!cur || at >= cur.atMs) byPr.set(key, { ...v, atMs: at, idx });
  });
  return { byPr, bad };
}

async function sectionPrs(ctx) {
  const title = "Open PRs";
  const res = await ctx.exec("gh", [
    "pr",
    "list",
    "--repo",
    REPO,
    "--limit",
    "100",
    "--state",
    "open",
    "--json",
    "number,title,headRefName,headRefOid,isDraft,mergeable,mergeStateStatus,baseRefName",
  ]);
  if (!res.ok) return unknown("prs", title, res.error);
  const parsed = parseJson(res.out, "open PRs");
  if (!parsed.ok) return unknown("prs", title, parsed.error);
  const prs = parsed.value.slice().sort((a, b) => a.number - b.number);

  const asset = readAsset(ctx, "verdicts.jsonl");
  const verdicts = asset.ok ? latestVerdicts(asset.text) : { byPr: new Map(), bad: 0 };

  let status = "OK";
  const lines = [];
  const data = [];
  if (!asset.ok) {
    status = "UNKNOWN";
    lines.push(`UNKNOWN: ${asset.error}`);
  }
  if (verdicts.bad)
    lines.push(`note: ${verdicts.bad} unreadable line(s) in verdicts.jsonl skipped`);
  lines.push("# | head | draft | conflicting | base | verdict | title");
  for (const pr of prs) {
    const v = verdicts.byPr.get(pr.number);
    let verdictText;
    let state;
    if (!asset.ok) {
      verdictText = "UNKNOWN: verdicts.jsonl missing";
      state = "UNKNOWN";
    } else if (!v) {
      verdictText = "NO VERDICT";
      state = "NONE";
    } else if (!shaEq(v.sha, pr.headRefOid)) {
      verdictText = `STALE: ${v.verdict} @${short(v.sha)} by ${v.reviewer || "?"} (head ${short(pr.headRefOid)})`;
      state = "STALE";
      if (status === "OK") status = "STALE";
    } else {
      verdictText = `${v.verdict} @${short(v.sha)} by ${v.reviewer || "?"}${v.ref ? ` [${v.ref}]` : ""}`;
      state = v.verdict;
    }
    const base = pr.baseRefName === "master" ? "master" : `stacked:${pr.baseRefName}`;
    lines.push(
      [
        `#${pr.number}`,
        short(pr.headRefOid),
        pr.isDraft ? "draft" : "-",
        pr.mergeable === "CONFLICTING" ? "conflicting" : "-",
        base,
        verdictText,
        trunc(pr.title, 60),
      ].join(" | "),
    );
    data.push({
      number: pr.number,
      head: pr.headRefOid,
      draft: !!pr.isDraft,
      base: pr.baseRefName,
      state,
    });
  }
  if (prs.length === 0) lines.push("(none open)");
  return section("prs", title, status, lines, { prs: data });
}

// ---------------------------------------------------------------------------
// 5 ledger branches
// ---------------------------------------------------------------------------

async function sectionLedger(ctx) {
  const title = "Ledger branches";
  const asset = readAsset(ctx, "branches.json");
  if (!asset.ok) return unknown("ledger", title, asset.error);
  const parsed = parseJson(asset.text, "branches.json");
  if (!parsed.ok) return unknown("ledger", title, parsed.error);
  if (!Array.isArray(parsed.value))
    return unknown("ledger", title, "branches.json is not an array");

  const lines = [];
  const data = [];
  let status = "OK";
  const bump = (s) => {
    if (status === "OK" || (status === "STALE" && s === "UNKNOWN")) status = s;
  };
  for (const e of parsed.value) {
    const label = `${e.branch} (${e.machine || "?"}${e.pr ? `, #${e.pr}` : ""})`;
    const expect = e.expectOnOrigin !== false;
    const res = await ctx.exec("git", ["ls-remote", "origin", `refs/heads/${e.branch}`]);
    if (!res.ok) {
      lines.push(`${label}  UNKNOWN: ${res.error}`);
      bump("UNKNOWN");
      data.push({ branch: e.branch, state: "UNKNOWN" });
      continue;
    }
    const remote = parseLsRemote(res.out)[0];
    let state;
    if (!remote) {
      if (expect) {
        state = "MISSING";
        lines.push(`${label}  MISSING on origin (ledger @${short(e.sha)})`);
        bump("STALE");
      } else {
        state = "LOCAL-ONLY";
        lines.push(
          `${label}  LOCAL-ONLY on ${e.machine || "?"} @${short(e.sha)} (not verifiable from here)`,
        );
      }
    } else if (!expect) {
      state = "NOW-ON-ORIGIN";
      lines.push(
        `${label}  now on origin @${short(remote.sha)} (ledger said local-only @${short(e.sha)}); update the ledger`,
      );
      bump("STALE");
    } else if (shaEq(remote.sha, e.sha)) {
      state = "FOUND";
      lines.push(`${label}  FOUND @${short(remote.sha)}`);
    } else {
      state = "MOVED";
      lines.push(`${label}  MOVED origin @${short(remote.sha)} (ledger @${short(e.sha)})`);
      bump("STALE");
    }
    if (e.note) lines[lines.length - 1] += `  -- ${trunc(e.note, 60)}`;
    data.push({ branch: e.branch, state });
  }
  if (parsed.value.length === 0) lines.push("(ledger is empty)");
  return section("ledger", title, status, lines, { branches: data });
}

// ---------------------------------------------------------------------------
// 6 migrations (offline diffs)
// ---------------------------------------------------------------------------

const migrationFolderOf = (path) => {
  if (!path.startsWith(`${MIGRATIONS_PATH}/`)) return null;
  const rest = path.slice(MIGRATIONS_PATH.length + 1).split("/");
  return rest.length >= 2 && rest[0] ? rest[0] : null; // files directly under migrations/ are not folders
};

async function sectionMigrations(ctx) {
  const title = "Migrations";
  const lines = [];
  const problems = [];
  const data = {};

  // repo list
  const tree = await ctx.exec("git", ["ls-tree", "origin/master", `${MIGRATIONS_PATH}/`]);
  let repo = null;
  if (tree.ok) {
    repo = new Set(
      tree.out
        .split(/\r?\n/)
        .filter((l) => /^\d+ tree /.test(l))
        .map((l) => l.split("\t")[1]?.split("/").pop())
        .filter(Boolean),
    );
  } else problems.push(`repo list: ${tree.error} (git fetch origin?)`);

  // open-PR migration folders -> Map(folder -> [pr numbers])
  let carriers = null;
  const list = await ctx.exec("gh", [
    "pr",
    "list",
    "--repo",
    REPO,
    "--limit",
    "100",
    "--state",
    "open",
    "--json",
    "number",
  ]);
  if (list.ok) {
    const parsed = parseJson(list.out, "open PR numbers");
    if (parsed.ok) {
      carriers = new Map();
      const numbers = parsed.value.map((p) => p.number).sort((a, b) => a - b);
      const diffs = await pooled(numbers, 6, (n) =>
        ctx.exec("gh", ["pr", "diff", String(n), "--name-only"]),
      );
      numbers.forEach((number, i) => {
        const diff = diffs[i];
        if (!diff.ok) {
          problems.push(`PR #${number} diff: ${diff.error}`);
          return;
        }
        for (const f of new Set(diff.out.split(/\r?\n/).map(migrationFolderOf).filter(Boolean))) {
          carriers.set(f, [...(carriers.get(f) || []), number]);
        }
      });
    } else problems.push(parsed.error);
  } else problems.push(`open PR list: ${list.error}`);

  // prod list
  let prod = null;
  let prodMeta = null;
  const asset = readAsset(ctx, "prod-migrations.json");
  if (asset.ok) {
    const parsed = parseJson(asset.text, "prod-migrations.json");
    if (parsed.ok && Array.isArray(parsed.value.folders)) {
      prod = new Set(parsed.value.folders);
      prodMeta = parsed.value;
    } else problems.push(parsed.ok ? "prod-migrations.json has no folders[]" : parsed.error);
  } else problems.push(asset.error);

  const carrierText = (f) => {
    const prs = carriers?.get(f);
    return prs ? ` (carried by ${prs.map((n) => `#${n}`).join(", ")})` : "";
  };

  if (prodMeta) {
    lines.push(`prod list recorded ${prodMeta.recordedAt || "?"} at ${prodMeta.sittingRef || "?"}`);
  }
  if (prod && repo) {
    const inProdNotMaster = [...prod].filter((f) => !repo.has(f)).sort();
    const onMasterNotProd = [...repo].filter((f) => !prod.has(f)).sort();
    lines.push(
      "in prod, not on master (expected until the carrying PRs merge):",
      ...(inProdNotMaster.length
        ? inProdNotMaster.map(
            (f) => `  ${f}${carriers ? carrierText(f) || " (no open PR carries it)" : ""}`,
          )
        : ["  (none)"]),
      "on master, not in prod -- DANGER (deployed code expects a table prod does not have):",
      ...(onMasterNotProd.length ? onMasterNotProd.map((f) => `  ${f}`) : ["  (none)"]),
    );
    data.inProdNotMaster = inProdNotMaster;
    data.onMasterNotProd = onMasterNotProd;
  } else {
    lines.push("in prod / master diffs: UNKNOWN (need both the repo list and the prod list)");
  }
  if (carriers && repo) {
    const pending = [...carriers.keys()].filter((f) => !repo.has(f)).sort();
    lines.push(
      "pending in open PRs (not yet on master):",
      ...(pending.length ? pending.map((f) => `  ${f}${carrierText(f)}`) : ["  (none)"]),
    );
    data.pending = pending;
  } else {
    lines.push("pending in open PRs: UNKNOWN");
  }
  for (const p of problems) lines.push(`UNKNOWN: ${p}`);
  if (ctx.opts.prod) {
    lines.push(
      "prod schema drift (read-only; this script does NOT run it):",
      `  ${DRIFT_CMD}`,
      "  warn-then-approve: tell the owner it will read prod through railway, wait for a yes, expect exit 0 = no drift.",
    );
  }
  return section("migrations", title, problems.length ? "UNKNOWN" : "OK", lines, data);
}

// ---------------------------------------------------------------------------
// 7 board
// ---------------------------------------------------------------------------

async function sectionBoard(ctx) {
  const title = `Board #${ctx.boardIssue}`;
  const base = `repos/${ctx.repo}/issues/${ctx.boardIssue}`;
  const issue = await ctx.exec("gh", ["api", base]);
  if (!issue.ok) return unknown("board", title, issue.error);
  const parsed = parseJson(issue.out, "board issue");
  if (!parsed.ok) return unknown("board", title, parsed.error);
  const count = Number(parsed.value.comments) || 0;
  if (count === 0) return section("board", title, "OK", ["(no comments)"]);
  const perPage = 5;
  const lastPage = Math.ceil(count / perPage);
  let items = [];
  for (const page of [lastPage, lastPage - 1].filter((p) => p >= 1)) {
    const res = await ctx.exec("gh", ["api", `${base}/comments?per_page=${perPage}&page=${page}`]);
    if (!res.ok) return unknown("board", title, res.error);
    const p = parseJson(res.out, "board comments");
    if (!p.ok) return unknown("board", title, p.error);
    items = [...p.value, ...items];
    if (items.length >= perPage) break;
  }
  const last = items.slice(-perPage);
  const lines = [`${count} comments total`];
  for (const c of last) lines.push(`[${c.id}] ${c.created_at} ${trunc(c.body || "", 140)}`);
  return section("board", title, "OK", lines, { count });
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

const RUNNERS = {
  master: sectionMaster,
  visibility: sectionVisibility,
  trains: sectionTrains,
  prs: sectionPrs,
  ledger: sectionLedger,
  migrations: sectionMigrations,
  board: sectionBoard,
};

export async function runSections(ids, ctx) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("no sections configured: refusing to report a pass with nothing checked");
  }
  for (const id of ids) {
    if (!RUNNERS[id]) throw new Error(`unknown section "${id}" (known: ${SECTION_IDS.join(", ")})`);
  }
  const out = [];
  for (const id of ids) {
    try {
      out.push(await RUNNERS[id](ctx));
    } catch (err) {
      out.push(unknown(id, id, `internal error: ${err.message}`));
    }
  }
  return out;
}

export function exitCodeFor(sections, strict) {
  if (!strict) return 0;
  return sections.some((s) => s.status === "UNKNOWN" || s.status === "STALE") ? 3 : 0;
}

export function renderText(sections) {
  const out = [];
  sections.forEach((s) => {
    const n = SECTION_IDS.indexOf(s.id) + 1;
    out.push(`== ${n} ${s.title} [${s.status}] ==`, ...s.lines, "");
  });
  return out.join("\n");
}

function makeRealCtx(opts) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const proc = makeProc(root);
  let assets = process.env.LEAD_ASSETS_DIR || join(root, "local-assets", "lead");
  if (!process.env.LEAD_ASSETS_DIR && !existsSync(assets)) {
    const common = proc.tryRun("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (common.ok) {
      const alt = join(dirname(common.out.trim()), "local-assets", "lead");
      if (existsSync(alt)) assets = alt;
    }
  }
  return {
    exec: (cmd, args) => proc.tryRunAsync(cmd, args),
    readText: (name) => {
      try {
        return readFileSync(join(assets, name), "utf8");
      } catch {
        return null;
      }
    },
    repo: REPO,
    boardIssue: BOARD_ISSUE,
    opts,
  };
}

export async function main(argv) {
  if (argv.includes("--self-test")) {
    await import("./lead-status.self-test.mjs");
    return;
  }
  const flag = (f) => argv.includes(f);
  const val = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
  const opts = { strict: flag("--strict"), prod: flag("--prod"), json: flag("--json") };
  const only = val("--only");
  const ids = only
    ? only
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [...ALL_SECTION_IDS, ...(flag("--board") ? ["board"] : [])];

  let sections;
  try {
    sections = await runSections(ids, makeRealCtx(opts));
  } catch (err) {
    console.error(`lead-status: ${err.message}`);
    process.exitCode = 2;
    return;
  }
  const code = exitCodeFor(sections, opts.strict);
  const body = opts.json
    ? JSON.stringify({ generatedAt: new Date().toISOString(), exit: code, sections }, null, 2)
    : `# lead-status ${new Date().toISOString()}\n\n${renderText(sections)}`;
  console.log(body);
  const outFile = val("--out");
  if (outFile) writeFileSync(outFile, body + "\n");
  process.exitCode = code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`lead-status: ${err.stack || err}`);
    process.exitCode = 2;
  });
}
