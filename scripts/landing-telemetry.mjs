#!/usr/bin/env node
// Landing telemetry (R1-b): one row per merged PR — route, review rounds, lines, rework-of and cost — so the factory
// scoreboard (metric 7) can say whether a routine helped. Read-only toward GitHub, git and the bug register; it writes
// only local-assets/telemetry/landings.jsonl in the MAIN checkout (append-only; readers merge rows per PR with
// latestByPr: gh facts from the newest row, cost from the newest costed row of each host).
// Spec: local-assets/handoff/2026-10-28/R1-landing-telemetry-SPEC.md.
//
// USAGE
//   node scripts/landing-telemetry.mjs --pr <n> [--json] [--dry-run]
//   node scripts/landing-telemetry.mjs --since <date> [--json] [--dry-run]
//     --pr        one merged PR (the ops-post-push merge confirmer runs this, detached)
//     --since     every PR merged since <date>: run by hand to back-fill merges the confirmer never saw
//     --json      print the rows
//     --dry-run   compute and print, write nothing
//     --fixture   <dir> read gh, board and transcript inputs from fixture files (self-test only)
// Exit 0 ok, 1 a source failed (named on stderr, nothing written), 2 usage.
//
// FIELDS AND THEIR BASIS (a basis says where the number came from; nothing is estimated)
//   route        HEAD/PR-body trailer `Factory-Route:` -> "trailer"; else inferred from the branch -> "inferred"; else "none"
//   reviewRounds distinct shas with a code-review verdict on the fleet board (verdictOf: first line names #<pr>
//                exactly, verdict PASS/FAIL/BLOCK after reviewer slot names are removed) -> "board"; none -> null
//   reworkOf     trailer `Rework-Of: #<n>` -> "trailer"; else the title citing #<n> beside fix/follow-up/revert/...,
//                or the body saying "revert/supersede/hotfix/follow-up to/rework of #<n>" -> "inferred"
//   costUsd      this host's transcript lines inside [first commit - 2 h, merge + 15 min]: lines on the PR branch ->
//                "branch", plus subagents whose description (else first prompt) names exactly this PR or branch and
//                no other PR -> "mention"; none -> null, never 0. A row says which host it saw.
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
import { fileURLToPath } from "node:url";

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

// A body names rework only in these explicit phrases; "Fixes #2554" (an issue) or "from the #3869 review" (a stacked
// feature) is not rework, and trailers such as `Bookkeeping-Follow-Up:` never match.
const BODY_REWORK_RE =
  /\b(?:revert(?:s|ed)?|supersed(?:e|es|ed)|hotfix(?:es)? for|follow-?up to|rework of)\s+#(\d{3,5})(?!\d)/i;

