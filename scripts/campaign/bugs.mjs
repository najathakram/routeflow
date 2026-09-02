#!/usr/bin/env node
// bugs.mjs — the in-repo bug catalogue: intake, selection, and the fix carve-out.
//
// WHY THIS EXISTS
// The campaign already had two of the three things a bug tracker needs. The
// *state machine* lives in `.claude/campaign/status/F##.jsonl` (one row per bug
// ID, guarded by campaign-check). The *board* lives in GitHub Issues, one card
// per batch, with lanes derived from live PR/CI state. What was missing was the
// *catalogue* — the description of what each bug actually IS. That lived only in
// `local-assets/docs/routeflow-bug-register.html`, which is gitignored and can
// only be republished by the owner, so no agent could file a bug or read one
// back. An automated pickup loop cannot be built on a source of truth that
// agents cannot write to; this file is that source of truth.
//
// It deliberately does NOT duplicate the state machine. A row here carries what
// a bug *is* (title, location, severity, symptom); `status/F##.jsonl` still owns
// what a bug *is doing* (queued/proven/done + its proof). `next` joins them.
//
// THE CARVE-OUT
// Owner decision (2026-09-02): agents may auto-take normal bugs unattended, but
// anything touching money math, tenant scoping, or migrations is planned and
// parked for review. Those are precisely where this repo has taken production
// incidents — the three pricing.ts mirrors drifting, unscoped bulk writes, and
// destructive migrations. `classify()` below is that rule, expressed once, so
// the dispatcher cannot forget it and nobody can quietly widen it in passing.
//
// USAGE — every implemented command (`cmds.*` below is the source of truth;
// keep this list in sync with it, not the other way round):
//   node scripts/campaign/bugs.mjs import                     # seed the catalogue from the register HTML (owner-machine only)
//   node scripts/campaign/bugs.mjs file "<title>" --location "<where>" --severity high|medium|low|critical [--symptom "..."] [--batch F## --tier T1|T2|T3] [--files "a.ts b.ts"]   (--tier is required whenever --batch is given)
//   node scripts/campaign/bugs.mjs next [--json] [--no-claims]  # the next batch an agent may take (the head of wave 1)
//   node scripts/campaign/bugs.mjs waves [--cap N] [--hub-threshold N] [--json] [--no-claims]  # the parallel schedule
//   node scripts/campaign/bugs.mjs list [--open] [--sensitive] [--batch F09]
//   node scripts/campaign/bugs.mjs stats
//   node scripts/campaign/bugs.mjs expand                      # create/refresh one record per catalogue row
//   node scripts/campaign/bugs.mjs sync [--quiet] [--rescan]    # derive History from the ledger + an ANCHORED git scan (idempotent; Gate 4 runs this every turn)
//   node scripts/campaign/bugs.mjs show <B###>
//   node scripts/campaign/bugs.mjs note <B###> "<text>" [--section "Root cause"]
//   node scripts/campaign/bugs.mjs index                        # rebuild bugs.jsonl from the records (regenerate, never hand-edit)
//   node scripts/campaign/bugs.mjs brief <F##|B###>             # everything an agent needs to start a batch, in one output
//   node scripts/campaign/bugs.mjs prove <B###> --pr <n> --proof "REG-B### ..." [--pending-deploy]
//   node scripts/campaign/bugs.mjs discharge <F##> --evidence "<post-deploy proof>" [--evidence-B### "<per-row proof>"]   # per-row evidence is REQUIRED for every T2 row
//   node scripts/campaign/bugs.mjs reopen <B###> --why "<failing REG-B### token or the run that showed the regression>"
//   node scripts/campaign/bugs.mjs claim <F##>                  # flip that batch's workable rows to in-flight (next/waves skip it)
//   node scripts/campaign/bugs.mjs release <F##>                # give them back
//   node scripts/campaign/bugs.mjs tier <B###> <T1|T2|T3> --why "<reason>"
//   node scripts/campaign/bugs.mjs status [F##]                 # per-batch done/analysed counts
//   node scripts/campaign/bugs.mjs triage                       # catalogue bugs with no ledger row at all
//   node scripts/campaign/bugs.mjs move <B###> --to <F##> [--why "<reason>"]
//   node scripts/campaign/bugs.mjs enrich                       # pull the register's detail blocks + files into every record (owner-machine only)
//   node scripts/campaign/bugs.mjs deps [--bug B###] [--hub-threshold N] [--all]
//   node scripts/campaign/bugs.mjs render [--open]              # regenerate the derived HTML view
//   node scripts/campaign/bugs.mjs self-test                    # also runs as a step of `npm run verify`
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

// Overridable via BUGS_ROOT so the self-test can point the REAL commands at a
// throwaway directory instead of re-implementing their logic against a fixture
// (see cmds["self-test"]). Read lazily (never cached in a top-level const) so a
// self-test that sets process.env.BUGS_ROOT mid-run is honoured immediately.
const rootDir = () => process.env.BUGS_ROOT || ".claude/campaign";
const CATALOGUE = () => join(rootDir(), "bugs.jsonl");
const STATUS_DIR = () => join(rootDir(), "status");
// Overridable via BUGS_REGISTER for the same reason as rootDir(): the self-test
// exercises the real cmds.enrich against a fixture instead of a hand copy of it.
const REGISTER = () => process.env.BUGS_REGISTER || "local-assets/docs/routeflow-bug-register.html";
const BOARD = () => join(rootDir(), "board.json");

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, none: 4 };

// ── the carve-out ─────────────────────────────────────────────────────────
// Matched against title + location. Deliberately over-broad: a false "sensitive"
// costs one owner glance, a false "safe" costs a production money bug.
const SENSITIVE = {
  money:
    /pricing\.ts|\bprice|\bmoney|invoice|credit[- ]?note|payment|\btax\b|discount|promo|billing|commission|wallet|estimate|vendor[- ]?bill|bookkeeping|\bcost|settle|refund|deposit|ledger/i,
  tenancy:
    /\btenant|\brls\b|impersonat|\bauth\b|\brole\b|permission|\bscoped?\b|\bjwt\b|session|forTenant|platform[- ]admin/i,
  migration: /migration|schema\.prisma|prisma migrate|backfill|\bdrop (table|column)|destructive/i,
};

function classify(bug) {
  const hay = `${bug.title ?? ""} ${bug.location ?? ""}`;
  const reasons = Object.entries(SENSITIVE)
    .filter(([, rx]) => rx.test(hay))
    .map(([k]) => k);
  return { sensitive: reasons.length > 0, reasons };
}

