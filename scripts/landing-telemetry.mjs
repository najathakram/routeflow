#!/usr/bin/env node
// Landing telemetry (R1-b): one row per merged PR — route, review rounds, lines, rework-of and cost — so the factory
// scoreboard (metric 7) can say whether a routine helped. Read-only toward GitHub, git and the bug register; it writes
// only local-assets/telemetry/landings.jsonl in the MAIN checkout (append-only; readers take the newest row per PR).
// Spec: local-assets/handoff/2026-10-28/R1-landing-telemetry-SPEC.md.
//
// USAGE
//   node scripts/landing-telemetry.mjs --pr <n> [--json] [--dry-run]
//   node scripts/landing-telemetry.mjs --since <date> [--json] [--dry-run]
//     --pr        one merged PR (the ops-post-push merge confirmer runs this, detached)
//     --since     every PR merged since <date> (the scoreboard runs this before it computes)
//     --json      print the rows
//     --dry-run   compute and print, write nothing
//     --fixture   <dir> read gh, board and transcript inputs from fixture files (self-test only)
// Exit 0 ok, 1 a source failed (named on stderr, nothing written), 2 usage.
//
// FIELDS AND THEIR BASIS (a basis says where the number came from; nothing is estimated)
//   route        HEAD/PR-body trailer `Factory-Route:` -> "trailer"; else inferred from the branch -> "inferred"; else "none"
//   reviewRounds distinct shas with a verdict on the fleet board (`**#<pr> ... @ <sha>...**`) -> "board"; none -> null
//   reworkOf     trailer `Rework-Of: #<n>` -> "trailer"; else a title/body citing #<n> beside fix/follow-up/fold/
//                revert/supersede/hotfix -> "inferred"
//   costUsd      this host's transcripts: lines on the PR branch -> "branch", plus subagents whose description or first
//                prompt names the PR or branch -> "mention"; none -> null, never 0. A row says which host it saw.
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const GH_REPO = "najathakram/routeflow";
const BOARD_ISSUE = Number(process.env.FLEET_BOARD_ISSUE || 3686);
export const LANDINGS_FILE = path.join("local-assets", "telemetry", "landings.jsonl");
export const ROUTES = [
  "dev-pipeline",
  "bug-pipeline",
  "bug-swarm",
  "lane",
  "light-loop",
  "train",
  "docs",
  "manual",
];
const PR_FIELDS =
  "number,title,headRefName,createdAt,mergedAt,mergeCommit,additions,deletions,changedFiles,body,commits";
const CMD_TIMEOUT_MS = 120_000;
const DAY_MS = 86_400_000;
const PR_LIMIT = 500;

class UsageError extends Error {}

// ── pure ─────────────────────────────────────────────────────────────────────────────────────

const trailer = (text, key) =>
  String(text ?? "").match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "im"))?.[1] ?? null;

/** Trailer text: the HEAD commit's message body, then the PR body. */
function trailerOf(pr, key) {
  const head = pr.commits?.[pr.commits.length - 1];
  return trailer(head?.messageBody, key) ?? trailer(pr.body, key);
}

export function routeOf(pr) {
  const t = trailerOf(pr, "Factory-Route")?.toLowerCase();
  if (t && ROUTES.includes(t)) return { route: t, routeBasis: "trailer" };
  const b = String(pr.headRefName ?? "").toLowerCase();
  const inferred = /^train\//.test(b)
    ? "train"
    : /swarm/.test(b)
      ? "bug-swarm"
      : /^bug\//.test(b)
        ? "bug-pipeline"
        : /(^|[/-])(w-?\d+|row-?\d+|sa-?\d+|b\d+)(\b|[-_])/.test(b)
          ? "lane"
          : /^docs\//.test(b)
            ? "docs"
            : null;
  return inferred
    ? { route: inferred, routeBasis: "inferred" }
    : { route: null, routeBasis: "none" };
}

const REWORK_WORD =
  /\b(fix(es|ed)?|follow-?ups?|fold(s|ed)?|revert(s|ed)?|supersed(e|es|ed)|hotfix|regress(ion)?)\b/i;