export function reworkOf(pr) {
  const t = trailerOf(pr, "Rework-Of")?.match(/#?(\d+)/)?.[1];
  if (t) return { reworkOf: Number(t), reworkBasis: "trailer" };
  const title = String(pr.title ?? "");
  for (const m of title.matchAll(/#(\d{3,5})(?!\d)/g)) {
    const n = Number(m[1]);
    const near = title.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
    if (n !== pr.number && REWORK_WORD.test(near)) return { reworkOf: n, reworkBasis: "inferred" };
  }
  const b = String(pr.body ?? "").match(BODY_REWORK_RE);
  if (b && Number(b[1]) !== pr.number) return { reworkOf: Number(b[1]), reworkBasis: "inferred" };
  return { reworkOf: null, reworkBasis: "none" };
}

// Reviewer slot names ("PASS 1 of 2", "PASS 2 (re-run)", "PASS 1 (sole)") are not verdicts.
const SLOT_RE = /\bPASS\s+\d+(?:\s+of\s+\d+)?(?:\s*\((?:sole|delta|re-run)\))?/g;
// Upper-case verdict words; HOLD and NOT CLEAN are verdicts that did not pass.
const VERDICT_RE = /\b(PASS|FAIL|BLOCK(?:ED)?|HOLD|NOT CLEAN)\b/g;
const BOLD_VERDICT_RE = /\*\*\s*(PASS|FAIL|BLOCK(?:ED)?|HOLD)\b[^*]{0,20}\*\*/;
// Gate results and rulings posted on the board are not code-review verdicts.
const NOT_REVIEW_RE = /^(?:DB lane|Re-proof|SA-\d+)\b|\b(?:apple-ux|mm-ux|UX)\b|follow-up:/i;

/**
 * One board comment -> { pr, sha, pass } when its first line is a code-review verdict, else null. The PR is the first
 * `#<n>` (exact number); the sha follows `@` or `at` (a backtick between is fine); the verdict is the LAST upper-case
 * PASS / FAIL / BLOCK once slot names are removed, so "PASS 2 · #3770 @ sha · PASS WITH NOTES" is one PASS.
 */
export function verdictOf(body) {
  const first =
    String(body ?? "")
      .split(/\r?\n/)
      .find((l) => l.trim()) ?? "";
  // Markdown out; a `#` stays only where it starts a PR number.
  const head = first
    .replace(/[*`_]+/g, " ")
    .replace(/#+(?!\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (NOT_REVIEW_RE.test(head)) return null;
  const pr = first.match(/#(\d{3,5})(?!\d)/)?.[1];
  if (!pr) return null;
  const sha = head.match(/(?:@|\bat)\s*([0-9a-f]{7,40})(?![0-9a-z])/i)?.[1]?.toLowerCase() ?? null;
  const words = [...head.replace(SLOT_RE, " ").matchAll(VERDICT_RE)];
  let verdict = words.at(-1)?.[1] ?? null;
  // "## review-c verdict: #3762 at <sha> (tier 1, PASS 1)" puts the verdict in bold on one of the next lines.
  if (!verdict)
    for (const l of String(body ?? "")
      .split(/\r?\n/)
      .filter((x) => x.trim())
      .slice(1, 4)) {
      verdict = l.match(BOLD_VERDICT_RE)?.[1] ?? null;
      if (verdict) break;
    }
  if (!verdict) return null;
  return { pr: Number(pr), sha: sha?.slice(0, 7) ?? null, pass: verdict === "PASS" };
}

/** Board comments (chronological) -> verdicts for one PR: rounds = distinct shas, firstPass = the first round all PASS. */
export function reviewOf(prNumber, comments) {
  const verdicts = [];
  comments.forEach((c, i) => {
    const v = verdictOf(c.body);
    // A verdict with no sha is its own round (keyed by its comment).
    if (v && v.pr === prNumber)
      verdicts.push({ round: v.sha ?? `comment-${c.id ?? i}`, pass: v.pass });
  });
  if (!verdicts.length)
    return { reviewRounds: null, firstPass: null, verdicts: null, reviewBasis: "none" };
  const firstRound = verdicts[0].round;
  return {
    reviewRounds: new Set(verdicts.map((v) => v.round)).size,
    firstPass: verdicts.filter((v) => v.round === firstRound).every((v) => v.pass),
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

/**
 * One merged row per PR. gh facts (route, rounds, lines...) come from the newest row; cost is summed over hosts, each
 * host's from its newest COSTED row, so a later re-run that found no transcripts (cleaned up, or another host) never
 * erases a cost already measured. `costHosts` names what each host contributed.
 */
export function latestByPr(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.pr)) groups.set(r.pr, []);
    groups.get(r.pr).push(r);
  }
  return [...groups.values()].map((g) => {
    g.sort((a, b) => String(a.computedAt).localeCompare(String(b.computedAt)));
    const base = g.at(-1);
    const byHost = {};
    for (const r of g) if (r.costUsd != null) byHost[r.host ?? "unknown"] = r;
    const hosts = Object.keys(byHost).sort();
    if (!hosts.length) return { ...base, costHosts: null };
    const newestCosted = hosts
      .map((h) => byHost[h])
      .sort((a, b) => String(a.computedAt).localeCompare(String(b.computedAt)))
      .at(-1);
    const sum = hosts.reduce((s, h) => s + byHost[h].costUsd, 0);
    return {
      ...base,
      costUsd: Math.round(sum * 1e6) / 1e6,
      costBasis: newestCosted.costBasis,
      costHosts: Object.fromEntries(hosts.map((h) => [h, byHost[h].costUsd])),
    };
  });
}

const SLACK_BEFORE_MS = 2 * 3_600_000;
const SLACK_AFTER_MS = 15 * 60_000;

/** [lo, hi] for transcript lines that can belong to the PR: first commit (or creation) - 2 h .. merge + 15 min. */
export function costWindow(pr) {
  const starts = [
    pr.createdAt,
    ...(pr.commits ?? []).flatMap((c) => [c.authoredDate, c.committedDate]),
  ]
    .map((d) => Date.parse(d))
    .filter(Number.isFinite);
  const merged = Date.parse(pr.mergedAt);
  return {
    lo: starts.length ? Math.min(...starts) - SLACK_BEFORE_MS : 0,
    hi: Number.isFinite(merged) ? merged + SLACK_AFTER_MS : Infinity,
  };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── cost from this host's transcripts ────────────────────────────────────────────────────────

/** Sum session-usage's own accounting over the transcript lines that belong to the PR. */
export async function costFor(pr, { transcriptDir }) {
  // A literal specifier: scripts-live-target-guard.spec counts a computed import() as a possible DB client.
  const su = await import("../.claude/skills/model-routing/scripts/session-usage.mjs");
  if (!transcriptDir || !existsSync(transcriptDir)) return null;
  const { table } = su.loadPriceTable({});
  const warnings = [];
  const records = [];
  const bases = new Set();
  const { lo, hi } = costWindow(pr);
  const inWindow = (o) => {
    const t = Date.parse(o.timestamp);
    return Number.isFinite(t) && t >= lo && t <= hi;
  };
  // Exact references only: #387 never matches "#3874", and fix/w785 never matches fix/w785-followups.
  const prRe = new RegExp(`#${pr.number}(?!\\d)`);
  const branchRe = pr.headRefName
    ? new RegExp(`(?<![\\w./-])${escapeRe(pr.headRefName)}(?![\\w./-])`)
    : null;
  const prsNamed = (s) => new Set([...s.matchAll(/#(\d{3,5})(?!\d)/g)].map((m) => m[1]));
  // A subagent is billed to this PR only when it names this PR (or branch) and no other PR: one that names two is
  // shared work, and billing it in full to both would make the rows add up to more than was spent.
  const namesOnlyThis = (s) =>
    (prRe.test(s) || (branchRe?.test(s) ?? false)) &&
    [...prsNamed(s)].every((n) => Number(n) === pr.number);
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
    // Coarse pre-filter only: a file last written before the window opened holds no line inside it.
    if (statSync(full).mtimeMs < lo) continue;
    if (sub) {
      // The description says what the agent was for; the prompt may cite other PRs as examples, so it is read only
      // when there is no description.
      let desc = "";
      try {
        desc = String(
          JSON.parse(readFileSync(full.replace(/\.jsonl$/, ".meta.json"), "utf8")).description ??
            "",
        );
      } catch {
        /* no meta */
      }
      const text = desc.trim() ? desc : readFileSync(full, "utf8").slice(0, 4000);
      if (namesOnlyThis(text)) {
        const mine = [...su.readUsageRecords(full, warnings, inWindow)];
        if (mine.length) {
          records.push(...mine);
          bases.add("mention");
        }
        continue;
      }
    }
    const onBranch = [
      ...su.readUsageRecords(full, warnings, (o) => o.gitBranch === pr.headRefName && inWindow(o)),
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

/**
 * The MAIN checkout, or null. Fail closed: the confirmer's detached child can outlive a worktree removed right after
 * the merge, and guessing a root there would re-create the deleted folder.
 */
function mainCheckoutRoot() {
  try {
    return path.dirname(
      run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(),
    );
  } catch {
    return null;
  }
}

/** ~/.claude/projects/<encoded main checkout>, as session-usage encodes it. */
function transcriptDirFor(root) {
  return root
    ? path.join(os.homedir(), ".claude", "projects", root.replace(/[^A-Za-z0-9]/g, "-"))
    : null;
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
  // `merged:a..b` is inclusive, so a PR merged on a slice boundary comes back twice.
  const merged = [...new Map(prs.filter((p) => p.mergedAt).map((p) => [p.number, p])).values()];
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
  try {
    for (const pr of inputs.prs) {
      const cost = await costFor(pr, { transcriptDir: inputs.transcriptDir });
      rows.push(landingRow(pr, { comments: inputs.comments, cost, host, nowIso: inputs.nowIso }));
    }
  } catch (e) {
    console.error(
      `landing-telemetry: cost source (session-usage / transcripts) failed, nothing written: ${String(e?.message ?? e).split("\n")[0]}`,
    );
    return 1;
  }
  if (!opts.dryRun && !opts.fixture && rows.length) {
    const root = mainCheckoutRoot();
    if (!root) {
      console.error("landing-telemetry: git cannot resolve the main checkout, nothing written");
      return 1;
    }
    const file = path.join(root, LANDINGS_FILE);
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