// ── io ────────────────────────────────────────────────────────────────────
const readCatalogue = () =>
  existsSync(CATALOGUE())
    ? readFileSync(CATALOGUE(), "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

function writeCatalogue(rows) {
  rows.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  mkdirSync(rootDir(), { recursive: true });
  writeFileSync(CATALOGUE(), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

// Latest state per bug ID, read from the shards campaign-check already guards.
function readState() {
  const state = new Map();
  if (!existsSync(STATUS_DIR())) return state;
  for (const f of readdirSync(STATUS_DIR()).filter((n) => n.endsWith(".jsonl"))) {
    const lines = readFileSync(join(STATUS_DIR(), f), "utf8").split(/\r?\n/).filter(Boolean);
    lines.forEach((line, i) => {
      // A crash here used to take down the ENTIRE command with no indication
      // of which shard or line was at fault — and via Gate 4, went completely
      // silent (the hook swallows a non-zero exit and prints nothing).
      let o;
      try {
        o = JSON.parse(line);
      } catch (e) {
        fail(`malformed JSON in ${f}:${i + 1} — ${e.message}\n  line: ${line.slice(0, 200)}`);
      }
      state.set(o.id, o);
    });
  }
  return state;
}

const fail = (m) => {
  console.error(`bugs: ${m}`);
  process.exit(1);
};

function flag(args, name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  // A missing or flag-shaped value means the CALLER's next `--flag` silently
  // became this flag's value (e.g. `prove B1 --pr --proof "..."` would have
  // set pr to the literal string "--proof"). Fail loudly instead.
  if (v === undefined || v.startsWith("--"))
    fail(`--${name} requires a value${v === undefined ? "" : ` (got "${v}")`}`);
  return v;
}

// Batches are always uppercase F##. Every command that takes one must agree —
// `file` used to be the one command that didn't, so `file --batch f11` wrote a
// ledger row whose own `batch` field (f11) disagreed with the shard it landed
// in (F11.jsonl), and would duplicate the shard outright on a case-sensitive
// filesystem (Linux CI).
function normBatch(raw, { optional = false } = {}) {
  if (raw === null || raw === undefined || raw === "") {
    if (optional) return null;
    fail("a batch is required and must look like F##");
  }
  const b = String(raw).toUpperCase();
  if (!/^F\d{2}$/.test(b)) fail(`batch must look like F## (got "${raw}")`);
  return b;
}

// "B04" and "B4" are the same bug — compare NORMALISED forms rather than
// migrating the nine zero-padded ids (B01-B09) that predate this convention.
// Returns null for anything that isn't a B-id shape at all.
const normId = (raw) => {
  const m = /^B0*(\d+)$/i.exec(String(raw ?? "").trim());
  return m ? `B${m[1]}` : null;
};

// Resolve a user-typed id to whatever form the registry actually stores on
// disk (e.g. "B04", not "B4") by comparing normalised forms against the
// catalogue — WITHOUT migrating any file. Falls back to the uppercased input
// verbatim when nothing matches, so an unknown id still fails with the
// caller's own "no record"/"no ledger row" message instead of a new one here.
function resolveId(raw) {
  const typed = String(raw ?? "")
    .toUpperCase()
    .trim();
  const key = normId(typed);
  if (!key) return typed;
  const hit = readCatalogue().find((r) => normId(r.id) === key);
  return hit ? hit.id : typed;
}

const stripTags = (s) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&middot;/g, "·")
    .replace(/&amp;/g, "&")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();

// ── commands ──────────────────────────────────────────────────────────────
const cmds = {};

// One-time seed. Idempotent: never overwrites a row that already exists, so a
// hand-edited symptom survives a re-import.
cmds.import = () => {
  if (!existsSync(REGISTER()))
    fail(
      `register not found at ${REGISTER()} (gitignored — this runs on the owner's machine only)`,
    );
  const html = readFileSync(REGISTER(), "utf8");
  const rows = [
    ...html.matchAll(
      /<tr><td><a href="#b\d+">(B\d+)<\/a><\/td><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><\/tr>/g,
    ),
  ];
  if (!rows.length)
    fail(
      "no bug rows matched — the register markup changed; fix the pattern rather than importing nothing",
    );

  const existing = readCatalogue();
  const known = new Set(existing.map((r) => r.id));
  const state = readState();
  let added = 0;

  for (const [, id, title, location, sevCell, stateCell] of rows) {
    if (known.has(id)) continue;
    const sev = /chip (critical|high|medium|low)/.exec(sevCell);
    const bug = {
      id,
      title: stripTags(title),
      location: stripTags(location),
      severity: sev ? sev[1] : "none",
      register: stripTags(stateCell),
      batch: state.get(id)?.batch ?? null,
      source: "register-import",
      filedAt: null,
    };
    const c = classify(bug);
    bug.sensitive = c.sensitive;
    bug.sensitiveFor = c.reasons;
    existing.push(bug);
    added++;
  }
  writeCatalogue(existing);
  console.log(`imported ${added} new row(s); catalogue now holds ${existing.length}.`);
};

cmds.file = (args) => {
  const title = args[0];
  if (!title || title.startsWith("--"))
    fail(
      'usage: file "<title>" --location "<where>" --severity critical|high|medium|low [--symptom "..."] [--batch F## --tier T1|T2|T3] [--files "a.ts b.ts"]',
    );
  const location = flag(args, "location");
  const severity = flag(args, "severity", "medium");
  const filesFlag = flag(args, "files");
  if (!location) fail("--location is required: an agent cannot route a bug it cannot place");
  if (!(severity in SEVERITY_RANK))
    fail(`--severity must be one of ${Object.keys(SEVERITY_RANK).join("|")}`);

  const rows = readCatalogue();
  // Never infer a free id from a gap — reserved is not abandoned. Always max+1.
  const maxId = rows.reduce((m, r) => Math.max(m, Number(r.id.slice(1))), 0);
  const bug = {
    id: `B${maxId + 1}`,
    title,
    location,
    severity,
    symptom: flag(args, "symptom"),
    register: "open",
    batch: normBatch(flag(args, "batch"), { optional: true }),
    source: "filed",
    filedAt: new Date().toISOString(),
  };
  const c = classify(bug);
  bug.sensitive = c.sensitive;
  bug.sensitiveFor = c.reasons;
  rows.push(bug);
  writeCatalogue(rows);

  console.log(`filed ${bug.id} — ${title}`);
  console.log(`  location : ${location}`);
  console.log(`  severity : ${severity}`);
  if (c.sensitive)
    console.log(
      `  carve-out: touches ${c.reasons.join(", ")} — an agent may PLAN this but must not fix it unattended.`,
    );
  else console.log("  agent-safe: yes");
  if (!bug.batch) console.log("  no batch yet — run @tech-lead to batch it, or pass --batch F##.");

  // A bug with no ledger row is invisible to campaign-check and to `next`, so
  // filing must create it. Doing this by hand is how B211 first landed.
  //
  // MUST run BEFORE expand(): expand derives the record's front matter (and
  // its body header line) from frontFor(bug, st), and `st` is this ledger
  // row. Calling expand first used to bake in "uncampaigned"/no-tier
  // permanently into the body until the next unrelated sync happened to
  // touch this bug — the ledger said "queued" from the first moment, the
  // record disagreed with its own ledger row from the first moment too.
  if (bug.batch) {
    const tier = (flag(args, "tier") ?? "").toUpperCase();
    if (!/^T[123]$/.test(tier))
      fail(
        "--tier T1|T2|T3 is required with --batch — a ledger tier is a ruling, not a default. " +
          "File without --batch (it lands in `triage`) and set the tier after analysis with `tier`.",
      );
    const { what, row } = upsertLedgerRow(bug.batch, {
      id: bug.id,
      batch: bug.batch,
      tier,
      state: "queued",
      pr: null,
      proof: null,
      evidence: null,
    });
    if (row?.batch !== bug.batch || row?.tier !== tier || row?.state !== "queued")
      fail(
        `ledger write for ${bug.id} did not land as intended — re-read row is ${JSON.stringify(row)}`,
      );
    console.log(`  ledger   : ${bug.batch}.jsonl row ${what} (tier ${tier}, queued)`);
  } else {
    console.log("  ledger   : none — pass --batch F## so campaign-check and `next` can see it.");
    console.log(
      "  triage   : an unbatched bug is invisible to next/status/deps — run `triage` to list every bug in this state.",
    );
  }

  // Filing a bug and leaving it without a record is exactly the drift this
  // registry exists to prevent, so create it in the same breath. expand is
  // idempotent and never touches an existing narrative.
  cmds.expand();
  console.log(`  record   : ${recordPath(bug.id)}`);

  // A filed bug's front matter otherwise never carries `files` (only `enrich`
  // writes it, and only for register imports) — with no files, `deps` sees
  // zero edges for it and the dependency graph can only ever get less
  // complete as bugs get filed rather than imported.
  if (filesFlag) {
    const rec = readRecord(bug.id);
    if (rec) {
      writeRecord(bug.id, { ...rec.front, files: filesFlag }, rec.body);
      console.log(`  files    : ${filesFlag}`);
    }
  }
};

// ── selection: what is workable, what blocks it, and in what order ────────
// A batch is workable when it holds rows nobody is on. `in-flight` is the local
// signal (written by `claim` below) and a live team.mjs claim comment is the
// authoritative one; the local signal exists so the exclusion survives a lost
// GitHub read, which is the difference between "two agents got the same batch"
// and "the dispatcher waited".
const WORKABLE = new Set(["queued", "regressed"]);
// The standing agent cap (feedback_cap_background_agents_at_four) — a wave that
// proposes more parallel batches than the fleet can run is not a plan.
const AGENT_CAP = 4;

const boardJson = () =>
  existsSync(BOARD()) ? JSON.parse(readFileSync(BOARD(), "utf8")) : { batches: {} };

// Mirrors scripts/team/team.mjs's claim protocol — marker, comment grammar and
// lease. team.mjs is a CLI, not a module, so there is nothing to import; if the
// protocol changes there, it must change here in the same commit. A failure to
// read (offline, no gh, no auth) NEVER pretends the batch is free: it degrades
// to the local `in-flight` signal and says so.
const TEAM_MARKER = "<!--rf:agent-->";
function liveClaim(issue) {
  if (!issue) return null;
  let bodies;
  try {
    const out = execSync(
      `gh api "repos/{owner}/{repo}/issues/${issue}/comments?per_page=100" --jq ".[].body"`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 },
    );
    // `--jq .[].body` flattens every comment to lines, so a protocol line is
    // still line-anchored. Keep ALL lines: the protocol scan wants the anchored
    // ones, the informal scan below wants the prose.
    bodies = out.split("\n");
  } catch (e) {
    return { unknown: true, why: firstLine(e) };
  }
  const isProtocol = (l) => /^\s*(claim|release):\s*id=/.test(l);
  const released = new Set();
  for (const b of bodies.filter(isProtocol)) {
    const m = /release:\s*id=(\S+)/.exec(b);
    if (m) released.add(m[1]);
  }
  const now = new Date();
  const live = bodies
    .filter(isProtocol)
    .map((b) => /claim:\s*id=(\S+)\s+lease-until=(\S+)/.exec(b))
    .filter(Boolean)
    .map((m) => ({ id: m[1], leaseUntil: new Date(m[2]) }))
    .filter((c) => !released.has(c.id) && c.leaseUntil > now);
  if (live.length) return live[0];
  // An INFORMAL claim — a session that wrote "Claimed for planning …" in prose
  // instead of taking a lease — is not a lease and must not be treated as one,
  // but it is exactly how the F11 collision happened (a live session held
  // fix/F11-run-cancel-skip while `next` proposed F11). Surface it; the human
  // or the lead decides. Never guess a lock from prose.
  const informal = bodies.find((b) => !isProtocol(b) && /\bclaim(ed|ing)\b/i.test(b));
  return informal ? { informal: true, why: informal.slice(0, 140) } : null;
}

// Every batch that holds workable rows, with everything the selector needs to
// rank it and everything the operator needs to see why it was skipped.
function batchIndex() {
  const catalogue = readCatalogue();
  const state = readState();
  const board = boardJson();
  const byId = new Map(catalogue.map((r) => [r.id, r]));
  const batches = new Map();

  for (const [id, row] of state) {
    if (!row.batch) continue;
    if (!batches.has(row.batch))
      batches.set(row.batch, {
        batch: row.batch,
        bugs: [],
        sensitive: [],
        inFlight: [],
        issue: board.batches?.[row.batch] ?? null,
      });
    const b = batches.get(row.batch);
    if (row.state === "in-flight") b.inFlight.push(id);
    if (!WORKABLE.has(row.state)) continue;
    const bug = byId.get(id) ?? { id, title: "(not in catalogue)", location: "", severity: "none" };
    b.bugs.push(bug);
    if (bug.sensitive ?? classify(bug).sensitive) b.sensitive.push(bug);
  }
  for (const [k, b] of batches) if (!b.bugs.length && !b.inFlight.length) batches.delete(k);
  return { batches, state };
}

const worstRank = (b) => Math.min(...b.bugs.map((x) => SEVERITY_RANK[x.severity] ?? 4), 4);
const worstSeverity = (b) =>
  Object.keys(SEVERITY_RANK).find((k) => SEVERITY_RANK[k] === worstRank(b)) ?? "none";

// Deterministic: worst severity first, then the bigger batch, then the name.
// Never a Map/readdir order — two agents ranking the same ledger must agree.
const rankBatches = (list) =>
  [...list].sort(
    (a, b) =>
      worstRank(a) - worstRank(b) ||
      b.bugs.length - a.bugs.length ||
      String(a.batch).localeCompare(String(b.batch)),
  );

// Batch-level hard conflicts between OPEN bugs: two batches that share a
// non-hub file must never run in parallel. Hub files stay a review signal, not
// a conflict — see buildGraph's warning.
function batchConflicts(hubThreshold) {
  const g = buildGraph(hubThreshold);
  const open = (id) => WORKABLE.has(g.state.get(id)?.state);
  const conflicts = new Map();
  const link = (a, b, files) => {
    if (!conflicts.has(a)) conflicts.set(a, new Map());
    const m = conflicts.get(a);
    if (!m.has(b)) m.set(b, new Set());
    files.forEach((f) => m.get(b).add(f));
  };
  for (const id of g.bugs) {
    if (!open(id)) continue;
    for (const [other, e] of g.edges.get(id)) {
      if (!open(other) || !e.hard.length) continue;
      const a = g.batchOf.get(id);
      const b = g.batchOf.get(other);
      if (!a || !b || a === b) continue;
      link(a, b, e.hard);
      link(b, a, e.hard);
    }
  }
  return conflicts;
}

// Greedy colouring, capped at the agent limit. Greedy is the right tool here:
// the graph is tiny, the answer must be stable between runs and explainable to
// a human, and an optimal colouring would still be re-computed the moment a
// batch is claimed. Order is the ranking above, so the worst severity gets
// wave 1 and nothing in a wave shares a non-hub file with anything else in it.
function computeWaves(ranked, conflicts, cap = AGENT_CAP) {
  const waveOf = new Map();
  const sizes = [];
  for (const b of ranked) {
    const neighbours = [...(conflicts.get(b.batch)?.keys() ?? [])];
    let w = 0;
    while (
      (sizes[w] ?? 0) >= cap ||
      neighbours.some((o) => waveOf.get(o) === w) // a hard conflict already in this wave
    )
      w++;
    waveOf.set(b.batch, w);
    sizes[w] = (sizes[w] ?? 0) + 1;
  }
  const waves = [];
  for (const b of ranked) {
    const w = waveOf.get(b.batch);
    (waves[w] ??= []).push(b);
  }
  return waves.map((w) => w ?? []);
}

// The one selector both `next` and `waves` run on, so they can never disagree
// about which batch is next — the review found `next` proposing F11 while
// `deps` reported F11 hard-conflicting with three other open batches.
function selectBatches(args) {
  const hubThresholdRaw = flag(args, "hub-threshold", HUB_DEFAULT);
  const hubThreshold = Number(hubThresholdRaw);
  if (!Number.isFinite(hubThreshold) || hubThreshold < 1)
    fail(`--hub-threshold must be a positive integer (got "${hubThresholdRaw}")`);
  const capRaw = flag(args, "cap", AGENT_CAP);
  const cap = Number(capRaw);
  if (!Number.isInteger(cap) || cap < 1) fail(`--cap must be a positive integer (got "${capRaw}")`);

  const { batches } = batchIndex();
  const skipped = [];
  const parked = [];
  const candidates = [];

  for (const b of rankBatches(batches.values())) {
    if (b.sensitive.length) {
      parked.push(b);
      continue;
    }
    if (!b.bugs.length) {
      skipped.push({ ...b, why: `no workable rows (${b.inFlight.length} in-flight)` });
      continue;
    }
    if (b.inFlight.length) {
      skipped.push({
        ...b,
        why: `${b.inFlight.length} row(s) in-flight: ${b.inFlight.join(", ")}`,
      });
      continue;
    }
    candidates.push(b);
  }

  // The claim read is per candidate and network-bound, so it runs LAST and only
  // over batches that survived every free check.
  if (!args.includes("--no-claims")) {
    const still = [];
    for (const b of candidates) {
      const c = liveClaim(b.issue);
      if (c?.unknown) {
        // Unreadable is not free: keep the batch, but say the check did not run.
        b.claimCheck = `claim check unavailable (${c.why}) — relying on in-flight rows only`;
        still.push(b);
      } else if (c?.informal) {
        b.claimCheck = `issue #${b.issue} carries an informal claim (no team.mjs lease) — VERIFY before taking it: "${c.why}"`;
        still.push(b);
      } else if (c) {
        skipped.push({ ...b, why: `claimed by ${c.id} until ${c.leaseUntil.toISOString()}` });
      } else {
        still.push(b);
      }
    }
    candidates.length = 0;
    candidates.push(...still);
  }

  const waves = computeWaves(candidates, batchConflicts(hubThreshold), cap);
  return { waves, parked, skipped, cap, hubThreshold };
}

const claimHint = (b) => `node scripts/team/team.mjs claim ${b.issue ?? "<issue#>"}`;

// The dispatcher's selector. Returns the next BATCH an agent may take, because a
// batch — not a single bug — is what the board card, the pipeline folder and the
// PR are all scoped to. It returns the head of WAVE 1, not the head of a
// severity sort: the top of a severity sort routinely hard-conflicts with the
// batch someone else is already in.
cmds.next = (args) => {
  const { waves, parked, skipped } = selectBatches(args);
  const wave1 = waves[0] ?? [];

  if (args.includes("--json")) {
    console.log(JSON.stringify({ eligible: wave1, waves, parked, skipped }, null, 2));
    return;
  }

  if (!wave1.length) {
    console.log(
      "No batch is available right now — every batch with workable rows is parked by the " +
        "carve-out, claimed, or in-flight.",
    );
  } else {
    const top = wave1[0];
    console.log(`next agent-safe batch: ${top.batch}${top.issue ? ` (issue #${top.issue})` : ""}`);
    console.log(`  ${top.bugs.length} workable bug(s), worst severity ${worstSeverity(top)}`);
    for (const b of top.bugs)
      console.log(`    ${b.id.padEnd(5)} ${String(b.severity).padEnd(8)} ${b.title.slice(0, 76)}`);
    if (top.claimCheck) console.log(`  ⚠ ${top.claimCheck}`);
    if (wave1.length > 1)
      console.log(
        `  safe to run alongside it (same wave, no shared non-hub file): ` +
          wave1
            .slice(1)
            .map((b) => b.batch)
            .join(" "),
      );
    console.log(`\n  claim it:  ${claimHint(top)}`);
  }

  if (skipped.length) {
    console.log(`\nskipped (${skipped.length}):`);
    for (const b of skipped) console.log(`    ${String(b.batch).padEnd(4)}  ${b.why}`);
  }

  if (parked.length) {
    console.log(`\nparked for owner review (${parked.length} batch(es) trip the carve-out):`);
    for (const b of parked) {
      const why = [
        ...new Set(b.sensitive.flatMap((x) => x.sensitiveFor ?? classify(x).reasons)),
      ].join(", ");
      console.log(
        `    ${b.batch}  ${String(b.sensitive.length).padStart(2)}/${b.bugs.length} sensitive  (${why})`,
      );
    }
  }
};

// The schedule `deps` stopped one step short of. `deps` reports which batches
// conflict; this answers the question that was actually being asked — what can
// four agents run RIGHT NOW, and what has to wait for them.
cmds.waves = (args) => {
  const { waves, parked, skipped, cap, hubThreshold } = selectBatches(args);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ waves, parked, skipped, cap, hubThreshold }, null, 2));
    return;
  }
  console.log(
    `Waves — greedy colouring of the batch hard-conflict graph (hub threshold ${hubThreshold}), ` +
      `capped at ${cap} concurrent batches, worst severity first.\n`,
  );
  if (!waves.length) console.log("  nothing available to schedule.");
  waves.forEach((w, i) => {
    console.log(`wave ${i + 1}`);
    for (const b of w) {
      console.log(
        `    ${b.batch.padEnd(4)} ${String(b.bugs.length).padStart(2)} bug(s)  ` +
          `worst ${worstSeverity(b).padEnd(8)} ${b.issue ? `#${b.issue}` : "  —  "}  ${claimHint(b)}`,
      );
      if (b.claimCheck) console.log(`         ⚠ ${b.claimCheck}`);
    }
  });
  if (skipped.length) {
    console.log(`\nnot scheduled (${skipped.length}):`);
    for (const b of skipped) console.log(`    ${String(b.batch).padEnd(4)}  ${b.why}`);
  }
  if (parked.length)
    console.log(
      `\nparked by the carve-out (plan only, never fixed unattended): ` +
        parked.map((b) => b.batch).join(" "),
    );
};

cmds.list = (args) => {
  const state = readState();
  let rows = readCatalogue();
  if (args.includes("--open"))
    rows = rows.filter((r) => (state.get(r.id)?.state ?? "queued") === "queued");
  if (args.includes("--sensitive")) rows = rows.filter((r) => r.sensitive ?? classify(r).sensitive);
  const batch = normBatch(flag(args, "batch"), { optional: true });
  if (batch) rows = rows.filter((r) => r.batch === batch);
  rows.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 4) - (SEVERITY_RANK[b.severity] ?? 4));
  for (const r of rows) {
    const st = state.get(r.id)?.state ?? "—";
    const mark = r.sensitive ? "!" : " ";
    console.log(
      `${r.id.padEnd(5)} ${String(r.severity).padEnd(8)} ${String(r.batch ?? "—").padEnd(5)} ${st.padEnd(10)} ${mark} ${r.title.slice(0, 70)}`,
    );
  }
  console.log(`\n${rows.length} row(s).`);
};

cmds.stats = () => {
  const catalogue = readCatalogue();
  const state = readState();
  const bySeverity = {};
  const byState = {};
  let sensitive = 0;
  for (const r of catalogue) {
    bySeverity[r.severity] = (bySeverity[r.severity] || 0) + 1;
    const st = state.get(r.id)?.state ?? "uncampaigned";
    byState[st] = (byState[st] || 0) + 1;
    if (r.sensitive ?? classify(r).sensitive) sensitive++;
  }
  console.log(`catalogue : ${catalogue.length} bug(s)`);
  console.log(`severity  : ${JSON.stringify(bySeverity)}`);
  console.log(`state     : ${JSON.stringify(byState)}`);
  console.log(`carve-out : ${sensitive} sensitive / ${catalogue.length - sensitive} agent-safe`);
};

// ── the per-bug record ────────────────────────────────────────────────────
// One markdown file per bug, at `.claude/campaign/bugs/B###.md`. This is the
// Jira-card equivalent and it is deliberately a FILE, not a row:
//   * an agent tackling B129 reads ~1 KB, not a 200-row catalogue or a 614 KB
//     HTML — the single biggest token lever in the whole loop;
//   * `git log -p` on one file IS that bug's audit trail, for free;
//   * a human can open, read and edit exactly one bug.
// The narrative sections are written by the analysis pass; the front matter and
// the History log are DERIVED and refreshed by `sync`, so the record cannot
// drift from the proof ledger the way the board did.
const RECORD_DIR = () => join(rootDir(), "bugs");
const recordPath = (id) => join(RECORD_DIR(), `${id}.md`);
const SECTIONS = [
  "Summary",
  "What this feature is for",
  "Root cause",
  "User impact",
  "Fix approach and UX",
  "Test plan",
];
const UNANALYSED = "_Not yet analysed._";

function parseRecord(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!m) {
    // A file that opens with the delimiter but doesn't match at all (was: any
    // CRLF-terminated record, since the old regex was LF-only) used to be
    // returned whole as the body, and a subsequent write baked a SECOND
    // front-matter block on top of the first rather than reporting anything.
    if (/^---\r?\n/.test(text))
      fail(
        "record opens with '---' but does not parse as front matter + body — inspect it by hand",
      );
    return { front: {}, body: text };
  }
  const front = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w]*):\s*(.*)$/.exec(line);
    if (kv) front[kv[1]] = kv[2] === "" ? null : kv[2];
  }
  return { front, body: m[2] };
}