export function reworkOf(pr) {
  const t = trailerOf(pr, "Rework-Of")?.match(/#?(\d+)/)?.[1];
  if (t) return { reworkOf: Number(t), reworkBasis: "trailer" };
  for (const text of [pr.title, pr.body]) {
    for (const m of String(text ?? "").matchAll(/#(\d{3,5})\b/g)) {
      const n = Number(m[1]);
      const near = String(text).slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
      if (n !== pr.number && REWORK_WORD.test(near))
        return { reworkOf: n, reworkBasis: "inferred" };
    }
  }
  return { reworkOf: null, reworkBasis: "none" };
}

/** Board comments (chronological) -> verdicts for one PR: rounds = distinct shas, firstPass = first verdict PASS. */
export function reviewOf(prNumber, comments) {
  const verdicts = [];
  for (const c of comments) {
    const head = String(c.body ?? "").match(/^\*\*#(\d+)\b[^*]*?@\s*([0-9a-f]{7,40})[^*]*\*\*/);
    if (!head || Number(head[1]) !== prNumber) continue;
    const pass = /\bPASS/.test(head[0]) && !/\bFAIL|\bBLOCK/.test(head[0]);
    verdicts.push({ sha: head[2].slice(0, 7), pass });
  }
  if (!verdicts.length)
    return { reviewRounds: null, firstPass: null, verdicts: null, reviewBasis: "none" };
  return {
    reviewRounds: new Set(verdicts.map((v) => v.sha)).size,
    firstPass: verdicts[0].pass,
    verdicts: {
      pass: verdicts.filter((v) => v.pass).length,
      fail: verdicts.filter((v) => !v.pass).length,
    },
    reviewBasis: "board",
  };
}

export const typeOf = (title) =>
  String(title ?? "")
    .match(/^(\w+)(\(|!|:)/)?.[1]
    ?.toLowerCase() ?? null;

export function hostClass(name = os.hostname()) {
  const n = name.toLowerCase();
  return /mini/.test(n)
    ? "macmini"
    : /macbook|mbp/.test(n)
      ? "macbook"
      : /mac/.test(n)
        ? "mac"
        : "pc";
}

export function landingRow(pr, { comments, cost, host, nowIso }) {
  return {
    v: 1,
    pr: pr.number,
    mergedAt: pr.mergedAt ?? null,
    mergeSha: pr.mergeCommit?.oid ?? null,
    branch: pr.headRefName ?? null,
    title: pr.title ?? null,
    type: typeOf(pr.title),
    lines: (pr.additions ?? 0) + (pr.deletions ?? 0),
    files: pr.changedFiles ?? null,
    ...routeOf(pr),
    ...reviewOf(pr.number, comments),
    ...reworkOf(pr),
    costUsd: cost?.costUsd ?? null,
    costBasis: cost?.costUsd != null ? cost.basis : "none",
    host,
    computedAt: nowIso,
  };
}

/** Newest row per PR (rows from a later --pr or --since run supersede older ones). */
export function latestByPr(rows) {
  const out = new Map();
  for (const r of rows) {
    const prev = out.get(r.pr);
    if (!prev || String(r.computedAt) >= String(prev.computedAt)) out.set(r.pr, r);
  }
  return [...out.values()];
}

// ── cost from this host's transcripts ────────────────────────────────────────────────────────

/** Sum session-usage's own accounting over the transcript lines that belong to the PR. */
export async function costFor(pr, { transcriptDir, since }) {
  const su = await import(
    pathToFileURL(
      path.join(REPO_ROOT, ".claude", "skills", "model-routing", "scripts", "session-usage.mjs"),
    ).href
  );
  if (!transcriptDir || !existsSync(transcriptDir)) return null;
  const { table } = su.loadPriceTable({});
  const warnings = [];
  const records = [];
  const bases = new Set();
  const named = (s) =>
    s.includes(`#${pr.number}`) || (pr.headRefName && s.includes(pr.headRefName));
  const files = [];
  for (const f of readdirSync(transcriptDir)) {
    const full = path.join(transcriptDir, f);
    if (f.endsWith(".jsonl")) files.push({ full, sub: false });
    const subs = path.join(full, "subagents");
    if (existsSync(subs))
      for (const s of readdirSync(subs))
        if (s.endsWith(".jsonl")) files.push({ full: path.join(subs, s), sub: true });
  }
  for (const { full, sub } of files) {
    if (since && statSync(full).mtimeMs < since) continue;
    if (sub) {
      const meta = full.replace(/\.jsonl$/, ".meta.json");
      const head = readFileSync(full, "utf8").slice(0, 4000);
      const desc = existsSync(meta) ? readFileSync(meta, "utf8") : "";
      if (named(desc) || named(head)) {
        records.push(...su.readUsageRecords(full, warnings));
        bases.add("mention");
        continue;
      }
    }
    const onBranch = [
      ...su.readUsageRecords(full, warnings, (o) => o.gitBranch === pr.headRefName),
    ];
    if (onBranch.length) {
      records.push(...onBranch);
      bases.add("branch");
    }
  }
  if (!records.length) return null;
  const agg = su.aggregate(records, table, 600_000, warnings);
  // Same rule as the agent-log hook: one unpriced model makes the cost null, never a partial sum.
  if (Object.values(agg.byModel).some((b) => b.costUsd == null))
    return { costUsd: null, basis: "unpriced" };
  return { costUsd: agg.total.costUsd, basis: bases.has("branch") ? "branch" : "mention" };
}

// ── IO ───────────────────────────────────────────────────────────────────────────────────────

function run(cmd, args, cwd = REPO_ROOT) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: CMD_TIMEOUT_MS,
    shell: false,
    maxBuffer: 64 << 20,
  });
}

function mainCheckoutRoot() {
  try {
    return path.dirname(
      run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(),
    );
  } catch {
    return REPO_ROOT;
  }
}

/** ~/.claude/projects/<encoded main checkout>, as session-usage encodes it. */
function transcriptDirFor(root) {
  return path.join(os.homedir(), ".claude", "projects", root.replace(/[^A-Za-z0-9]/g, "-"));
}

function liveInputs(opts) {
  const prs = [];
  if (opts.pr)
    prs.push(
      JSON.parse(
        run("gh", ["pr", "view", String(opts.pr), "-R", GH_REPO, "--json", `${PR_FIELDS},state`]),
      ),
    );
  else {
    for (let start = Date.parse(opts.since); start < Date.now(); start += 7 * DAY_MS) {
      const a = new Date(start).toISOString().slice(0, 10);
      const b = new Date(Math.min(start + 7 * DAY_MS, Date.now() + DAY_MS))
        .toISOString()
        .slice(0, 10);
      const slice = JSON.parse(
        run("gh", [
          "pr",
          "list",
          "-R",
          GH_REPO,
          "--state",
          "merged",
          "--search",
          `merged:${a}..${b}`,
          "--limit",
          String(PR_LIMIT),
          "--json",
          PR_FIELDS,
        ]),
      );
      if (slice.length >= PR_LIMIT)
        throw new Error(`gh: slice ${a}..${b} hit the ${PR_LIMIT} limit`);
      prs.push(...slice);
    }
  }
  const merged = prs.filter((p) => p.mergedAt);
  const oldest = merged.map((p) => p.createdAt).sort()[0];
  const comments = oldest
    ? JSON.parse(
        run("gh", [
          "api",
          "--paginate",
          "--slurp",
          `repos/${GH_REPO}/issues/${BOARD_ISSUE}/comments?per_page=100&since=${oldest}`,
        ]),
      ).flat()
    : [];
  return {
    prs: merged,
    comments,
    transcriptDir: transcriptDirFor(mainCheckoutRoot()),
    nowIso: new Date().toISOString(),
  };
}

function fixtureInputs(dir) {
  const read = (f) => JSON.parse(readFileSync(path.join(dir, f), "utf8"));
  return {
    prs: read("gh-prs.json").filter((p) => p.mergedAt),
    comments: read("board-comments.json"),
    transcriptDir: path.join(dir, "transcripts"),
    nowIso: readFileSync(path.join(dir, "now.txt"), "utf8").trim(),
  };
}

const USAGE = `usage: node scripts/landing-telemetry.mjs (--pr <n> | --since <date>) [--json] [--dry-run] [--fixture <dir>]`;

export function parseArgs(argv) {
  const o = { json: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--pr" && /^\d+$/.test(argv[i + 1] ?? "")) o.pr = Number(argv[++i]);
    else if (a === "--since" && Number.isFinite(Date.parse(argv[i + 1] ?? ""))) o.since = argv[++i];
    else if (a === "--fixture" && argv[i + 1]) o.fixture = argv[++i];
    else throw new UsageError(USAGE);
  }
  if (!o.pr === !o.since) throw new UsageError(USAGE);
  return o;
}

export async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  let inputs;
  try {
    inputs = opts.fixture ? fixtureInputs(opts.fixture) : liveInputs(opts);
  } catch (e) {
    console.error(
      `landing-telemetry: a source failed, nothing written: ${e.message.split("\n")[0]}`,
    );
    return 1;
  }
  const host = opts.fixture ? "pc" : hostClass();
  const rows = [];
  for (const pr of inputs.prs) {
    const cost = await costFor(pr, {
      transcriptDir: inputs.transcriptDir,
      since: Date.parse(pr.createdAt) || 0,
    });
    rows.push(landingRow(pr, { comments: inputs.comments, cost, host, nowIso: inputs.nowIso }));
  }
  if (!opts.dryRun && !opts.fixture && rows.length) {
    const file = path.join(mainCheckoutRoot(), LANDINGS_FILE);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  console.log(
    opts.json
      ? JSON.stringify(rows)
      : `landing-telemetry: ${rows.length} row(s)${opts.dryRun || opts.fixture ? " (not written)" : ""}`,
  );
  return 0;
}

// Run only as a CLI (realpath, so a junctioned path still runs): the scoreboard imports this module.
const isCli = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (process.argv[1] && isCli()) {
  process.exitCode = await main(process.argv.slice(2));
}
