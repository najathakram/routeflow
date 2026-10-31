#!/usr/bin/env node
// check-train-members.mjs: a mechanical check of a train's member table, the one in the train PR's body.
//
//   node scripts/check-train-members.mjs <body.md>            # before assembly, on the draft ("-" = stdin)
//   node scripts/check-train-members.mjs --pr <n>             # the same on the live body
//   node scripts/check-train-members.mjs --pr <n> --landing   # after the merged-tree walk, before merge
//
// Exit codes: 0 = PASS; 1 = FAIL (every problem is printed); 2 = a usage or read error. A gh that cannot
// answer is a 2: nothing was proven, so it is never a PASS.
//
// The table needs these columns; other columns are free:
//   | PR | text-type | apple-ux |
//   | #7 | 123 | 81 · High 0 · SA-1066 · report 456 |
//
// A UI member is worked out from the PR's changed files, never marked by hand, so a blank cell cannot
// be excused by calling a PR non-UI. Every row needs one #<n> in its PR cell, unless the cell says
// "train commit" or is a bare sha: a cell this can't read is a FAIL, never a member dropped in silence.
//   text-type   the id of a text read. Checked at both stages.
//   apple-ux    <score> · High <n> · [fix card] · report <id>. Checked at --landing only, because the
//               score comes from the walk of the merged tree (ruling 2026-10-31: a train has one walk,
//               so one report, and every UI member cites it). Open Highs hold a train; a score under
//               90 holds it only when no fix card takes it to 90 (W-783).
//
// A read counts on board #3686 or on the member PR, and a report also on the train PR (Lead's ruling
// 2026-10-31), if its body says what it is and names the PR at a commit of that PR with only merges
// after it. A report may name the train at its own head in place of each member. A clean merge-up
// carries a read; a commit of the PR's own needs a new one.
//
// Whether the reads are RIGHT is the reviewer's call. This proves they exist, and at which commit.
//
// TEST-ONLY: TRAIN_MEMBERS_GH_CMD (a JSON argv) replaces `gh` inside a Jest worker; anywhere else it is
// ignored loudly, so a stray export can never make this gate pass from a stub (see
// apps/api/src/common/check-train-members-script.spec.ts).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REPO = "najathakram/routeflow";
const UX_BAR = 90;
const BOARD = "3686";
// Display code, read from the path. This errs towards a read: a lib file with no strings in it costs
// one read, and a copy file the check can't see costs a read nobody asked for.
const UI_FILE =
  /^(apps\/(web|mobile)\/(app|components|lib)\/|packages\/ui\/src\/)|\.(tsx|css)$|(^|[/-])copy\.ts$|(^|\/)tailwind\.config\./;
const NOT_UI = /\.(test|spec)\.|__tests__|__mocks__|\/mocks\/|\/e2e\/|\/test-utils\/|\.md$/;
const SHA = /\b[0-9a-f]{7,40}\b/g;
const TEXT_READ = /\btext\b/i;
const UX_READ = /\bapple-ux\b/i;
const FIX_CARD = /^(SA-\d+|W-\d+|B\d+)$/;

class ReadError extends Error {}

function ghArgv() {
  const raw = process.env.TRAIN_MEMBERS_GH_CMD;
  if (!raw) return ["gh"];
  if (!process.env.JEST_WORKER_ID) {
    console.error("check-train-members: TRAIN_MEMBERS_GH_CMD is ignored outside test; using gh");
    return ["gh"];
  }
  return JSON.parse(raw);
}

/** gh's stdout, or null for a 404. Anything else throws: an unanswered question is not a PASS. */
function gh(args) {
  const [cmd, ...base] = ghArgv();
  const res = spawnSync(cmd, [...base, ...args], {
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) throw new ReadError(`gh failed: ${res.error.message}`);
  if (res.status === 0) return res.stdout;
  if (/HTTP 404/.test(res.stderr)) return null;
  throw new ReadError(`gh failed: ${res.stderr.trim().slice(0, 300)}`);
}

const prBody = (pr) => gh(["pr", "view", pr, "--repo", REPO, "--json", "body", "--jq", ".body"]);

function isUiPr(pr) {
  const out = gh(["api", `repos/${REPO}/pulls/${pr}/files`, "--paginate", "--jq", ".[].filename"]);
  if (out === null) throw new ReadError(`#${pr} is not a PR`);
  return out.split(/\r?\n/).some((f) => UI_FILE.test(f) && !NOT_UI.test(f));
}

/** The PR a comment sits on and its body, or null when there is no such comment. */
function readComment(id) {
  const out = gh(["api", `repos/${REPO}/issues/comments/${id}`]);
  if (out === null) return null;
  const { issue_url: url, body } = JSON.parse(out);
  return { on: /\/issues\/(\d+)\s*$/.exec(url)?.[1] ?? null, body: body ?? "" };
}

const commitCache = new Map();

/** The PR's commits, oldest first: `{ sha, merge }`. */
function prCommits(pr) {
  if (commitCache.has(pr)) return commitCache.get(pr);
  const jq = '.[] | "\\(.sha) \\(.parents | length)"';
  const out = gh(["api", `repos/${REPO}/pulls/${pr}/commits`, "--paginate", "--jq", jq]);
  if (out === null) throw new ReadError(`#${pr} is not a PR`);
  const commits = out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha, parents] = line.split(" ");
      return { sha, merge: Number(parents) > 1 };
    });
  commitCache.set(pr, commits);
  return commits;
}

