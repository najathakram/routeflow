#!/usr/bin/env node
/**
 * team.mjs — the RouteFlow agent team's shared board.
 *
 * GitHub Issues is the board. This wraps `gh` so every agent speaks the same
 * protocol and no agent has to hand-roll the sequence.
 *
 * Why comments and not assignees: every Claude Code session on this box
 * authenticates as the SAME GitHub account, so `@me` carries no information
 * about which session holds a claim, and `--add-assignee` is an idempotent add
 * to a set (it does not fail when someone else holds it). Issue comments have
 * server-assigned, totally ordered ids — so "lowest live claim id wins" is a
 * real compare-and-swap. Assignee is set anyway, as a human-readable mirror.
 *
 * Why the marker: agent comments carry an invisible `<!--rf:agent-->` first
 * line. Anything WITHOUT it was written by a human — that is how `ask`/`answered`
 * tell the owner's reply (typed on the GitHub mobile app) apart from agent chatter,
 * given both post as the same account.
 *
 * Claim identity is the worktree directory name: it survives /resume and
 * context compaction, which session names and pids do not.
 *
 *   node scripts/team/team.mjs board
 *   node scripts/team/team.mjs epic  "Bulk price override on order edit" --client c3
 *   node scripts/team/team.mjs task  42 "API: accept overridePrice on PATCH /orders/:id" --area api
 *   node scripts/team/team.mjs claim 43
 *   node scripts/team/team.mjs note  43 "specs red, implementing"
 *   node scripts/team/team.mjs ask   43 "Should the override apply to boxed lines per-box or per-piece?"
 *   node scripts/team/team.mjs answered 43
 *   node scripts/team/team.mjs done  43 "PR #501"
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

const MARKER = "<!--rf:agent-->";
const LEASE_MINUTES = 90;
const CLAIM_JITTER_MS = [2000, 5000];

// ── gh plumbing ────────────────────────────────────────────────────────────

function gh(args, { allowFail = false } = {}) {
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    if (allowFail) return null;
    const msg = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
    fail(`gh ${args.slice(0, 3).join(" ")} failed:\n${msg}`);
  }
}

function ghJson(args, opts) {
  const out = gh(args, opts);
  if (out === null) return null;
  try {
    return JSON.parse(out);
  } catch {
    fail(`could not parse gh output as JSON:\n${out.slice(0, 400)}`);
  }
}

let _repo;
function repo() {
  if (!_repo) _repo = gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
  return _repo;
}

function api(pathname, extra = []) {
  return ghJson(["api", `repos/${repo()}/${pathname}`, ...extra]);
}

// ── identity ───────────────────────────────────────────────────────────────

/** Worktree dir name — stable across /resume and compaction. */
function claimId() {
  if (process.env.RF_CLAIM_ID) return process.env.RF_CLAIM_ID;
  const top = gh(["rev-parse", "--show-toplevel"], { allowFail: true });
  const root = top ?? process.cwd();
  return path.basename(root.trim());
}

function currentBranch() {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "(no branch)";
  }
}

// ── comment helpers ────────────────────────────────────────────────────────

function comments(n) {
  return api(`issues/${n}/comments?per_page=100`) ?? [];
}

function post(n, body) {
  return ghJson(["api", `repos/${repo()}/issues/${n}/comments`, "-f", `body=${MARKER}\n${body}`]);
}

// ⚠️ THE CLAIM GRAMMAR IS READ IN TWO PLACES. `scripts/campaign/bugs.mjs`
// (`readClaims`) reads these same comments so `next`/`waves` can honour a lease
// with no per-batch network round-trip. There is nothing to import — this file
// is a CLI — so the two readings MUST CHANGE TOGETHER, IN ONE COMMIT.
// The three rules below are the contract: the marker filter (`isAgent`) runs
// BEFORE any parse; `^claim:` / `^release:` are anchored with /m and permit NO
// leading whitespace; and both run per COMMENT, never over a flattened stream
// of lines. Loosening any of them over there frees leases this file still holds.
const isAgent = (c) => (c.body ?? "").startsWith(MARKER);
const isHuman = (c) => !isAgent(c);

