// Collector: polls the derived-fact sources (specs clone, GitHub, git branches, bug registry,
// file tree, Railway) and keeps the last good data per source. All IO goes through an injected
// exec(cmd, args, opts) → Promise<{code, stdout, stderr}>. Parsers are pure and exported.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileToArea, areaDomain, buildAreaTree, guessDomainFromText } from "./areas.mjs";
import { GITHUB_REPO } from "./config.mjs";
import { parseRegisterReport } from "./backfill.mjs";
import { cloudSyncSpecs, readOnlyExec, redact } from "./cloud.mjs";

export const DEFAULT_INTERVALS = {
  specs: 30,
  github: 60,
  branches: 120,
  bugs: 120,
  areas: 300,
  railway: 120,
};
// Cloud: webhooks make it real time; the polls are the backstop.
export const CLOUD_INTERVALS = {
  github: 120,
  specs: 120,
  branches: 300,
  bugs: 300,
  areas: 600,
  railway: 300,
};
export const BRANCH_DIFF_CAP = 30;
export const FETCH_EVERY = 5;
const BUGS_DIR = ".claude/campaign/bugs";
const LEDGER_DIR = ".claude/campaign/status";
// A registry state in this set means the bug is no longer open. The ledger (status/F##.jsonl)
// carries `proven` / `proven-pending-deploy`; reconcile.mjs treats the same words as closed.
const CLOSED_STATES = new Set([
  "done",
  "already-fixed",
  "refuted",
  "closed",
  "fixed",
  "duplicate",
  "wontfix",
  "proven",
  "proven-pending-deploy",
  "verified",
  "live",
]);
const DAY = 86400_000;
export const BODY_CAP = 4000;
export const PENDING_BUG_CAP = 50;
export const BUG_FILE_RE = /^\.claude\/campaign\/bugs\/B\d+[^/]*\.md$/;
/** CI gate check names (regex sources, case-insensitive); config.ciGates replaces them. */
export const DEFAULT_CI_GATES = ["verify", "e2e"];

const [OWNER, REPO] = GITHUB_REPO.split("/");
const CONTEXTS = `statusCheckRollup { state contexts(first: 50) { nodes { __typename ... on CheckRun { name conclusion status } ... on StatusContext { context state } } } }`;
export const GRAPHQL_QUERY = `query {
  repository(owner: "${OWNER}", name: "${REPO}") {
    visibility
    open: pullRequests(states: OPEN, first: 60, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { number title body isDraft headRefName headRefOid baseRefName updatedAt url
        commits(last: 1) { nodes { commit { ${CONTEXTS} } } }
        files(first: 100) { nodes { path } } }
    }
    merged: pullRequests(states: MERGED, first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { number title body headRefName mergedAt url baseRefName mergeCommit { oid } }
    }
    master: ref(qualifiedName: "refs/heads/master") {
      target { ... on Commit { oid committedDate messageHeadline ${CONTEXTS} } }
    }
    deployments(first: 10, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { environment commitOid createdAt latestStatus { state createdAt } }
    }
  }
}`;

// ---------- pure parsers ----------

// ---------- CI checks: contexts -> per-name runs -> gate / probes ----------

const RUN_RANK = { failure: 5, pending: 4, success: 3, cancelled: 2, skipped: 1 };

/**
 * One GraphQL check context (CheckRun | StatusContext) -> { name, state } with state in
 * success | failure | pending | skipped | cancelled. Unknown shapes -> null.
 */
export function normalizeContext(n) {
  if (!n || typeof n !== "object") return null;
  if (n.__typename === "StatusContext" || (n.context && !n.name)) {
    if (!n.context) return null;
    const s = String(n.state ?? "").toUpperCase();
    const state =
      s === "SUCCESS" ? "success" : s === "FAILURE" || s === "ERROR" ? "failure" : "pending";
    return { name: String(n.context), state };
  }
  if (!n.name) return null;
  const status = String(n.status ?? "").toUpperCase();
  if (status && status !== "COMPLETED") return { name: String(n.name), state: "pending" };
  const c = String(n.conclusion ?? "").toUpperCase();
  let state = "pending"; // COMPLETED without a conclusion, ACTION_REQUIRED: not finished
  if (c === "SUCCESS" || c === "NEUTRAL") state = "success";
  else if (c === "SKIPPED") state = "skipped";
  else if (c === "CANCELLED" || c === "STALE") state = "cancelled";
  else if (c === "FAILURE" || c === "TIMED_OUT" || c === "STARTUP_FAILURE") state = "failure";
  return { name: String(n.name), state };
}

/**
 * Context nodes -> one run per check NAME (several workflow runs report the same name; a skipped
 * duplicate must never hide the real result). Worst wins: failure > pending > success >
 * cancelled > skipped. First-appearance order.
 */
export function collapseRuns(nodes) {
  const by = new Map();
  for (const raw of nodes ?? []) {
    const r = normalizeContext(raw);
    if (!r) continue;
    const had = by.get(r.name);
    if (!had || RUN_RANK[r.state] > RUN_RANK[had]) by.set(r.name, r.state);
  }
  return [...by].map(([name, state]) => ({ name, state }));
}

function compileGates(config) {
  const list = Array.isArray(config?.ciGates) ? config.ciGates : DEFAULT_CI_GATES;
  const out = [];
  for (const g of list) {
    if (g instanceof RegExp) {
      out.push(g);
      continue;
    }
    if (typeof g !== "string" || !g) continue;
    try {
      const m = /^\/(.+)\/([a-z]*)$/.exec(g);
      out.push(m ? new RegExp(m[1], m[2]) : new RegExp(g, "i"));
    } catch {
      // a bad pattern in ops/config.json is ignored, never fatal
    }
  }
  return out;
}

/** 'gate' when the check name matches config.ciGates (default verify, e2e), else 'probe'. */
export function classifyCheck(name, config) {
  const n = String(name ?? "");
  return compileGates(config).some((re) => re.test(n)) ? "gate" : "probe";
}