const renderFront = (front) =>
  "---\n" +
  Object.entries(front)
    .map(([k, v]) => (v === null || v === undefined || v === "" ? `${k}:` : `${k}: ${v}`))
    .join("\n") +
  "\n---\n";

const readRecord = (id) =>
  existsSync(recordPath(id)) ? parseRecord(readFileSync(recordPath(id), "utf8")) : null;

function writeRecord(id, front, body) {
  mkdirSync(RECORD_DIR(), { recursive: true });
  writeFileSync(recordPath(id), renderFront(front) + body);
}

// History is append-only and deduped on `key` — so sync is idempotent and can
// run from a hook on every turn without growing the file.
//
// ⚠️ Dedupe-on-key is correct ONLY for events whose key already identifies the
// occurrence (a commit sha). For a STATE event it silently swallows a repeat:
// a bug that goes done → queued → done carries `<!--state-done-->` from the
// first pass, so the second `done` is a no-op — and sync reported it as
// recorded anyway. Use `appendEvent` for anything that can legitimately recur.
function appendHistory(body, key, event, detail) {
  if (body.includes(`<!--${key}-->`)) return body;
  const line = `- ${new Date().toISOString().slice(0, 10)} · **${event}** · ${String(detail).replace(/\s+/g, " ").trim()} <!--${key}-->`;
  return body.includes("## History")
    ? `${body.replace(/\s*$/, "")}\n${line}\n`
    : `${body}\n## History\n\n${line}\n`;
}

// The occurrence discriminator. `base` identifies the KIND of event (plus its
// natural discriminator — a PR number, a date, a from→to pair); this appends
// `#2`, `#3`, … when that base has already been logged, so a revisited state
// always produces a new line instead of vanishing.
function uniqueHistoryKey(body, base) {
  if (!body.includes(`<!--${base}-->`)) return base;
  let n = 2;
  while (body.includes(`<!--${base}#${n}-->`)) n++;
  return `${base}#${n}`;
}

// Append an event that MAY legitimately recur, and assert it landed. Callers
// of this are all guarded by a real comparison (the ledger state differs from
// the record's, `move` refuses from===to, `tier` refuses a no-op), so a
// no-change return here is a defect, never a benign dedupe — fail loudly
// rather than report an event the record does not carry (L-051).
function appendEvent(body, base, event, detail) {
  const next = appendHistory(body, uniqueHistoryKey(body, base), event, detail);
  if (next === body)
    fail(
      `history append for "${base}" produced no change — refusing to report an event the record does not carry`,
    );
  return next;
}

const today = () => new Date().toISOString().slice(0, 10);

// The single helper for replacing one named "## Section" block's content.
// `cmds.note` and the self-test both call this — never two copies of the
// regex, which is exactly how a regression in the shipped writer went
// uncaught (the self-test asserted against its own hand-built copy).
// Bounded by the next heading OF ANY KIND (or end of string), never a specific
// heading name — an anchor bound to one fixed next-heading deletes every
// section in between when a different heading actually comes next.
function replaceSection(body, sectionName, text) {
  const rx = new RegExp(`(## ${sectionName}\\n\\n)([\\s\\S]*?)(?=\\n## |$)`);
  if (!rx.test(body)) return null;
  // Function replacement, never a string one: a string replacement expands
  // $1 / $& / $` / $' inside the CALLER's text, and analysis prose in a
  // delivery product says "$100" constantly (proved: it shredded B32).
  return body.replace(rx, (_m, heading) => `${heading}${text}\n`);
}

const frontFor = (bug, st) => ({
  id: bug.id,
  title: bug.title,
  location: bug.location,
  severity: bug.severity,
  batch: st?.batch ?? bug.batch ?? null,
  tier: st?.tier ?? null,
  state: st?.state ?? "uncampaigned",
  // Only a state that actually carries a proof shows one. `reopen` CLEARS the
  // ledger's proof, and a state-only rule (`!== "queued"`) would have let the
  // very next `sync` resurrect the token it had just erased — the record would
  // claim a proof its own ledger row does not have.
  proof: st?.proof ? `REG-${bug.id}` : null,
  sensitive: bug.sensitive ?? classify(bug).sensitive,
  sensitiveFor: (bug.sensitiveFor ?? classify(bug).reasons).join(",") || null,
  closed: st && ["done", "already-fixed"].includes(st.state) ? "yes" : null,
});

// The single machine-generated summary line under the H1 title. Rendered from
// front matter so it can be REGENERATED on every refresh instead of drifting
// forever — a record's body used to bake this in once at creation and never
// touch it again, so B32 still read "Batch F11" and B211 still read "State
// uncampaigned" long after their ledger rows moved on.
const renderHeaderLine = (front) =>
  `**Location** \`${front.location}\` · **Severity** ${front.severity}` +
  `${front.batch ? ` · **Batch** ${front.batch}` : ""} · **State** ${front.state}`;

// Delimited and machine-generated: find the line by its fixed "**Location**"
// prefix (never by matching the surrounding title, which can contain anything)
// and rewrite it wholesale. A record with no such line yet is left alone.
function refreshHeaderLine(body, front) {
  if (!/^\*\*Location\*\*.*$/m.test(body)) return body;
  return body.replace(/^\*\*Location\*\*.*$/m, () => renderHeaderLine(front));
}

// Create records that do not exist yet; refresh derived front matter on ones
// that do. NEVER touches a narrative section — analysis is expensive and a
// refresh must not be able to destroy it.
cmds.expand = () => {
  const catalogue = readCatalogue();
  if (!catalogue.length) fail("catalogue is empty — run `import` first");
  const state = readState();
  let created = 0;
  let refreshed = 0;

  for (const bug of catalogue) {
    const st = state.get(bug.id);
    const front = frontFor(bug, st);
    const existing = readRecord(bug.id);

    if (!existing) {
      let body =
        `\n# ${bug.id} · ${bug.title}\n\n` +
        `${renderHeaderLine(front)}\n\n` +
        SECTIONS.map((s) => `## ${s}\n\n${UNANALYSED}\n`).join("\n") +
        // A filed bug's own description is the only substantive text about it
        // until analysis lands — carry it into the body, the same section name
        // `enrich` uses for register imports, so it is never stranded in the
        // catalogue alone (a documented `index` run used to destroy it).
        (bug.source === "filed" && bug.symptom
          ? `\n## Reported evidence\n\n${bug.symptom}\n`
          : "") +
        `\n## History\n`;
      // Provenance must say what actually happened — a bug created via
      // `bugs.mjs file` was never "imported from the register", and that false
      // line was baked into every filed bug's History (B211 onward).
      body = appendHistory(
        body,
        `filed`,
        "filed",
        bug.source === "filed"
          ? "filed directly via `bugs.mjs file`"
          : `imported from the register (${bug.register})`,
      );
      if (st) body = appendHistory(body, `batch-${st.batch}`, "batched", `assigned to ${st.batch}`);
      if (st && st.state !== "queued")
        body = appendHistory(
          body,
          `state-${st.state}`,
          st.state,
          st.pr ? `PR #${st.pr}` : "recorded in the proof ledger",
        );
      writeRecord(bug.id, front, body);
      created++;
    } else {
      writeRecord(bug.id, { ...existing.front, ...front }, refreshHeaderLine(existing.body, front));
      refreshed++;
    }
  }
  console.log(`records: ${created} created, ${refreshed} refreshed, in ${RECORD_DIR()}/`);
};

// ── the commit scanner: a deliberately WEAK signal ────────────────────────
// ⚠️ Automatic tracking is NOT delivered by commit archaeology, and this file
// should never be read as claiming it is. Measured on this repo: of 101 `fix:`
// commits, 4 name a B-id, 12 name a batch, and 85 name neither. What makes
// tracking automatic is that `prove` / `discharge` are the non-negotiable LAST
// STEP of a fix — the ledger moves, and `sync` derives the record from it. The
// scanner only catches commits that happen to describe themselves, so:
//   * it matches a bare `B###` token (normalised, so "B4" finds "B04"), which
//     also matches unrelated tokens — a weak signal, recorded as one;
//   * it matches the house convention `fix(area): … (F10)` and fans that event
//     out to every id in F10's shard, because the batch is what commits name;
//   * it is ANCHORED, not windowed. `--max-count=400` was a rolling window: an
//     event that scrolled past 400 commits before a sync ran was unrecoverable.
//     The last-synced sha is persisted instead, so nothing can scroll away.
//
// The anchor file is machine-local and gitignored (`.campaign/`), NOT tracked:
// HEAD moves on every commit, and Gate 4 runs `sync` every turn, so a tracked
// anchor would leave the tree permanently dirty and conflict across the eight
// live worktrees. A fresh clone therefore has no anchor — and the FIRST run
// only anchors, it does not re-derive history, because the records committed in
// git already carry theirs. `--rescan` forces the bounded first-run window.
//
// Branch scope is intentional: `git log` walks this worktree's HEAD, which is
// the branch whose records are being written.
const SYNC_STATE = () =>
  process.env.BUGS_SYNC_STATE ||
  (process.env.BUGS_ROOT ? join(rootDir(), "sync-state.json") : ".campaign/bugs-sync-state.json");
const FIRST_RUN_WINDOW = 400;

const git = (cmd) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function readSyncState() {
  const p = SYNC_STATE();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    return fail(`malformed sync anchor at ${p} — ${e.message} (delete it to re-anchor)`);
  }
}

// Reads back and asserts, like every other write path here (L-051): an anchor
// that silently fails to advance re-scans the same range forever.
function writeSyncState(lastSha) {
  const p = SYNC_STATE();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ lastSha, at: new Date().toISOString() }, null, 2) + "\n");
  if (readSyncState().lastSha !== lastSha) fail(`sync anchor write did not land at ${p}`);
}

// One git pass for every bug, not one per bug: 210 `git log --grep` calls would
// dominate the runtime of a hook that fires on every turn.
function commitMentions(state, args) {
  const mentions = new Map();
  const rescan = args.includes("--rescan");
  let head;
  try {
    head = git("git rev-parse HEAD").trim();
  } catch (e) {
    // No git (a tarball, a broken PATH) is not a reason to lose the ledger half
    // of the sync — say so and carry on.
    return { mentions, note: `git unavailable, commit scan skipped — ${firstLine(e)}` };
  }

  const prev = readSyncState().lastSha;
  // A sha that git no longer knows (rebased away, a different clone) must not
  // abort the scan — fall back to the bounded window.
  const anchored = prev && !rescan && isCommit(prev) ? prev : null;
  if (!anchored && !rescan) {
    writeSyncState(head);
    return {
      mentions,
      note: prev
        ? `anchor ${prev.slice(0, 8)} is unknown to git — re-anchored at ${head.slice(0, 8)}, no scan`
        : `first run — anchored at ${head.slice(0, 8)}; commit history is not re-derived (use --rescan to force)`,
    };
  }
  const spec = anchored ? `${anchored}..HEAD` : `--max-count=${FIRST_RUN_WINDOW} HEAD`;

  let log;
  try {
    log = git(`git log --format=%H%x09%s ${spec}`);
  } catch (e) {
    return { mentions, note: `commit scan failed (${spec}) — ${firstLine(e)}` };
  }

  const { mentions: scanned, commits } = parseMentions(log, state);
  writeSyncState(head);
  return {
    mentions: scanned,
    note: commits
      ? `scanned ${commits} commit(s) since ${(anchored ?? "the window").slice(0, 8)}`
      : null,
  };
}

// Pure, so the self-test can drive the fan-out from a fixture log instead of
// whatever this worktree's history happens to contain.
function parseMentions(log, state) {
  const mentions = new Map();
  const idsInShard = new Map();
  for (const [id, row] of state) {
    if (!row.batch) continue;
    if (!idsInShard.has(row.batch)) idsInShard.set(row.batch, []);
    idsInShard.get(row.batch).push(id);
  }

  const add = (id, hit) => {
    const key = normId(id) ?? id;
    if (!mentions.has(key)) mentions.set(key, []);
    mentions.get(key).push(hit);
  };

  let commits = 0;
  for (const line of log.split("\n").filter(Boolean)) {
    const [sha, subject = ""] = line.split("\t");
    commits++;
    const short = sha.slice(0, 8);
    // Bug ids first: when a commit names both, the bug-id detail is the one
    // that lands (both share the `commit-<sha>` marker, first write wins).
    for (const raw of new Set(subject.match(/\bB\d{1,3}\b/g) ?? []))
      add(raw, { sha: short, detail: `\`${short}\` ${subject}` });
    for (const m of new Set([...subject.matchAll(/\(F(\d{2})\)/g)].map((x) => `F${x[1]}`)))
      for (const id of idsInShard.get(m) ?? [])
        add(id, { sha: short, detail: `\`${short}\` ${subject} — matched via batch ${m}` });
  }
  return { mentions, commits };
}

const firstLine = (e) => String(e.message ?? e).split("\n")[0];
const isCommit = (sha) => {
  try {
    return git(`git cat-file -t ${sha}`).trim() === "commit";
  } catch {
    return false;
  }
};

// The automatic half. Derives history events from the two sources that already
// move on their own — the proof ledger and git — and appends any the record has
// not recorded yet. Idempotent, so it is safe to run from a hook every turn.
cmds.sync = (args) => {
  const catalogue = readCatalogue();
  const state = readState();
  const quiet = args.includes("--quiet");
  const events = [];

  const { mentions, note } = commitMentions(state, args);
  if (note && !quiet) console.log(`sync: ${note}`);

  for (const bug of catalogue) {
    const rec = readRecord(bug.id);
    if (!rec) continue;
    const st = state.get(bug.id);
    let body = rec.body;
    const before = body;

    if (st && st.state !== rec.front.state) {
      // Discriminated by the PR when there is one and the date otherwise, then
      // by occurrence — a bug that RETURNS to a state it has held before must
      // log a second line. done → queued → done is a regression and a refix,
      // which is the single most important thing a history can record, and the
      // bare `state-<state>` key swallowed it while sync reported it recorded.
      body = appendEvent(
        body,
        `state-${st.state}-${st.pr ?? today()}`,
        st.state,
        st.pr ? `PR #${st.pr}` : "recorded in the proof ledger",
      );
      events.push(`${bug.id} ${rec.front.state} → ${st.state}`);
    }
    for (const c of mentions.get(normId(bug.id) ?? bug.id) ?? []) {
      // Compare THIS append's return, not the whole-iteration `before`: `before`
      // is captured once per bug, so as soon as anything in the iteration
      // changed the body every later append reported as new whether it landed
      // or not (the same defect as the state event above, one line down).
      const withCommit = appendHistory(body, `commit-${c.sha}`, "commit", c.detail);
      if (withCommit !== body) events.push(`${bug.id} commit ${c.sha}`);
      body = withCommit;
    }

    const front = frontFor(bug, st);
    // Regenerate the header line every sync, not only on the events above —
    // it is the ONLY place a ledger state change was ever reflected in the
    // body text, and it used to be written once at record creation and never
    // refreshed again.
    body = refreshHeaderLine(body, front);

    if (body !== before) writeRecord(bug.id, { ...rec.front, ...front }, body);
    else if (st && st.state !== rec.front.state)
      writeRecord(bug.id, { ...rec.front, ...front }, body);
  }

  if (!quiet || events.length) console.log(`sync: recorded ${events.length} new event(s).`);
  for (const e of events.slice(0, 20)) console.log(`  ${e}`);
};

