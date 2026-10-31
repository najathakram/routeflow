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
//   | #4001 | 6536792593 | 81 · High 0 · SA-1066 · report 6537804026 |
//
// A UI member is worked out from the PR's changed files, never marked by hand, so a blank cell cannot
// be excused by calling a PR non-UI. A row with no #<n> in its PR cell (a train commit) is not a member.
//   text-type   the id of a comment on that member PR. Checked at both stages.
//   apple-ux    <score> · High <n> · [fix card] · report <id>. Checked at --landing only, because the
//               score comes from the walk of the merged tree (ruling 2026-10-31: a train has one walk,
//               so one report, a comment on the train PR, and every UI member cites it). Open Highs
//               hold a train; a score under 90 holds it only when no fix card takes it to 90 (W-783).
//
// Whether the reads are RIGHT is the reviewer's call. This proves they exist.
//
// TEST-ONLY: TRAIN_MEMBERS_GH_CMD (a JSON argv) replaces `gh` inside a Jest worker; anywhere else it is
// ignored loudly, so a stray export can never make this gate pass from a stub (see
// apps/api/src/common/check-train-members-script.spec.ts).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REPO = "najathakram/routeflow";
const UX_BAR = 90;
const UI_FILE =
  /^(apps\/(web|mobile)\/(app|components)\/|(apps\/(web|mobile)|packages\/ui)\/.*\.(tsx|css)$)/;
const NOT_UI = /\.(test|spec)\.|__tests__|__mocks__|\/e2e\/|\/test-utils\//;
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

/** The number of the PR a comment sits on, or null when there is no such comment. */
function commentPr(id) {
  const out = gh(["api", `repos/${REPO}/issues/comments/${id}`, "--jq", ".issue_url"]);
  if (out === null) return null;
  return /\/issues\/(\d+)\s*$/.exec(out)?.[1] ?? null;
}

const cells = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/** The first table with a PR column: `{ text, ux, members }`, where text and ux are column indexes. */
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
  for (const line of lines.slice(at + 2)) {
    if (!line.trim().startsWith("|")) break;
    const row = cells(line);
    const n = /#(\d+)/.exec(row[pr] ?? "")?.[1];
    if (n) members.push({ pr: n, row });
  }
  return { text: head.indexOf("text-type"), ux: head.indexOf("apple-ux"), members };
}

function checkTextType(pr, cell, problems) {
  if (!cell) problems.push(`#${pr}: UI member with no text-type comment id`);
  else if (!/^\d+$/.test(cell)) {
    problems.push(`#${pr}: text-type cell "${cell}" is not a comment id`);
  } else {
    const on = commentPr(cell);
    if (on === null) problems.push(`#${pr}: text-type comment ${cell} does not exist`);
    else if (on !== pr) problems.push(`#${pr}: text-type comment ${cell} is on #${on}`);
  }
}

/** Reads `81 · High 0 · SA-1066 · report 123`. Returns what the walk said, or null if unreadable. */
function checkAppleUx(pr, cell, problems) {
  if (!cell) {
    problems.push(`#${pr}: UI member with no apple-ux score`);
    return null;
  }
  const parts = cell.split("·").map((p) => p.trim());
  const score = /^\d{1,3}$/.test(parts[0]) ? Number(parts[0]) : null;
  const high = parts.map((p) => /^High (\d+)$/i.exec(p)).find(Boolean);
  const report = parts.map((p) => /^report (\d+)$/i.exec(p)).find(Boolean);
  if (score === null) problems.push(`#${pr}: apple-ux cell "${cell}" has no score`);
  else if (score < UX_BAR && !parts.some((p) => FIX_CARD.test(p))) {
    problems.push(`#${pr}: apple-ux ${score} is under ${UX_BAR} with no fix card`);
  }
  if (!high) problems.push(`#${pr}: apple-ux cell has no High count`);
  else if (Number(high[1]) > 0) problems.push(`#${pr}: apple-ux has ${high[1]} open High`);
  if (!report) problems.push(`#${pr}: apple-ux cell cites no report`);
  if (score === null || !high || !report) return null;
  return `${score} · High ${high[1]} · report ${report[1]}`;
}

function check(md, { landing, trainPr }) {
  const table = parseTable(md);
  if (!table) return { problems: ["no member table (a table with a PR column)"] };
  const problems = [];
  if (table.text < 0) problems.push("member table has no text-type column");
  if (table.ux < 0) problems.push("member table has no apple-ux column");
  if (problems.length) return { problems };
  if (table.members.length === 0) return { problems: ["member table has no member rows"] };

  const ui = table.members.filter((m) => isUiPr(m.pr));
  for (const m of ui) checkTextType(m.pr, m.row[table.text] ?? "", problems);
  if (landing) {
    const walks = ui.map((m) => checkAppleUx(m.pr, m.row[table.ux] ?? "", problems));
    const cited = [...new Set(walks.filter(Boolean))];
    if (cited.length > 1) problems.push(`UI members cite different walks: ${cited.join(", ")}`);
    for (const id of new Set(cited.map((w) => /report (\d+)/.exec(w)[1]))) {
      if (commentPr(id) !== trainPr) {
        problems.push(`report ${id} is not a comment on train #${trainPr}`);
      }
    }
  }
  return { problems, members: table.members.length, ui: ui.length };
}

function usage(message) {
  console.error(`check-train-members: ${message}`);
  console.error("usage: check-train-members.mjs <body.md|-> | --pr <n> [--landing]");
  process.exit(2);
}

function main() {
  const args = process.argv.slice(2);
  const landing = args.includes("--landing");
  const prAt = args.indexOf("--pr");
  const trainPr = prAt >= 0 ? args[prAt + 1] : undefined;
  const source = prAt < 0 ? args.find((a) => a !== "--landing") : undefined;
  if (prAt >= 0 && !/^\d+$/.test(trainPr ?? "")) usage("--pr needs a number");
  if (landing && prAt < 0)
    usage("--landing needs --pr: the walk's report is a comment on the train PR");
  if (prAt < 0 && !source) usage("nothing to check");

  let md;
  try {
    if (prAt >= 0) md = prBody(trainPr);
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