/**
 * Runs ([{name,state}]) -> { gate, probesFailing, runs: [{name,kind,state}] }.
 * gate = failure | pending | success | skipped | none over the GATE runs only; a failing probe
 * never fails the gate (it is listed by name in probesFailing). A cancelled gate with nothing
 * better counts as failure (it did not pass and nothing re-ran it).
 */
export function summarizeChecks(runs, config) {
  const out = (runs ?? []).map((r) => ({
    name: r.name,
    kind: classifyCheck(r.name, config),
    state: r.state,
  }));
  const gates = out.filter((r) => r.kind === "gate");
  const has = (s) => gates.some((r) => r.state === s);
  let gate = "none";
  if (gates.length) {
    if (has("failure")) gate = "failure";
    else if (has("pending")) gate = "pending";
    else if (has("success")) gate = "success";
    else if (has("cancelled")) gate = "failure";
    else gate = "skipped";
  }
  return {
    gate,
    probesFailing: out
      .filter((r) => r.kind === "probe" && r.state === "failure")
      .map((r) => r.name),
    runs: out,
  };
}

const clipBody = (b) => (typeof b === "string" ? b.slice(0, BODY_CAP) : "");
const runsOf = (commitNode) =>
  collapseRuns(commitNode?.statusCheckRollup?.contexts?.nodes?.filter(Boolean));

/** gh graphql JSON → { visibility, open, merged, master }. */
export function parsePrGraphql(json) {
  const repo = json?.data?.repository ?? json?.repository ?? {};
  const open = (repo.open?.nodes ?? []).filter(Boolean).map((n) => ({
    number: n.number,
    title: n.title,
    body: clipBody(n.body),
    draft: Boolean(n.isDraft),
    branch: n.headRefName,
    headSha: n.headRefOid ?? null,
    base: n.baseRefName ?? null,
    updatedAt: n.updatedAt ?? null,
    url: n.url ?? null,
    checks: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
    runs: runsOf(n.commits?.nodes?.[0]?.commit),
    files: (n.files?.nodes ?? []).map((f) => f?.path).filter(Boolean),
  }));
  const merged = (repo.merged?.nodes ?? []).filter(Boolean).map((n) => ({
    number: n.number,
    title: n.title,
    body: clipBody(n.body),
    branch: n.headRefName,
    mergedAt: n.mergedAt ?? null,
    mergeSha: n.mergeCommit?.oid ?? null,
    url: n.url ?? null,
    base: n.baseRefName ?? null,
  }));
  const t = repo.master?.target;
  const master = t
    ? {
        sha: t.oid,
        date: t.committedDate ?? null,
        headline: t.messageHeadline ?? "",
        checks: t.statusCheckRollup?.state ?? null,
        runs: runsOf(t),
      }
    : null;
  return {
    visibility: repo.visibility ?? null,
    open,
    merged,
    master,
    deploys: parseGithubDeployments(repo.deployments?.nodes),
  };
}

/**
 * GitHub deployment nodes (newest first) → one entry per service, source 'github'. The service is
 * the `@routeflow/<x>` in the environment name when present, else the environment itself.
 */
export function parseGithubDeployments(nodes) {
  const out = [];
  const seen = new Set();
  for (const n of nodes ?? []) {
    if (!n || typeof n.environment !== "string") continue;
    const service = /@routeflow\/[\w.-]+/.exec(n.environment)?.[0] ?? n.environment;
    if (seen.has(service)) continue;
    seen.add(service);
    out.push({
      service,
      status: n.latestStatus?.state ?? null,
      sha: n.commitOid ?? null,
      createdAt: n.latestStatus?.createdAt ?? n.createdAt ?? null,
      source: "github",
    });
  }
  return out;
}

/** GitHub + Railway deploy rows → one per service; Railway's status wins, GitHub's is kept. */
export function mergeDeploys(githubDeploys, railwayDeploys) {
  const gh = githubDeploys ?? [];
  const rw = railwayDeploys ?? [];
  const rwNames = new Set(rw.map((d) => d.service));
  const out = rw.map((r) => {
    const g = gh.find((x) => x.service === r.service);
    return g
      ? { ...r, github: { status: g.status, sha: g.sha, createdAt: g.createdAt } }
      : { ...r };
  });
  for (const g of gh) if (!rwNames.has(g.service)) out.push(g);
  return out;
}

/** `refname<TAB>sha<TAB>iso-date` lines → [{ branch, sha, date }] (origin/ stripped; HEAD/master dropped). */
export function parseForEachRef(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [ref, sha, date] = line.split("\t");
    if (!ref || !sha) continue;
    if (!ref.startsWith("origin/")) continue;
    const branch = ref.slice("origin/".length);
    if (branch === "HEAD" || branch === "master" || !branch) continue;
    out.push({ branch, sha, date: date ? new Date(date).toISOString() : null });
  }
  return out;
}

/** Registry bug markdown → fields; YAML-ish `key: value` lines between the first two `---`. */
export function parseBugFrontMatter(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const kv = {};
  let i = lines.findIndex((l) => l.trim() === "---");
  if (i >= 0) {
    for (i += 1; i < lines.length && lines[i].trim() !== "---"; i++) {
      const m = /^([A-Za-z][\w-]*):\s?(.*)$/.exec(lines[i]);
      if (m) kv[m[1]] = m[2].trim();
    }
  }
  return {
    id: kv.id ?? "",
    title: kv.title ?? "",
    severity: kv.severity ?? "",
    state: kv.state ?? "",
    sensitive: /^true$/i.test(kv.sensitive ?? ""),
    files: (kv.files ?? "").split(/\s+/).filter(Boolean),
    location: kv.location ?? "",
    closed: kv.closed ?? "",
    alreadyFixed: parseAlreadyFixed(lines.slice(i >= 0 ? i + 1 : 0)),
  };
}

/**
 * An "ALREADY FIXED on master by PR #693 (692bdf8, …)" note in a bug record's body (uppercase,
 * at the start of a line or list item): bugs.mjs has no close verb yet, so the bookkeeping lane
 * records a verified fix this way while the state still reads uncampaigned (lead 10-19). Returns
 * { pr, sha } (either may be null) or null.
 */