function parseClaim(c) {
  const m = (c.body ?? "").match(/^claim:\s*id=(\S+)\s+lease-until=(\S+)/m);
  if (!m) return null;
  return { id: m[1], leaseUntil: new Date(m[2]), commentId: c.id };
}

/** Live claims = claim comments not superseded by a later release, lease unexpired. */
function liveClaims(n) {
  const cs = comments(n).filter(isAgent);
  const released = new Set();
  for (const c of cs) {
    const m = (c.body ?? "").match(/^release:\s*id=(\S+)/m);
    if (m) released.add(m[1]);
  }
  const now = new Date();
  return cs
    .map(parseClaim)
    .filter(Boolean)
    .filter((c) => !released.has(c.id) && c.leaseUntil > now)
    .sort((a, b) => a.commentId - b.commentId);
}

function label(n, name, add = true) {
  gh(["issue", "edit", String(n), add ? "--add-label" : "--remove-label", name], {
    allowFail: true,
  });
}

// ── output ─────────────────────────────────────────────────────────────────

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`,
};

function fail(msg) {
  console.error(C.r(`✗ ${msg}`));
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function flag(args, name, def = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

// ── commands ───────────────────────────────────────────────────────────────

const cmds = {};

/**
 * Index open PRs by the issue they close.
 *
 * Adapted from Agent Orchestrator's SCM-observer design (docs/scm-observer.md):
 * board position is DERIVED from real PR + CI + review facts, never authored.
 * A lane you have to remember to set is a lane that will be wrong; a lane
 * computed from `gh pr` output cannot drift from reality.
 */
function prIndex() {
  const prs =
    ghJson([
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,body,headRefName,isDraft,reviewDecision,statusCheckRollup",
    ]) ?? [];

  const byIssue = new Map();
  for (const pr of prs) {
    const refs = [...(pr.body ?? "").matchAll(/\b(?:closes|fixes|resolves)\s+#(\d+)/gi)];
    for (const m of refs) byIssue.set(Number(m[1]), pr);
  }
  return byIssue;
}

/** Roll a PR's checks up to one of: pending | failing | green. */
function checkState(pr) {
  const rollup = pr.statusCheckRollup ?? [];
  if (!rollup.length) return "pending";
  const norm = (c) => (c.conclusion || c.state || c.status || "").toUpperCase();
  if (
    rollup.some((c) =>
      ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(norm(c)),
    )
  )
    return "failing";
  if (
    rollup.some((c) =>
      ["PENDING", "IN_PROGRESS", "QUEUED", "WAITING", "EXPECTED", ""].includes(norm(c)),
    )
  )
    return "pending";
  return "green";
}

cmds.board = () => {
  const issues = ghJson([
    "issue",
    "list",
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,title,labels,updatedAt",
  ]);
  if (!issues?.length) {
    console.log(C.dim("\n  board empty — no open issues.\n"));
    console.log(`  Create one:  ${C.c('node scripts/team/team.mjs epic "Your requirement"')}\n`);
    return;
  }

  const prs = prIndex();
  const claims = new Map();
  for (const i of issues) {
    const lc = liveClaims(i.number);
    if (lc.length) claims.set(i.number, lc[0]);
  }

  const has = (i, l) => i.labels.some((x) => x.name === l);

  // Derivation order matters: the first rule that matches wins, and the rules
  // are ordered by what most needs a human's attention.
  const lane = (i) => {
    if (has(i, "blocked:owner")) return "Needs you";
    const pr = prs.get(i.number);
    if (pr) {
      const cs = checkState(pr);
      if (cs === "failing") return "CI failing";
      if (pr.reviewDecision === "CHANGES_REQUESTED") return "Review comments";
      if (pr.isDraft) return "In progress";
      if (cs === "green" && pr.reviewDecision === "APPROVED") return "Ready to merge";
      return "In review";
    }
    if (claims.has(i.number)) return "In progress";
    if (has(i, "ready")) return "Ready";
    return "Backlog";
  };

  const lanes = [
    "Needs you",
    "CI failing",
    "Review comments",
    "Ready to merge",
    "In review",
    "In progress",
    "Ready",
    "Backlog",
  ];
  const tint = {
    "Needs you": C.r,
    "CI failing": C.r,
    "Review comments": C.y,
    "Ready to merge": C.g,
    "In review": C.y,
    "In progress": C.c,
    Ready: C.c,
    Backlog: C.dim,
  };

  console.log(C.b(`\n  ${repo()} — team board`));
  console.log(C.dim(`  lanes derived from live PR + CI + review state\n`));

  for (const l of lanes) {
    const rows = issues.filter((i) => lane(i) === l);
    if (!rows.length) continue;
    console.log(`  ${tint[l](C.b(l))} ${C.dim(`(${rows.length})`)}`);
    for (const i of rows) {
      const cl = claims.get(i.number);
      const pr = prs.get(i.number);
      const bits = [];
      if (cl) bits.push(`← ${cl.id}`);
      if (pr) bits.push(`PR #${pr.number} ${checkState(pr)}`);
      const meta = bits.length ? C.dim(`  ${bits.join("  ")}`) : "";
      const tags = i.labels
        .map((x) => x.name)
        .filter((x) => /^(client|area|kind|prio):/.test(x))
        .join(" ");
      console.log(`    ${C.b(`#${i.number}`.padEnd(5))} ${i.title.slice(0, 58)}${meta}`);
      if (tags) console.log(`          ${C.dim(tags)}`);
    }
    console.log("");
  }

  const blocked = issues.filter((i) => lane(i) === "Needs you").length;
  if (blocked) {
    console.log(C.r(`  ${blocked} issue(s) waiting on you.`));
    console.log(
      C.dim("  Reply to the question comment on GitHub (web or the mobile app) to unblock.\n"),
    );
  }
};