cmds.show = (args) => {
  const typed = (args[0] ?? "").toUpperCase();
  if (!/^B\d+$/.test(typed)) fail("usage: show <B###>");
  const id = resolveId(typed);
  if (!existsSync(recordPath(id))) fail(`no record for ${id} — run \`expand\``);
  process.stdout.write(readFileSync(recordPath(id), "utf8"));
};

// How an analysis agent writes its findings back. `--section` replaces one
// narrative section; without it the text lands as a history note.
cmds.note = (args) => {
  const typed = (args[0] ?? "").toUpperCase();
  const text = args[1];
  if (!/^B\d+$/.test(typed) || !text || text.startsWith("--"))
    fail('usage: note <B###> "<text>" [--section "Root cause"]');
  const id = resolveId(typed);
  const rec = readRecord(id);
  if (!rec) fail(`no record for ${id} — run \`expand\``);
  const section = flag(args, "section");

  if (section) {
    const match = SECTIONS.find((s) => s.toLowerCase() === section.toLowerCase());
    if (!match) fail(`--section must be one of: ${SECTIONS.join(" | ")}`);
    const body = replaceSection(rec.body, match, text);
    if (body === null) fail(`section "${match}" not found in ${id}`);
    writeRecord(id, rec.front, body);
    console.log(`${id}: wrote "${match}".`);
  } else {
    const key = `note-${Date.now()}`;
    writeRecord(id, rec.front, appendHistory(rec.body, key, "note", text));
    console.log(`${id}: history note added.`);
  }
};

// bugs.jsonl is a DERIVED index over the records — regenerate, never hand-edit.
cmds.index = () => {
  if (!existsSync(RECORD_DIR())) fail("no records yet — run `expand`");
  // Preserve every catalogue field this command does not derive from the record
  // front matter (symptom, filedAt, register, source, …) by reading the EXISTING
  // row and spreading the derived keys on top of it, never the other way round.
  // A prior `index` rebuilt a fixed 9-key shape from scratch and silently
  // destroyed the filed symptom, filedAt, and 61 register PR links.
  const priorById = new Map(readCatalogue().map((r) => [r.id, r]));
  const rows = readdirSync(RECORD_DIR())
    .filter((f) => f.endsWith(".md"))
    .map((f) => parseRecord(readFileSync(join(RECORD_DIR(), f), "utf8")).front)
    .map((fm) => ({
      ...(priorById.get(fm.id) ?? {}),
      id: fm.id,
      title: fm.title,
      location: fm.location,
      severity: fm.severity,
      batch: fm.batch,
      // `register` is NOT recomputed here — it means what the register said at
      // import time (or "open" for a bug that never had a prior row at all),
      // and `closed` is a ledger-derived front-matter field, not a register verdict.
      register: priorById.get(fm.id)?.register ?? "open",
      sensitive: fm.sensitive === "true",
      sensitiveFor: fm.sensitiveFor ? fm.sensitiveFor.split(",") : [],
    }));
  writeCatalogue(rows);
  const preserved = rows.filter((r) => priorById.has(r.id)).length;
  console.log(
    `index: rebuilt bugs.jsonl from ${rows.length} record(s) (${preserved} row(s) carried forward prior catalogue fields).`,
  );
};

// ── ledger writes ─────────────────────────────────────────────────────────
// The proof ledger is REPLACE-IN-PLACE, one row per bug id across all shards —
// campaign-check rejects a duplicate id, and appending a second row for the same
// bug is the first thing anyone tries (it cost a full redo during the F07/F10
// discharge). Every ledger write in this file goes through upsertLedgerRow, so
// that mistake is unrepresentable rather than merely documented.
const shardPath = (batch) => join(STATUS_DIR(), `${batch}.jsonl`);

