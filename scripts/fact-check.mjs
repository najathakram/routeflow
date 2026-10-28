#!/usr/bin/env node
// Fact-check (R0): verify the PR numbers, shas, branches, HH:MMZ stamps and "gate-complete/ready" claims in an outbound
// lead message against their primary sources at send time (gh, git ls-remote, local git, the clock). Read-only.
// Spec: local-assets/handoff/2026-10-28/R0-lead-fact-check-SPEC.md. Anchor: LEAD-LOG "Verify before instructing" (45x).
//
// USAGE
//   node scripts/fact-check.mjs [--file <path> | -] [--json]       text from a file or stdin (default stdin)
//   node scripts/fact-check.mjs --fixture <cases.json> --case <id>   self-test input, no gh/git/network
// Exit 0 clean (unverified tokens allowed), 1 at least one MISMATCH, 2 usage.
//
// RULES (each a self-test case in scripts/fixtures/fact-check/cases.json)
// - Fenced ``` blocks are quoted material and skipped; inline `code` is still checked (that is how heads are written).
// - A sha is 7-40 lowercase hex with at least one digit and one a-f letter, not touching letters, digits, "-" or "/".
// - A sha binds to the PR before it in the same clause only through a pairing word (@, head, at, as, pin, re-pin, sha);
//   "'s head" binds to the possessor; "master/base/onto/origin" between them unbinds it. Two or more PRs and shas in a
//   clause with no pairing is ambiguous: unverified, never a mismatch.
// - A bare sha must resolve in the local clone; when the clone was fetched over 30 min ago it is only unverified.
// - A stamp may not be more than 59 s ahead of now; over 12 h ahead means yesterday. Stamps carrying a date or after a
//   deadline word are skipped, except a header stamp (in the first three words of its line), which is always checked.
// - A ready claim needs a green rollup at the PR's current head: non-empty, every check completed SUCCESS/SKIPPED/
//   NEUTRAL, at least one SUCCESS. Negated or questioned claims are not claims. It checks CI only, not the PASSes.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FACT_CHECK_MODE = "warn"; // the enforcing flip is a separate diff with the owner's OK
const REPO = { owner: "najathakram", name: "routeflow" };
const CMD_TIMEOUT_MS = 8000;
const STALE_CLONE_MS = 30 * 60_000;
const STAMP_TOLERANCE_MS = 59_000;
const DAY_MS = 86_400_000;