cmds.epic = (args) => {
  const title = args[0];
  if (!title) fail('usage: epic "<requirement>" [--client cN] [--prio P1]');
  const labels = ["kind:feature", `prio:${flag(args, "prio", "P2")}`];
  const client = flag(args, "client");
  if (client) labels.push(`client:${client}`);

  const body = [
    "## The ask",
    "",
    title,
    "",
    "## Acceptance criteria",
    "",
    "- [ ] _(the lead fills these in — each becomes a task)_",
    "",
    "## Out of scope",
    "",
    "- _(state what this deliberately does NOT do)_",
    "",
    "---",
    "_Epic. Child tasks link back here. Verbatim client wording stays in `local-assets/`, never in this issue._",
  ].join("\n");

  const url = gh([
    "issue",
    "create",
    "--title",
    title,
    "--body",
    body,
    "--label",
    labels.join(","),
  ]);
  console.log(C.g(`✓ epic created  ${url}`));
  console.log(C.dim(`  next: node scripts/team/team.mjs task <this#> "<first task>" --area api`));
};

cmds.task = (args) => {
  const parent = args[0];
  const title = args[1];
  if (!parent || !title)
    fail('usage: task <parent#> "<title>" [--area api|web|mobile] [--kind bug]');
  const labels = [`kind:${flag(args, "kind", "feature")}`, "ready"];
  const area = flag(args, "area");
  if (area) labels.push(`area:${area}`);

  const body = [
    `Part of #${parent}.`,
    "",
    "## Done when",
    "",
    "- [ ] _(testable criterion)_",
    "",
    "## Notes",
    "",
    "_Plan file, if any, goes in `.claude/pipeline/plans/`._",
  ].join("\n");

  const url = gh([
    "issue",
    "create",
    "--title",
    title,
    "--body",
    body,
    "--label",
    labels.join(","),
  ]);
  console.log(C.g(`✓ task created  ${url}`));
};