export function parseAlreadyFixed(lines) {
  for (const line of lines) {
    if (!/^\s*(?:[-*]\s+)?(?:\*\*)?ALREADY FIXED\b/.test(line)) continue;
    const pr = /#(\d{2,6})\b/.exec(line);
    const sha = /\b([0-9a-f]{7,40})\b/.exec(line.replace(/#\d+/g, ""));
    return { pr: pr ? Number(pr[1]) : null, sha: sha ? sha[1] : null };
  }
  return null;
}

const firstWord = (s) =>
  String(s ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)[0];

/**
 * Open unless closed. The ledger state (status/F##.jsonl) WINS over the front matter when the
 * bug has a ledger row: a `regressed` row reopens a bug whose file says done/closed.
 */
export function isOpenBug(b) {
  // A regressed/reopened ledger row always means open, whatever notes say.
  if (/reopen|regress/i.test(String(b.ledgerState ?? ""))) return true;
  if (b.alreadyFixed) return false;
  if (b.ledgerState && String(b.ledgerState).trim())
    return !CLOSED_STATES.has(firstWord(b.ledgerState));
  if (b.closed && String(b.closed).trim()) return false;
  return !CLOSED_STATES.has(firstWord(b.state));
}

// ---------- ledger, git-log and specs-file parsers ----------

/** One status/F##.jsonl blob -> [{ id, state, batch, tier, pr }]; blank and bad lines skipped. */
export function parseLedgerText(text) {
  const rows = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (!j || typeof j.id !== "string" || !j.id) continue;
    rows.push({
      id: j.id,
      state: typeof j.state === "string" ? j.state : "",
      batch: j.batch ?? null,
      tier: j.tier ?? null,
      pr: Number.isInteger(j.pr) ? j.pr : null,
    });
  }
  return rows;
}

// Text store.exec / git-exec put in stderr when git could not run at all (not a git error).
const GIT_FAILURE_RE = /git spawn failed|git timed out/;
// Cloud blob prefetch: one `git fetch` per this many blob shas.
const PREFETCH_CHUNK = 250;
const fileNo = (p) => Number(/F(\d+)[^/]*$/i.exec(p)?.[1] ?? 1e9);

/**
 * Ledger files [{ path, text }] (or { path, rows }) -> Map(id -> latest row). File order is the
 * numeric order of F##, then line order; the LAST row for an id wins.
 */
export function parseLedgerFiles(files) {
  const sorted = [...files].sort(
    (a, b) => fileNo(a.path) - fileNo(b.path) || (a.path < b.path ? -1 : 1),
  );
  const out = new Map();
  for (const f of sorted) for (const r of f.rows ?? parseLedgerText(f.text)) out.set(r.id, r);
  return out;
}

const LOG_HEAD_RE = /^\d{4}-\d{2}-\d{2}T\S+$/;

/** `git log --format=[%x00]%cI --name-only` -> [{ at (ISO), files }] in log order. */
export function parseGitLogNames(text) {
  const commits = [];
  let cur = null;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.replace(/^\u0000/, "").trim();
    if (!line) continue;
    if (LOG_HEAD_RE.test(line)) {
      const t = Date.parse(line);
      cur = Number.isNaN(t) ? null : { at: new Date(t).toISOString(), files: [] };
      if (cur) commits.push(cur);
    } else if (cur) cur.files.push(line);
  }
  return commits;
}

/** Bug-add log -> { B-id: ISO of its OLDEST add inside the window }. */
export function parseBugFiledAt(text) {
  const out = {};
  for (const c of parseGitLogNames(text)) {
    for (const f of c.files) {
      const id = /(?:^|\/)(B\d+)[^/]*\.md$/.exec(f)?.[1];
      if (!id) continue;
      if (!out[id] || c.at < out[id]) out[id] = c.at;
    }
  }
  return out;
}

/** handoff/lanes log -> [{ file (basename), at (newest commit ISO) }] in first-seen order. */
export function parseHandoffLog(text) {
  const by = new Map();
  for (const c of parseGitLogNames(text)) {
    for (const f of c.files) {
      if (!f.startsWith("handoff/lanes/")) continue;
      const file = f.slice(f.lastIndexOf("/") + 1);
      if (!by.has(file) || c.at > by.get(file)) by.set(file, c.at);
    }
  }
  return [...by].map(([file, at]) => ({ file, at }));
}

/** `git log --format=%x00%cI --name-only -- incidents` -> { basename: newest commit ISO }. */
export function parseIncidentLog(text) {
  const out = {};
  for (const c of parseGitLogNames(text)) {
    for (const f of c.files) {
      if (!f.startsWith("incidents/")) continue;
      const file = f.slice(f.lastIndexOf("/") + 1);
      if (!out[file] || c.at > out[file]) out[file] = c.at;
    }
  }
  return out;
}

const INCIDENT_STATUS_WORDS = [
  "open",
  "mitigated",
  "closed",
  "resolved",
  "suspected",
  "unverified",
];

/**
 * incidents/*.md [{ file, text }] -> [{ id, file, title, status, date, changedAt }]. README is
 * skipped. status = the first word after `Status:` when it is open | mitigated | closed | resolved |
 * suspected | unverified, else `unknown` (no Status line is never silently open). `changedAt` =
 * the file's newest commit time from `changedByFile` (parseIncidentLog), else null. The id is
 * DERIVED (INC-MMDD + a letter in file order); it is never stored anywhere.
 */