const PR_RE = /(?<![\w#&/])#(\d{3,5})\b/g;
const SHA_RE = /(?<![0-9A-Za-z_/-])[0-9a-f]{7,40}(?![0-9A-Za-z_-])/g;
const BRANCH_RE =
  /(?<![\w/.-])(?:feat|fix|chore|docs|test|ci|refactor|perf|train|bug|swarm)\/[\w.\-/]*[A-Za-z0-9](?![\w/])/g;
const STAMP_RE = /(?<![\d:])(\d{2}):(\d{2})(?::(\d{2}))?Z\b/g;
const READY_RE =
  /gate[- ]complete|\bCI green\b|\bgreen CI\b|\bready to (?:land|merge)\b|\bready for (?:W\d+|merge|landing|the window|a window|the train)\b|#\d{3,5}\s+(?:is\s+)?ready\b(?!\?)/i;
const NEGATION_RE = /\bnot\s+(?:yet\s+)?(?:ready|green|gate)|\bnever\b|n't\b|\?|^\s*is\b/i;
const PAIR_RE = /(?:@|\(|\bhead\b|\bat\b|\bas\b|\bpinned\b|\bre-?pin\b|\bsha\b)/i;
const UNPAIR_RE = /\b(?:master|base|onto|origin|main)\b/i;
const DEADLINE_RE =
  /\b(?:by|until|before|after|reset|deadline|eta|target|due|window|closes|opens|at|next|resume|re-?check|from|expires?)\b|→|~/i;
const FILE_EXT_RE = /\.[A-Za-z]{1,5}$/;
// A branch name carries a digit or a dash after its prefix; a bare directory (docs/runbooks, test/fixtures) does not.
const BRANCH_SHAPE_RE = /^[^/]+\/.*[\d-]/;
// Optional bullet and speaker ("- Lead ", "Coordinator: ") before a line's own stamp.
const HEADER_LEAD_RE = /^\s*(?:[-*•]\s+)?(?:(?:Lead|Coordinator|SA|Lane)\b:?\s+|[\w-]+:\s+)?$/;
const DATED_RE = /(?:\d{2}-\d{2}\s*|T)$/;
const RANGE_END_RE = /\d{2}:\d{2}Z?\s*[-–]\s*$/;
const LANDED_RE = /\b(?:merged|landed|deleted|squashed)\b/i;

const isSha = (t) => /\d/.test(t) && /[a-f]/.test(t) && !/^\d+e\d+$/.test(t);
const short = (sha) => (sha ? sha.slice(0, 9) : "none");

/** Clauses with their line text; fenced blocks removed (line count kept so header detection still works). */
function clausesOf(text) {
  let fenced = false;
  const out = [];
  // "PR#3893" / "PR #3893" -> same-length "  #3893" so offsets stay true.
  const plain = String(text ?? "").replace(/\bPR(\s?)#/g, (m) => " ".repeat(m.length - 1) + "#");
  for (const raw of plain.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    let offset = 0;
    for (const clause of raw.split(/(?<=[;,|·—])|(?<=\.)\s+|(?<=\.)(?=#)/)) {
      out.push({ text: clause, line: raw, lineOffset: offset });
      offset += clause.length;
    }
  }
  return out;
}

const matchesOf = (re, s) => [...s.matchAll(new RegExp(re.source, re.flags))];

/** Pure: every fact token with its binding, in order PR, sha, branch, stamp, ready. */
export function extractTokens(text) {
  const prs = [];
  const shas = [];
  const branches = [];
  const stamps = [];
  const ready = [];
  for (const c of clausesOf(text)) {
    const prMs = matchesOf(PR_RE, c.text);
    for (const m of prMs) prs.push(m[1]);
    const shaMs = matchesOf(SHA_RE, c.text).filter((m) => isSha(m[0]));
    const ambiguous = prMs.length >= 2 && shaMs.length >= 2;
    for (const m of shaMs) {
      const before = c.text.slice(0, m.index);
      const poss = before.match(/#(\d{3,5})'s head\s*`?$/);
      const prev = [...prMs].reverse().find((p) => p.index < m.index);
      let pr = null;
      if (poss) pr = poss[1];
      else if (prev) {
        const between = c.text.slice(prev.index + prev[0].length, m.index);
        if (PAIR_RE.test(between) && !UNPAIR_RE.test(between)) pr = prev[1];
      }
      shas.push({ token: m[0], pr, ambiguous: ambiguous && !poss });
    }
    for (const m of matchesOf(BRANCH_RE, c.text))
      if (!FILE_EXT_RE.test(m[0]) && BRANCH_SHAPE_RE.test(m[0]))
        branches.push({ token: m[0], landed: LANDED_RE.test(c.text) });
    for (const m of matchesOf(STAMP_RE, c.text)) {
      const before = c.line.slice(0, c.lineOffset + m.index);
      // Dates and range ends are never "now" claims; a line's own header stamp always is; elsewhere deadlines skip.
      if (DATED_RE.test(before) || RANGE_END_RE.test(before)) continue;
      const header = HEADER_LEAD_RE.test(before);
      const lastWords = before.trim().split(/\s+/).slice(-3).join(" ");
      if (!header && DEADLINE_RE.test(lastWords)) continue;
      stamps.push({ token: m[0], h: +m[1], m: +m[2], s: +(m[3] ?? 0) });
    }
    if (READY_RE.test(c.text) && !NEGATION_RE.test(c.text)) for (const m of prMs) ready.push(m[1]);
  }
  return {
    prs: [...new Set(prs)],
    shas,
    branches: [...new Map(branches.map((b) => [b.token, b])).values()],
    stamps,
    ready: [...new Set(ready)],
  };
}

/** Pure: green means non-empty, every check completed SUCCESS/SKIPPED/NEUTRAL, at least one SUCCESS. */
export function rollupVerdict(rollup) {
  if (!rollup?.length) return { green: false, why: "no CI run at this head" };
  const bad = rollup.filter(
    (r) => r.status !== "COMPLETED" || !["SUCCESS", "SKIPPED", "NEUTRAL"].includes(r.conclusion),
  );
  if (bad.length)
    return {
      green: false,
      why: bad.map((r) => `${r.name} ${r.conclusion ?? r.status}`).join(", "),
    };
  if (!rollup.some((r) => r.conclusion === "SUCCESS"))
    return { green: false, why: "every check SKIPPED or NEUTRAL" };
  return { green: true, why: "green" };
}

/**
 * Pure: compare tokens with sources. sources = { nowMs, prs: {n: pr|{issue:true}|null} | null (gh down),
 * branches: Set | null, commit(sha) -> true|false|null, cloneFresh: bool }.
 */
export function checkFacts(text, sources) {
  const t = extractTokens(text);
  const hits = [];
  const unverified = [];
  const hit = (kind, token, claim, truth) => hits.push({ kind, token, claim, truth });
  const unv = (kind, token, why) => unverified.push({ kind, token, why });
  const prOf = (n) => sources.prs?.[n];

  for (const n of t.prs) {
    if (!sources.prs) unv("pr", `#${n}`, "gh unavailable");
    else if (!prOf(n)) hit("pr", `#${n}`, `#${n} exists`, "no issue or PR with that number");
  }
  for (const s of t.shas) {
    const pr = s.pr && prOf(s.pr);
    if (s.ambiguous) unv("sha", s.token, "several PRs and shas in one clause");
    else if (s.pr && !sources.prs) unv("sha", s.token, "gh unavailable");
    else if (pr && !pr.issue) {
      const ok = [pr.headRefOid, pr.state === "MERGED" ? pr.mergeCommit : null].some((x) =>
        x?.startsWith(s.token),
      );
      if (!ok)
        hit(
          "sha",
          s.token,
          `#${s.pr} is at ${s.token}`,
          `#${s.pr} ${pr.state} head is ${short(pr.headRefOid)}`,
        );
    } else if (!s.pr || pr?.issue) {
      const found = sources.commit(s.token);
      if (found === false && sources.cloneFresh)
        hit(
          "sha",
          s.token,
          `${s.token} is a commit`,
          "no such commit in a clone fetched under 30 min ago",
        );
      else if (found !== true)
        unv("sha", s.token, found === false ? "local clone older than 30 min" : "git unavailable");
    }
  }
  for (const { token: b, landed } of t.branches) {
    if (!sources.branches) unv("branch", b, "git ls-remote unavailable");
    else if (sources.branches.has(b)) continue;
    else if (landed) unv("branch", b, "absent on origin; merged branches are deleted");
    else hit("branch", b, `${b} exists`, "no such branch on origin");
  }
  for (const s of t.stamps) {
    const now = new Date(sources.nowMs);
    let at = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), s.h, s.m, s.s);
    if (at - sources.nowMs > DAY_MS / 2) at -= DAY_MS;
    if (at - sources.nowMs > STAMP_TOLERANCE_MS)
      hit("stamp", s.token, `it is ${s.token}`, `now is ${now.toISOString().slice(11, 19)}Z`);
  }
  for (const n of t.ready) {
    const pr = prOf(n);
    if (!sources.prs) unv("ready", `#${n}`, "gh unavailable");
    else if (pr && !pr.issue && pr.state === "OPEN") {
      const v = rollupVerdict(pr.rollup);
      if (!v.green)
        hit(
          "ready",
          `#${n}`,
          `#${n} is ready`,
          `CI at ${short(pr.headRefOid)} not green: ${v.why}`,
        );
    }
  }
  return { hits, unverified };
}

// ── IO (not exercised by the self-test except through --fixture) ──────────────────────────────────

/** Sources from cases.json: the shared truth plus a case's `override`, `now` and `ghDown`. */
export function fixtureSources(data, c) {
  const prs = {};
  for (const [n, p] of Object.entries(data.prs ?? {}))
    prs[n] = { ...p, ...(c.override?.[n] ?? {}) };
  for (const n of data.issues ?? []) prs[n] = { issue: true };
  const commits = data.commits ?? [];
  return {
    nowMs: Date.parse(c.now),
    prs: c.ghDown ? null : prs,
    branches: new Set(data.branches ?? []),
    commit: (sha) => commits.some((x) => x.startsWith(sha)),
    cloneFresh: c.cloneFresh ?? true,
  };
}

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: CMD_TIMEOUT_MS,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

/** The MAIN checkout (parent of `git --git-common-dir`). */
export function mainCheckoutRoot(cwd = process.cwd()) {
  try {
    return path.dirname(
      run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd).trim(),
    );
  } catch {
    return cwd;
  }
}

// 100 contexts covers every RouteFlow workflow today (4 checks); a longer list would be truncated silently.
const CHECKS =
  "contexts(first:100){nodes{__typename ...on CheckRun{name status conclusion} ...on StatusContext{context state}}}";
const PR_FIELDS = `__typename ...on PullRequest{state headRefOid headRefName mergeCommit{oid} commits(last:1){nodes{commit{statusCheckRollup{${CHECKS}}}}}}`;

function normalizeRollup(node) {
  const ctx = node?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  return ctx.map((x) =>
    x.__typename === "StatusContext"
      ? {
          name: x.context,
          status: x.state === "PENDING" || x.state === "EXPECTED" ? x.state : "COMPLETED",
          conclusion: x.state,
        }
      : { name: x.name, status: x.status, conclusion: x.conclusion },
  );
}

/**
 * Pure: the PR map from a `gh api graphql` stdout, or null when it cannot be trusted. A number that does not exist comes
 * back as a null node plus a NOT_FOUND error and gh exits 1, so that partial answer is still used; any other error,
 * or no data, means gh is unavailable.
 */
export function prsFromGraphql(stdout, numbers) {
  let doc;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return null;
  }
  const repo = doc?.data?.repository;
  if (!repo || (doc.errors ?? []).some((e) => e.type !== "NOT_FOUND")) return null;
  const prs = {};
  for (const n of numbers) {
    const node = repo[`p${n}`];
    if (!node) continue;
    prs[n] =
      node.__typename === "PullRequest"
        ? {
            state: node.state,
            headRefOid: node.headRefOid,
            mergeCommit: node.mergeCommit?.oid ?? null,
            rollup: normalizeRollup(node),
          }
        : { issue: true };
  }
  return prs;
}

/** Live sources; only the lookups the text needs (no PR or branch tokens -> no network). */
export function liveSources(text, cwd = process.cwd()) {
  const t = extractTokens(text);
  const root = mainCheckoutRoot(cwd);
  let prs = {};
  if (t.prs.length) {
    const body = t.prs.map((n) => `p${n}:issueOrPullRequest(number:${n}){${PR_FIELDS}}`).join(" ");
    const q = `query{repository(owner:"${REPO.owner}",name:"${REPO.name}"){${body}}}`;
    try {
      prs = prsFromGraphql(run("gh", ["api", "graphql", "-f", `query=${q}`], root), t.prs);
    } catch (e) {
      prs = prsFromGraphql(String(e.stdout ?? ""), t.prs); // exit 1 with a partial NOT_FOUND answer
    }
  }
  let branches = new Set();
  if (t.branches.length) {
    try {
      const out = run(
        "git",
        ["ls-remote", "--heads", "origin", ...t.branches.map((b) => `refs/heads/${b.token}`)],
        root,
      );
      branches = new Set(
        out
          .split("\n")
          .map((l) => l.split("refs/heads/")[1]?.trim())
          .filter(Boolean),
      );
    } catch {
      branches = null;
    }
  }
  let cloneFresh = false;
  try {
    const common = run(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      root,
    ).trim();
    cloneFresh = Date.now() - statSync(path.join(common, "FETCH_HEAD")).mtimeMs < STALE_CLONE_MS;
  } catch {
    cloneFresh = false;
  }
  const commit = (sha) => {
    try {
      run("git", ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], root);
      return true;
    } catch (e) {
      return e.status === 1 ? false : null; // 128 = ambiguous or git failure: unverified
    }
  };
  return { nowMs: Date.now(), prs, branches, commit, cloneFresh };
}

export function formatReport({ hits, unverified }) {
  const lines = hits.map(
    (h) => `MISMATCH ${h.kind} ${h.token}: claimed ${h.claim}; truth: ${h.truth}`,
  );
  if (unverified.length) {
    const why = [...new Set(unverified.map((u) => u.why))].join("; ");
    lines.push(
      `${unverified.length} token(s) unverified (${why}): ${unverified.map((u) => u.token).join(" ")}`,
    );
  }
  return lines.join("\n");
}

const USAGE =
  "usage: node scripts/fact-check.mjs [--file <path> | -] [--json] | --fixture <cases.json> --case <id>";

function main(argv) {
  const opts = { file: "-", json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "-") opts.file = "-";
    else if (["--file", "--fixture", "--case"].includes(a) && argv[i + 1])
      opts[a.slice(2)] = argv[++i];
    else if (a === "--help") return (console.log(USAGE), 0);
    else return (console.error(USAGE), 2);
  }
  let text;
  let sources;
  if (opts.fixture) {
    if (!opts.case) return (console.error(USAGE), 2);
    const data = JSON.parse(readFileSync(opts.fixture, "utf8"));
    const c = data.cases.find((x) => x.id === opts.case);
    if (!c) return (console.error(`no case ${opts.case}`), 2);
    text = c.message;
    sources = fixtureSources(data, c);
  } else {
    text = readFileSync(opts.file === "-" ? 0 : opts.file, "utf8");
    sources = liveSources(text);
  }
  const result = checkFacts(text, sources);
  const report = formatReport(result);
  console.log(opts.json ? JSON.stringify(result) : report || "clean");
  return result.hits.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