cmds.claim = async (args) => {
  const n = args[0];
  if (!n) fail("usage: claim <issue#>");
  const id = claimId();
  const branch = currentBranch();
  const lease = new Date(Date.now() + LEASE_MINUTES * 60_000).toISOString();

  const existing = liveClaims(n);
  if (existing.length && existing[0].id !== id) {
    console.log(
      C.y(
        `✗ #${n} is held by ${C.b(existing[0].id)} until ${existing[0].leaseUntil.toISOString()}`,
      ),
    );
    process.exit(3);
  }

  post(n, `claim: id=${id} lease-until=${lease} branch=${branch}`);

  // Jitter, then re-read: two agents racing must not both re-read instantly.
  const [lo, hi] = CLAIM_JITTER_MS;
  await sleep(lo + Math.random() * (hi - lo));

  const winner = liveClaims(n)[0];
  if (!winner || winner.id !== id) {
    post(n, `release: id=${id} reason=lost-race`);
    console.log(C.y(`✗ lost the race for #${n} to ${C.b(winner?.id ?? "unknown")}`));
    process.exit(3);
  }

  gh(["issue", "edit", String(n), "--add-assignee", "@me"], { allowFail: true });
  label(n, "ready", false);
  console.log(C.g(`✓ #${n} claimed by ${C.b(id)}  (lease ${LEASE_MINUTES}m, branch ${branch})`));
};

cmds.release = (args) => {
  const n = args[0];
  if (!n) fail("usage: release <issue#> [reason]");
  post(n, `release: id=${claimId()} reason=${args.slice(1).join(" ") || "done"}`);
  console.log(C.g(`✓ #${n} released by ${claimId()}`));
};

cmds.note = (args) => {
  const n = args[0];
  const text = args.slice(1).join(" ");
  if (!n || !text) fail('usage: note <issue#> "<progress note>"');
  post(n, `**${claimId()}** · ${text}`);
  console.log(C.g(`✓ noted on #${n}`));
};

cmds.ask = (args) => {
  const n = args[0];
  const q = args.slice(1).join(" ");
  if (!n || !q) fail('usage: ask <issue#> "<question for the owner>"');
  post(
    n,
    [
      `question: id=${claimId()}`,
      "",
      `### ❓ ${q}`,
      "",
      "_Reply on this issue — any plain comment unblocks me._",
    ].join("\n"),
  );
  label(n, "blocked:owner");
  console.log(C.g(`✓ asked on #${n} — issue labelled blocked:owner`));
  console.log(C.dim("  now send a PushNotification so it reaches the phone, then stop."));
  console.log(C.dim(`  resume check: node scripts/team/team.mjs answered ${n}`));
};

cmds.answered = (args) => {
  const n = args[0];
  if (!n) fail("usage: answered <issue#>");
  const cs = comments(n);
  let lastQ = -1;
  cs.forEach((c, i) => {
    if (isAgent(c) && /^question:/m.test(c.body ?? "")) lastQ = i;
  });
  if (lastQ === -1) {
    console.log(C.dim(`#${n} has no open question.`));
    return;
  }
  const replies = cs.slice(lastQ + 1).filter(isHuman);
  if (!replies.length) {
    console.log(C.y(`… #${n} still waiting on the owner`));
    process.exit(4);
  }
  console.log(C.g(`✓ owner replied on #${n}:\n`));
  for (const r of replies) console.log(`  ${r.body.trim().replace(/\n/g, "\n  ")}\n`);
  label(n, "blocked:owner", false);
};

cmds.done = (args) => {
  const n = args[0];
  if (!n) fail('usage: done <issue#> "[closing note]"');
  const note = args.slice(1).join(" ");
  post(n, `**${claimId()}** · done. ${note}`);
  post(n, `release: id=${claimId()} reason=done`);
  console.log(C.g(`✓ #${n} marked done by ${claimId()}`));
  console.log(C.dim("  the issue closes itself when a PR with `Closes #" + n + "` merges."));
};