export function parseIncidents(files, changedByFile = {}, mask = (t) => t) {
  const out = [];
  const perDay = new Map();
  const list = files
    .filter((f) => /\.md$/i.test(f.file) && !/^readme\.md$/i.test(f.file))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  for (const f of list) {
    const d = /^(\d{4})-(\d{2})-(\d{2})-/.exec(f.file);
    const slug = f.file.replace(/\.md$/i, "").replace(/^\d{4}-\d{2}-\d{2}-/, "");
    // The id is date + index only (never a file-name slug: those carry client words).
    const k = d ? `${d[2]}${d[3]}` : "0000";
    const n = perDay.get(k) ?? 0;
    perDay.set(k, n + 1);
    const id = `INC-${k}${String.fromCharCode(97 + (n % 26))}`;
    // Masked BEFORE the cut, so a name never survives as a fragment.
    const title = mask(/^#\s+(.+?)\s*$/m.exec(f.text)?.[1] ?? slug);
    const word = /^[\s>*_-]*status[\s*_]*[:.][\s*_]*([A-Za-z]+)/im.exec(f.text)?.[1]?.toLowerCase();
    out.push({
      id,
      file: f.file,
      title: title.slice(0, 300),
      status: INCIDENT_STATUS_WORDS.includes(word) ? word : "unknown",
      date: d ? `${d[1]}-${d[2]}-${d[3]}` : null,
      changedAt: changedByFile?.[f.file] ?? null,
    });
  }
  return out;
}

const QUEUE_WORDS = /^(STANDING YES|DEFAULT IN EFFECT|ANSWERED|DONE|BOOKED|OPEN|CHECK)\b/i;
const DECISION_FILE_RE = /(?<![\w-])(D-\d{4}-\d{2}-\d{2}-[\w-]+\.md)/;

const splitRow = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|\s*$/, "")
    .split("|");

/**
 * OWNER-QUEUE.md -> [{ key, statusWord, decisionFile, asOf }] from the rows of tables that have an
 * Item column and a Recommended* column. The first cell reads `<key> · **<STATUS> <date> → <file>**`
 * (a bare `<key>` is an open row). statusWord is one of ANSWERED DONE STANDING YES DEFAULT IN
 * EFFECT BOOKED OPEN CHECK, else null; decisionFile is the `D-YYYY-MM-DD-*.md` named in that
 * cell; asOf the first `M-D` date left in it. A key seen twice keeps its first row.
 */
export function parseOwnerQueueRows(md) {
  const lines = String(md ?? "").split(/\r?\n/);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    const block = [];
    while (i < lines.length && lines[i].trim().startsWith("|")) block.push(lines[i++]);
    i -= 1;
    const head = splitRow(block[0]).map((c) => c.trim().toLowerCase());
    if (!head.includes("item") || !head.some((c) => c.startsWith("recommended"))) continue;
    for (const line of block.slice(1)) {
      const cells = splitRow(line);
      const first = (cells[0] ?? "").trim();
      if (!first || /^:?-{3,}:?$/.test(first)) continue;
      const m = /^(\S+?)\s*·\s*(.*)$/s.exec(first);
      const key = m ? m[1] : first;
      if (!/^[A-Za-z0-9][\w.-]{0,15}$/.test(key) || seen.has(key)) continue;
      seen.add(key);
      const status = (m ? m[2] : "").replace(/\*\*/g, "").trim();
      const decisionFile = DECISION_FILE_RE.exec(status)?.[1] ?? null;
      const rest = decisionFile ? status.replace(decisionFile, "") : status;
      out.push({
        key,
        statusWord: QUEUE_WORDS.exec(status)?.[1].toUpperCase() ?? null,
        decisionFile,
        asOf: /(?<![\d-])(\d{1,2}-\d{1,2})(?![\d-])/.exec(rest)?.[1] ?? null,
      });
    }
  }
  return out;
}

/**
 * The specs-clone files the snapshot needs beyond events (reads need no lock): incidents/*.md,
 * priorities/OWNER-QUEUE.md and ONE `git log` for the lane handoff commit times. Never throws;
 * every failure is listed in `errors` (a missing piece is data, not a crash).
 */
export async function readSpecsExtras({
  dir,
  exec,
  fs = { readdirSync, readFileSync },
  mask = (t) => t,
}) {
  const errors = [];
  let incidents = [];
  let ownerQueueRows = null;
  let laneHandoffs = [];
  let registerRowIds = null;
  let registerDuplicateIds = [];
  try {
    const d = join(dir, "incidents");
    const files = fs
      .readdirSync(d)
      .filter((f) => /\.md$/i.test(f))
      .map((f) => ({ file: f, text: fs.readFileSync(join(d, f), "utf8") }));
    // ONE git log gives every incident file's last commit time (a failure leaves them null).
    let changed = {};
    try {
      const r = await exec("git", ["log", "--format=%x00%cI", "--name-only", "--", "incidents"], {
        cwd: dir,
      });
      if (r.code !== 0)
        throw new Error(`git log failed (${r.code}): ${(r.stderr || "").trim().slice(0, 100)}`);
      changed = parseIncidentLog(r.stdout);
    } catch (e) {
      errors.push(`incident times: ${String(e?.message ?? e).slice(0, 120)}`);
    }
    incidents = parseIncidents(files, changed, mask);
  } catch (e) {
    errors.push(`incidents: ${String(e?.message ?? e).slice(0, 120)}`);
  }
  try {
    ownerQueueRows = parseOwnerQueueRows(
      fs.readFileSync(join(dir, "priorities", "OWNER-QUEUE.md"), "utf8"),
    );
  } catch (e) {
    errors.push(`owner queue: ${String(e?.message ?? e).slice(0, 120)}`);
  }
  // The hand-kept register's row ids: a duplicate id marks a corrupted snapshot (sync refuses it),
  // and the ids let the snapshot spot a row that shares its number with a monitor item. A missing
  // register file is normal (generated mode, cloud clone) and not an error.
  try {
    const md = fs.readFileSync(join(dir, "register", "WORK-REGISTER.md"), "utf8");
    registerRowIds = parseRegisterReport(md).drafts.map((x) => x.id);
    const seen = new Set();
    for (const id of registerRowIds) {
      if (seen.has(id) && !registerDuplicateIds.includes(id)) registerDuplicateIds.push(id);
      seen.add(id);
    }
  } catch (e) {
    if (e?.code !== "ENOENT") errors.push(`register: ${String(e?.message ?? e).slice(0, 120)}`);
  }
  try {
    const r = await exec(
      "git",
      ["log", "--since=7.days", "--format=%x00%cI", "--name-only", "--", "handoff/lanes"],
      { cwd: dir },
    );
    if (r.code !== 0)
      throw new Error(`git log failed (${r.code}): ${(r.stderr || "").trim().slice(0, 100)}`);
    laneHandoffs = parseHandoffLog(r.stdout);
  } catch (e) {
    errors.push(`lane handoffs: ${String(e?.message ?? e).slice(0, 120)}`);
  }
  return {
    incidents,
    ownerQueueRows,
    laneHandoffs,
    registerRowIds,
    registerDuplicateIds,
    errors,
  };
}