function readShard(batch) {
  const p = shardPath(batch);
  if (!existsSync(p)) return { rows: [], eol: "\n" };
  const raw = readFileSync(p, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  return {
    // Same failure mode as readState's per-line parse: a crash here used to
    // take down every ledger-reading command with no indication of which
    // shard/line was at fault.
    rows: lines.map((l, i) => {
      try {
        return JSON.parse(l);
      } catch (e) {
        return fail(
          `malformed JSON in ${batch}.jsonl:${i + 1} — ${e.message}\n  line: ${l.slice(0, 200)}`,
        );
      }
    }),
    eol: raw.includes("\r\n") ? "\r\n" : "\n",
  };
}

// Returns { what: "added"|"updated", row: <the RE-READ row> } so a caller can
// assert its write actually landed instead of trusting the in-memory object it
// built — proved necessary: `prove --pr not-a-number` wrote `"pr":null` to the
// shard while the in-memory `row` it printed from still said `pr: NaN`.
function upsertLedgerRow(batch, row) {
  const { rows, eol } = readShard(batch);
  const i = rows.findIndex((r) => r.id === row.id);
  if (i === -1) {
    // Widen the duplicate guard to ALL shards, not just this one — the
    // same-shard check below cannot catch a row for this id already living in
    // a DIFFERENT shard, which is precisely the duplicate campaign-check
    // rejects and the invariant the surrounding comments already claim holds.
    const elsewhere = findShardOf(row.id);
    if (elsewhere && elsewhere !== batch)
      fail(`refusing to write ${batch}: ${row.id} already has a row in ${elsewhere}.jsonl`);
    rows.push(row);
  } else {
    rows[i] = { ...rows[i], ...row };
  }
  const ids = rows.map((r) => r.id);
  if (new Set(ids).size !== ids.length) fail(`refusing to write ${batch}: duplicate id in shard`);
  mkdirSync(STATUS_DIR(), { recursive: true });
  writeFileSync(shardPath(batch), rows.map((r) => JSON.stringify(r)).join(eol) + eol);
  const after = readShard(batch).rows.find((r) => r.id === row.id);
  return { what: i === -1 ? "added" : "updated", row: after };
}

const findShardOf = (id) => {
  if (!existsSync(STATUS_DIR())) return null;
  for (const f of readdirSync(STATUS_DIR()).filter((n) => n.endsWith(".jsonl"))) {
    const batch = f.replace(/\.jsonl$/, "");
    if (readShard(batch).rows.some((r) => r.id === id)) return batch;
  }
  return null;
};

// ── brief: everything an agent needs to start, in one output ───────────────
// The point of the registry is that an agent picking up work reads ONE thing.
// Before this, starting a batch meant assembling the board card, the ledger,
// four record files and the pipeline discovery by hand — which is how an agent
// ends up fixing the right bug the wrong way.
cmds.brief = (args) => {
  const typed = (args[0] ?? "").toUpperCase();
  if (!/^(F\d{2}|B\d+)$/.test(typed)) fail("usage: brief <F##|B###>");
  const target = /^B/.test(typed) ? resolveId(typed) : typed;

  const board = existsSync(BOARD()) ? JSON.parse(readFileSync(BOARD(), "utf8")) : { batches: {} };
  // A B-id with no ledger row used to slip past the length guard below (`ids`
  // is a length-1 array by construction for a B-target) and print `# null`.
  const batch = /^B/.test(target) ? findShardOf(target) : target;
  if (/^B/.test(target) && !batch)
    fail(`${target} is in no ledger shard — file it with a --batch first`);
  const ids = /^B/.test(target) ? [target] : readShard(target).rows.map((r) => r.id);
  if (!ids.length) fail(`no ledger rows for ${target}`);

  const state = readState();
  const out = [];
  out.push(`# ${batch}${board.batches?.[batch] ? ` · board issue #${board.batches[batch]}` : ""}`);

  const pipelineDir = existsSync(".claude/pipeline")
    ? readdirSync(".claude/pipeline").find((d) => d.toUpperCase().includes(`-${batch}-`))
    : null;
  const discovery = pipelineDir ? join(".claude/pipeline", pipelineDir, "discovery.md") : null;

  const rows = ids.map((id) => ({ id, st: state.get(id), rec: readRecord(id) }));
  const analysed = rows.filter((r) => r.rec && !r.rec.body.includes(UNANALYSED));
  out.push(
    `\n${rows.length} bug(s) · ${rows.filter((r) => r.st?.state === "queued").length} queued · ` +
      `${analysed.length}/${rows.length} analysed` +
      (rows.some((r) => r.rec?.front.sensitive === "true")
        ? " · ⚠ CONTAINS CARVE-OUT BUGS — plan only, do not fix unattended"
        : ""),
  );
  const contested = rows.filter((r) => r.rec?.front.contestedBy || r.rec?.front.supersededBy);
  if (contested.length)
    out.push(
      `\n⚠️ **${contested.length} record(s) in this batch are CONTESTED or SUPERSEDED** ` +
        `(${contested.map((r) => r.id).join(", ")}) — their fix approach is disputed by another ` +
        `record. Each is flagged again in its own block below; do not build from one alone.`,
    );

  if (discovery && existsSync(discovery)) {
    out.push(
      `\n## Batch plan\n\nRead this FIRST — it carries the ordering, the file conflicts and the risks:\n\n    ${discovery}`,
    );
    const txt = readFileSync(discovery, "utf8");
    const verdict = /## Verdict\n\n([\s\S]*?)(?=\n## )/.exec(txt);
    if (verdict) out.push(`\n${verdict[1].trim()}`);
    const order = /## Ordering\n\n([\s\S]*?)(?=\n## )/.exec(txt);
    if (order) out.push(`\n## Ordering\n\n${order[1].trim()}`);
  } else {
    out.push(
      `\n## Batch plan\n\n⚠ none yet — run the analysis pass before fixing (see the bug-registry skill).`,
    );
  }

  out.push(`\n## Bugs`);
  for (const { id, st, rec } of rows) {
    const f = rec?.front ?? {};
    out.push(
      `\n### ${id} · ${f.severity ?? "?"} · ${st?.state ?? "—"} · tier ${st?.tier ?? f.tier ?? "?"}` +
        `${f.sensitive === "true" ? ` · ⚠ carve-out (${f.sensitiveFor})` : ""}`,
    );
    out.push(`${f.title ?? ""}`);
    out.push(`\`${f.location ?? ""}\``);
    // ⚠️ LOUD, and above the analysis: a record whose conclusions another
    // record disputes is the one way this registry can hand a builder a
    // confident, well-cited plan that is WRONG. B34 prescribed an order-unpin
    // that its own batch's discovery refutes; anyone reading B34 alone ships
    // the regression and writes a green test for it.
    if (f.contestedBy)
      out.push(
        `\n> ⚠️ **CONTESTED BY ${f.contestedBy}** — that record disputes this one's conclusions. ` +
          `Read it BEFORE writing any code for ${id}, and do not follow this fix approach until they agree.`,
      );
    if (f.supersededBy)
      out.push(
        `\n> ⚠️ **SUPERSEDED BY ${f.supersededBy}** — work that record instead; this one is kept for its history.`,
      );
    if (!rec) {
      out.push(`_no record — run \`bugs expand\`_`);
      continue;
    }
    for (const s of ["Summary", "Fix approach and UX", "Test plan"]) {
      const m = new RegExp(`## ${s}\\n\\n([\\s\\S]*?)(?=\\n## |$)`).exec(rec.body);
      if (m) out.push(`\n**${s}**\n\n${m[1].trim()}`);
    }
    out.push(`\nFull record: \`.claude/campaign/bugs/${id}.md\``);
  }

  out.push(`\n## When you finish`);
  out.push(
    `    npm run bugs -- prove <B###> --pr <n> --proof "REG-B### <what the passing test asserts>"\n` +
      `    npm run bugs -- discharge ${batch} --evidence "<post-deploy proof>"   # only AFTER a green deploy\n` +
      `      … plus --evidence-B### "<the run that exercised THAT row>" for every T2 row, or the discharge is refused`,
  );
  process.stdout.write(out.join("\n") + "\n");
};

// ── prove / discharge: the two ledger transitions ──────────────────────────
// proven = merged with a passing REG-B### test. done = live after a green
// deploy. Keeping them separate is the whole reason campaign-check can be
// trusted, so neither command will invent the other's evidence.
cmds.prove = (args) => {
  const typed = (args[0] ?? "").toUpperCase();
  const prRaw = flag(args, "pr");
  const proof = flag(args, "proof");
  if (!/^B\d+$/.test(typed) || !prRaw || !proof)
    fail('usage: prove <B###> --pr <number> --proof "REG-B### <what the passing test asserts>"');
  const id = resolveId(typed);
  // Validate BEFORE writing — `Number("not-a-number")` is NaN, and
  // `JSON.stringify({pr:NaN})` silently emits `"pr":null` while the command
  // still printed that the PR was recorded.
  const pr = Number(prRaw);
  if (!Number.isInteger(pr) || pr <= 0) fail(`--pr must be a positive integer (got "${prRaw}")`);
  if (!new RegExp(`REG-${id}(?![0-9])`).test(proof))
    fail(
      `--proof must cite the exact token REG-${id} — campaign-check matches that token and nothing else`,
    );

  const batch = findShardOf(id);
  if (!batch) fail(`${id} is in no ledger shard — file it with a --batch first`);
  const row = readShard(batch).rows.find((r) => r.id === id);
  const pending = args.includes("--pending-deploy");
  const state = pending ? "proven-pending-deploy" : "proven";
  if (pending && row.tier !== "T2")
    fail("--pending-deploy is for T2 rows only (their proof cannot run pre-merge)");

  const reproving =
    ["proven", "proven-pending-deploy"].includes(row.state) &&
    (row.pr !== pr || row.proof !== proof);
  if (reproving)
    console.warn(
      `${id}: WARNING — overwriting an existing proof (was PR #${row.pr} · "${row.proof}") with PR #${pr}. The old proof is not otherwise kept.`,
    );

  const { what, row: after } = upsertLedgerRow(batch, { ...row, state, pr, proof });
  if (after?.state !== state || after?.pr !== pr || after?.proof !== proof)
    fail(
      `ledger write for ${id} did not land as intended — re-read row is ${JSON.stringify(after)}`,
    );

  const rec = readRecord(id);
  if (rec) {
    // Key the History marker on the PR number too — a bare `state-${state}`
    // key deduped a SECOND prove into a no-op History write, so `show`/the
    // record kept displaying the FIRST proof forever after the ledger moved on.
    // `appendEvent` adds the occurrence discriminator on top, so re-proving the
    // same PR after a `reopen` logs a second line rather than vanishing; the
    // guard below is what keeps a byte-identical re-run from duplicating one.
    const changed = row.state !== state || row.pr !== pr || row.proof !== proof;
    writeRecord(
      id,
      { ...rec.front, state, proof: `REG-${id}` },
      changed ? appendEvent(rec.body, `state-${state}-${pr}`, state, `PR #${pr}`) : rec.body,
    );
  }
  console.log(`${id}: ${batch} row ${what} → ${state} (PR #${pr})`);
  console.log(
    `  discharge to done only after a green deploy: npm run bugs -- discharge ${batch} --evidence "..."`,
  );
};

// ⚠️ THE T2 EVIDENCE RULE. campaign-check accepts a non-empty
// `dischargeEvidence` INSTEAD of a Playwright artifact for a T2 `done` row (a
// verify runner never has one — Playwright runs post-deploy). That makes the
// field the softest spot in the whole gate, and this command used to stamp ONE
// batch-wide sentence onto every proven row in the batch: a single 40-character
// string could discharge an arbitrary number of T2 rows past the strongest
// control the campaign has. So:
//   * T2 rows require their OWN `--evidence-B### "…"`, or the discharge is
//     refused outright — nothing partial is written;
//   * the batch-wide `--evidence` is fine for T1/T3 and is written to
//     `evidence` (matching the convention B96/B101 already carry), never to the
//     field only T2 is read from.
// Rows discharged before this rule (B24/B130/B154 share one string) are
// grandfathered; campaign-check warns about them rather than turning master red.
cmds.discharge = (args) => {
  const evidence = flag(args, "evidence");
  if (!evidence)
    fail(
      'usage: discharge <F##> --evidence "<post-deploy proof: deploy id + the CI run that exercised it>"' +
        '\n       [--evidence-B### "<that row\'s own post-deploy proof>"]   # REQUIRED for every T2 row',
    );
  const batch = normBatch(args[0]);
  const thin = (what, text) =>
    text.length < 40 &&
    fail(
      `${what} must actually cite the deploy and the run that proved it — this is the claim campaign-check cannot check for you`,
    );
  thin("--evidence", evidence);

  const { rows } = readShard(batch);
  const ready = rows.filter((r) => r.state === "proven" || r.state === "proven-pending-deploy");
  if (!ready.length)
    fail(
      `${batch} has no proven row to discharge (states: ${[...new Set(rows.map((r) => r.state))].join(", ")})`,
    );

  // --evidence-B### <text>, collected before ANY write so a missing one refuses
  // the whole discharge rather than leaving half the batch done.
  const perRow = new Map();
  for (let i = 0; i < args.length; i++) {
    const m = /^--evidence-(B\d+)$/i.exec(args[i]);
    if (!m) continue;
    const id = resolveId(m[1].toUpperCase());
    const text = args[i + 1];
    if (text === undefined || text.startsWith("--")) fail(`${args[i]} requires a value`);
    if (!ready.some((r) => r.id === id))
      fail(`${args[i]}: ${id} is not a proven row in ${batch} — nothing to discharge for it`);
    thin(args[i], text);
    perRow.set(id, text);
  }

  const missing = ready.filter((r) => r.tier === "T2" && !perRow.has(r.id));
  if (missing.length)
    fail(
      `T2 row(s) ${missing.map((r) => r.id).join(", ")} need their OWN evidence — ` +
        `pass --evidence-${missing[0].id} "<the run that exercised THIS bug against the deployed build>". ` +
        `campaign-check accepts dischargeEvidence in place of a Playwright artifact, so one batch-wide ` +
        `string would discharge every T2 row in the batch past the only control that reads it.`,
    );
  const seen = new Map();
  for (const [id, text] of perRow) {
    if (seen.has(text))
      fail(
        `${id} and ${seen.get(text)} were given byte-identical evidence — cite each row's own run`,
      );
    seen.set(text, id);
  }

  for (const row of ready) {
    const own = perRow.get(row.id);
    // T2 is the only tier campaign-check reads dischargeEvidence for; every
    // other tier records the batch string as plain `evidence`.
    const patch = own
      ? { state: "done", dischargeEvidence: own, evidence: own }
      : { state: "done", evidence };
    const { row: after } = upsertLedgerRow(batch, { ...row, ...patch });
    for (const [k, v] of Object.entries(patch))
      if (after?.[k] !== v)
        fail(
          `ledger write for ${row.id} did not land as intended (${k}) — re-read row is ${JSON.stringify(after)}`,
        );
    const rec = readRecord(row.id);
    if (rec)
      writeRecord(
        row.id,
        { ...rec.front, state: "done", closed: "yes" },
        appendEvent(rec.body, `state-done-${today()}`, "done", (own ?? evidence).slice(0, 200)),
      );
  }
  console.log(
    `${batch}: discharged ${ready.length} row(s) → done — ${ready.map((r) => r.id).join(", ")}`,
  );
  if (perRow.size) console.log(`  per-row evidence recorded for: ${[...perRow.keys()].join(", ")}`);
  console.log(`  verify: node scripts/campaign-check.mjs`);
};

// ── reopen: the state the ledger had no way to express ────────────────────
// Before this, a bug that regressed after `done` could only be re-filed under a
// FRESH id — which severs it from the analysis, the proof and the history that
// made it closable in the first place. `prove` and `discharge` only ever
// advanced, and `move` refuses any non-queued row. `regressed` is a CLAIM
// state: campaign-check holds it to its evidence exactly like `already-fixed`,
// because "it came back" is an assertion about production, not a mood.
cmds.reopen = (args) => {
  const typed = (args[0] ?? "").toUpperCase();
  const why = flag(args, "why");
  if (!/^B\d+$/.test(typed) || !why)
    fail(
      'usage: reopen <B###> --why "<the failing REG-B### token, or the run/report that showed it>"',
    );
  const id = resolveId(typed);
  const batch = findShardOf(id);
  if (!batch) fail(`${id} is in no ledger shard — nothing to reopen`);
  const row = readShard(batch).rows.find((r) => r.id === id);
  if (WORKABLE.has(row.state))
    fail(`${id} is already ${row.state} — it is open work, there is nothing to reopen`);

  // A regression claim with no artifact behind it is a rumour, and this command
  // ERASES a proof — so it costs a citation, the same way `prove` costs a token.
  const citesToken = new RegExp(`REG-${id}(?![0-9])`).test(why);
  const citesRun = /#\d+|https?:\/\/|\brun \d+|\bdeploy\b/i.test(why);
  if (why.length < 40 || !(citesToken || citesRun))
    fail(
      `--why must cite the failing REG-${id} token or the run/deploy/report that showed the ` +
        `regression — reopening clears ${id}'s proof (PR #${row.pr ?? "—"}), which is not recoverable from here`,
    );

  const patch = {
    state: "regressed",
    pr: null,
    proof: null,
    evidence: why,
    dischargeEvidence: null,
  };
  const { row: after } = upsertLedgerRow(batch, { ...row, ...patch });
  for (const [k, v] of Object.entries(patch))
    if (after?.[k] !== v)
      fail(
        `ledger write for ${id} did not land as intended (${k}) — re-read row is ${JSON.stringify(after)}`,
      );

  const rec = readRecord(id);
  if (rec)
    writeRecord(
      id,
      { ...rec.front, state: "regressed", proof: null, closed: null },
      appendEvent(rec.body, `regressed-${today()}`, "regressed", why),
    );
  console.log(`${id}: ${batch} row → regressed (was ${row.state}, PR #${row.pr ?? "—"} cleared)`);
  console.log(`  it is workable again — \`next\`/\`waves\` will offer ${batch} once more.`);
};

// ── claim / release: the offline half of the dispatcher's exclusion ────────
// `in-flight` was already a valid ledger state that NOTHING ever wrote, so the
// only signal that a batch was taken lived in a GitHub comment — unreadable
// offline, and a network hiccup away from handing one batch to two agents.
// team.mjs's lease stays authoritative for the BOARD; this is the ledger's own
// record of the same fact, and `next`/`waves` honour it with no network at all.
const claimId = () => {
  if (process.env.RF_CLAIM_ID) return process.env.RF_CLAIM_ID;
  try {
    return git("git rev-parse --show-toplevel").trim().split(/[/\\]/).pop();
  } catch {
    return "unknown";
  }
};

cmds.claim = (args) => {
  const batch = normBatch(args[0]);
  const { rows } = readShard(batch);
  const take = rows.filter((r) => WORKABLE.has(r.state));
  if (!take.length)
    fail(
      `${batch} has no workable row to claim (states: ${[...new Set(rows.map((r) => r.state))].join(", ")})`,
    );
  const held = rows.filter((r) => r.state === "in-flight");
  if (held.length)
    fail(
      `${batch} already has ${held.length} in-flight row(s) (${held.map((r) => r.id).join(", ")}) — ` +
        `release it first, or take another batch`,
    );

  const who = claimId();
  for (const row of take) {
    const { row: after } = upsertLedgerRow(batch, {
      ...row,
      state: "in-flight",
      claimedFrom: row.state,
      claimedBy: who,
    });
    if (after?.state !== "in-flight" || after?.claimedFrom !== row.state)
      fail(
        `ledger write for ${row.id} did not land as intended — re-read row is ${JSON.stringify(after)}`,
      );
    // Front matter only, no History line: a claim is transient bookkeeping, and
    // a record's history is for what happened TO THE BUG.
    const rec = readRecord(row.id);
    if (rec) writeRecord(row.id, { ...rec.front, state: "in-flight" }, rec.body);
  }
  console.log(`${batch}: ${take.length} row(s) → in-flight, held by ${who}`);
  console.log(`  \`next\`/\`waves\` will skip ${batch} until: npm run bugs -- release ${batch}`);
};

cmds.release = (args) => {
  const batch = normBatch(args[0]);
  const { rows } = readShard(batch);
  const held = rows.filter((r) => r.state === "in-flight");
  if (!held.length) fail(`${batch} holds no in-flight row`);
  for (const row of held) {
    // Restore what the row WAS: releasing a regressed batch must not quietly
    // launder it into a plain queued one.
    const back = WORKABLE.has(row.claimedFrom) ? row.claimedFrom : "queued";
    const { row: after } = upsertLedgerRow(batch, {
      ...row,
      state: back,
      claimedFrom: null,
      claimedBy: null,
    });
    if (after?.state !== back)
      fail(
        `ledger write for ${row.id} did not land as intended — re-read row is ${JSON.stringify(after)}`,
      );
    const rec = readRecord(row.id);
    if (rec) writeRecord(row.id, { ...rec.front, state: back }, rec.body);
  }
  console.log(`${batch}: released ${held.length} row(s) — ${held.map((r) => r.id).join(", ")}`);
};

// A record's own analysis routinely concludes a different tier than the
// ledger row it lives under (B32 designed 9 T1 jest cases while its ledger
// row still said T3, so that conclusion had no path into the gate). `tier`
// is that path — a first-class reconciliation, not a hand edit of the shard.
cmds.tier = (args) => {
  const typed = (args[0] ?? "").toUpperCase();
  const tier = (args[1] ?? "").toUpperCase();
  const why = flag(args, "why");
  if (!/^B\d+$/.test(typed) || !["T1", "T2", "T3"].includes(tier) || !why)
    fail('usage: tier <B###> <T1|T2|T3> --why "<reason the analysis changed>"');
  const id = resolveId(typed);

  const batch = findShardOf(id);
  if (!batch) fail(`${id} is in no ledger shard — file it with a --batch first`);
  const row = readShard(batch).rows.find((r) => r.id === id);
  // A ruling that CONFIRMS the standing tier is a real conclusion — B211's
  // analysis ruled T1 over a defaulted T1 and had to be filed as a plain note
  // because this refused a no-op. Record it; just don't pretend it moved.
  if (row.tier === tier) {
    const rec = readRecord(id);
    if (rec)
      writeRecord(
        id,
        rec.front,
        appendEvent(rec.body, `tier-confirmed-${tier}`, "tier confirmed", `${tier} — ${why}`),
      );
    console.log(
      `${id}: already tier ${tier} — recorded the ruling that confirms it (ledger unchanged).`,
    );
    return;
  }

  const { row: after } = upsertLedgerRow(batch, { ...row, tier });
  if (after?.tier !== tier)
    fail(
      `ledger write for ${id} did not land as intended — re-read row is ${JSON.stringify(after)}`,
    );

  const rec = readRecord(id);
  if (rec)
    writeRecord(
      id,
      { ...rec.front, tier },
      appendEvent(rec.body, `tier-${tier}`, "re-tiered", `${row.tier} → ${tier} — ${why}`),
    );
  console.log(`${id}: ${batch} row updated → tier ${tier} (was ${row.tier})`);
};

cmds.status = (args) => {
  const only = normBatch(args[0], { optional: true });
  const board = existsSync(BOARD()) ? JSON.parse(readFileSync(BOARD(), "utf8")) : { batches: {} };
  const batches = readdirSync(STATUS_DIR())
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(/\.jsonl$/, ""))
    .filter((b) => !only || b === only)
    .sort();
  for (const b of batches) {
    const { rows } = readShard(b);
    if (!rows.length) continue;
    const by = {};
    for (const r of rows) by[r.state] = (by[r.state] || 0) + 1;
    const analysed = rows.filter((r) => {
      const rec = readRecord(r.id);
      return rec && !rec.body.includes(UNANALYSED);
    }).length;
    const done = (by.done || 0) + (by["already-fixed"] || 0);
    console.log(
      `${b.padEnd(4)} ${String(done + "/" + rows.length).padStart(6)} done · ${String(analysed).padStart(2)} analysed · ` +
        `${board.batches?.[b] ? "#" + board.batches[b] : "  —  "}  ${Object.entries(by)
          .map(([k, v]) => `${k}:${v}`)
          .join(" ")}`,
    );
  }
};

// readState() only ever reads status/*.jsonl, so a catalogue bug with no
// ledger row is invisible to `next`, `status`, `deps` and campaign-check —
// today that's exactly the most recently hunted bugs (B202-B210 at the time
// this command was added). `triage` is the one place that set is visible.
cmds.triage = () => {
  const catalogue = readCatalogue();
  const state = readState();
  const untriaged = catalogue.filter((b) => !state.has(b.id));
  if (!untriaged.length) {
    console.log("triage: every catalogue bug has a ledger row.");
    return;
  }
  untriaged.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 4) - (SEVERITY_RANK[b.severity] ?? 4));
  console.log(
    `triage: ${untriaged.length} catalogue bug(s) have no ledger row — invisible to ` +
      `\`next\`/\`status\`/\`deps\`/campaign-check:`,
  );
  for (const b of untriaged)
    console.log(`  ${b.id.padEnd(5)} ${String(b.severity).padEnd(8)} ${b.title.slice(0, 70)}`);
  console.log(
    `\n  give one a ledger row: node scripts/campaign/bugs.mjs file "<title>" --location "..." ` +
      `--severity <s> --batch F## (creates a NEW id)`,
  );
  console.log(
    `  or, once it has a row in some shard, re-home it: node scripts/campaign/bugs.mjs move <B###> --to F##`,
  );
};