cmds.reap = () => {
  const issues =
    ghJson(["issue", "list", "--state", "open", "--limit", "100", "--json", "number,title"]) ?? [];
  let n = 0;
  for (const i of issues) {
    const cs = comments(i.number).filter(isAgent);
    const claims = cs.map(parseClaim).filter(Boolean);
    if (!claims.length) continue;
    const released = new Set();
    for (const c of cs) {
      const m = (c.body ?? "").match(/^release:\s*id=(\S+)/m);
      if (m) released.add(m[1]);
    }
    const stale = claims.filter((c) => !released.has(c.id) && c.leaseUntil <= new Date());
    for (const s of stale) {
      post(i.number, `release: id=${s.id} reason=lease-expired`);
      console.log(
        C.y(`↺ reclaimed #${i.number} from ${s.id} (lease expired ${s.leaseUntil.toISOString()})`),
      );
      n++;
    }
  }
  console.log(n ? C.g(`✓ reaped ${n} stale claim(s)`) : C.dim("no stale claims"));
};

cmds.setup = () => {
  const defs = [
    ["ready", "0e8a16", "Specified and safe for an agent to claim"],
    ["blocked:owner", "d93f0b", "Waiting on the owner to answer a question"],
    ["in-review", "fbca04", "Implementation done, under independent review"],
    ["kind:feature", "1d76db", ""],
    ["kind:bug", "b60205", ""],
    ["kind:chore", "c5def5", ""],
    ["kind:migration", "5319e7", "Touches the Prisma schema"],
    ["area:api", "bfd4f2", ""],
    ["area:web", "bfd4f2", ""],
    ["area:mobile", "bfd4f2", ""],
    ["area:packages", "bfd4f2", ""],
    ["prio:P0", "b60205", ""],
    ["prio:P1", "d93f0b", ""],
    ["prio:P2", "fbca04", ""],
    ["prio:P3", "c2e0c6", ""],
  ];
  for (const [name, color, desc] of defs) {
    const r = gh(["label", "create", name, "--color", color, "--description", desc, "--force"], {
      allowFail: true,
    });
    console.log(r === null ? C.y(`· ${name} (skipped)`) : C.g(`✓ ${name}`));
  }
  console.log(C.dim("\nClient labels are created on demand — use --client cN on `epic`."));
  console.log(
    C.dim(
      "Keep client codes OPAQUE: the map belongs in local-assets/client-codes.json (gitignored).",
    ),
  );
};

// ── dispatch ───────────────────────────────────────────────────────────────

const [, , cmd, ...rest] = process.argv;
if (!cmd || cmd === "help" || cmd === "--help") {
  console.log(`
${C.b("team.mjs")} — the RouteFlow agent team's board (GitHub Issues underneath)

  ${C.c("setup")}                         create the label schema (run once)
  ${C.c("board")}                         show every open issue by lane
  ${C.c("epic")}  "<ask>" [--client cN]   file a client requirement
  ${C.c("task")}  <parent#> "<title>"     file a child task under an epic
  ${C.c("claim")} <issue#>                take ownership (comment-CAS, ${LEASE_MINUTES}m lease)
  ${C.c("note")}  <issue#> "<text>"       post progress
  ${C.c("ask")}   <issue#> "<question>"   ask the owner and mark blocked
  ${C.c("answered")} <issue#>             print the owner's reply, clear blocked
  ${C.c("done")}  <issue#> "[note]"       mark finished and release
  ${C.c("release")} <issue#> [reason]     give the claim back
  ${C.c("reap")}                          release every expired lease

Claim id = worktree dir name (${C.b(claimId())}). Override with RF_CLAIM_ID.
`);
  process.exit(0);
}
if (!cmds[cmd]) fail(`unknown command "${cmd}" — try: node scripts/team/team.mjs help`);
await cmds[cmd](rest);