/** What keeps a body from counting as a read of the PR, or null when it counts. */
function readGap(pr, body) {
  if (!new RegExp(`#${pr}\\b`).test(body)) return `does not name #${pr}`;
  const named = body.match(SHA) ?? [];
  const commits = prCommits(pr);
  const at = commits.findLastIndex((c) => named.some((sha) => c.sha.startsWith(sha)));
  if (at < 0) return `names no commit of #${pr}`;
  const own = commits.slice(at + 1).filter((c) => !c.merge);
  if (own.length === 0) return null;
  const headSha = commits[commits.length - 1].sha.slice(0, 10);
  return `reads ${commits[at].sha.slice(0, 10)}, ${own.length} commit(s) behind ${headSha}`;
}

// A pipe inside a cell is written \| and stays in that cell.
const cells = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());

/** The first table with a PR column: `{ text, ux, members, unread }`; text and ux are column indexes. */
function parseTable(md) {
  const lines = md.split(/\r?\n/);
  const at = lines.findIndex(
    (l) =>
      l.trim().startsWith("|") &&
      cells(l)
        .map((c) => c.toLowerCase())
        .includes("pr"),
  );
  if (at < 0) return null;
  const head = cells(lines[at]).map((c) => c.toLowerCase());
  const pr = head.indexOf("pr");
  const members = [];
  const unread = [];
  for (const line of lines.slice(at + 2)) {
    if (!line.trim().startsWith("|")) break;
    const row = cells(line);
    const cell = row[pr] ?? "";
    const prs = [...cell.matchAll(/#(\d+)/g)].map((m) => m[1]);
    if (prs.length === 1) members.push({ pr: prs[0], row });
    else if (prs.length > 1) unread.push(`PR cell "${cell}" names ${prs.length} PRs: one row each`);
    else if (!/^(train commit|`?[0-9a-f]{7,40}`?)$/i.test(cell)) {
      unread.push(
        `PR cell "${cell}" has no #<n>: a member needs one, a commit says "train commit"`,
      );
    }
  }
  return { text: head.indexOf("text-type"), ux: head.indexOf("apple-ux"), members, unread };
}

function checkTextType(pr, cell, problems) {
  if (!cell) problems.push(`#${pr}: UI member with no text-type comment id`);
  else if (!/^\d+$/.test(cell)) {
    problems.push(`#${pr}: text-type cell "${cell}" is not a comment id`);
  } else {
    const read = readComment(cell);
    const label = `#${pr}: text-type comment ${cell}`;
    if (read === null) problems.push(`${label} does not exist`);
    else if (read.on !== pr && read.on !== BOARD) problems.push(`${label} is on #${read.on}`);
    else if (!TEXT_READ.test(read.body)) problems.push(`${label} does not read as a text read`);
    else {
      const gap = readGap(pr, read.body);
      if (gap) problems.push(`${label} ${gap}`);
    }
  }
}

/** Reads `81 · High 0 · SA-1066 · report 123`. Returns what the walk said, or null if unreadable. */
function checkAppleUx(pr, cell, problems) {
  if (!cell) {
    problems.push(`#${pr}: UI member with no apple-ux score`);
    return null;
  }
  const parts = cell.split("·").map((p) => p.trim());
  const score = /^\d{1,3}$/.test(parts[0]) && Number(parts[0]) <= 100 ? Number(parts[0]) : null;
  const highs = parts.map((p) => /^High (\d+)$/i.exec(p)).filter(Boolean);
  const high = highs[0];
  const report = parts.map((p) => /^report (\d+)$/i.exec(p)).find(Boolean);
  if (score === null) problems.push(`#${pr}: apple-ux cell "${cell}" has no score`);
  else if (score < UX_BAR && !parts.some((p) => FIX_CARD.test(p))) {
    problems.push(`#${pr}: apple-ux ${score} is under ${UX_BAR} with no fix card`);
  }
  if (!high) problems.push(`#${pr}: apple-ux cell has no High count`);
  else if (highs.length > 1) problems.push(`#${pr}: apple-ux cell has ${highs.length} High counts`);
  else if (Number(high[1]) > 0) problems.push(`#${pr}: apple-ux has ${high[1]} open High`);
  if (!report) problems.push(`#${pr}: apple-ux cell cites no report`);
  if (score === null || !high || !report) return null;
  return `${score} · High ${high[1]} · report ${report[1]}`;
}

/** The train's one report: in a place that counts, and naming the train or else every UI member. */
function checkReport(id, ui, trainPr, problems) {
  const report = readComment(id);
  if (report === null) problems.push(`report ${id} does not exist`);
  else if (![trainPr, BOARD, ...ui.map((m) => m.pr)].includes(report.on)) {
    problems.push(`report ${id} is on #${report.on}`);
  } else if (!UX_READ.test(report.body)) {
    problems.push(`report ${id} does not read as an apple-ux read`);
  } else if (readGap(trainPr, report.body)) {
    for (const m of ui) {
      const gap = readGap(m.pr, report.body);
      if (gap) problems.push(`#${m.pr}: report ${id} ${gap}`);
    }
  }
}

function check(md, { landing, trainPr }) {
  const table = parseTable(md);
  if (!table) return { problems: ["no member table (a table with a PR column)"] };
  const problems = [...table.unread];
  if (table.text < 0) problems.push("member table has no text-type column");
  if (table.ux < 0) problems.push("member table has no apple-ux column");
  if (table.text < 0 || table.ux < 0) return { problems };
  if (table.members.length === 0 && problems.length === 0) {
    return { problems: ["member table has no member rows"] };
  }

  const ui = table.members.filter((m) => isUiPr(m.pr));
  for (const m of ui) checkTextType(m.pr, m.row[table.text] ?? "", problems);
  if (landing) {
    const walks = ui.map((m) => checkAppleUx(m.pr, m.row[table.ux] ?? "", problems));
    const cited = [...new Set(walks.filter(Boolean))];
    if (cited.length > 1) problems.push(`UI members cite different walks: ${cited.join(", ")}`);
    for (const id of new Set(cited.map((w) => /report (\d+)/.exec(w)[1]))) {
      checkReport(id, ui, trainPr, problems);
    }
  }
  return { problems, members: table.members.length, ui: ui.length };
}

function usage(message) {
  console.error(`check-train-members: ${message}`);
  console.error("usage: check-train-members.mjs <body.md|-> | --pr <n> [--landing]");
  process.exit(2);
}

/** Strict on purpose: a mistyped --landing that still ran would be the weaker check, and a PASS. */
function parseArgs(args) {
  const opts = { landing: false, trainPr: undefined, source: undefined };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--landing") opts.landing = true;
    else if (a === "--pr") opts.trainPr = args[++i] ?? "";
    else if (a.startsWith("-") && a !== "-") usage(`unknown flag ${a}`);
    else if (opts.source !== undefined) usage(`more than one body: ${a}`);
    else opts.source = a;
  }
  if (opts.trainPr !== undefined && !/^\d+$/.test(opts.trainPr)) usage("--pr needs a number");
  if (opts.trainPr !== undefined && opts.source !== undefined) usage("--pr or a body, not both");
  if (opts.landing && opts.trainPr === undefined) {
    usage("--landing needs --pr: the walk's report names the train");
  }
  if (opts.trainPr === undefined && opts.source === undefined) usage("nothing to check");
  return opts;
}

function main() {
  const { landing, trainPr, source } = parseArgs(process.argv.slice(2));

  let md;
  try {
    if (trainPr !== undefined) md = prBody(trainPr);
    else md = readFileSync(source === "-" ? 0 : source, "utf8");
    if (md === null) throw new ReadError(`#${trainPr} is not a PR`);
    const { problems, members, ui } = check(md, { landing, trainPr });
    if (problems.length === 0) {
      console.log(`check-train-members: PASS (${members} members, ${ui} UI)`);
      return;
    }
    console.log("check-train-members: FAIL");
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
  } catch (err) {
    if (!(err instanceof ReadError) && err.code !== "ENOENT") throw err;
    console.error(`check-train-members: ${err.message}`);
    process.exitCode = 2;
  }
}

main();