/** Ordered `git cat-file --batch` output for `<sha>:<path>` inputs -> [content | null] per input. */
export function parseCatFileOrdered(buf, count) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ""), "utf8");
  const out = [];
  let pos = 0;
  while (pos < b.length && out.length < count) {
    const nl = b.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = b.toString("utf8", pos, nl).trim();
    pos = nl + 1;
    const m = /^\S+ blob (\d+)$/.exec(header);
    if (!m) {
      out.push(null); // "<spec> missing" and the like
      continue;
    }
    const size = Number(m[1]);
    out.push(b.toString("utf8", pos, pos + size));
    pos += size + 1;
  }
  while (out.length < count) out.push(null);
  return out;
}

export const SENSITIVE_TITLE = "Security hardening item (details machine-local)";

/** Public-safe bug row; sensitive bugs lose title, area and files. */
export function maskBug(b, area) {
  if (b.sensitive) {
    return {
      id: b.id,
      title: SENSITIVE_TITLE,
      severity: b.severity,
      state: b.state,
      area: null,
      domain: null,
      sensitive: true,
    };
  }
  const a = area ?? (b.files?.length ? fileToArea(b.files[0]).area : null);
  const domain = a ? areaDomain(a) : (guessDomainFromText(b.title) ?? "other");
  return {
    id: b.id,
    title: b.title,
    severity: b.severity,
    state: b.state,
    area: a,
    domain,
    sensitive: false,
  };
}

/** `git cat-file --batch` output (Buffer or string) → [{ sha, content }]; missing objects skipped. */
export function parseCatFileBatch(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ""), "utf8");
  const out = [];
  let pos = 0;
  while (pos < b.length) {
    const nl = b.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = b.toString("utf8", pos, nl).trim();
    pos = nl + 1;
    if (!header) continue;
    const m = /^(\S+) blob (\d+)$/.exec(header);
    if (!m) continue;
    const size = Number(m[2]);
    out.push({ sha: m[1], content: b.toString("utf8", pos, pos + size) });
    pos += size + 1;
  }
  return out;
}

/** `railway status --json` → production @routeflow/* service deploys. */
export function parseRailwayStatus(json) {
  const root = json?.data ?? json ?? {};
  const envs = (root.environments?.edges ?? []).map((e) => e?.node).filter(Boolean);
  const prod = envs.find((e) => e.name === "production");
  if (!prod) return [];
  const out = [];
  for (const edge of prod.serviceInstances?.edges ?? []) {
    const n = edge?.node;
    if (!n || typeof n.serviceName !== "string" || !n.serviceName.startsWith("@routeflow/"))
      continue;
    const d = n.latestDeployment ?? {};
    out.push({
      service: n.serviceName,
      status: d.status ?? null,
      sha: d.meta?.commitHash ?? null,
      createdAt: d.createdAt ?? null,
    });
  }
  return out;
}

// ---------- Railway API (read-only) ----------

// EVERY Railway GraphQL document lives here. The token is a project token for another project's
// production environment: queries only, never a mutation.
export const RAILWAY_QUERIES = {
  projectToken: "query { projectToken { projectId environmentId } }",
  project:
    "query ($id: String!) { project(id: $id) { services { edges { node { name serviceInstances { edges { node { environmentId latestDeployment { status createdAt meta } } } } } } } } }",
};
export const RAILWAY_URL = "https://backboard.railway.com/graphql/v2";