// ── self-test ─────────────────────────────────────────────────────────────
// Three defects shipped from this file in one session — trailing-space churn,
// silent no-op edits, and $-expansion in note() — all the same family: a write
// path that reports success without checking what it wrote. These assert the
// round-trips rather than trusting them.
// Runs the REAL CLI in a child process. The only way to exercise a REFUSAL:
// `fail` exits the process, so an in-process call would take the self-test with
// it — and "it refused" is exactly the assertion a guard needs.
const runCli = (argv, root) => {
  const cmd = [process.argv[1], ...argv].map((a) => JSON.stringify(a)).join(" ");
  try {
    return {
      code: 0,
      out: execSync(`node ${cmd}`, {
        encoding: "utf8",
        env: { ...process.env, BUGS_ROOT: root },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};

// `brief` writes to stdout rather than returning a string (it is a report, not
// a value), so asserting what it SAYS means capturing what it wrote.
const capture = (fn) => {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = "";
  process.stdout.write = (chunk) => ((buf += chunk), true);
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return buf;
};

cmds["self-test"] = () => {
  let failures = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failures++;
    console.log(
      `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
    );
  };

  // front matter must round-trip, and an empty field must NOT gain a trailing
  // space — prettier strips it, so a space makes every refresh dirty the tree.
  const front = { id: "B1", title: "x", batch: null, closed: null };
  const rendered = renderFront(front);
  check("renderFront: no trailing space on empty field", /: $/m.test(rendered), false);
  check("renderFront/parseRecord round-trip", parseRecord(rendered + "body").front, {
    id: "B1",
    title: "x",
    batch: null,
    closed: null,
  });

  // A CRLF-terminated record must parse the same as an LF one, not get its
  // whole front-matter block silently swallowed into the body.
  const crlf = "---\r\nid: B9\r\ntitle: x\r\n---\r\n\r\n# B9\r\n\r\n## History\r\n";
  check(
    "parseRecord: CRLF front matter parses (not swallowed into body)",
    parseRecord(crlf).front,
    {
      id: "B9",
      title: "x",
    },
  );

  // note() and enrich() text must survive $-patterns verbatim, verified by
  // reading the file back after calling the REAL commands (against a
  // throwaway BUGS_ROOT/BUGS_REGISTER) — never a hand copy of their regex.
  // A copy is exactly what let a regression in the shipped writer go uncaught.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    const prevRegister = process.env.BUGS_REGISTER;
    process.env.BUGS_ROOT = tmp;
    const registerPath = join(tmp, "register.html");
    process.env.BUGS_REGISTER = registerPath;
    try {
      // -- cmds.note --
      const noteBody = "## Summary\n\nOLD\n\n## Root cause\n\nx\n";
      writeRecord("B900", { id: "B900", title: "note fixture" }, noteBody);
      const dollarText = "Driver loses $100; also $& and $` and $'.";
      cmds.note(["B900", dollarText, "--section", "Summary"]);
      const afterNote = readRecord("B900").body;
      check(
        "note: $-patterns survive verbatim (real cmds.note)",
        afterNote.includes(dollarText),
        true,
      );
      check(
        "note: an unrelated section is left alone",
        afterNote.includes("## Root cause\n\nx"),
        true,
      );

      // -- cmds.enrich --
      writeCatalogue([
        {
          id: "B901",
          title: "enrich fixture",
          location: "apps/api/src/self-test.ts",
          severity: "low",
          register: "open",
          batch: null,
          source: "filed",
          filedAt: null,
          sensitive: false,
          sensitiveFor: [],
        },
      ]);
      writeRecord(
        "B901",
        { id: "B901", title: "enrich fixture" },
        "\n# B901 · enrich fixture\n\n## History\n",
      );
      // B902 has NO "## History" heading at all — both the "already has the
      // section" and "insert before History" branches used to fall through as
      // a silent no-op here.
      writeCatalogue([
        ...readCatalogue(),
        {
          id: "B902",
          title: "enrich fixture no history",
          location: "apps/api/src/self-test.ts",
          severity: "low",
          register: "open",
          batch: null,
          source: "filed",
          filedAt: null,
          sensitive: false,
          sensitiveFor: [],
        },
      ]);
      writeRecord(
        "B902",
        { id: "B902", title: "enrich fixture no history" },
        "\n# B902 · no history\n",
      );
      const html =
        '<span class="bug-id">B901</span>' +
        "<dt>Meant to do</dt><dd>Ship correct totals</dd>" +
        "<dt>Actually does</dt><dd>Off by $100 due to a $&amp; glitch</dd>" +
        '<div class="evidence">apps/api/src/self-test.ts:1 — $1 broke it</div>' +
        '<span class="bug-id">B902</span>' +
        "<dt>Meant to do</dt><dd>Ship correct totals</dd>" +
        "<dt>Actually does</dt><dd>Also broken, no History heading</dd>" +
        '<span class="bug-id">ZZZ</span>';
      writeFileSync(registerPath, html);
      cmds.enrich();
      const afterEnrich = readRecord("B901").body;
      const afterEnrichNoHistory = readRecord("B902").body;
      check(
        "enrich: a record with no '## History' heading gets the section appended, not skipped",
        afterEnrichNoHistory.includes("## Reported evidence") &&
          afterEnrichNoHistory.includes("Also broken, no History heading"),
        true,
      );
      check(
        "enrich: register HTML with $-patterns survives verbatim (real cmds.enrich)",
        afterEnrich.includes("Off by $100 due to a $& glitch"),
        true,
      );
      check(
        "enrich: writes a '## Reported evidence' section",
        afterEnrich.includes("## Reported evidence"),
        true,
      );
    } finally {
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      if (prevRegister === undefined) delete process.env.BUGS_REGISTER;
      else process.env.BUGS_REGISTER = prevRegister;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // cmds.render must escape severity/id into HTML, and inline() must not
  // mangle a snake_case identifier inside a code span. Exercise the REAL
  // command against a throwaway BUGS_ROOT/BUGS_RENDER_OUT, never the real
  // 211-bug dashboard.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const renderOut = join(tmp, "render.html");
    const prevRoot = process.env.BUGS_ROOT;
    const prevRenderOut = process.env.BUGS_RENDER_OUT;
    process.env.BUGS_ROOT = tmp;
    process.env.BUGS_RENDER_OUT = renderOut;
    try {
      cmds.file([
        "Render fixture",
        "--location",
        "apps/api/src/self-test.ts",
        "--severity",
        "low",
        "--batch",
        "F01",
        "--tier",
        "T1",
      ]);
      cmds.note([
        "B1",
        "see `order_items_tenant_id` and **bold text** here",
        "--section",
        "Summary",
      ]);
      cmds.render([]);
      const html = readFileSync(renderOut, "utf8");
      check(
        "render: inline() does not mangle snake_case inside a code span",
        html.includes("<code>order_items_tenant_id</code>"),
        true,
      );
      check("render: ** emphasis still renders", html.includes("<strong>bold text</strong>"), true);
    } finally {
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      if (prevRenderOut === undefined) delete process.env.BUGS_RENDER_OUT;
      else process.env.BUGS_RENDER_OUT = prevRenderOut;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // history must dedupe on its marker, or Gate 4 grows the file every turn.
  const once = appendHistory("## History\n", "k1", "e", "d");
  check("appendHistory: idempotent on the same key", appendHistory(once, "k1", "e", "d"), once);
  check(
    "uniqueHistoryKey: discriminates a repeat of the same base",
    uniqueHistoryKey(once, "k1"),
    "k1#2",
  );

  // Wave colouring: pure, so it is asserted directly rather than through a
  // network-bound `next`. Two batches sharing a non-hub file must NEVER be
  // scheduled together, and no wave may exceed the standing agent cap.
  {
    const mk = (batch, sev) => ({
      batch,
      bugs: [{ id: "B1", severity: sev, title: "x" }],
      sensitive: [],
      inFlight: [],
      issue: null,
    });
    const ranked = rankBatches([mk("F02", "low"), mk("F01", "critical"), mk("F03", "high")]);
    check(
      "waves: ranked worst-severity-first, deterministic",
      ranked.map((b) => b.batch),
      ["F01", "F03", "F02"],
    );
    const conflicts = new Map([
      ["F01", new Map([["F03", new Set(["apps/api/src/a.ts"])]])],
      ["F03", new Map([["F01", new Set(["apps/api/src/a.ts"])]])],
    ]);
    const waves = computeWaves(ranked, conflicts, 4);
    check(
      "waves: a hard conflict is pushed out of the wave, not into it",
      waves.map((w) => w.map((b) => b.batch)),
      [["F01", "F02"], ["F03"]],
    );
    const five = ["F01", "F02", "F03", "F04", "F05"].map((b) => mk(b, "high"));
    check(
      "waves: never schedules more than the agent cap at once",
      computeWaves(rankBatches(five), new Map(), 4).map((w) => w.length),
      [4, 1],
    );
  }

  // in-flight is the local, offline-safe half of the claim exclusion: a row
  // someone is on must not be offered to a second agent.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    try {
      cmds.file([
        "in-flight fixture",
        "--location",
        "apps/api/src/self-test.ts",
        "--severity",
        "low",
        "--batch",
        "F01",
        "--tier",
        "T1",
      ]);
      const before = batchIndex().batches.get("F01");
      check("selection: a queued row is workable", before.bugs.length, 1);
      upsertLedgerRow("F01", { ...readShard("F01").rows[0], state: "in-flight" });
      const after = batchIndex().batches.get("F01");
      check("selection: an in-flight row is not workable", after.bugs.length, 0);
      check(
        "selection: in-flight ids are named, so `next` can say WHY it skipped",
        after.inFlight,
        ["B1"],
      );
    } finally {
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // The commit scanner: a `(F##)` subject must fan out to every id in that
  // shard (the house convention names the batch, not the bug), and a bare
  // B-token must still match a zero-padded id.
  {
    const fixtureState = new Map([
      ["B04", { id: "B04", batch: "F20" }],
      ["B41", { id: "B41", batch: "F10" }],
      ["B42", { id: "B42", batch: "F10" }],
    ]);
    const log =
      "aaaaaaaaaaaa\tfix(routes): guard reopenStop and the stop/run transitions (F10) (#591)\n" +
      "bbbbbbbbbbbb\tfix(api): unrelated work, names nothing\n" +
      "cccccccccccc\tfix: deep-dive backlog B4 only\n";
    const { mentions: m, commits } = parseMentions(log, fixtureState);
    check("commit scan: counts every commit in the range", commits, 3);
    check(
      "commit scan: a (F##) subject fans out to every id in that shard",
      [...(m.get("B41") ?? []), ...(m.get("B42") ?? [])].map((h) => h.sha),
      ["aaaaaaaa", "aaaaaaaa"],
    );
    check(
      "commit scan: the fan-out detail says it matched via the batch, not the id",
      (m.get("B41") ?? [])[0]?.detail.includes("matched via batch F10"),
      true,
    );
    check(
      "commit scan: a bare B4 token still matches the zero-padded B04",
      (m.get("B4") ?? []).map((h) => h.sha),
      ["cccccccc"],
    );
    check("commit scan: a commit naming nothing produces no event", m.has("B99"), false);
  }

  // The anchor: a first run must anchor without re-deriving history, and the
  // run after it must scan only what landed since — never a rolling window an
  // event can scroll out of.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevAnchor = process.env.BUGS_SYNC_STATE;
    process.env.BUGS_SYNC_STATE = join(tmp, "sync-state.json");
    try {
      const first = commitMentions(new Map(), []);
      check(
        "commit scan: the first run anchors and does not re-derive history",
        first.mentions.size === 0 && /first run — anchored at [0-9a-f]{8}/.test(first.note ?? ""),
        true,
      );
      const head = git("git rev-parse HEAD").trim();
      check("commit scan: the anchor is persisted at HEAD", readSyncState().lastSha, head);
      const second = commitMentions(new Map(), []);
      check(
        "commit scan: the next run scans only since the anchor (nothing new here)",
        second.mentions.size === 0 && second.note === null,
        true,
      );
    } finally {
      if (prevAnchor === undefined) delete process.env.BUGS_SYNC_STATE;
      else process.env.BUGS_SYNC_STATE = prevAnchor;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // A bug that revisits a state (regressed then refixed) must log EVERY visit.
  // Exercised through the REAL cmds.sync against a throwaway BUGS_ROOT — the
  // defect was that sync PRINTED the second transition while the marker dedupe
  // silently dropped it, so only a read-back of the record can catch it.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    try {
      writeCatalogue([
        {
          id: "B950",
          title: "sync revisit fixture",
          location: "apps/api/src/self-test.ts",
          severity: "low",
          register: "open",
          batch: "F01",
          source: "filed",
          filedAt: null,
          sensitive: false,
          sensitiveFor: [],
        },
      ]);
      cmds.expand();
      const setState = (state) =>
        upsertLedgerRow("F01", {
          id: "B950",
          batch: "F01",
          tier: "T1",
          state,
          pr: null,
          proof: null,
          evidence: null,
        });
      for (const s of ["done", "queued", "done"]) {
        setState(s);
        cmds.sync(["--quiet"]);
      }
      const body = readRecord("B950").body;
      check(
        "sync: done -> queued -> done logs TWO done lines (revisited state is not swallowed)",
        (body.match(/\*\*done\*\*/g) || []).length,
        2,
      );
      check(
        "sync: the intervening queued transition is logged too",
        (body.match(/\*\*queued\*\*/g) || []).length,
        1,
      );
      const settled = readRecord("B950").body;
      cmds.sync(["--quiet"]);
      check("sync: a no-change re-run appends nothing", readRecord("B950").body, settled);
    } finally {
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // replaceSection must be bounded by the NEXT heading of any kind, not one
  // fixed heading name — an anchor bound to "## History" specifically deleted
  // every section in between when a different heading came first.
  {
    const withGap = "\n## Reported evidence\n\nOLD\n\n## Summary\n\nKEEP ME\n\n## History\n\n- e\n";
    const replaced = replaceSection(withGap, "Reported evidence", "NEW");
    check(
      "replaceSection: bounded by the next heading, not a fixed one",
      replaced?.includes("KEEP ME") && replaced?.includes("NEW") && !replaced?.includes("OLD"),
      true,
    );
  }

  // "B04" and "B4" must compare equal — the nine zero-padded ids predate this
  // convention and are never migrated on disk, only normalised at comparison.
  check("normId: B04 and B4 are the same bug", normId("B04") === normId("B4"), true);
  check("normId: case-insensitive", normId("b4") === normId("B4"), true);

  // the ledger must hold exactly one row per id, repo-wide.
  const seen = new Map();
  let dupes = 0;
  for (const f of readdirSync(STATUS_DIR()).filter((n) => n.endsWith(".jsonl")))
    for (const r of readShard(f.replace(/\.jsonl$/, "")).rows) {
      if (seen.has(r.id)) dupes++;
      seen.set(r.id, true);
    }
  check("ledger: one row per bug id across all shards", dupes, 0);

  // every catalogue row should have a record, or `brief` renders holes.
  const missing = readCatalogue()
    .filter((b) => !existsSync(recordPath(b.id)))
    .map((b) => b.id);
  check("every catalogue row has a record", missing, []);

  // The body's baked-in header line must match its own front matter — it used
  // to be written once at creation and never refreshed, so a re-batch or a
  // state change never touched it (B32 still said "Batch F11", B211 still
  // said "State uncampaigned" long after the ledger moved on).
  const headerDrift = [];
  for (const f of readdirSync(RECORD_DIR()).filter((n) => n.endsWith(".md"))) {
    const { front, body: b } = parseRecord(readFileSync(join(RECORD_DIR(), f), "utf8"));
    const m = /^\*\*Location\*\*.*$/m.exec(b);
    if (!m) continue; // no header line yet (shouldn't happen for an expanded record)
    if (m[0] !== renderHeaderLine(front)) headerDrift.push(f);
  }
  check("record header line matches its own front matter", headerDrift, []);

  // Every history entry must be exactly ONE line. A detail containing a newline
  // used to split the entry and leave loose prose floating in the section
  // (B32/B34/B129/B146 all carried one), which reads as a corrupted record.
  const strays = [];
  for (const f of readdirSync(RECORD_DIR()).filter((n) => n.endsWith(".md"))) {
    const t = readFileSync(join(RECORD_DIR(), f), "utf8");
    const i = t.indexOf("## History");
    if (i < 0) continue;
    for (const l of t.slice(i).split("\n"))
      if (l.trim() && !l.startsWith("- ") && !l.startsWith("#"))
        strays.push(`${f}: ${l.slice(0, 40)}`);
  }
  check("history: every entry is a single line", strays, []);

  // Exactly one History heading per record. A second one means a $-pattern in
  // caller text was expanded into the body by a string replacement — enrich hit
  // this on B109, whose evidence says "$235.00 vs PERCENT's $181.05", so `$1`
  // became the captured heading. Cheaper to diagnose than the stray-line check.
  const multiHistory = readdirSync(RECORD_DIR())
    .filter((n) => n.endsWith(".md"))
    .filter(
      (n) =>
        (readFileSync(join(RECORD_DIR(), n), "utf8").match(/^## History$/gm) || []).length !== 1,
    );
  check("exactly one '## History' heading per record", multiHistory, []);

  // The T2 evidence rule. A refusal path cannot be exercised in-process
  // (`fail` exits), so the refusal runs the REAL CLI in a child process and
  // asserts BOTH the non-zero exit and that nothing was written.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    const BATCH_EV = "Railway deploy 1234abcd SUCCESS; Actions run 999 E2E green against it";
    const ROW_EV = "Actions run 999 job 42: spec 28 REG-B1 passed against deploy 1234abcd";
    try {
      cmds.file([
        "T2 discharge fixture",
        "--location",
        "apps/web/e2e/self-test.spec.ts",
        "--severity",
        "low",
        "--batch",
        "F01",
        "--tier",
        "T2",
      ]);
      cmds.file([
        "T1 discharge fixture",
        "--location",
        "apps/api/src/self-test.ts",
        "--severity",
        "low",
        "--batch",
        "F01",
        "--tier",
        "T1",
      ]);
      cmds.prove(["B1", "--pr", "601", "--proof", "REG-B1 e2e: the deployed build shows the fix"]);
      cmds.prove(["B2", "--pr", "601", "--proof", "REG-B2 jest: the total rounds to cents"]);

      const refused = runCli(["discharge", "F01", "--evidence", BATCH_EV], tmp);
      check("discharge: refuses a T2 row given only batch-wide evidence", refused.code !== 0, true);
      check(
        "discharge: refuses BEFORE writing anything (no partial discharge)",
        readShard("F01").rows.map((r) => r.state),
        ["proven", "proven"],
      );

      cmds.discharge(["F01", "--evidence", BATCH_EV, "--evidence-B1", ROW_EV]);
      const byId = new Map(readShard("F01").rows.map((r) => [r.id, r]));
      check(
        "discharge: the T2 row carries its OWN dischargeEvidence",
        byId.get("B1")?.dischargeEvidence,
        ROW_EV,
      );
      check(
        "discharge: the T1 row carries the batch string as `evidence`, never as dischargeEvidence",
        [byId.get("B2")?.evidence, byId.get("B2")?.dischargeEvidence],
        [BATCH_EV, undefined],
      );
    } finally {
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // `brief` must lead with a contested/superseded record, not bury it: a
  // builder reading a confident, well-cited plan that another record refutes
  // ships the regression AND writes a green test for it.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    try {
      cmds.file([
        "contested fixture",
        "--location",
        "apps/api/src/self-test.ts",
        "--severity",
        "low",
        "--batch",
        "F01",
        "--tier",
        "T1",
      ]);
      const rec = readRecord("B1");
      writeRecord("B1", { ...rec.front, contestedBy: "B999" }, rec.body);
      const out = capture(() => cmds.brief(["F01"]));
      check("brief: names a contested record in the batch header", out.includes("CONTESTED"), true);
      check(
        "brief: flags it again inside that bug's own block, above the fix approach",
        out.indexOf("CONTESTED BY B999") > out.indexOf("### B1"),
        true,
      );
    } finally {
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // reopen / claim / release: the ledger transitions that did not exist. A
  // regressed bug used to require a fresh id, severing it from its own history.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    try {
      cmds.file([
        "reopen fixture",
        "--location",
        "apps/api/src/self-test.ts",
        "--severity",
        "low",
        "--batch",
        "F01",
        "--tier",
        "T1",
      ]);
      cmds.prove(["B1", "--pr", "700", "--proof", "REG-B1 jest: the guard holds"]);
      cmds.discharge([
        "F01",
        "--evidence",
        "Railway deploy 1234abcd SUCCESS; Actions run 999 green against it",
      ]);
      check("reopen fixture reaches done first", readShard("F01").rows[0].state, "done");

      const thin = runCli(["reopen", "B1", "--why", "it broke again"], tmp);
      check("reopen: refuses a regression claim that cites nothing", thin.code !== 0, true);
      check("reopen: the refusal wrote nothing", readShard("F01").rows[0].state, "done");

      cmds.reopen([
        "B1",
        "--why",
        "REG-B1 failed in Actions run 33557237968 against deploy 1234abcd",
      ]);
      const row = readShard("F01").rows[0];
      check(
        "reopen: state regressed, proof and PR cleared, evidence kept",
        [row.state, row.pr, row.proof, Boolean(row.evidence)],
        ["regressed", null, null, true],
      );
      check(
        "reopen: the record carries the regression event",
        readRecord("B1").body.includes("**regressed**"),
        true,
      );
      check(
        "reopen: a regressed row is workable again",
        batchIndex().batches.get("F01").bugs.length,
        1,
      );
      cmds.sync(["--quiet"]);
      check(
        "reopen: the next sync does NOT resurrect the proof reopen erased",
        readRecord("B1").front.proof,
        null,
      );

      cmds.tier(["B1", "T1", "--why", "the analysis ruled T1 over a defaulted T1"]);
      check(
        "tier: a ruling that CONFIRMS the standing tier is recorded, not refused",
        readRecord("B1").body.includes("**tier confirmed**"),
        true,
      );

      cmds.claim(["F01"]);
      check("claim: workable rows go in-flight", readShard("F01").rows[0].state, "in-flight");
      check(
        "claim: the record's front matter follows the ledger",
        readRecord("B1").front.state,
        "in-flight",
      );
      cmds.release(["F01"]);
      check(
        "release: restores the pre-claim state, never launders regressed into queued",
        readShard("F01").rows[0].state,
        "regressed",
      );
    } finally {
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // A filed bug's symptom must survive file → index round trip. Run this
  // against the REAL cmds.file/cmds.index against a throwaway BUGS_ROOT, never
  // a re-implementation — `index` used to rebuild the catalogue from a fixed
  // 9-key shape and silently destroy every filed symptom.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    try {
      cmds.file([
        "Self-test filed bug",
        "--location",
        "apps/api/src/self-test.ts",
        "--severity",
        "low",
        "--symptom",
        "SELF_TEST_SYMPTOM_MARKER survives the round trip",
      ]);
      cmds.index();
      const row = readCatalogue().find((r) => r.title === "Self-test filed bug");
      const rec = row ? readRecord(row.id) : null;
      check(
        "filed symptom survives file -> index round trip (catalogue row)",
        row?.symptom,
        "SELF_TEST_SYMPTOM_MARKER survives the round trip",
      );
      check(
        "filed symptom survives file -> index round trip (record body)",
        !!rec && rec.body.includes("SELF_TEST_SYMPTOM_MARKER survives the round trip"),
        true,
      );
    } finally {
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  console.log(failures ? `\nself-test: ${failures} FAILURE(S)` : "\nself-test: all checks passed");
  if (failures) process.exit(1);
};

// Re-batching is a first-class registry operation, not a hand edit. The analysis
// pass routinely concludes a bug is in the wrong batch (F11's synthesis said
// exactly that about B32), and doing it by hand means editing two shards, the
// record front matter and the catalogue — four places, each an opportunity to
// leave the ledger holding two rows for one id.
cmds.move = (args) => {
  const typed = (args[0] ?? "").toUpperCase();
  const why = flag(args, "why");
  if (!/^B\d+$/.test(typed)) fail('usage: move <B###> --to <F##> [--why "<reason>"]');
  const id = resolveId(typed);
  const to = normBatch(flag(args, "to"));

  const from = findShardOf(id);
  if (!from) fail(`${id} is in no ledger shard — nothing to move`);
  if (from === to) fail(`${id} is already in ${to}`);

  const row = readShard(from).rows.find((r) => r.id === id);
  if (row.state !== "queued")
    fail(
      `${id} is ${row.state}, not queued — moving a bug that already carries a proof would orphan it from its batch's evidence`,
    );

  // Drop from the old shard first: two rows for one id is the duplicate
  // campaign-check rejects, so never let both exist even momentarily.
  const old = readShard(from);
  const kept = old.rows.filter((r) => r.id !== id);
  writeFileSync(
    shardPath(from),
    kept.map((r) => JSON.stringify(r)).join(old.eol) + (kept.length ? old.eol : ""),
  );
  const { row: after } = upsertLedgerRow(to, { ...row, batch: to });
  if (after?.batch !== to)
    fail(
      `ledger write for ${id} did not land as intended — re-read row is ${JSON.stringify(after)}`,
    );

  const rows = readCatalogue();
  const cat = rows.find((r) => r.id === id);
  if (cat) {
    cat.batch = to;
    writeCatalogue(rows);
  }

  const rec = readRecord(id);
  if (rec) {
    const body = appendEvent(
      rec.body,
      `move-${from}-${to}`,
      "re-batched",
      `${from} → ${to}${why ? ` — ${why}` : ""}`,
    );
    writeRecord(id, { ...rec.front, batch: to }, body);
  }

  console.log(`${id}: ${from} → ${to}${why ? ` (${why})` : ""}`);
  console.log(
    `  ${from} now holds ${kept.length} row(s); verify with: node scripts/campaign-check.mjs`,
  );
};

// ── enrich: pull the register's DETAIL into every record ──────────────────
// `import` only ever read the register's summary TABLE — id, title, area,
// severity, status — so 207 of 211 records carried a one-line title and nothing
// else. The register's detail blocks hold what an agent actually needs (what the
// feature was meant to do, what it does instead, the gap, file:line evidence, a
// suggested fix and the verifier's note) AND, in 209 of 210 cases, the file
// paths that make a dependency graph computable at all. Leaving that in a
// gitignored HTML file was the same mistake the catalogue was built to fix.
//
// Writes ONLY the front-matter `files` list and a `## Reported evidence`
// section. The six analysis sections stay reserved for the analysis pass, so
// "analysed" keeps meaning "a model reasoned about this", not "we have prose".
const FILE_RX =
  /(?:apps|packages|scripts)\/[A-Za-z0-9_.\/()\[\]@-]*\.(?:tsx|jsx|mjs|cjs|prisma|ts|js)/g;

function registerDetail(html, id) {
  const i = html.indexOf(`<span class="bug-id">${id}</span>`);
  if (i < 0) return null;
  const j = html.indexOf('<span class="bug-id">', i + 10);
  const block = html.slice(i, j > 0 ? j : html.length);
  const pick = (rx) => {
    const m = rx.exec(block);
    return m ? stripTags(m[1]) : null;
  };
  return {
    meant: pick(/<dt>Meant to do<\/dt>\s*<dd>([\s\S]*?)<\/dd>/),
    actual: pick(/<dt>Actually does<\/dt>\s*<dd>([\s\S]*?)<\/dd>/),
    gap: pick(/<dt[^>]*>The gap<\/dt>\s*<dd>([\s\S]*?)<\/dd>/),
    evidence: pick(/<div class="evidence">([\s\S]*?)<\/div>/),
    suggested: pick(/<strong>Suggested fix:<\/strong>([\s\S]*?)<\/p>/),
    verifier: pick(/<strong>Verifier's note:<\/strong>([\s\S]*?)<\/p>/),
    provenance: pick(/<p class="verinote">([\s\S]*?)<\/p>/),
    files: [...new Set(block.match(FILE_RX) || [])].sort(),
  };
}

cmds.enrich = () => {
  if (!existsSync(REGISTER()))
    fail(
      `register not found at ${REGISTER()} (gitignored — this runs on the owner's machine only)`,
    );
  const html = readFileSync(REGISTER(), "utf8");
  let enriched = 0;
  let noDetail = 0;
  let files = 0;

  for (const bug of readCatalogue()) {
    const rec = readRecord(bug.id);
    if (!rec) continue;
    const d = registerDetail(html, bug.id);
    if (!d || (!d.actual && !d.evidence)) {
      noDetail++;
      continue;
    }

    const parts = [
      "_Imported verbatim from the bug register — this is the ORIGINAL report, not analysis._",
      "",
    ];
    if (d.meant) parts.push(`**Meant to do.** ${d.meant}`, "");
    if (d.actual) parts.push(`**Actually does.** ${d.actual}`, "");
    if (d.gap) parts.push(`**The gap.** ${d.gap}`, "");
    if (d.evidence) parts.push(`**Evidence.** ${d.evidence}`, "");
    if (d.suggested)
      parts.push(
        `**Suggested fix (register).** ${d.suggested}`,
        "",
        "> ⚠️ Treat this as a hypothesis, not a plan. On F11 the adversarial pass refuted the",
        "> suggested fix for every one of the four bugs while confirming every diagnosis.",
        "",
      );
    if (d.verifier) parts.push(`**Verifier's note.** ${d.verifier}`, "");
    if (d.provenance) parts.push(`_${d.provenance}_`, "");
    if (d.files.length)
      parts.push(
        `**Files implicated (${d.files.length}):**`,
        ...d.files.map((f) => `- \`${f}\``),
        "",
      );

    const contentCore = parts
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const before = rec.body;
    let body;
    if (before.includes("## Reported evidence")) {
      // Bounded by the next heading OF ANY KIND, not a specific one — an
      // anchor bound to "## History" specifically deleted every section in
      // between when a different heading came first (proved: it deleted the
      // analysed Summary out from under a record that had one).
      body = replaceSection(before, "Reported evidence", contentCore);
    } else if (before.includes("\n## History")) {
      body = before.replace(
        /(\n## History)/,
        (_m, h) => `\n## Reported evidence\n\n${contentCore}\n${h}`,
      );
    } else {
      // No History heading to anchor on at all — append rather than silently
      // no-op (both branches used to fall through unchanged here).
      body = `${before.replace(/\s*$/, "")}\n\n## Reported evidence\n\n${contentCore}\n`;
    }
    if (body === null || !body.includes(contentCore))
      fail(
        `enrich: "## Reported evidence" for ${bug.id} did not take effect — write path produced no change`,
      );

    writeRecord(bug.id, { ...rec.front, files: d.files.join(" ") || null }, body);
    enriched++;
    files += d.files.length;
  }
  console.log(
    `enriched ${enriched} record(s) with the register detail; ${files} file references captured.`,
  );
  if (noDetail) console.log(`  ${noDetail} record(s) had no detail block in the register.`);
};

// ── deps: the dependency graph, computed not maintained ───────────────────
// Two bugs conflict when they touch the same file: they must land in one batch
// or be serialised, never worked in parallel. That is set intersection over the
// `files` list enrich captured, so waves can be COMPUTED rather than argued
// about. Every hand-maintained index here has drifted (the board by three cards,
// the ledger by thirteen rows); a derived graph cannot.
//
// ⚠️ HUB FILES ARE THE WHOLE DIFFICULTY. A naive "shares a file ⇒ conflicts"
// rule reported that NO batch was ever parallel-safe, which is useless. The
// cause: six god-files dominate the repo — measured today, orders.service.ts is
// touched by 36 bugs, invoices.service.ts 30, routes.service.ts 29, schema.prisma 28.
// Two bugs in a 5,000-line service almost always touch different methods, so a
// hub overlap is a REVIEW signal, not a conflict. Only a shared NON-hub file is
// treated as hard. The threshold is data, not a constant, and `--hub-threshold`
// exposes it because the right cut-off is a judgement the repo may change.
const HUB_DEFAULT = 10;

const fileSet = (id) => {
  const raw = readRecord(id)?.front?.files;
  return new Set(raw ? raw.split(" ").filter(Boolean) : []);
};

function buildGraph(hubThreshold) {
  const state = readState();
  const bugs = [...state.keys()].filter((id) => existsSync(recordPath(id)));
  const files = new Map(bugs.map((id) => [id, fileSet(id)]));

  const freq = new Map();
  for (const set of files.values()) for (const f of set) freq.set(f, (freq.get(f) || 0) + 1);
  const hubs = new Set([...freq].filter(([, n]) => n >= hubThreshold).map(([f]) => f));

  const batchOf = new Map(bugs.map((id) => [id, state.get(id).batch]));
  const edges = new Map(bugs.map((id) => [id, new Map()]));
  for (let a = 0; a < bugs.length; a++)
    for (let b = a + 1; b < bugs.length; b++) {
      const shared = [...files.get(bugs[a])].filter((f) => files.get(bugs[b]).has(f));
      if (!shared.length) continue;
      const hard = shared.filter((f) => !hubs.has(f));
      const edge = { shared, hard };
      edges.get(bugs[a]).set(bugs[b], edge);
      edges.get(bugs[b]).set(bugs[a], edge);
    }
  return { bugs, files, batchOf, edges, state, hubs, freq };
}

cmds.deps = (args) => {
  const hubThresholdRaw = flag(args, "hub-threshold", HUB_DEFAULT);
  const hubThreshold = Number(hubThresholdRaw);
  // A bad or missing value used to become NaN, silently inverting the answer:
  // `n >= NaN` is always false, so the hub set went empty and every shared
  // file became a hard conflict instead.
  if (!Number.isFinite(hubThreshold) || hubThreshold < 1)
    fail(`--hub-threshold must be a positive integer (got "${hubThresholdRaw}")`);
  const g = buildGraph(hubThreshold);
  const bugFlag = flag(args, "bug");
  const one = bugFlag ? resolveId(bugFlag.toUpperCase()) : "";
  const openOnly = !args.includes("--all");
  const isOpen = (id) => g.state.get(id)?.state === "queued";

  if (one) {
    if (!g.edges.has(one)) fail(`${one} has no record or no ledger row`);
    console.log(`${one} — ${g.files.get(one).size} file(s), batch ${g.batchOf.get(one)}`);
    const conflicts = [...g.edges.get(one)].sort((x, y) => y[1].hard.length - x[1].hard.length);
    const hard = conflicts.filter(([, e]) => e.hard.length);
    if (!hard.length)
      console.log(
        "  no HARD conflict with any other bug — only god-file overlap, safe to fix alone.",
      );
    for (const [other, e] of hard)
      console.log(
        `    ${other.padEnd(5)} ${g.batchOf.get(other) === g.batchOf.get(one) ? "same batch" : "BATCH " + String(g.batchOf.get(other)).padEnd(4)} ` +
          `${e.hard.length} shared: ${e.hard.slice(0, 2).join(", ")}${e.hard.length > 2 ? " …" : ""}`,
      );
    const soft = conflicts.filter(([, e]) => !e.hard.length).length;
    if (soft) console.log(`  (+ ${soft} bug(s) sharing only god-files — review, not conflict)`);
    return;
  }

  console.log(
    `Hub files (touched by >= ${hubThreshold} bugs, treated as shared surface not conflict):`,
  );
  for (const f of [...g.hubs].sort((a, b) => g.freq.get(b) - g.freq.get(a)))
    console.log(`  ${String(g.freq.get(f)).padStart(3)}  ${f}`);

  const batches = new Map();
  for (const id of g.bugs) {
    if (openOnly && !isOpen(id)) continue;
    const b = g.batchOf.get(id);
    if (!batches.has(b)) batches.set(b, []);
    batches.get(b).push(id);
  }

  console.log(
    "\nBATCH COHESION — a bug sharing no NON-hub file with its batch-mates is an outlier\n",
  );
  const outliers = [];
  for (const b of [...batches.keys()].sort()) {
    const ids = batches.get(b);
    const inner = ids.filter((id) =>
      ids.some((o) => o !== id && (g.edges.get(id).get(o)?.hard.length ?? 0) > 0),
    );
    const out = ids.filter((id) => !inner.includes(id));
    outliers.push(...out.map((id) => ({ id, batch: b })));
    console.log(
      `${b.padEnd(4)} ${String(inner.length + "/" + ids.length).padStart(6)} cohesive` +
        (out.length ? `   outliers: ${out.join(", ")}` : ""),
    );
  }

  console.log(
    "\nCROSS-BATCH HARD CONFLICTS — these share a non-hub file and MUST NOT run in parallel\n",
  );
  const pairs = new Map();
  for (const id of g.bugs) {
    if (openOnly && !isOpen(id)) continue;
    for (const [other, e] of g.edges.get(id)) {
      if (openOnly && !isOpen(other)) continue;
      if (!e.hard.length) continue;
      const a = g.batchOf.get(id);
      const b = g.batchOf.get(other);
      if (a === b || !a || !b) continue;
      const key = [a, b].sort().join(" <-> ");
      if (!pairs.has(key)) pairs.set(key, new Set());
      e.hard.forEach((f) => pairs.get(key).add(f));
    }
  }
  const ranked = [...pairs].sort((x, y) => y[1].size - x[1].size);
  for (const [key, fs2] of ranked)
    console.log(
      `  ${key.padEnd(15)} ${String(fs2.size).padStart(2)}: ${[...fs2].slice(0, 2).join(", ")}${fs2.size > 2 ? " …" : ""}`,
    );
  if (!ranked.length) console.log("  none.");

  const conflicted = new Set(ranked.flatMap(([k]) => k.split(" <-> ")));
  const free = [...batches.keys()].filter((b) => !conflicted.has(b)).sort();
  console.log(
    `\nPARALLEL-SAFE BATCHES (no hard conflict with any other open batch):\n  ${free.length ? free.join(" ") : "none"}`,
  );
  if (outliers.length)
    console.log(
      `\nOUTLIERS worth re-batching:\n  ${outliers.map((o) => `${o.id}(${o.batch})`).join(" ")}`,
    );
};

// ── render: the one-page view, DERIVED ────────────────────────────────────
// The register HTML used to be the source of truth, which is why it could only
// be republished by the owner and why no agent could write a bug. Now it is a
// projection of the records, regenerated on demand — so it can never drift, and
// losing it costs one command.
//
// ⚠️ Writes to routeflow-bug-registry.html, NOT the original
// routeflow-bug-register.html. `enrich` still parses the original's markup as
// the historical import source; overwriting it would destroy that and break
// re-import. Both live in gitignored local-assets/.
// Overridable via BUGS_RENDER_OUT so the self-test can exercise the real
// cmds.render without clobbering the real 211-bug dashboard with a 1-bug
// fixture render.
const RENDER_OUT = () =>
  process.env.BUGS_RENDER_OUT || "local-assets/docs/routeflow-bug-registry.html";

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Minimal markdown → HTML for the record bodies. Deliberately small: the records
// only ever use headings, bold, code, list items and blockquotes.
function mdToHtml(md) {
  const out = [];
  let inList = false;
  for (const raw of md.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (/^## /.test(line)) {
      if (inList) (out.push("</ul>"), (inList = false));
      out.push(`<h4>${esc(line.slice(3))}</h4>`);
      continue;
    }
    if (/^# /.test(line)) continue; // the record's own title; the card already shows it
    if (/^- /.test(line)) {
      if (!inList) (out.push("<ul>"), (inList = true));
      out.push(`<li>${inline(line.slice(2))}</li>`);
      continue;
    }
    if (inList) (out.push("</ul>"), (inList = false));
    if (/^> /.test(line)) out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

// Code spans are pulled out to placeholders BEFORE the emphasis rule runs, and
// restored last -- the emphasis regex used to run over the whole string AFTER
// code-span replacement, so it fired INSIDE <code> too: records are full of
// snake_case DB columns/paths, and a code span like order_items_tenant_id
// rendered with the middle word wrapped in <em> inside the code tag. The
// marker below is plain ASCII on purpose -- an escape-sequence-based marker
// silently became a real non-printable byte the last time this was written,
// which is exactly the failure this comment now warns against.
const CODE_MARK = "ZZZBUGSCODESPANZZZ";
const inline = (s) => {
  const codeSpans = [];
  const withPlaceholders = esc(s).replace(/`([^`]+)`/g, (_m, code) => {
    codeSpans.push(code);
    return CODE_MARK + (codeSpans.length - 1) + CODE_MARK;
  });
  const codeMarkRx = new RegExp(CODE_MARK + "(\\d+)" + CODE_MARK, "g");
  return withPlaceholders
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/&lt;!--.*?--&gt;/g, "")
    .replace(/_([^_]{2,}?)_/g, "<em>$1</em>")
    .replace(codeMarkRx, (_m, i) => `<code>${codeSpans[Number(i)]}</code>`);
};

cmds.render = (args) => {
  const state = readState();
  const rows = readCatalogue()
    .map((b) => ({ b, rec: readRecord(b.id), st: state.get(b.id) }))
    .filter((r) => r.rec);
  if (!rows.length) fail("no records to render — run `expand` first");

  const sev = (r) => r.rec.front.severity ?? "none";
  rows.sort(
    (x, y) =>
      (SEVERITY_RANK[sev(x)] ?? 4) - (SEVERITY_RANK[sev(y)] ?? 4) ||
      Number(x.b.id.slice(1)) - Number(y.b.id.slice(1)),
  );

  const stateOf = (r) => r.st?.state ?? "unbatched";
  const isDone = (r) => ["done", "already-fixed"].includes(stateOf(r));
  const counts = rows.reduce((a, r) => ((a[sev(r)] = (a[sev(r)] || 0) + 1), a), {});
  const open = rows.filter((r) => !isDone(r)).length;
  const analysed = rows.filter((r) => !r.rec.body.includes(UNANALYSED)).length;

  const summary = rows
    .map(
      (
        r,
      ) => `<tr class="r" data-s="${esc(sev(r))}" data-state="${isDone(r) ? "done" : "open"}" data-b="${esc(r.st?.batch ?? "")}">
<td><a href="#${esc(r.b.id.toLowerCase())}">${esc(r.b.id)}</a></td>
<td>${esc(r.rec.front.title)}</td>
<td class="dim">${esc(r.rec.front.location ?? "")}</td>
<td>${esc(r.st?.batch ?? "—")}</td>
<td><span class="chip ${esc(sev(r))}">${esc(sev(r))}</span></td>
<td><span class="chip ${isDone(r) ? "done" : "open"}">${esc(stateOf(r))}</span></td></tr>`,
    )
    .join("\n");

  const details = rows
    .map(
      (
        r,
      ) => `<article class="bug" id="${esc(r.b.id.toLowerCase())}" data-s="${esc(sev(r))}" data-state="${isDone(r) ? "done" : "open"}">
<h3><span class="bid">${esc(r.b.id)}</span> ${esc(r.rec.front.title)}
<span class="chips"><span class="chip ${esc(sev(r))}">${esc(sev(r))}</span><span class="chip ${isDone(r) ? "done" : "open"}">${esc(stateOf(r))}</span>${r.rec.front.sensitive === "true" ? '<span class="chip carve">carve-out</span>' : ""}</span></h3>
<p class="area">${esc(r.rec.front.location ?? "")} · batch ${esc(r.st?.batch ?? "—")} · tier ${esc(r.st?.tier ?? "—")}${r.st?.pr ? ` · PR #${r.st.pr}` : ""}</p>
${mdToHtml(r.rec.body)}
</article>`,
    )
    .join("\n");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RouteFlow bug registry</title>
<style>
:root{color-scheme:light dark;--bg:#fbfbfd;--fg:#14161a;--dim:#5d6470;--line:#e3e6ec;--card:#fff;--accent:#2b5cd9}
@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e6e8ec;--dim:#98a0ae;--line:#242832;--card:#161922;--accent:#7aa2f7}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:22px;margin:0 0 4px}.sub{color:var(--dim);margin:0 0 20px}
.stats{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 12px}
.stat b{font-size:17px}.stat span{color:var(--dim);font-size:12px;display:block}
.controls{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;position:sticky;top:0;background:var(--bg);padding:10px 0;z-index:5;border-bottom:1px solid var(--line)}
input,select{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:7px 10px;font:inherit}
input{flex:1;min-width:220px}
table{width:100%;border-collapse:collapse;margin-bottom:36px}
th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
td a{color:var(--accent);text-decoration:none;font-weight:600}
.dim{color:var(--dim)}
.chip{display:inline-block;padding:1px 8px;border-radius:99px;font-size:11px;font-weight:600;border:1px solid var(--line)}
.chip.critical{background:#f8d7da;color:#842029}.chip.high{background:#ffe0c2;color:#8a4b08}
.chip.medium{background:#fff3cd;color:#7a5d00}.chip.low{background:#e2e3e5;color:#41464b}
.chip.done{background:#d1e7dd;color:#0f5132}.chip.open{background:#e7eaf0;color:#3b4252}
.chip.carve{background:#e0d4f7;color:#4b2d80}
@media(prefers-color-scheme:dark){.chip{border-color:transparent;filter:saturate(.8) brightness(.92)}}
.bug{background:var(--card);border:1px solid var(--line);border-radius:11px;padding:16px 20px;margin-bottom:14px}
.bug h3{margin:0 0 3px;font-size:15px;display:flex;gap:9px;align-items:baseline;flex-wrap:wrap}
.bid{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--accent)}
.chips{display:inline-flex;gap:5px}.area{color:var(--dim);margin:0 0 12px;font-size:12.5px}
.bug h4{margin:16px 0 5px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--dim)}
.bug p{margin:0 0 8px}.bug ul{margin:0 0 10px;padding-left:20px}
blockquote{margin:8px 0;padding:7px 12px;border-left:3px solid var(--accent);background:color-mix(in srgb,var(--accent) 7%,transparent);border-radius:0 6px 6px 0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;background:color-mix(in srgb,var(--fg) 8%,transparent);padding:1px 5px;border-radius:4px;word-break:break-word}
.hide{display:none!important}
</style></head><body><div class="wrap">
<h1>RouteFlow bug registry</h1>
<p class="sub">Generated from <code>.claude/campaign/bugs/</code> — a derived view. Edit the records, not this file.</p>
<div class="stats">
<div class="stat"><b>${rows.length}</b><span>bugs</span></div>
<div class="stat"><b>${open}</b><span>open</span></div>
<div class="stat"><b>${rows.length - open}</b><span>closed</span></div>
<div class="stat"><b>${analysed}</b><span>analysed</span></div>
${["critical", "high", "medium", "low"].map((s) => `<div class="stat"><b>${counts[s] ?? 0}</b><span>${s}</span></div>`).join("")}
</div>
<div class="controls">
<input id="q" placeholder="Search id, title, location, evidence…" autocomplete="off">
<select id="sev"><option value="">all severities</option>${["critical", "high", "medium", "low"].map((s) => `<option>${s}</option>`).join("")}</select>
<select id="st"><option value="">all states</option><option value="open">open</option><option value="done">closed</option></select>
</div>
<table><thead><tr><th>ID</th><th>Title</th><th>Location</th><th>Batch</th><th>Severity</th><th>State</th></tr></thead>
<tbody id="tb">${summary}</tbody></table>
<h2 style="font-size:17px;margin:0 0 12px">Details</h2>
${details}
</div>
<script>
const q=document.getElementById('q'),sv=document.getElementById('sev'),st=document.getElementById('st');
const rows=[...document.querySelectorAll('tr.r')],bugs=[...document.querySelectorAll('article.bug')];
function apply(){
  const t=q.value.toLowerCase(),s=sv.value,x=st.value;
  for(const r of rows){
    const ok=(!s||r.dataset.s===s)&&(!x||r.dataset.state===x)&&(!t||r.textContent.toLowerCase().includes(t));
    r.classList.toggle('hide',!ok);
  }
  for(const b of bugs){
    const ok=(!s||b.dataset.s===s)&&(!x||b.dataset.state===x)&&(!t||b.textContent.toLowerCase().includes(t));
    b.classList.toggle('hide',!ok);
  }
}
[q,sv,st].forEach(e=>e.addEventListener('input',apply));
</script></body></html>`;

  mkdirSync("local-assets/docs", { recursive: true });
  writeFileSync(RENDER_OUT(), html);
  console.log(
    `rendered ${rows.length} bug(s) -> ${RENDER_OUT()} (${(html.length / 1024).toFixed(0)} KB)`,
  );
  console.log(`  ${open} open · ${rows.length - open} closed · ${analysed} analysed`);
  if (args.includes("--open")) console.log(`  open it: start ${RENDER_OUT()}`);
};

const [, , cmd, ...rest] = process.argv;
if (!cmd || !cmds[cmd])
  fail(`unknown command '${cmd ?? ""}' — try: ${Object.keys(cmds).join(", ")}`);
cmds[cmd](rest);