/** The single Railway request function: refuses anything that is not a plain query. */
export async function railwayRequest({ fetch: fetchFn = globalThis.fetch, token, doc, variables }) {
  if (
    typeof doc !== "string" ||
    !/^\s*query\b/.test(doc) ||
    /\b(mutation|subscription)\b/i.test(doc)
  ) {
    throw new Error("Railway access is read-only: only query documents are allowed");
  }
  const res = await fetchFn(RAILWAY_URL, {
    method: "POST",
    headers: { "Project-Access-Token": token, "content-type": "application/json" },
    body: JSON.stringify({ query: doc, ...(variables ? { variables } : {}) }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Railway API ${res.status}: ${redact(text, [token]).slice(0, 200)}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Railway API returned invalid JSON");
  }
  if (json.errors?.length && !json.data) {
    throw new Error(
      `Railway API: ${redact(json.errors[0]?.message ?? "error", [token]).slice(0, 200)}`,
    );
  }
  return json.data ?? {};
}

/** project(id) services → same rows as parseRailwayStatus, for the token's environment. */
export function parseRailwayProject(json, environmentId) {
  const root = json?.data ?? json ?? {};
  const out = [];
  for (const edge of root.project?.services?.edges ?? []) {
    const svc = edge?.node;
    if (!svc || typeof svc.name !== "string" || !svc.name.startsWith("@routeflow/")) continue;
    const inst = (svc.serviceInstances?.edges ?? [])
      .map((e) => e?.node)
      .find((n) => n && n.environmentId === environmentId);
    if (!inst) continue;
    const d = inst.latestDeployment ?? {};
    out.push({
      service: svc.name,
      status: d.status ?? null,
      sha: d.meta?.commitHash ?? null,
      createdAt: d.createdAt ?? null,
    });
  }
  return out;
}

// ---------- collector ----------

async function defaultExec(cmd, args, opts) {
  const store = await import("./store.mjs");
  return store.exec(cmd, args, opts);
}

export function createCollector({
  repoRoot,
  specsDir,
  exec = defaultExec,
  now = Date.now,
  intervals = {},
  onUpdate = () => {},
  log = () => {},
  env = process.env,
  deps = {},
  cloud = false,
  fetch: fetchFn = globalThis.fetch,
  mask = (t) => t,
} = {}) {
  // Cloud never writes git: every git call goes through the read-only allow-list.
  const guardedExec = cloud ? readOnlyExec(exec) : exec;
  exec = guardedExec;
  const fetchEvery = cloud ? 1 : FETCH_EVERY;
  const iv = { ...DEFAULT_INTERVALS, ...(cloud ? CLOUD_INTERVALS : {}), ...intervals };
  const sources = {};
  for (const name of Object.keys(DEFAULT_INTERVALS)) {
    sources[name] = {
      ok: false,
      at: null,
      tried: null,
      error: null,
      data: null,
      intervalSec: iv[name],
    };
  }
  const running = new Map();
  const timers = [];
  const runCounts = {};
  const diffCache = new Map(); // sha → files
  const bugBlobCache = new Map(); // blob sha → parsed bug
  const ledgerBlobCache = new Map(); // blob sha → ledger rows
  const pendingBlobCache = new Map(); // `<sha>:<path>` → masked bug | null
  let bugsKey = null;
  let areasSha = null;

  const git = (args) => exec("git", args, { cwd: repoRoot });
  const fail = (msg) => {
    throw new Error(msg);
  };

  const runners = {
    async specs() {
      const store = deps.store ?? (await import("./store.mjs"));
      const cfg = deps.config ?? (await import("./config.mjs"));
      // Writers (rf, the views writer) hold the specs lock for a whole append; a poll never waits
      // for it. When busy this run skips the sync and reads the working tree as it is.
      const underLock = (fn) => (store.tryWithSpecsLock ? store.tryWithSpecsLock(fn) : fn());
      if (cloud) {
        // Read-only clone made at boot: fetch + reset to origin, never pull --rebase or push.
        await underLock(async () => {
          const r = await (deps.cloudSyncSpecs ?? cloudSyncSpecs)(specsDir, exec);
          if (!r.ok) fail(r.error);
        });
      } else {
        await underLock(async () => {
          if (store.ensureClone) {
            await store.ensureClone({
              dir: specsDir,
              remote: cfg.specsRemote ? cfg.specsRemote() : undefined,
            });
          }
          await store.syncSpecs(specsDir);
        });
      }
      const events = await store.readAllEvents(specsDir);
      const config = (deps.loadConfig ?? cfg.loadConfig)(specsDir);
      // Incidents, the owner queue rows and the lane handoff times ride with the events. A failure
      // here is listed in extrasErrors and never fails the source (the events are what matters).
      let extras;
      try {
        extras = await (deps.specsExtras ?? readSpecsExtras)({ dir: specsDir, exec, mask });
      } catch (e) {
        extras = { errors: [`extras: ${String(e?.message ?? e).slice(0, 160)}`] };
      }
      return {
        events,
        config,
        incidents: extras.incidents ?? [],
        ownerQueueRows: extras.ownerQueueRows ?? null,
        laneHandoffs: extras.laneHandoffs ?? [],
        registerRowIds: extras.registerRowIds ?? null,
        registerDuplicateIds: extras.registerDuplicateIds ?? [],
        extrasErrors: extras.errors ?? [],
      };
    },

    async github() {
      const token = env.GITHUB_TOKEN;
      let json;
      if (token) {
        let res;
        try {
          res = await fetchFn("https://api.github.com/graphql", {
            method: "POST",
            headers: {
              authorization: `bearer ${token}`,
              "content-type": "application/json",
              "user-agent": "routeflow-ops-monitor",
            },
            body: JSON.stringify({ query: GRAPHQL_QUERY }),
            signal: AbortSignal.timeout(30000),
          });
        } catch (e) {
          fail(`github API request failed: ${redact(e?.message ?? e, [token]).slice(0, 200)}`);
        }
        const text = await res.text();
        if (!res.ok) fail(`github API ${res.status}: ${redact(text, [token]).slice(0, 200)}`);
        try {
          json = JSON.parse(text);
        } catch {
          fail("github API returned invalid JSON");
        }
        if (json.errors?.length && !json.data) {
          fail(
            `github graphql: ${redact(json.errors[0].message ?? "error", [token]).slice(0, 200)}`,
          );
        }
        return parsePrGraphql(json);
      }
      const r = await exec("gh", ["api", "graphql", "-f", `query=${GRAPHQL_QUERY}`], {
        cwd: repoRoot,
      });
      if (r.code !== 0)
        fail(`gh failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
      try {
        json = JSON.parse(r.stdout);
      } catch {
        fail("gh returned invalid JSON");
      }
      if (json.errors?.length && !json.data)
        fail(`gh graphql: ${json.errors[0].message ?? "error"}`);
      return parsePrGraphql(json);
    },

    async branches() {
      const n = (runCounts.branches ?? 1) - 1;
      let fetchError = null;
      if (n % fetchEvery === 0 && env.RF_OPS_LIGHT !== "1") {
        const f = await git(["fetch", "origin", "--quiet"]);
        if (f.code !== 0) fetchError = (f.stderr || "fetch failed").trim().slice(0, 200);
      }
      const r = await git([
        "for-each-ref",
        "refs/remotes/origin",
        "--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)",
      ]);
      if (r.code !== 0) fail(`git for-each-ref failed: ${r.stderr.trim().slice(0, 200)}`);
      const t = now();
      const mergedByBranch = new Map();
      for (const p of sources.github.data?.merged ?? [])
        mergedByBranch.set(p.branch, Date.parse(p.mergedAt));
      const recent = parseForEachRef(r.stdout).filter((b) => {
        const d = Date.parse(b.date);
        if (Number.isNaN(d) || t - d > 14 * DAY) return false;
        const mergedAt = mergedByBranch.get(b.branch);
        return !(mergedAt !== undefined && d <= mergedAt);
      });
      let diffs = 0;
      const out = [];
      for (const b of recent) {
        let files = diffCache.get(b.sha);
        if (!files && diffs < BRANCH_DIFF_CAP) {
          diffs += 1;
          const d = await git(["diff", "--name-only", `origin/master...${b.sha}`]);
          if (d.code === 0) {
            files = d.stdout.split(/\r?\n/).filter(Boolean);
            diffCache.set(b.sha, files);
          }
        }
        out.push({ ...b, files: files ?? [] });
      }

      // Pending registry: bug files a branch carries that master does not have yet. The files
      // list comes from the diffs above; the front matter is read in ONE cat-file call (sha:path),
      // cached by sha:path, at most PENDING_BUG_CAP per run. Sensitive bugs are masked here.
      const wanted = [];
      for (const b of out)
        for (const f of b.files)
          if (BUG_FILE_RE.test(f))
            wanted.push({ key: `${b.sha}:${f}`, branch: b.branch, sha: b.sha, path: f });
      const unread = wanted.filter((w) => !pendingBlobCache.has(w.key)).slice(0, PENDING_BUG_CAP);
      let pendingError = null;
      if (unread.length) {
        const r = await exec("git", ["cat-file", "--batch"], {
          cwd: repoRoot,
          input: `${unread.map((w) => w.key).join("\n")}\n`,
        });
        if (r.code === 0) {
          parseCatFileOrdered(r.stdout, unread.length).forEach((content, i) => {
            const w = unread[i];
            if (content === null) {
              pendingBlobCache.set(w.key, null);
              return;
            }
            const fm = parseBugFrontMatter(content);
            const id = fm.id || (/(B\d+)/.exec(w.path)?.[1] ?? "");
            pendingBlobCache.set(
              w.key,
              id ? { ...maskBug({ ...fm, id }), open: isOpenBug(fm) } : null,
            );
          });
        } else pendingError = `git cat-file failed: ${(r.stderr || "").trim().slice(0, 160)}`;
      }
      const pendingBugs = [];
      for (const w of wanted) {
        const bug = pendingBlobCache.get(w.key);
        if (bug && pendingBugs.length < PENDING_BUG_CAP)
          pendingBugs.push({ ...bug, branch: w.branch, sha: w.sha, path: w.path });
      }
      return { branches: out, fetchError, pendingBugs, pendingError };
    },

    async bugs() {
      // One rev-parse covers both trees; they (with nothing else) key the cache. A repo without
      // the ledger directory still serves the front matter.
      const tree = await git([
        "rev-parse",
        `origin/master:${BUGS_DIR}`,
        `origin/master:${LEDGER_DIR}`,
      ]);
      const shas = tree.stdout
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter((x) => /^\S+$/.test(x)); // stdout carries only resolved shas (errors go to stderr)
      if (!shas.length) {
        // A spawn failure / timeout is NOT a missing registry; say what really happened.
        if (GIT_FAILURE_RE.test(tree.stderr)) fail(tree.stderr.trim().slice(0, 200));
        fail(`bug registry not found on origin/master: ${tree.stderr.trim().slice(0, 200)}`);
      }
      const treeSha = shas[0];
      const ledgerTree = tree.code === 0 && shas.length > 1 ? shas[1] : null;
      const key = `${treeSha}:${ledgerTree}`;
      if (key === bugsKey && sources.bugs.data) return sources.bugs.data;
      const ls = await git(["ls-tree", "origin/master", `${BUGS_DIR}/`]);
      if (ls.code !== 0) fail(`git ls-tree failed: ${ls.stderr.trim().slice(0, 200)}`);
      const entries = [];
      for (const line of ls.stdout.split(/\r?\n/)) {
        const m = /^\d+ blob ([0-9a-f]{7,40})\t(.+)$/.exec(line);
        if (m && /(^|\/)B\d+[^/]*\.md$/.test(m[2])) entries.push({ sha: m[1], path: m[2] });
      }
      const ledgerEntries = [];
      if (ledgerTree) {
        const lt = await git(["ls-tree", "origin/master", `${LEDGER_DIR}/`]);
        if (lt.code !== 0) fail(`git ls-tree (ledger) failed: ${lt.stderr.trim().slice(0, 200)}`);
        for (const line of lt.stdout.split(/\r?\n/)) {
          const m = /^\d+ blob ([0-9a-f]{7,40})\t(.+\.jsonl)$/.exec(line);
          if (m) ledgerEntries.push({ sha: m[1], path: m[2] });
        }
      }
      const needBug = [...new Set(entries.map((e) => e.sha))].filter((x) => !bugBlobCache.has(x));
      const needLedger = [...new Set(ledgerEntries.map((e) => e.sha))].filter(
        (x) => !ledgerBlobCache.has(x),
      );
      const need = [...new Set([...needBug, ...needLedger])];
      const ingest = (sha, content) => {
        if (needBug.includes(sha)) bugBlobCache.set(sha, parseBugFrontMatter(content));
        if (needLedger.includes(sha)) ledgerBlobCache.set(sha, parseLedgerText(content));
      };
      const have = (sha) =>
        (!needBug.includes(sha) || bugBlobCache.has(sha)) &&
        (!needLedger.includes(sha) || ledgerBlobCache.has(sha));
      if (need.length && cloud) {
        // The cloud clone is BLOBLESS: every blob cat-file lacks triggers its own lazy https fetch
        // (a git-remote-https child each). Fetch all missing blobs up front, ONE fetch per chunk,
        // so the forks per poll are bounded by ceil(N / PREFETCH_CHUNK) instead of by N.
        for (let i = 0; i < need.length; i += PREFETCH_CHUNK) {
          // negotiationAlgorithm=noop (as git's own lazy fetch): no negotiation against the clone.
          const f = await exec(
            "git",
            [
              "fetch",
              "--quiet",
              "--no-tags",
              "--no-write-fetch-head",
              "--recurse-submodules=no",
              "origin",
              ...need.slice(i, i + PREFETCH_CHUNK),
            ],
            {
              cwd: repoRoot,
              env: {
                GIT_CONFIG_COUNT: "1",
                GIT_CONFIG_KEY_0: "fetch.negotiationAlgorithm",
                GIT_CONFIG_VALUE_0: "noop",
              },
            },
          );
          if (f.code !== 0) fail(`blob prefetch failed: ${(f.stderr || "").trim().slice(0, 200)}`);
        }
      }
      if (need.length) {
        // One batched read when exec supports stdin (opts.input); otherwise (or if it returned
        // nothing) fall back to one `git cat-file blob` per unseen blob, 8 at a time.
        const r = await exec("git", ["cat-file", "--batch"], {
          cwd: repoRoot,
          input: `${need.join("\n")}\n`,
        });
        if (r.code === 0)
          for (const { sha, content } of parseCatFileBatch(r.stdout)) ingest(sha, content);
        // Cloud never fans out per blob: a blob the one batch could not read is an error below.
        const left = cloud ? [] : need.filter((x) => !have(x));
        for (let i = 0; i < left.length; i += 8) {
          await Promise.all(
            left.slice(i, i + 8).map(async (sha) => {
              const one = await git(["cat-file", "blob", sha]);
              if (one.code === 0) ingest(sha, one.stdout);
            }),
          );
        }
        const still = need.filter((x) => !have(x));
        if (needBug.length && needBug.every((x) => still.includes(x)))
          fail("git cat-file returned no bug files");
        if (still.some((x) => needLedger.includes(x)))
          fail("git cat-file could not read the bug ledger (status/*.jsonl)");
      }
      const ledger = parseLedgerFiles(
        ledgerEntries.map((e) => ({ path: e.path, rows: ledgerBlobCache.get(e.sha) ?? [] })),
      );
      // When was each bug filed? ONE git log over the last 30 days; older bugs have no date.
      let filed = {};
      let filedAtError = null;
      const lg = await git([
        "log",
        "--since=30.days",
        "--diff-filter=A",
        "--format=%cI",
        "--name-only",
        "origin/master",
        "--",
        BUGS_DIR,
      ]);
      if (lg.code === 0) filed = parseBugFiledAt(lg.stdout);
      else filedAtError = `git log failed: ${(lg.stderr || "").trim().slice(0, 160)}`;
      const all = [];
      for (const e of entries) {
        const b = bugBlobCache.get(e.sha);
        if (!b) continue;
        const id = b.id || (/(B\d+)/.exec(e.path)?.[1] ?? "");
        if (id) all.push({ ...b, id });
      }
      bugsKey = key;
      // Raw sensitive rows never leave this function: everything downstream sees masked bugs.
      const masked = all.map((b) => {
        const led = ledger.get(b.id) ?? null;
        return {
          ...maskBug(b),
          open: isOpenBug({ ...b, ledgerState: led?.state ?? null }),
          ledgerState: led?.state || null,
          batch: led?.batch ?? null,
          tier: led?.tier ?? null,
          filedAt: filed[b.id] ?? null,
          // The proof shown on the bug card when an ALREADY FIXED note closes it.
          alreadyFixed: b.alreadyFixed ?? null,
        };
      });
      return {
        treeSha,
        ledgerTreeSha: ledgerTree,
        bugs: masked,
        open: masked.filter((b) => b.open),
        filedAtError,
      };
    },

    async areas() {
      const head = await git(["rev-parse", "origin/master"]);
      if (head.code !== 0) fail(`git rev-parse failed: ${head.stderr.trim().slice(0, 200)}`);
      const sha = head.stdout.trim();
      if (sha === areasSha && sources.areas.data) return sources.areas.data;
      const r = await git([
        "ls-tree",
        "-r",
        "--name-only",
        "origin/master",
        "--",
        "apps",
        "packages",
        "scripts",
        "tools",
        ".claude",
        ".github",
        "docs",
      ]);
      if (r.code !== 0) fail(`git ls-tree failed: ${r.stderr.trim().slice(0, 200)}`);
      const paths = r.stdout.split(/\r?\n/).filter(Boolean);
      areasSha = sha;
      return { sha, fileCount: paths.length, tree: buildAreaTree(paths) };
    },

    async railway() {
      const rwToken = env.RAILWAY_API_TOKEN;
      if (rwToken) {
        try {
          const t = await railwayRequest({
            fetch: fetchFn,
            token: rwToken,
            doc: RAILWAY_QUERIES.projectToken,
          });
          const { projectId, environmentId } = t.projectToken ?? {};
          if (!projectId || !environmentId) fail("Railway token has no project/environment");
          const p = await railwayRequest({
            fetch: fetchFn,
            token: rwToken,
            doc: RAILWAY_QUERIES.project,
            variables: { id: projectId },
          });
          return {
            deploys: parseRailwayProject({ data: p }, environmentId).map((d) => ({
              ...d,
              source: "railway",
            })),
          };
        } catch (e) {
          fail(redact(e?.message ?? e, [rwToken]).slice(0, 300));
        }
      }
      // On Windows the npm-installed CLI is railway.cmd, which Node only runs through cmd.exe
      // (fixed arguments, no user input on the command line).
      const [rwCmd, rwArgs] =
        process.platform === "win32"
          ? ["cmd.exe", ["/d", "/s", "/c", "railway", "status", "--json"]]
          : ["railway", ["status", "--json"]];
      const r = await exec(rwCmd, rwArgs, { cwd: repoRoot });
      if (
        r.code === 127 ||
        /is not recognized as an internal or external command/i.test(r.stderr || "")
      )
        fail("railway CLI unavailable");
      if (r.code !== 0)
        fail(`railway failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
      let json;
      try {
        json = JSON.parse(r.stdout);
      } catch {
        fail("railway returned invalid JSON");
      }
      return { deploys: parseRailwayStatus(json).map((d) => ({ ...d, source: "railway" })) };
    },
  };

  function runOnce(name) {
    if (!runners[name]) return Promise.reject(new Error(`unknown source ${name}`));
    if (running.has(name)) return running.get(name);
    const p = (async () => {
      const s = sources[name];
      s.tried = now();
      runCounts[name] = (runCounts[name] ?? 0) + 1;
      try {
        s.data = await runners[name]();
        s.ok = true;
        s.at = now();
        s.error = null;
      } catch (e) {
        s.ok = false;
        s.error = String(e?.message ?? e);
        log(`source ${name} failed: ${s.error}`);
      }
      try {
        onUpdate(name);
      } catch (e) {
        log(`onUpdate(${name}) threw: ${e?.message ?? e}`);
      }
      return s;
    })().finally(() => running.delete(name));
    running.set(name, p);
    return p;
  }

  return {
    sources,
    guardedExec,
    runOnce,
    start() {
      for (const name of Object.keys(runners)) {
        runOnce(name).catch(() => {});
        const t = setInterval(() => runOnce(name).catch(() => {}), iv[name] * 1000);
        t.unref?.();
        timers.push(t);
      }
    },
    stop() {
      for (const t of timers.splice(0)) clearInterval(t);
    },
  };
}
