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
// CONCURRENCY — THE SHARD LOCK
// The campaign runs several sub-agents at once, routinely on ONE batch, so two
// processes read-modify-write the same `status/F##.jsonl` within milliseconds of
// each other. Every write path here asserts its OWN row landed and nothing looks
// at the rest of the file, so the second writer's copy silently erased the
// first's — a proven, evidence-backed row reverted to `queued` with both gates
// green. Every shard read-modify-write therefore runs inside a `<shard>.lock`
// directory (see `withShardLock` below): the READ is inside the lock too, or the
// patch a caller computed is already stale by the time it writes.
//
// LOCK ORDER — CATALOGUE, THEN SHARD. ONE WAY, NEVER THE REVERSE.
// bugs.jsonl (the catalogue) gets the exact same protection, for the exact
// same reason: `file`, `move`, `import`, `index` and `discharge` all
// read-modify-write it, and every one of them ALSO touches a shard (a ledger
// row, or — for `discharge` — every OTHER shard's dischargeEvidence) in the
// same critical section. The rule, enforced by this file's own self-test
// (both statically, by parsing this source for the pattern, and at runtime,
// by racing two lock-order-obeying commands against each other): a command
// that needs both locks takes `withCatalogueLock` FIRST and `withShardLock`/
// `withShardLocks` nested INSIDE it, never the other way round. One-way
// ordering is what makes deadlock structurally impossible — there is no
// cycle to wait on when nothing ever takes them in the opposite order.
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
//   node scripts/campaign/bugs.mjs prove <B###> --pr <n> --proof "REG-B### ..." [--pending-deploy] [--build-plan <path>]  (--build-plan is REQUIRED for a T3 row)
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
  utimesSync,
  statSync,
  openSync,
  closeSync,
  chmodSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir, uptime } from "node:os";
import { execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { normalizeEvidence } from "./normalize-evidence.mjs";
import {
  hasRegToken,
  hasManualVerificationRow,
  manualVerificationIds,
  BUG_ID_RE,
} from "./reg-token.mjs";

// The repo root, independent of cwd — resolved from this file's own location
// (scripts/campaign/bugs.mjs) rather than process.cwd(), so a --build-plan
// path resolves the same way whether this runs via `npm run bugs --` or a
// direct `node scripts/campaign/bugs.mjs` from some other directory.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
// Overridable via BUGS_PIPELINE_DIR for the same reason as REGISTER(): the
// self-test exercises the real cmds.brief against a fixture discovery.md
// instead of the real .claude/pipeline directory.
const PIPELINE_DIR = () => process.env.BUGS_PIPELINE_DIR || ".claude/pipeline";

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

  // The read, the merge and the write are ONE critical section — this used to
  // run with no lock at all, so a concurrent `file`/`index`/`move` landing
  // between the read and this write had its own catalogue change silently
  // discarded when this write landed second.
  withCatalogueLock(() => {
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
  });
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

  // The id allocation below and the catalogue write at the bottom are ONE
  // critical section. Split, two sessions filing at the same moment read the
  // same snapshot, allocate the SAME id, and the second one's ledger write
  // takes the update branch over the first one's row — both exit 0 printing
  // the same `filed B##`, and one entire bug (catalogue row, ledger row and
  // record) is gone with nothing to detect it.
  withCatalogueLock(() => {
    const rows = readCatalogue();
    // Never infer a free id from a gap — reserved is not abandoned. Always
    // max+1, over the UNION of the catalogue's ids AND every ledger shard's:
    // two sessions filing against the same catalogue snapshot used to allocate
    // the SAME id (only the catalogue side of the union was considered), and
    // whichever session's catalogue write landed second clobbered the first's
    // row outright.
    const shardMaxId = Math.max(
      0,
      ...[...readState().keys()].map((id) => Number(String(id).slice(1)) || 0),
    );
    const maxId = Math.max(
      shardMaxId,
      rows.reduce((m, r) => Math.max(m, Number(r.id.slice(1))), 0),
    );
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

    // A bug with no ledger row is invisible to campaign-check and to `next`, so
    // filing must create it. This write can fail() and exit — it now runs
    // BEFORE the catalogue is touched at all, so a refused write never leaves a
    // catalogue row describing a bug whose ledger row does not exist, or (the
    // concurrent case: two sessions filing at once) belongs to a DIFFERENT
    // session's title/batch because that session's catalogue write landed
    // first and got silently clobbered.
    let tier = null;
    let ledgerWhat = null;
    if (bug.batch) {
      tier = (flag(args, "tier") ?? "").toUpperCase();
      if (!/^T[123]$/.test(tier))
        fail(
          "--tier T1|T2|T3 is required with --batch — a ledger tier is a ruling, not a default. " +
            "File without --batch (it lands in `triage`) and set the tier after analysis with `tier`.",
        );
      // mustBeNew: this id was allocated moments ago as a FRESH one. If a row
      // for it already exists, another writer took it — refuse loudly instead of
      // quietly merging this bug into that one.
      const { what, row } = upsertLedgerRow(
        bug.batch,
        {
          id: bug.id,
          batch: bug.batch,
          tier,
          state: "queued",
          pr: null,
          proof: null,
          evidence: null,
        },
        { mustBeNew: true },
      );
      if (row?.batch !== bug.batch || row?.tier !== tier || row?.state !== "queued")
        fail(
          `ledger write for ${bug.id} did not land as intended — re-read row is ${JSON.stringify(row)}`,
        );
      ledgerWhat = what;
    }

    // Only NOW touch the catalogue. Anything below that still throws (expand()
    // deriving a record, the --files rewrite) restores the pre-write catalogue
    // rather than leave a dangling row with no record behind it.
    const before = readCatalogue();
    rows.push(bug);
    writeCatalogue(rows);
    try {
      console.log(`filed ${bug.id} — ${title}`);
      console.log(`  location : ${location}`);
      console.log(`  severity : ${severity}`);
      if (c.sensitive)
        console.log(
          `  carve-out: touches ${c.reasons.join(", ")} — an agent may PLAN this but must not fix it unattended.`,
        );
      else console.log("  agent-safe: yes");
      if (!bug.batch)
        console.log("  no batch yet — run @tech-lead to batch it, or pass --batch F##.");

      if (bug.batch)
        console.log(`  ledger   : ${bug.batch}.jsonl row ${ledgerWhat} (tier ${tier}, queued)`);
      else {
        console.log(
          "  ledger   : none — pass --batch F## so campaign-check and `next` can see it.",
        );
        console.log(
          "  triage   : an unbatched bug is invisible to next/status/deps — run `triage` to list every bug in this state.",
        );
      }

      // Filing a bug and leaving it without a record is exactly the drift this
      // registry exists to prevent, so create it in the same breath. expand is
      // idempotent and never touches an existing narrative.
      //
      // MUST run AFTER the ledger write above: expand derives the record's
      // front matter (and its body header line) from frontFor(bug, st), and
      // `st` is this ledger row. Calling expand first used to bake in
      // "uncampaigned"/no-tier permanently into the body until the next
      // unrelated sync happened to touch this bug.
      cmds.expand();
      console.log(`  record   : ${recordPath(bug.id)}`);

      // A filed bug's front matter otherwise never carries `files` (only
      // `enrich` writes it, and only for register imports) — with no files,
      // `deps` sees zero edges for it and the dependency graph can only ever
      // get less complete as bugs get filed rather than imported.
      if (filesFlag) {
        const rec = readRecord(bug.id);
        if (rec) {
          writeRecord(bug.id, { ...rec.front, files: filesFlag }, rec.body);
          console.log(`  files    : ${filesFlag}`);
        }
      }
    } catch (e) {
      writeCatalogue(before);
      // The ledger row this call just ADDED (mustBeNew:true guarantees it was
      // an add, never an update) is not this catch's to leave behind — left
      // in place, it is an orphan with no catalogue row and no record, and
      // no gate or command can see it.
      if (bug.batch) dropLedgerRow(bug.batch, bug.id);
      fail(
        `file: ${bug.id} failed after the catalogue write (${e.message}) — catalogue and ledger restored to their pre-write state`,
      );
    }
  });
};

// ── selection: what is workable, what blocks it, and in what order ────────
// A batch is workable when it holds rows nobody is on. `in-flight` is the local
// signal (written by `claim` below) and a live team.mjs claim comment is the
// authoritative one; the local signal exists so the exclusion survives a lost
// GitHub read, which is the difference between "two agents got the same batch"
// and "the dispatcher waited".
const WORKABLE = new Set(["queued", "regressed"]);
// CONFLICT-RELEVANT is a strictly wider question than WORKABLE, and conflating
// the two deleted the constraints that matter most. A row someone is fixing
// RIGHT NOW is the most conflict-relevant row in the repo — it is being edited —
// yet `in-flight` is not workable, so the conflict graph dropped it and
// `deps` stopped reporting the F11<->F12 pair the moment F11 was claimed.
// Anything a writer is holding open counts here; only proven/done rows fall out.
const CONFLICTING = new Set([...WORKABLE, "in-flight"]);
// The standing agent cap (feedback_cap_background_agents_at_four) — a wave that
// proposes more parallel batches than the fleet can run is not a plan.
const AGENT_CAP = 4;

const boardJson = () =>
  existsSync(BOARD()) ? JSON.parse(readFileSync(BOARD(), "utf8")) : { batches: {} };

// A board card's issue number is fed to `gh` and printed back to the operator
// as a `team.mjs claim <n>` instruction, so it is validated at the boundary
// where it enters: anything that is not a plain positive integer is not an
// issue number, and falls into the existing "no board card" branch — which is
// the honest report — rather than into a request or a command line. A crafted
// value used to reach a SHELL (the gh call went through execSync, which spawns
// cmd.exe on win32, and a `501" & echo … & rem ` board value executed), and a
// non-scalar printed as `(issue #[object Object])` with a claim instruction
// nobody could run.
const boardIssue = (raw) => {
  // The typeof guard is not decoration: String(["501"]) is "501", so a
  // one-element array would otherwise pass the digits test. Only a number or a
  // string can be an issue number.
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  const t = String(raw).trim();
  return /^[1-9]\d*$/.test(t) ? Number(t) : null;
};

// ⚠️ THIS IS scripts/team/team.mjs's CLAIM GRAMMAR, RE-STATED. team.mjs is a
// CLI, not a module, so there is nothing to import — the two readings of the
// same GitHub comments MUST CHANGE TOGETHER, IN ONE COMMIT. See the matching
// warning at team.mjs's `isAgent`/`parseClaim`/`liveClaims`.
//
// The three rules, and why each one is load-bearing (all three were broken here
// and the divergence went the dangerous way — this file freed leases team.mjs
// still held, and honoured leases team.mjs did not):
//   1. MARKER FIRST. Only a comment whose body starts with `<!--rf:agent-->` is
//      protocol. team.mjs filters on it before parsing anything; this file did
//      not, so ONE unmarked `claim:` comment from anybody shut the dispatcher
//      down for every batch on the board.
//   2. NO LEADING WHITESPACE. team.mjs anchors `^claim:` / `^release:` with /m;
//      this file allowed `^\s*`, so an INDENTED `release:` line inside a marked
//      comment freed a lease team.mjs still enforces — `next` would hand out a
//      batch `team.mjs claim` refuses with "held by …".
//   3. PER COMMENT, NOT PER LINE. `--jq .[].body` flattens every comment into
//      one stream of lines, which destroys rule 1 (a line has no marker) and
//      lets a release in one person's comment cancel a claim in another's.
//      Fetch structured objects and keep the comment boundary.
// A failure to read (offline, no gh, no auth) NEVER pretends the batch is free:
// it degrades to the local `in-flight` signal and says so.
const TEAM_MARKER = "<!--rf:agent-->";
// Byte-for-byte team.mjs:103 and team.mjs:113.
const TEAM_CLAIM_RE = /^claim:\s*id=(\S+)\s+lease-until=(\S+)/m;
const TEAM_RELEASE_RE = /^release:\s*id=(\S+)/m;

// Pure, so the self-test can drive the exact comment payloads that broke this
// with no network at all.
function readClaims(comments) {
  const all = (Array.isArray(comments) ? comments : []).map((c) => ({
    commentId: c?.id,
    body: String(c?.body ?? ""),
  }));
  const agent = all.filter((c) => c.body.startsWith(TEAM_MARKER));
  const released = new Set();
  for (const c of agent) {
    const m = TEAM_RELEASE_RE.exec(c.body);
    if (m) released.add(m[1]);
  }
  const now = new Date();
  const live = agent
    .map((c) => {
      const m = TEAM_CLAIM_RE.exec(c.body);
      return m ? { id: m[1], leaseUntil: new Date(m[2]), commentId: c.commentId } : null;
    })
    .filter(Boolean)
    .filter((c) => !released.has(c.id) && c.leaseUntil > now)
    // Rule 4 of the shared grammar: LOWEST LIVE COMMENT ID WINS. Issue comment
    // ids are server-assigned and totally ordered, which is the only reason
    // team.mjs's claim is a real compare-and-swap — see team.mjs:11-13 and its
    // matching `.sort` in liveClaims. This file used to take whatever the API
    // returned first, so with two live claims on one issue the two readers
    // named DIFFERENT holders.
    .sort((a, b) => a.commentId - b.commentId);
  if (live.length) return live[0];
  // An INFORMAL claim — a session that wrote "Claimed for planning …" in prose
  // instead of taking a lease — is not a lease and must not be treated as one,
  // but it is exactly how the F11 collision happened (a live session held
  // fix/F11-run-cancel-skip while `next` proposed F11). Surface it; the human
  // or the lead decides. Never guess a lock from prose. Scanned over ALL
  // comments, marked or not: prose is prose whoever wrote it.
  const informal = all.find(
    (c) =>
      !TEAM_CLAIM_RE.test(c.body) &&
      !TEAM_RELEASE_RE.test(c.body) &&
      /\bclaim(ed|ing)\b/i.test(c.body),
  );
  return informal
    ? { informal: true, why: informal.body.replace(/\s+/g, " ").trim().slice(0, 140) }
    : null;
}

// gh returns ONE page unless asked otherwise, and `--paginate --slurp` returns
// an ARRAY OF PAGES — so flatten. Both readers of this protocol use this exact
// expression. (`--slurp` cannot be combined with `--jq`: gh rejects the pair
// outright, so the projection happens here in JS instead.)
const flattenCommentPages = (pages) => (Array.isArray(pages) ? pages : []).flat();

// Named so the self-test can assert the argv itself: "does this reader ask for
// every page" is the question, and a source grep is not an answer.
const ghCommentsArgs = (issue) => [
  "api",
  "--paginate",
  "--slurp",
  `repos/{owner}/{repo}/issues/${issue}/comments?per_page=100`,
];

// Deliberately a `let` binding rather than a function declaration: it is the
// single network-bound call in the selector, and the self-test substitutes it
// to drive `selectBatches`/`next` against a fixture lease. `gh` cannot be
// shimmed onto PATH instead — execFileSync spawns a real executable and win32
// refuses a .cmd without a shell.
let liveClaim = (issue) => {
  // `null` here used to be the SAME return value as "checked, and free" —
  // indistinguishable at the call site from an actual clean check. A batch
  // with no board.json issue at all silently passed as free and was then
  // proposed with an uncompletable `claim <issue#>` instruction. Route it
  // through the same "unknown" branch a failed network read already uses.
  if (!issue) return { unknown: true, why: "no board issue for this batch" };
  let comments;
  try {
    // execFileSync, never execSync: no shell is involved at any point, so the
    // argument vector cannot be re-parsed as a command line whatever the board
    // says. team.mjs has always called gh this way; this file had not.
    const out = execFileSync("gh", ghCommentsArgs(issue), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
    });
    const pages = JSON.parse(out || "[]");
    if (!Array.isArray(pages)) throw new Error("gh returned a non-array comment payload");
    // WITHOUT --paginate gh returns page 1 — the OLDEST 100 comments — while a
    // claim is by construction the NEWEST comment. A lease posted as comment
    // #101 was invisible here and in team.mjs alike: the batch was not busy, so
    // it occupied no capacity and every conflict it carried was dropped.
    comments = flattenCommentPages(pages);
  } catch (e) {
    return { unknown: true, why: firstLine(e) };
  }
  return readClaims(comments);
};

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
        issue: boardIssue(board.batches?.[row.batch]),
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
  const open = (id) => CONFLICTING.has(g.state.get(id)?.state);
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
//
// `busy` is the batches that are ALREADY being worked — in-flight locally, or
// held under a live team.mjs lease. They are pre-coloured into wave 1 rather
// than deleted, because deleting them deleted the constraints they carried:
// claiming F11 used to make F11<->F12 vanish, and `next` then offered F12 to a
// second agent editing the same two web files. They occupy a slot of the agent
// cap (four agents means four, whatever they are already on) and are never
// returned as a pick — the wave assembly below walks `ranked` only.
function computeWaves(ranked, conflicts, cap = AGENT_CAP, busy = []) {
  const waveOf = new Map();
  const sizes = [];
  const busySet = new Set(busy);
  for (const b of busySet) {
    waveOf.set(b, 0);
    sizes[0] = (sizes[0] ?? 0) + 1;
  }
  for (const b of ranked) {
    const neighbours = [...(conflicts.get(b.batch)?.keys() ?? [])];
    // Recorded so the operator is told WHY a batch is not on offer. A candidate
    // that hard-conflicts with a busy batch is always pushed past wave 1, since
    // every busy batch sits in wave 1 — so this list is exactly the reason.
    const heldUp = neighbours.filter((o) => busySet.has(o));
    b.blockedBy = heldUp.length ? heldUp : null;
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
  // When busy batches alone fill wave 1, index 0 is never assigned above and
  // `waves` is a SPARSE array — `Array.prototype.map` skips holes rather than
  // visiting them, so a `w ?? []` map here never runs and the hole survives
  // into `JSON.stringify` as `null`. Fill holes in place instead.
  for (let i = 0; i < waves.length; i++) waves[i] ??= [];
  return waves;
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

  // Batches parked by the carve-out that still need their LEASE checked. The
  // carve-out is a LABEL on a batch, never a reason to drop it out of the
  // scheduling problem: parking used to `continue` before the busy tests ran,
  // so a parked batch that was in flight — or held under a live team.mjs lease
  // — never got `busy: true`. It then occupied no slot of the agent cap and
  // every hard conflict it carried was dropped from the colouring, and `next`
  // offered a batch editing the same non-hub file to a second agent.
  const parkedPendingClaim = [];
  for (const b of rankBatches(batches.values())) {
    const parkedByCarveOut = b.sensitive.length > 0;
    if (parkedByCarveOut) parked.push(b);
    // `busy` marks a skip that means "someone is working this", as opposed to
    // "there is nothing here". It is set explicitly rather than re-derived by
    // regex from the prose below, because the prose is for humans and a
    // scheduling invariant must not depend on its wording.
    if (!b.bugs.length) {
      skipped.push({
        ...b,
        busy: b.inFlight.length > 0,
        busyWhy: b.inFlight.length > 0 ? "in-flight" : null,
        why: `no workable rows (${b.inFlight.length} in-flight)`,
      });
      continue;
    }
    if (b.inFlight.length) {
      skipped.push({
        ...b,
        busy: true,
        busyWhy: "in-flight",
        why: `${b.inFlight.length} row(s) in-flight: ${b.inFlight.join(", ")}`,
      });
      continue;
    }
    // A parked batch is never a candidate — but it IS still checked for a
    // lease below, because a lease is what makes it busy.
    (parkedByCarveOut ? parkedPendingClaim : candidates).push(b);
  }

  // The claim read is per candidate and network-bound, so it runs LAST and only
  // over batches that survived every free check.
  if (!args.includes("--no-claims")) {
    const still = [];
    const parkedSet = new Set(parkedPendingClaim);
    for (const b of [...candidates, ...parkedPendingClaim]) {
      // A parked batch that survives the check goes nowhere: it stays parked.
      // A parked batch that is LEASED goes into `skipped` as busy, which is the
      // whole point — it must keep its slot and its conflicts.
      const keep = parkedSet.has(b) ? () => {} : (x) => still.push(x);
      const c = liveClaim(b.issue);
      if (c?.unknown) {
        // Unreadable is not free: keep the batch, but say the check did not
        // run. A missing board.json issue is a distinct, sharper case than a
        // transient read failure — the check will NEVER run for this batch
        // until one exists, not just this once.
        b.claimCheck = b.issue
          ? `claim check unavailable (${c.why}) — relying on in-flight rows only`
          : `no board card for ${b.batch} — no lease could be checked; add its issue number to ` +
            `.claude/campaign/board.json once one exists, or rely on in-flight rows only`;
        keep(b);
      } else if (c?.informal) {
        b.claimCheck = `issue #${b.issue} carries an informal claim (no team.mjs lease) — VERIFY before taking it: "${c.why}"`;
        keep(b);
      } else if (c) {
        skipped.push({
          ...b,
          busy: true,
          busyWhy: "leased",
          why: `claimed by ${c.id} until ${c.leaseUntil.toISOString()}`,
        });
      } else {
        keep(b);
      }
    }
    candidates.length = 0;
    candidates.push(...still);
  }

  // The batches that are already being worked are NOT deleted from the problem:
  // they occupy wave 1 and keep their hard conflicts, so a candidate that shares
  // a non-hub file with one of them is pushed past wave 1 instead of being
  // handed to a second agent.
  const conflicts = batchConflicts(hubThreshold);
  const busy = skipped.filter((s) => s.busy).map((s) => s.batch);
  // Which KIND of busy each holder is — a local in-flight row, or a remote
  // team.mjs lease — so the blocked reason below can say which, instead of
  // hardcoding "in-flight" for a holder that may not have one at all.
  const busyKind = new Map(skipped.filter((s) => s.busy).map((s) => [s.batch, s.busyWhy]));
  const waves = computeWaves(candidates, conflicts, cap, busy);
  const blocked = candidates
    .filter((b) => b.blockedBy?.length)
    .map((b) => {
      const files = [
        ...new Set(b.blockedBy.flatMap((o) => [...(conflicts.get(b.batch)?.get(o) ?? [])])),
      ];
      const holders = b.blockedBy
        .map((o) => `${busyKind.get(o) === "leased" ? "leased" : "in-flight"} ${o}`)
        .join(", ");
      return {
        batch: b.batch,
        blockedBy: b.blockedBy,
        files,
        why:
          `blocked by ${holders} — shares ` +
          `${files.slice(0, 2).join(", ")}${files.length > 2 ? ` (+${files.length - 2} more)` : ""}`,
      };
    });
  return { waves, parked, skipped, blocked, busy, cap, hubThreshold };
}

const claimHint = (b) => `node scripts/team/team.mjs claim ${b.issue ?? "<issue#>"}`;

// The dispatcher's selector. Returns the next BATCH an agent may take, because a
// batch — not a single bug — is what the board card, the pipeline folder and the
// PR are all scoped to. It returns the head of WAVE 1, not the head of a
// severity sort: the top of a severity sort routinely hard-conflicts with the
// batch someone else is already in.
cmds.next = (args) => {
  const { waves, parked, skipped, blocked, busy, cap, hubThreshold } = selectBatches(args);
  const wave1 = waves[0] ?? [];

  if (args.includes("--json")) {
    // `next` is the ONE place that names a head at all — the text path
    // treats wave1[0] as "the next batch" and the rest as "safe to run
    // alongside it", but --json used to hand back only `eligible` (the
    // WHOLE wave, un-headed) with no `cap`/`hubThreshold` a consumer could
    // use to tell what schedule produced it. Now self-describing, matching
    // `waves --json`'s shape plus the named head.
    console.log(
      JSON.stringify(
        {
          next: wave1[0] ?? null,
          alongside: wave1.slice(1),
          eligible: wave1,
          waves,
          parked,
          skipped,
          // Candidates a batch already being worked pushed past wave 1, and the
          // batches doing the pushing. Without these a consumer sees a shorter
          // wave 1 and no reason for it.
          blocked,
          busy,
          cap,
          hubThreshold,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!wave1.length) {
    console.log(
      "No batch is available right now — every batch with workable rows is parked by the " +
        `carve-out, claimed, in-flight, or held out of wave 1 by one of the ${busy.length} ` +
        `batch(es) already being worked (agent cap ${cap}).`,
    );
  } else {
    const top = wave1[0];
    console.log(`next agent-safe batch: ${top.batch}${top.issue ? ` (issue #${top.issue})` : ""}`);
    console.log(`  ${top.bugs.length} workable bug(s), worst severity ${worstSeverity(top)}`);
    for (const b of top.bugs)
      console.log(`    ${b.id.padEnd(5)} ${String(b.severity).padEnd(8)} ${b.title.slice(0, 76)}`);
    if (top.claimCheck) console.log(`  ⚠ ${top.claimCheck}`);
    if (wave1.length > 1) {
      // Each alongside batch gets its OWN claimCheck line — this used to be
      // consulted for `top` alone, so a batch whose claim check failed
      // identically to the head's was still listed as "safe to run
      // alongside it" with no warning at all (`waves` already does this
      // per-batch; `next`'s text path did not).
      console.log(`  safe to run alongside it (same wave, no shared non-hub file):`);
      for (const b of wave1.slice(1)) {
        console.log(`    ${b.batch}`);
        if (b.claimCheck) console.log(`      ⚠ ${b.claimCheck}`);
      }
    }
    console.log(`\n  claim it:  ${claimHint(top)}`);
  }

  // `blocked` belongs in THIS list: `next` only ever offers wave 1, so a batch a
  // busy neighbour pushed to a later wave is skipped as far as this command is
  // concerned — and saying nothing about it is what let `next` propose F11 while
  // a live lease on F12 was editing the same two web files.
  if (skipped.length || blocked.length) {
    console.log(`\nskipped (${skipped.length + blocked.length}):`);
    for (const b of skipped) console.log(`    ${String(b.batch).padEnd(4)}  ${b.why}`);
    for (const b of blocked) console.log(`    ${String(b.batch).padEnd(4)}  ${b.why}`);
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
  const { waves, parked, skipped, blocked, busy, cap, hubThreshold } = selectBatches(args);
  const blockedBy = new Map(blocked.map((b) => [b.batch, b]));
  if (args.includes("--json")) {
    console.log(
      JSON.stringify({ waves, parked, skipped, blocked, busy, cap, hubThreshold }, null, 2),
    );
    return;
  }
  console.log(
    `Waves — greedy colouring of the batch hard-conflict graph (hub threshold ${hubThreshold}), ` +
      `capped at ${cap} concurrent batches, worst severity first.\n`,
  );
  // Batches already being worked are not listed as picks, but they hold a slot
  // of the cap and their hard conflicts still push candidates into later waves.
  // Saying so is the difference between a short wave 1 and an unexplained one.
  if (busy.length)
    console.log(
      `  wave 1 already holds ${busy.length} batch(es) being worked (${busy.join(" ")}) — ` +
        `they occupy the cap and keep their conflicts.\n`,
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
      // A later wave is a CONSEQUENCE, not an explanation. Name the batch
      // already being worked that holds this one back.
      const held = blockedBy.get(b.batch);
      if (held) console.log(`         ⚠ ${held.why}`);
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

// Every writer refreshes the body's baked-in header line itself, from the
// SAME front matter it is writing — a caller cannot forget it. Before this,
// only `sync` ever called refreshHeaderLine, so `reopen`/`prove`/`discharge`/
// `claim`/`release`/`tier` left the visible "**Location** ... **State** ..."
// line stale until the next Gate-4 sync happened to touch the same bug —
// `show`/`brief` render the body, so an agent reading between the write and
// that sync saw a superseded state.
function writeRecord(id, front, body) {
  mkdirSync(RECORD_DIR(), { recursive: true });
  writeFileSync(recordPath(id), renderFront(front) + refreshHeaderLine(body, front));
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
  // Strip HTML comment delimiters from arbitrary caller text — most often a
  // raw commit subject. Left in, a literal `<!--...-->` lands in the body
  // and pre-occupies a dedupe marker, silently swallowing a later GENUINE
  // event that happens to share that marker; a subject carrying a bare
  // `-->` corrupts the marker beside it too. Done AFTER whitespace is
  // collapsed, so a marker split across a line break is still caught.
  const cleanDetail = String(detail)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/<!--|-->/g, "");
  const core = `**${event}** · ${cleanDetail}`;
  // A hand-stripped marker leaves the visible line behind with no trailing
  // `<!--...-->` at all. If that line — by its stable event+detail text, not
  // the DATE prefix, since a healing --rescan can run on a different day
  // than the original write — is already present without a marker, this is
  // a heal, not a new occurrence: appending would duplicate the visible line.
  const hasMarkerlessLine = body
    .split("\n")
    .some(
      (l) => l.trim().startsWith("- ") && l.includes(core) && !/<!--[^>]*-->\s*$/.test(l.trim()),
    );
  if (hasMarkerlessLine) return body;
  const line = `- ${new Date().toISOString().slice(0, 10)} · ${core} <!--${key}-->`;
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
      // writeRecord refreshes the header line itself now — no need to do it
      // here first.
      writeRecord(bug.id, { ...existing.front, ...front }, existing.body);
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
    // of the sync — say so and carry on. Nothing to anchor either.
    return { mentions, head: null, note: `git unavailable, commit scan skipped — ${firstLine(e)}` };
  }

  const prev = readSyncState().lastSha;
  // A sha that git no longer knows (rebased away, a different clone) must not
  // abort the scan — fall back to the bounded window.
  const anchored = prev && !rescan && isCommit(prev) ? prev : null;
  if (!anchored && !rescan) {
    // Nothing is scanned in THIS branch — there is no per-record loop for the
    // anchor to race against, so it is safe (and necessary: a first run must
    // not silently re-derive the same unbounded window forever) to persist
    // it right here, synchronously.
    writeSyncState(head);
    return {
      mentions,
      head,
      // These two notes mean "a commit range was NEVER scanned" — the one
      // case a quiet hook must not go silent on. `unscanned` lets cmds.sync
      // route them to stderr unconditionally, regardless of --quiet.
      unscanned: true,
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
    // The scan itself failed — nothing was derived for this range, so the
    // anchor must not move either, or the range is silently skipped forever.
    return { mentions, head: null, note: `commit scan failed (${spec}) — ${firstLine(e)}` };
  }

  const { mentions: scanned, commits } = parseMentions(log, state);
  // The anchor is RETURNED, not persisted here. A mid-run failure in the
  // per-record loop that consumes `mentions` (cmds.sync, below) must not have
  // already moved past events that loop never got to write — the anchor used
  // to advance right here, before a single record was touched, so a bug that
  // crashed the loop lost every event destined for a bug processed AFTER it,
  // permanently (the next run's anchor already sat past them). Only
  // `cmds.sync`, once every record has actually been written, persists it.
  return {
    mentions: scanned,
    head,
    note: commits
      ? // Only a REAL sha gets truncated to 8 chars — the literal fallback
        // "the window" is not a sha, and `.slice(0, 8)`'d it into the
        // unreadable "the wind".
        `scanned ${commits} commit(s) since ${anchored ? anchored.slice(0, 8) : "the window"}`
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
    // Split on the FIRST tab only — a subject containing its own tab
    // character used to truncate the scanned subject there, losing every id
    // that came after it.
    const tabAt = line.indexOf("\t");
    const sha = tabAt === -1 ? line : line.slice(0, tabAt);
    const subject = tabAt === -1 ? "" : line.slice(tabAt + 1);
    commits++;
    const short = sha.slice(0, 8);
    // Bug ids first: when a commit names both, the bug-id detail is the one
    // that lands (both share the `commit-<sha>` marker, first write wins).
    for (const raw of new Set(subject.match(/\bB\d{1,4}\b/g) ?? []))
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

  const { mentions, head, note, unscanned } = commitMentions(state, args);
  if (note) {
    if (unscanned)
      // Gate 4 (the ONLY place this ever runs unattended) invokes `sync
      // --quiet` — a lost or unknown anchor used to drop the whole
      // unscanned range with ZERO output there. Route it to stderr
      // unconditionally so a quiet caller still sees it.
      process.stderr.write(`sync: ${note}\n`);
    else if (!quiet) console.log(`sync: ${note}`);
  }

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
    const nextFront = { ...rec.front, ...front };
    // Write whenever the DERIVED front matter differs from what the record
    // currently carries — not only when the body text changed. `tier` (and
    // any other ledger-only field with no representation in the header line
    // or History) never touches `body` at all, so gating the write on
    // `body !== before` alone meant a tier move (or any such field) reached
    // the ledger but never the record — this file's own docstring claims the
    // record cannot drift from the ledger, and that was false for exactly
    // this case. writeRecord regenerates the header line itself regardless.
    if (body !== before || JSON.stringify(nextFront) !== JSON.stringify(rec.front))
      writeRecord(bug.id, nextFront, body);
  }

  // Persist the scan anchor LAST, only after every record above has actually
  // been written — a crash partway through the loop must leave the anchor at
  // its PRE-scan position, so the next run re-scans (and this time records)
  // the same range instead of silently skipping it forever. `head` is null
  // when commitMentions already persisted it itself (the first-run/re-anchor
  // branch, which scans nothing so there is nothing to race) or when the
  // scan itself failed outright.
  if (head) writeSyncState(head);

  if (!quiet || events.length) console.log(`sync: recorded ${events.length} new event(s).`);
  for (const e of events.slice(0, 20)) console.log(`  ${e}`);
};

cmds.show = (args) => {
  const typed = (args[0] ?? "").toUpperCase();
  if (!BUG_ID_RE.test(typed)) fail("usage: show <B###>");
  const id = resolveId(typed);
  if (!existsSync(recordPath(id))) fail(`no record for ${id} — run \`expand\``);
  process.stdout.write(readFileSync(recordPath(id), "utf8"));
};

// How an analysis agent writes its findings back. `--section` replaces one
// narrative section; without it the text lands as a history note.
cmds.note = (args) => {
  const typed = (args[0] ?? "").toUpperCase();
  const text = args[1];
  if (!BUG_ID_RE.test(typed) || !text || text.startsWith("--"))
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
  // The read, the rebuild and the write are ONE critical section — this used
  // to rewrite bugs.jsonl wholesale with no lock at all, so a concurrent
  // `file` landing between the read and this write had its brand-new row
  // silently dropped when this rebuild landed second. `index` takes no shard
  // lock, so the ordering rule (catalogue, then shard) is trivially satisfied.
  withCatalogueLock(() => {
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
  });
};

// ── ledger writes ─────────────────────────────────────────────────────────
// The proof ledger is REPLACE-IN-PLACE, one row per bug id across all shards —
// campaign-check rejects a duplicate id, and appending a second row for the same
// bug is the first thing anyone tries (it cost a full redo during the F07/F10
// discharge). Every ledger write in this file goes through upsertLedgerRow, so
// that mistake is unrepresentable rather than merely documented.
const shardPath = (batch) => join(STATUS_DIR(), `${batch}.jsonl`);

// ── the shard lock ────────────────────────────────────────────────────────
// `mkdir` is the filesystem primitive that is atomic and fails loudly on BOTH
// NTFS and POSIX (an O_EXCL file is too; a directory survives a crash more
// legibly and a human can remove it with one command). A lockfile library is
// deliberately not introduced for this — the repo's dependency rules are
// narrow and this is 40 lines.
//
// Rules, all of them load-bearing:
//   * the READ belongs inside the lock, not just the write — a caller that
//     read the row outside it computes its patch from a stale snapshot;
//   * re-entrant per process, so a command may hold the lock across a loop of
//     `upsertLedgerRow` calls that each take it again (`discharge`, `claim`);
//   * a lock is broken on its owner being DEAD, never on its AGE. Each lockdir
//     carries `owner.json` = {pid, token, at}; a waiter breaks the lock only
//     when `process.kill(pid, 0)` reports ESRCH (which works on win32 too), or
//     — a loud last resort, for a lock whose owner cannot be read at all —
//     when it is older than LOCK_ABANDON_MS. Age is NOT liveness: breaking a
//     live holder's lock put two writers inside the critical section, and the
//     stolen-from writer then wrote its stale snapshot back over two proven,
//     evidence-backed rows with every process exiting 0;
//   * release is identity-checked against that token. A process whose lock was
//     broken must NOT delete the lock its successor now holds — doing so
//     admitted a THIRD writer to the same shard;
//   * multi-shard holds (only `move`) are taken in sorted order, so two
//     processes moving rows in opposite directions cannot deadlock;
//   * `fail()` calls `process.exit`, which does NOT run `finally`, so held
//     locks are also dropped from an `exit` handler — and SIGINT/SIGTERM/SIGHUP
//     are routed through `process.exit` so that handler runs for them too
//     (Node's default action for those signals skips it entirely).
// The spin has to outlast a legitimate critical section, so it is now far
// longer than any single write: a waiter that gives up while a LIVE holder is
// still writing is the same lost work by another route.
const LOCK_SPIN_MS = 10000;
const LOCK_STEP_MS = 20;
// Last resort ONLY, for a lockdir carrying no readable owner.json (a crash
// between the mkdir and the owner write, or a lock left by an older build).
// Deliberately far larger than any real critical section — this threshold must
// never be the thing that breaks a lock a live process is holding.
const LOCK_ABANDON_MS = 120000;
const lockPath = (batch) => `${shardPath(batch)}.lock`;
const ownerPath = (p) => join(p, "owner.json");
const shardOfLockPath = (p) => basename(p).replace(/\.lock$/, "");
// lock path -> the token THIS process wrote into that lockdir's owner.json.
const heldLocks = new Map();

const readLockOwner = (p) => {
  try {
    const o = JSON.parse(readFileSync(ownerPath(p), "utf8"));
    return o && typeof o === "object" ? o : null;
  } catch {
    return null; // missing, half-written, or not ours to read — unknowable
  }
};

// A boot-epoch stamp: current time minus how long THIS boot has been up, so
// it is (near enough) constant across every process started on the same
// boot and DIFFERENT after a reboot — even if the OS immediately reuses the
// exact same pid. Without this, `pidAlive(owner.pid)` alone cannot tell "the
// original writer is still running" from "an unrelated process now happens
// to hold this pid", and a lockdir whose owner pid gets reused by ANY live
// process was never broken — permanently wedged, since `process.kill(pid,0)`
// answers `true` for the impostor forever. A live pid on the SAME boot is
// still unbreakable — bootAt only ever proves a NEGATIVE (this cannot be the
// same process), never used to break a lock whose boot actually matches.
const bootStamp = () => Math.round(Date.now() - uptime() * 1000);
// A few seconds of slop for clock/measurement jitter between the stamp this
// process wrote and the one read back moments (or days) later — comfortably
// smaller than any real reboot gap, which is measured in minutes at least.
const BOOT_STAMP_SLOP_MS = 5000;

// true = alive, false = definitely gone (ESRCH) OR its owner pid predates
// this boot (so it cannot possibly be the process that wrote the lock), null
// = cannot tell. EPERM means the pid exists and belongs to someone else —
// alive, not free, UNLESS the boot stamp already proved it can't be ours.
const pidAlive = (pid, ownerBootAt) => {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (typeof ownerBootAt === "number" && Math.abs(ownerBootAt - bootStamp()) > BOOT_STAMP_SLOP_MS)
    return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "ESRCH" ? false : true;
  }
};
// Synchronous sleep — this whole file is synchronous by design (it is a CLI a
// hook shells out to), so a promise-based wait would need every caller to be
// async. `Atomics.wait` on the main thread is permitted in Node.
const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
let exitHookInstalled = false;
function installLockExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const [p, token] of [...heldLocks]) {
      try {
        releaseLock(p, token);
      } catch {
        /* nothing useful to do while exiting */
      }
    }
  });
  // Node's DEFAULT action for these three signals terminates the process
  // WITHOUT running `exit` listeners, so a Ctrl-C (or an orchestrator's
  // SIGTERM) mid-write left the lockdir behind and wedged the next writer.
  // Routing them through process.exit runs the hook above with the
  // conventional 128+signal status.
  for (const [sig, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ]) {
    try {
      process.on(sig, () => process.exit(code));
    } catch {
      /* not every signal is listenable on every platform */
    }
  }
}

// The one lock primitive. `p` is the lock DIRECTORY, `name` the thing it
// guards as a human says it ("F01.jsonl", "bugs.jsonl"), `guarded` the file
// itself for the give-up message. The shard lock and the catalogue lock are the
// SAME mechanism deliberately: a second, hand-rolled copy for the catalogue is
// exactly how the two of them would drift apart.
function acquireLock(p, name, guarded) {
  mkdirSync(dirname(p), { recursive: true });
  const deadline = Date.now() + LOCK_SPIN_MS;
  for (;;) {
    try {
      mkdirSync(p); // NOT recursive: recursive:true succeeds on an existing dir
      installLockExitHook();
      // The owner stamp is what makes both the break and the release
      // identity-checked. Written immediately after the mkdir wins the race;
      // a waiter that reads the lockdir in that sub-millisecond window sees no
      // owner, cannot conclude anything, and simply spins again.
      const token = randomUUID();
      try {
        // TEST SEAM, gated exactly like BUGS_TEST_STALL_MS: a real disk-full
        // or permission fault here is not reproducible on demand, so the
        // self-test drives this exact path through an env var instead of a
        // hand-rolled re-implementation of the cleanup logic below.
        if (process.env.BUGS_SELF_TEST === "1" && process.env.BUGS_TEST_FAIL_OWNER_WRITE === "1")
          throw Object.assign(new Error("BUGS_TEST_FAIL_OWNER_WRITE fixture"), {
            code: "EFIXTURE",
          });
        writeFileSync(
          ownerPath(p),
          JSON.stringify({ pid: process.pid, token, at: Date.now(), bootAt: bootStamp() }),
        );
      } catch (writeErr) {
        // A crash here (disk full, a permission fault) must not leave behind
        // a lockdir with no owner stamp — that is exactly the "no readable
        // owner.json" case that wedges every later waiter for a full
        // LOCK_ABANDON_MS before it self-heals. Remove the directory THIS
        // call just created (never one it merely found already there)
        // before rethrowing — the crash itself is a real fault the caller
        // needs to see, not something to retry silently.
        try {
          rmSync(p, { recursive: true, force: true });
        } catch {
          /* best effort — surfacing writeErr matters more than this cleanup */
        }
        throw writeErr;
      }
      heldLocks.set(p, token);
      return p;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const owner = readLockOwner(p);
    const alive = owner ? pidAlive(owner.pid, owner.bootAt) : null;
    const bootMismatch =
      alive === false &&
      typeof owner?.bootAt === "number" &&
      Math.abs(owner.bootAt - bootStamp()) > BOOT_STAMP_SLOP_MS;
    let age = null;
    try {
      age = Date.now() - statSync(p).mtimeMs;
    } catch {
      age = null; // it vanished between the mkdir and the stat — just retry
    }
    let breakWhy = null;
    if (bootMismatch)
      breakWhy = `its owner (pid ${owner.pid}) predates this boot — it cannot possibly still be that process`;
    else if (alive === false)
      breakWhy = `its owner (pid ${owner.pid}) is gone — a writer was killed mid-write`;
    else if (alive === null && age !== null && age > LOCK_ABANDON_MS)
      breakWhy =
        `LAST RESORT: it is ${Math.round(age / 1000)}s old and carries no readable owner.json, ` +
        `so its holder cannot be verified either way`;
    if (breakWhy) {
      console.error(
        `bugs: breaking the lock on ${name} — ${breakWhy}; ` +
          `re-read the file if anything looks wrong`,
      );
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        /* another process won the race to break it — retry below */
      }
    }
    if (Date.now() >= deadline)
      fail(
        `could not lock ${guarded} within ${LOCK_SPIN_MS}ms — ${name} is held by ` +
          `${owner?.pid ? `pid ${owner.pid}, which still answers` : "another bugs.mjs process"}. ` +
          `Retry; if nothing is running, remove ${p}` +
          // A lockdir with no readable owner.json isn't stuck forever — it is
          // exactly the LAST-RESORT case above, just not yet old enough to
          // trip it. Without this, the give-up message reads as a permanent
          // wedge needing a manual `rm`, when the honest story is "wait".
          (!owner
            ? ` — it carries no owner stamp and will be broken automatically ` +
              `once it is ${LOCK_ABANDON_MS / 1000}s old`
            : ""),
      );
    sleepSync(LOCK_STEP_MS);
  }
}

// Identity-checked. `token` defaults to whatever this process recorded for `p`;
// if the lockdir now names a DIFFERENT owner, our lock was broken while we were
// inside the critical section and the directory belongs to our successor —
// deleting it would admit a third writer, so leave it and say so out loud.
function releaseLock(p, token = heldLocks.get(p)) {
  heldLocks.delete(p);
  if (!existsSync(p)) return; // already gone — nothing to undo
  const owner = readLockOwner(p);
  if (!owner || !token || owner.token !== token) {
    console.error(
      `bugs: our lock on ${shardOfLockPath(p)} was broken by another process; verify the shard`,
    );
    // A stolen lock means a SECOND writer was inside the critical section
    // while this one still believed it held it exclusively — the integrity
    // of whatever this process just wrote is exactly what is now unknown.
    // Left at the default 0, a caller that shells out and branches on the
    // exit code (a hook, a CI step) read this as a clean success.
    process.exitCode = 1;
    return;
  }
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    /* already gone (someone broke it between the read and the rm) */
  }
}

// Re-entrant: if this process already holds `p`, `fn` runs directly and the
// OUTER hold owns the release.
function withLock(p, name, guarded, fn) {
  if (heldLocks.has(p)) return fn();
  acquireLock(p, name, guarded);
  try {
    return fn();
  } finally {
    releaseLock(p);
  }
}

// Runs `fn` with an exclusive hold on `batch`'s shard.
function withShardLock(batch, fn) {
  return withLock(lockPath(batch), `${batch}.jsonl`, shardPath(batch), fn);
}

// The catalogue needs the same protection as a shard and did not have it: `file`
// allocated an id from the catalogue ∪ the shards and wrote the catalogue with
// no lock at all, so two simultaneous `file --batch F01` calls both allocated
// B2, both exited 0 printing `filed B2`, and one whole bug — catalogue row,
// ledger row and record — vanished with no warning and both gates green.
// Held from the id allocation through the catalogue write, so allocation and
// commit are ONE critical section rather than two racing reads.
//
// Lock ORDER, and it is one-way: `file` takes the catalogue lock and then a
// shard lock inside it. Nothing takes them the other way round, so there is no
// cycle to deadlock on — keep it that way.
function withCatalogueLock(fn) {
  return withLock(`${CATALOGUE()}.lock`, "bugs.jsonl", CATALOGUE(), fn);
}

// Sorted, so two processes taking the same pair in opposite orders cannot
// deadlock. Only `move` needs it.
const withShardLocks = (batches, fn) =>
  [...new Set(batches)].sort().reduceRight((next, b) => () => withShardLock(b, next), fn)();

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
//
// `opts.allowExistingIn` names ONE shard where this id is allowed to already
// have a row without tripping the cross-shard duplicate guard — used only by
// `move`, which writes the destination shard additively WHILE the row still
// lives in the source shard (so the drop can happen only after this write is
// verified to have landed). Nothing else should ever pass it.
//
// The whole body runs under `withShardLock` — the re-read at the top is what
// makes the lock worth having, so a row written by another process between a
// caller's read and this call survives instead of being clobbered.
function upsertLedgerRow(batch, row, opts = {}) {
  return withShardLock(batch, () => upsertLedgerRowLocked(batch, row, opts));
}

function upsertLedgerRowLocked(batch, row, opts = {}) {
  const { rows, eol } = readShard(batch);
  // TEST SEAM. A lost update needs the two writers to interleave between this
  // read and the write below, and two freshly spawned node processes usually
  // do not — so the concurrency self-test widens the window deliberately
  // rather than hoping for it. Never set outside that test.
  // Gated on BUGS_SELF_TEST so a stray env var cannot slow — or, at a value
  // above the old age-based stale threshold, actively corrupt — a production
  // write, and capped so the seam can never wedge a run either.
  const stallMs =
    process.env.BUGS_SELF_TEST === "1"
      ? Math.min(Number(process.env.BUGS_TEST_STALL_MS) || 0, 30000)
      : 0;
  if (stallMs > 0) sleepSync(stallMs);
  const i = rows.findIndex((r) => r.id === row.id);
  // `mustBeNew` makes an id COLLISION unrepresentable rather than merely
  // unlikely: `file` allocates a fresh id and must never silently take the
  // update branch, which is how one session's freshly filed bug was overwritten
  // by another session that had allocated the same id from the same snapshot.
  if (i !== -1 && opts.mustBeNew)
    fail(
      `refusing to write ${batch}: ${row.id} already has a row in ${batch}.jsonl — this id was ` +
        `taken by another process between this one's read and its write`,
    );
  if (i === -1) {
    // Widen the duplicate guard to ALL shards, not just this one — the
    // same-shard check below cannot catch a row for this id already living in
    // a DIFFERENT shard, which is precisely the duplicate campaign-check
    // rejects and the invariant the surrounding comments already claim holds.
    const elsewhere = findShardOf(row.id);
    if (elsewhere && elsewhere !== batch && elsewhere !== opts.allowExistingIn)
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

// The other half of `upsertLedgerRow` — removes a row this process just
// added, under the same lock. Used ONLY to roll back a ledger write whose
// batch commit later failed: `file` used to restore the catalogue on a late
// failure but never touch the ledger row it had just added, leaving an
// ORPHAN row (no catalogue entry, no record) that no gate and no command
// could see.
function dropLedgerRowLocked(batch, id) {
  const { rows, eol } = readShard(batch);
  const next = rows.filter((r) => r.id !== id);
  if (next.length === rows.length) return false;
  mkdirSync(STATUS_DIR(), { recursive: true });
  writeFileSync(shardPath(batch), next.map((r) => JSON.stringify(r)).join(eol) + eol);
  return true;
}
function dropLedgerRow(batch, id) {
  return withShardLock(batch, () => dropLedgerRowLocked(batch, id));
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
  // A compound of the batch grammar and BUG_ID_RE's own pattern (stated here
  // as literal digits rather than composed from BUG_ID_RE.source, since a
  // regex source string embedded inside a bigger pattern is far easier to
  // get subtly wrong than it is to keep readable).
  if (!/^(F\d{2}|B\d{1,4})$/.test(typed)) fail("usage: brief <F##|B###>");
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
  // Validated at the boundary, same as `next`'s `issue` field — a raw board
  // value printed a non-scalar as `(issue #[object Object])`, a claim
  // instruction nobody could run.
  const briefIssue = boardIssue(board.batches?.[batch]);
  out.push(`# ${batch}${briefIssue ? ` · board issue #${briefIssue}` : ""}`);

  const pipelineDir = existsSync(PIPELINE_DIR())
    ? readdirSync(PIPELINE_DIR()).find((d) => d.toUpperCase().includes(`-${batch}-`))
    : null;
  const discovery = pipelineDir ? join(PIPELINE_DIR(), pipelineDir, "discovery.md") : null;

  const rows = ids.map((id) => ({ id, st: state.get(id), rec: readRecord(id) }));
  const analysed = rows.filter((r) => r.rec && !r.rec.body.includes(UNANALYSED));
  // WORKABLE (queued + regressed), not just queued — a batch holding only
  // regressed rows used to read "0 queued", hiding real open work behind a
  // number that looked like none was left.
  const workable = rows.filter((r) => WORKABLE.has(r.st?.state));
  const regressed = rows.filter((r) => r.st?.state === "regressed");
  out.push(
    `\n${rows.length} bug(s) · ${workable.length} workable (${regressed.length} regressed) · ` +
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
  if (regressed.length)
    out.push(
      `\n⚠️ **${regressed.length} record(s) in this batch REGRESSED** ` +
        `(${regressed.map((r) => r.id).join(", ")}) — closed once, proof came back false. Each ` +
        `carries its reopen citation in its own block below; read it before re-fixing.`,
    );

  let orderSequence = null;
  if (discovery && existsSync(discovery)) {
    out.push(
      `\n## Batch plan\n\nRead this FIRST — it carries the ordering, the file conflicts and the risks:\n\n    ${discovery}`,
    );
    const txt = readFileSync(discovery, "utf8");
    const verdict = /## Verdict\n\n([\s\S]*?)(?=\n## )/.exec(txt);
    if (verdict) out.push(`\n${verdict[1].trim()}`);
    const order = /## Ordering\n\n([\s\S]*?)(?=\n## )/.exec(txt);
    if (order) out.push(`\n## Ordering\n\n${order[1].trim()}`);
    // The Ordering section's own backtick sequence (e.g.
    // `B129 + B211 -> B146 -> B34`) is a deliberate build sequence — "+"
    // groups land in one PR, "->" means strictly after. Parsed here so the
    // "## Bugs" blocks below can be printed in THAT order, not ledger
    // (id-ascending) order, which has no relationship to it.
    const orderingLine = /## Ordering\n\n`([^`]+)`/.exec(txt);
    if (orderingLine)
      orderSequence = orderingLine[1]
        .split("->")
        .flatMap((g) => g.split("+"))
        .map((s) => s.trim().toUpperCase())
        .filter((s) => BUG_ID_RE.test(s));
  } else {
    out.push(
      `\n## Batch plan\n\n⚠ none yet — run the analysis pass before fixing (see the bug-registry skill).`,
    );
  }

  // Ids the sequence doesn't mention (or when there is no sequence at all)
  // keep their relative ledger order — Array#sort is stable, so this only
  // ever REORDERS what the sequence actually names.
  if (orderSequence) {
    const pos = new Map(orderSequence.map((id, i) => [id, i]));
    rows.sort((a, b) => (pos.get(a.id) ?? Infinity) - (pos.get(b.id) ?? Infinity));
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
    // A regressed row's `evidence` is the citation `reopen --why` demanded —
    // the failing REG-B### token or the run/deploy/report that showed the
    // regression. Print it here, not just buried in the History log, so a
    // builder re-fixing it starts from what actually broke.
    if (st?.state === "regressed" && st.evidence) out.push(`\n> ⚠️ **REGRESSED** — ${st.evidence}`);
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

// The ledger is SHARED (git-tracked, cloned onto every machine and CI
// runner), so a `--build-plan` value is only useful stored as a path relative
// to the repo root. An absolute path persists verbatim — leaking a local
// username/drive letter into a repo that goes public for CI — and resolves
// to nothing on any other checkout; a `../`-escaping relative path is the
// same problem one step removed. Reject both here, before the value ever
// reaches a shard, and persist the normalised, forward-slash form so the
// field reads the same on every OS.
function repoRelativeBuildPlan(raw) {
  if (isAbsolute(raw))
    fail(
      `--build-plan must be a path inside the repo, not absolute (got "${raw}") — the ledger is ` +
        `shared, and an absolute path resolves to nothing on any other machine`,
    );
  const resolved = resolve(REPO_ROOT, raw);
  const rel = relative(REPO_ROOT, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
    fail(
      `--build-plan ${raw} escapes the repo root — the ledger is shared, and a path outside the ` +
        `repo resolves to nothing on any other machine`,
    );
  return { resolved, rel: rel.split(sep).join("/") };
}

cmds.prove = (args) => {
  const typed = (args[0] ?? "").toUpperCase();
  const prRaw = flag(args, "pr");
  const proof = flag(args, "proof");
  const buildPlanRaw = flag(args, "build-plan");
  if (!BUG_ID_RE.test(typed) || !prRaw || !proof)
    fail(
      'usage: prove <B###> --pr <number> --proof "REG-B### <what the passing test asserts>" ' +
        "[--build-plan <path/to/build-plan.md>]   # required for a T3 row",
    );
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

  // The row read, the tier/build-plan ruling that depends on it, and the write
  // are ONE critical section: reading the row outside the lock is how a
  // concurrent prove of a sibling row used to be erased by this one's
  // `{ ...row }` spread of a stale shard.
  withShardLock(batch, () => {
    const row = readShard(batch).rows.find((r) => r.id === id);
    if (!row) fail(`${id} vanished from ${batch}.jsonl while this prove waited for the lock`);
    const pending = args.includes("--pending-deploy");
    const state = pending ? "proven-pending-deploy" : "proven";
    if (pending && row.tier !== "T2")
      fail("--pending-deploy is for T2 rows only (their proof cannot run pre-merge)");

    // campaign-check REQUIRES a `buildPlan` field on every T3 row before it can
    // discharge one (its proof is a manual-verification ROW in the batch's own
    // build-plan.md, never a test artifact) — and nothing wrote that field, so
    // a T3 prove used to land a claim campaign-check could never verify and no
    // command could repair. Refuse it here instead.
    let buildPlan = row.buildPlan ?? null;
    if (row.tier === "T3") {
      if (!buildPlanRaw)
        fail(
          `${id} is tier T3 — --build-plan <path/to/build-plan.md> is required, or campaign-check ` +
            `has no way to find its manual-verification row and this prove can never be discharged`,
        );
      const { resolved, rel } = repoRelativeBuildPlan(buildPlanRaw);
      if (!existsSync(resolved))
        fail(`--build-plan ${buildPlanRaw} does not exist (resolved to ${resolved})`);
      const text = readFileSync(resolved, "utf8");
      if (!hasManualVerificationRow(text, id))
        fail(
          `--build-plan ${buildPlanRaw} has no REG-${id} row in its "## Manual verification" ` +
            `section — campaign-check will look there and find nothing`,
        );
      buildPlan = rel;
    } else if (buildPlanRaw) {
      buildPlan = repoRelativeBuildPlan(buildPlanRaw).rel;
    }

    const reproving =
      ["proven", "proven-pending-deploy"].includes(row.state) &&
      (row.pr !== pr || row.proof !== proof);
    if (reproving)
      console.warn(
        `${id}: WARNING — overwriting an existing proof (was PR #${row.pr} · "${row.proof}") with PR #${pr}. The old proof is not otherwise kept.`,
      );

    const { what, row: after } = upsertLedgerRow(batch, { ...row, state, pr, proof, buildPlan });
    if (
      after?.state !== state ||
      after?.pr !== pr ||
      after?.proof !== proof ||
      (row.tier === "T3" && after?.buildPlan !== buildPlan)
    )
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
  });
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

  // The proven-row read, the per-row evidence checks and every write are ONE
  // critical section — a concurrent `prove` landing between the read and the
  // loop below would otherwise be spread back over by the stale `{ ...row }`.
  //
  // The catalogue lock wraps the shard lock (same one-way order as `file` and
  // `move`) for a reason that has nothing to do with the catalogue file
  // itself: the `seen` scan just below reads EVERY OTHER shard's
  // dischargeEvidence while holding only THIS batch's shard lock, so two
  // `discharge` calls on different batches never serialised against each
  // other — each could scan before the other's write landed, and both could
  // admit the same evidence string. The catalogue lock is the one mutex every
  // writer already takes, so holding it here makes discharge exclusive
  // repo-wide for the length of its own critical section too.
  withCatalogueLock(() =>
    withShardLock(batch, () => {
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
      // Normalized (trim, collapse whitespace, lowercase) with the SAME helper
      // campaign-check.mjs uses for its own byte-identical-evidence warning — a
      // trailing space or a case difference must not let this guard admit what
      // the gate would still flag.
      //
      // Scoped to the WHOLE ledger, not just this call: `discharge` is
      // per-batch, so seeding `seen` from only this invocation's rows let the
      // exact same string reused across TWO SEPARATE `discharge` calls (each
      // exit 0, neither refusing the other) sail straight through — and
      // campaign-check then had to call the second one "grandfathered" rather
      // than refuse it, because nothing here had ever seen it.
      const seen = new Map();
      if (existsSync(STATUS_DIR()))
        for (const f of readdirSync(STATUS_DIR()).filter((n) => n.endsWith(".jsonl")))
          for (const r of readShard(f.replace(/\.jsonl$/, "")).rows)
            if (r.dischargeEvidence) seen.set(normalizeEvidence(r.dischargeEvidence), r.id);
      for (const [id, text] of perRow) {
        const key = normalizeEvidence(text);
        const prior = seen.get(key);
        if (prior && prior !== id)
          fail(`${id} and ${prior} were given byte-identical evidence — cite each row's own run`);
        seen.set(key, id);
      }

      // Snapshot the shard as it stands right now — every refusal above has
      // already run, so nothing below this point is a validation failure —
      // and restore it whole on any throw. Without this, an IO failure
      // part-way through the loop (a record path replaced by a directory, a
      // full disk) left the batch HALF discharged: some rows `done`, the rest
      // still `proven`, with no rollback and a raw Node stack trace instead of
      // a `bugs:` message.
      const shardFile = shardPath(batch);
      const snapshot = readFileSync(shardFile, "utf8");
      // Records already WRITTEN before the failure are not this rollback's to
      // leave behind either — a record left at `state: done`/`closed: yes`,
      // with a permanent, self-deduplicating History line, for a discharge
      // that never happened is a fiction the shard rollback alone cannot
      // undo (readRecord/writeRecord never consult the shard). Captured
      // BEFORE each write, so a failure on THIS row's own writeRecord call
      // still has its pre-write snapshot to restore.
      const recordRestores = [];
      try {
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
          const rp = recordPath(row.id);
          recordRestores.push({
            path: rp,
            before: existsSync(rp) ? readFileSync(rp, "utf8") : null,
          });
          const rec = readRecord(row.id);
          if (rec)
            writeRecord(
              row.id,
              { ...rec.front, state: "done", closed: "yes" },
              appendEvent(
                rec.body,
                `state-done-${today()}`,
                "done",
                (own ?? evidence).slice(0, 200),
              ),
            );
        }
      } catch (e) {
        // Records BEFORE the shard: a caller reading a record mid-rollback
        // (an interleaved `show`) must never see a `done` record backed by a
        // shard that has already reverted to `proven` — the record is the
        // more visible artifact, so it goes back first.
        for (const { path: rp, before } of recordRestores) {
          try {
            if (before === null) rmSync(rp, { force: true });
            else writeFileSync(rp, before);
          } catch {
            /* best effort — the shard restore and the loud fail() below still fire */
          }
        }
        writeFileSync(shardFile, snapshot);
        fail(
          `discharge: ${batch} failed mid-batch and was rolled back to its pre-discharge state (${e.message})`,
        );
      }
      console.log(
        `${batch}: discharged ${ready.length} row(s) → done — ${ready.map((r) => r.id).join(", ")}`,
      );
      if (perRow.size)
        console.log(`  per-row evidence recorded for: ${[...perRow.keys()].join(", ")}`);
      console.log(`  verify: node scripts/campaign-check.mjs`);
    }),
  );
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
  if (!BUG_ID_RE.test(typed) || !why)
    fail(
      'usage: reopen <B###> --why "<the failing REG-B### token, or the run/report that showed it>"',
    );
  const id = resolveId(typed);
  const batch = findShardOf(id);
  if (!batch) fail(`${id} is in no ledger shard — nothing to reopen`);
  // Read the row, judge it, and erase its proof inside ONE hold — a proof is
  // exactly the thing a concurrent writer must not restore underneath us.
  withShardLock(batch, () => {
    const row = readShard(batch).rows.find((r) => r.id === id);
    if (!row) fail(`${id} vanished from ${batch}.jsonl while this reopen waited for the lock`);
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
  });
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
  // One hold over the read AND the loop, so two agents racing to claim the
  // same batch cannot both see it free and both write in-flight rows.
  withShardLock(batch, () => {
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
  });
};

cmds.release = (args) => {
  const batch = normBatch(args[0]);
  // One hold over the read AND the loop: a release that read a stale shard
  // would hand back rows a concurrent claim had just taken.
  withShardLock(batch, () => {
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
  });
};

// A record's own analysis routinely concludes a different tier than the
// ledger row it lives under (B32 designed 9 T1 jest cases while its ledger
// row still said T3, so that conclusion had no path into the gate). `tier`
// is that path — a first-class reconciliation, not a hand edit of the shard.
cmds.tier = (args) => {
  const typed = (args[0] ?? "").toUpperCase();
  const tier = (args[1] ?? "").toUpperCase();
  const why = flag(args, "why");
  if (!BUG_ID_RE.test(typed) || !["T1", "T2", "T3"].includes(tier) || !why)
    fail('usage: tier <B###> <T1|T2|T3> --why "<reason the analysis changed>"');
  const id = resolveId(typed);

  const batch = findShardOf(id);
  if (!batch) fail(`${id} is in no ledger shard — file it with a --batch first`);
  // The standing-tier comparison and the write are one critical section — an
  // early `return` below leaves the callback, and the lock, cleanly.
  withShardLock(batch, () => {
    const row = readShard(batch).rows.find((r) => r.id === id);
    if (!row) fail(`${id} vanished from ${batch}.jsonl while this re-tier waited for the lock`);
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
  });
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
    const statusIssue = boardIssue(board.batches?.[b]);
    console.log(
      `${b.padEnd(4)} ${String(done + "/" + rows.length).padStart(6)} done · ${String(analysed).padStart(2)} analysed · ` +
        `${statusIssue ? "#" + statusIssue : "  —  "}  ${Object.entries(by)
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
// Resolved from this file's own location (not process.argv[1], which is
// whatever relative/absolute form this process happened to be invoked with)
// so a self-test that temporarily process.chdir()s elsewhere — to drive a
// throwaway fixture git repo — still spawns the right script.
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const runCli = (argv, root) => {
  const cmd = [SCRIPT_PATH, ...argv].map((a) => JSON.stringify(a)).join(" ");
  try {
    return {
      code: 0,
      // `2>&1`: execSync's return value on a SUCCESSFUL exit is stdout only —
      // stderr is silently discarded even though it is piped — but some
      // writers (the sync anchor's --quiet-unconditional notes) deliberately
      // write to stderr on a clean exit, and a caller here needs to see it.
      // On failure both streams are already merged below (e.stdout+e.stderr).
      out: execSync(`node ${cmd} 2>&1`, {
        encoding: "utf8",
        // BUGS_SELF_TEST is what un-gates the stall seam in
        // upsertLedgerRowLocked; production runs never carry it.
        env: { ...process.env, BUGS_ROOT: root, BUGS_SELF_TEST: "1" },
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

    // When busy batches ALONE fill the cap, no candidate is ever assigned
    // wave 0 — `waves[0]` is a hole `Array.prototype.map` skips over, and
    // JSON.stringify then serialises it as `null` instead of `[]`.
    const busyFour = ["F10", "F11", "F12", "F13"];
    const wavesWithBusy = computeWaves(rankBatches(five), new Map(), 4, busyFour);
    check(
      "waves: wave 1 is [] (never a hole) when busy batches alone fill the cap",
      wavesWithBusy[0],
      [],
    );
    check(
      "waves: JSON.stringify agrees — no null where an empty wave belongs",
      JSON.parse(JSON.stringify({ waves: wavesWithBusy })).waves[0],
      [],
    );
  }

  // `next`'s text output only ever warned about the HEAD's claimCheck — the
  // rest of wave 1 was printed as "safe to run alongside it" with no warning
  // even when their own claim checks failed identically.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    const realLiveClaim = liveClaim;
    try {
      cmds.file([
        "alongside fixture A",
        "--location",
        "apps/api/src/self-test.ts",
        "--severity",
        "high",
        "--batch",
        "F01",
        "--tier",
        "T1",
      ]);
      cmds.file([
        "alongside fixture B",
        "--location",
        "apps/web/src/self-test.ts",
        "--severity",
        "high",
        "--batch",
        "F02",
        "--tier",
        "T1",
      ]);
      writeFileSync(BOARD(), JSON.stringify({ batches: { F01: 501, F02: 502 } }));
      liveClaim = () => ({ unknown: true, why: "network unreachable" });
      const shown = capture(() => cmds.next([]));
      check(
        "next: the alongside batch's own claimCheck is shown, not silently dropped",
        /F02[\s\S]*?⚠ claim check unavailable/.test(shown),
        true,
      );
    } finally {
      liveClaim = realLiveClaim;
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // `blocked`'s reason hardcoded "in-flight" even when the blocking batch was
  // held only by a REMOTE team.mjs lease — an operator who grepped the
  // ledger for a local in-flight row on that batch found none.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    const SHARED = "apps/web/app/(dashboard)/lease-occupancy/page.tsx";
    const realLiveClaim = liveClaim;
    try {
      for (const [title, batch] of [
        ["lease occupancy fixture A", "F01"],
        ["lease occupancy fixture B", "F02"],
      ])
        cmds.file([
          title,
          "--location",
          SHARED,
          "--severity",
          "high",
          "--batch",
          batch,
          "--tier",
          "T1",
          "--files",
          SHARED,
        ]);
      writeFileSync(BOARD(), JSON.stringify({ batches: { F01: 701, F02: 702 } }));
      liveClaim = (issue) =>
        issue === 701
          ? { id: "rf-remote", leaseUntil: new Date("2099-01-01T00:00:00.000Z") }
          : null;
      const { blocked, busy } = selectBatches([]);
      check("blocked reason: a remote lease is reported busy", busy, ["F01"]);
      check(
        "blocked reason: names the holder as LEASED, not in-flight, when held only by a remote lease",
        blocked.map((b) => b.why),
        [`blocked by leased F01 — shares ${SHARED}`],
      );
      const shown = capture(() => cmds.next([]));
      check(
        "blocked reason: `next` prints 'blocked by leased F01', not 'in-flight'",
        /F02\s+blocked by leased F01/.test(shown),
        true,
      );
    } finally {
      liveClaim = realLiveClaim;
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // The shared REG token grammar (scripts/campaign/reg-token.mjs) is the ONE
  // place `prove` and campaign-check both read now — they used to keep what a
  // comment called "a literal duplicate" that had actually drifted: `prove`
  // accepted REG-<id> at ANY digit count while campaign-check required
  // exactly 2-3 digits, so a single-digit id (B1..B9) could be proven but
  // could never be discharged — an unrepairable claim.
  {
    check(
      "reg-token: hasRegToken agrees across digit counts (B1, B12, B120, B1234)",
      ["B1", "B12", "B120", "B1234"].map((id) => hasRegToken(`REG-${id} passed`, id)),
      [true, true, true, true],
    );
    check(
      "reg-token: a token is never satisfied by a longer id sharing its prefix",
      hasRegToken("REG-B120 passed", "B12"),
      false,
    );
    check(
      "reg-token: manualVerificationIds ignores a token inside a fenced code block",
      [...manualVerificationIds("## Manual verification\n\n```\nREG-B120 do not use this\n```\n")],
      [],
    );
    check(
      "reg-token: manualVerificationIds ignores a bare prose mention outside any table row",
      [...manualVerificationIds("## Manual verification\n\nREG-B120 was the old token.\n")],
      [],
    );
    check(
      "reg-token: manualVerificationIds accepts a real table row",
      [...manualVerificationIds("## Manual verification\n\n| REG-B120 | click the thing |\n")],
      ["B120"],
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

  // `next --json` must be self-describing: a named head (not the whole wave
  // left for the caller to infer "index 0 is the head" from), plus the
  // cap/hubThreshold that produced the schedule — `waves --json` already
  // carries the latter, `next --json` did not.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    try {
      cmds.file([
        "next --json fixture",
        "--location",
        "apps/api/src/self-test.ts",
        "--severity",
        "low",
        "--batch",
        "F01",
        "--tier",
        "T1",
      ]);
      const out = capture(() => cmds.next(["--json", "--no-claims"]));
      const parsed = JSON.parse(out);
      check(
        "next --json: shape names the head, the schedule, and why anything was held back",
        Object.keys(parsed).sort(),
        [
          "alongside",
          "blocked",
          "busy",
          "cap",
          "eligible",
          "hubThreshold",
          "next",
          "parked",
          "skipped",
          "waves",
        ].sort(),
      );
      check("next --json: `next` names the head of wave 1", parsed.next?.batch, "F01");
      check("next --json: `alongside` is wave 1 minus the head", parsed.alongside, []);
      check(
        "next --json: cap/hubThreshold match the defaults waves --json exposes",
        parsed.cap,
        AGENT_CAP,
      );
    } finally {
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // liveClaim: a batch with NO board.json issue at all must be treated as
  // "unknown", never silently as "checked, and free" — the two used to
  // share the same `null` return, so such a batch was proposed with an
  // uncompletable `claim <issue#>` instruction. No network involved: `!issue`
  // returns synchronously before any gh call.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    try {
      cmds.file([
        "no-issue fixture",
        "--location",
        "apps/api/src/self-test.ts",
        "--severity",
        "low",
        "--batch",
        "F01",
        "--tier",
        "T1",
      ]);
      // No board.json at all — b.issue is undefined for every batch.
      const { waves, skipped } = selectBatches([]);
      const top = waves[0]?.[0];
      check(
        "liveClaim: a batch with no board issue is still offered, not silently skipped",
        top?.batch,
        "F01",
      );
      check(
        "liveClaim: the claimCheck message names the missing board card, not a generic failure",
        top?.claimCheck?.includes("no board card for F01"),
        true,
      );
      check(
        "liveClaim: it is never mistaken for a live claim (skipped list stays empty)",
        skipped.length,
        0,
      );
    } finally {
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ── liveClaim vs team.mjs: the same comments, the same verdict ───────────
  // This file re-implements team.mjs's claim grammar, and every point of
  // divergence went the DANGEROUS way. The three cases below are the ones the
  // verify pass constructed and drove against both readers; each asserts the
  // verdict team.mjs reaches, computed from the same fixture comments with no
  // network. `readClaims` is pure precisely so this can exist.
  {
    const LEASE = "2099-01-01T00:00:00.000Z";
    const marked = (body) => ({ body: `${TEAM_MARKER}\n${body}` });
    const unmarked = (body) => ({ body });
    const CLAIM = `claim: id=rf-F11 lease-until=${LEASE}`;

    // (5a) An UNMARKED protocol-looking comment. team.mjs filters it out before
    // parsing, so the issue is FREE — but one such comment used to read as a
    // live lease here and shut the whole dispatcher down for every batch.
    check(
      "liveClaim: an unmarked `claim:` comment is not a lease (team.mjs ignores it)",
      readClaims([unmarked(CLAIM)]),
      null,
    );

    // (5b-2a) A REAL marked lease, plus an UNMARKED release. team.mjs never
    // sees the release, so the lease still stands; this file used to free it and
    // hand out a batch `team.mjs claim` would refuse with "held by rf-F11".
    check(
      "liveClaim: an unmarked `release:` does NOT free a marked lease",
      readClaims([marked(CLAIM), unmarked("release: id=rf-F11")])?.id,
      "rf-F11",
    );

    // (5b-2b) The same lease, released by a marked comment whose release line is
    // INDENTED. team.mjs anchors `^release:` with /m and no `\s*`, so it does
    // not match; this file's `^\s*` did.
    check(
      "liveClaim: an INDENTED `release:` does NOT free a marked lease",
      readClaims([marked(CLAIM), marked("  release: id=rf-F11")])?.id,
      "rf-F11",
    );

    // The positive controls, so the three above cannot pass by refusing to read
    // anything at all.
    check(
      "liveClaim: a marked lease with no release IS live",
      readClaims([marked(CLAIM)])?.id,
      "rf-F11",
    );
    check(
      "liveClaim: a marked, unindented release DOES free it",
      readClaims([marked(CLAIM), marked("release: id=rf-F11")]),
      null,
    );
    check(
      "liveClaim: an expired lease is not live",
      readClaims([marked("claim: id=rf-F11 lease-until=2000-01-01T00:00:00.000Z")]),
      null,
    );
    // Prose is still surfaced for a human to judge — never treated as a lock.
    const informal = readClaims([unmarked("Claimed for planning, do not take F11")]);
    check("liveClaim: prose is reported as informal, not as a lease", informal?.informal, true);

    // PAGINATION. gh returns one page unless asked otherwise, and page 1 is the
    // OLDEST 100 comments — while a claim is by construction the NEWEST. A
    // lease posted as comment #101 was therefore invisible to BOTH readers, so
    // the batch was not busy, occupied no capacity, and every hard conflict it
    // carried was dropped. Fixture pages, no network.
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: 1000 + i,
      body: `${TEAM_MARKER}\nnote: routine chatter ${i}`,
    }));
    const page2 = [
      { id: 1100, body: `${TEAM_MARKER}\nclaim: id=rf-LONGLIVED lease-until=${LEASE}` },
    ];
    check(
      "pagination: page 1 alone — the pre-fix read — cannot see the lease at all",
      readClaims(page1),
      null,
    );
    check("pagination: the gh argv actually asks for every page", ghCommentsArgs(501), [
      "api",
      "--paginate",
      "--slurp",
      "repos/{owner}/{repo}/issues/501/comments?per_page=100",
    ]);
    check(
      "pagination: --paginate --slurp hands back an array of PAGES, flattened here",
      flattenCommentPages([page1, page2]).length,
      101,
    );
    check(
      "pagination: the lease posted as comment #101 IS live once the pages are joined",
      readClaims(flattenCommentPages([page1, page2]))?.id,
      "rf-LONGLIVED",
    );
    check(
      "pagination: flattening tolerates an already-flat payload and an empty one",
      [
        flattenCommentPages(page2).length,
        flattenCommentPages([]).length,
        flattenCommentPages(null).length,
      ],
      [1, 0, 0],
    );

    // LOWEST LIVE COMMENT ID WINS — team.mjs's documented compare-and-swap.
    // Fed in API order with the HIGHER id first, this file used to name the
    // wrong holder while team.mjs named the right one.
    const two = [
      { id: 2222, body: `${TEAM_MARKER}\nclaim: id=rf-HIGH lease-until=${LEASE}` },
      { id: 1111, body: `${TEAM_MARKER}\nclaim: id=rf-LOW lease-until=${LEASE}` },
    ];
    check(
      "two live claims: the LOWEST comment id wins, whatever the API order",
      readClaims(two)?.id,
      "rf-LOW",
    );
    check(
      "two live claims: reversing the input does not change the winner",
      readClaims([...two].reverse())?.id,
      "rf-LOW",
    );

    // The shared grammar is only shared if BOTH files still say it. There is
    // nothing to import — team.mjs is a CLI — so team.mjs's half is a source
    // grep for the load-bearing fragment. THIS file's half is NOT: grepping our
    // own source for the fragment is satisfied by the fragment literal on the
    // line below it, so removing --paginate from the real argv would leave the
    // check green. The local half is derived from the live value instead — the
    // argv the reader actually builds, and the winner readClaims actually
    // picks — which is the only half that can regress without the grep noticing.
    const teamSrc = readFileSync(join(dirname(SCRIPT_PATH), "..", "team", "team.mjs"), "utf8");
    const localArgv = ghCommentsArgs(1);
    for (const [what, fragment, hereHolds] of [
      [
        // The WHOLE expression, not just the array literal — a fragment of
        // '"--paginate", "--slurp"' alone is satisfied by a partial line and
        // does not cover the `.flat()` half at all: removing ONLY `.flat()`
        // from team.mjs (real regression, real mutation-probe) left the
        // narrower fragment matching and this whole grammar guard green,
        // while every lease over 100 comments became invisible to it —
        // `--paginate --slurp` hands back an ARRAY OF PAGES, and skipping the
        // flatten step means `.find`/`.sort` over live claims silently see
        // nothing past the first page's shape.
        "paginate the comment list AND flatten the resulting pages",
        '["--paginate", "--slurp"]) ?? []).flat()',
        () => localArgv.includes("--paginate") && localArgv.includes("--slurp"),
      ],
      [
        "ask for full pages",
        "per_page=100",
        () => localArgv.some((a) => a.includes("per_page=100")),
      ],
      [
        "take the lowest live comment id",
        ".sort((a, b) => a.commentId - b.commentId)",
        () => readClaims(two)?.id === "rf-LOW",
      ],
    ])
      check(
        `shared grammar: BOTH readers still ${what}`,
        [teamSrc.includes(fragment), hereHolds()],
        [true, true],
      );

    // Behavioural half of the same guard, independent of the source-grep
    // above: THIS file's own flattenCommentPages must actually flatten an
    // array of pages, so a mutation that broke the WHOLE reading path
    // (not just team.mjs's copy) cannot hide behind a source match alone.
    check(
      "shared grammar: flattenCommentPages actually flattens two fixture pages",
      flattenCommentPages([[{ id: 1, body: "x" }], [{ id: 2, body: "y" }]]).length,
      2,
    );
  }

  // ── wave occupancy ──────────────────────────────────────────────────────
  // Claiming a batch used to DELETE the constraints it carried. `computeWaves`
  // coloured only the candidate list, from which every in-flight/claimed batch
  // had already been removed, and the conflict graph treated an in-flight row
  // as closed — so after claiming F11, `deps` no longer reported F11<->F12 and
  // `next` cheerfully offered F12 to a second agent editing the same files.
  // The busy batch is now a pre-coloured occupant of wave 1: it holds a slot of
  // the cap, keeps its conflicts, and is never returned as a pick.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    const SHARED = "apps/web/app/(dashboard)/occupancy/page.tsx";
    try {
      for (const [title, batch] of [
        ["occupancy fixture A", "F01"],
        ["occupancy fixture B", "F02"],
      ])
        cmds.file([
          title,
          "--location",
          SHARED,
          "--severity",
          "high",
          "--batch",
          batch,
          "--tier",
          "T1",
          "--files",
          SHARED,
        ]);
      check(
        "occupancy fixture: the two batches hard-conflict before anything is claimed",
        [...(batchConflicts(HUB_DEFAULT).get("F01")?.keys() ?? [])],
        ["F02"],
      );

      cmds.claim(["F01"]);
      const { waves, skipped, blocked, busy } = selectBatches(["--no-claims"]);
      check(
        "occupancy: the claimed batch is reported busy, not merely skipped",
        [busy, skipped.map((s) => s.batch)],
        [["F01"], ["F01"]],
      );
      // THE assertion. Before the fix this was ["F02"] — the conflict F01
      // carried vanished with F01, and wave 1 offered F02 straight away.
      check(
        "occupancy: the conflicting batch is NOT in wave 1 while F01 is in flight",
        waves[0]?.map((b) => b.batch) ?? [],
        [],
      );
      check(
        "occupancy: it is scheduled for wave 2 instead of dropped",
        waves[1]?.map((b) => b.batch) ?? [],
        ["F02"],
      );
      check(
        "occupancy: the reason names the batch holding it back",
        blocked.map((b) => [b.batch, b.blockedBy, b.files]),
        [["F02", ["F01"], [SHARED]]],
      );
      const shown = capture(() => cmds.next(["--no-claims"]));
      check(
        "occupancy: `next` says 'blocked by in-flight F01' rather than staying silent",
        /F02\s+blocked by in-flight F01/.test(shown),
        true,
      );
      // The same defect from the reporting side: `deps` filtered to `queued`
      // only, so the pair disappeared from the conflict report at exactly the
      // moment someone needed to see it.
      const dep = capture(() => cmds.deps([]));
      check(
        "occupancy: `deps` still lists the F01 <-> F02 pair after the claim",
        dep.includes("F01 <-> F02"),
        true,
      );
    } finally {
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ── a hostile board.json reaches neither a shell nor the operator ───────
  // board.json is a checked-in file, but it is DATA: its issue values were
  // interpolated straight into an execSync template string (cmd.exe on win32),
  // so a crafted value executed a command whose output came back as the "JSON"
  // this file then failed to parse. Non-scalars were just as bad in the other
  // direction — `next` printed `(issue #[object Object])` above a claim
  // instruction nobody could run.
  {
    const HOSTILE = '501" & echo INJECTED-BY-BOARD-JSON & rem ';
    check(
      "board.json: a shell-metacharacter issue value is not an issue number",
      boardIssue(HOSTILE),
      null,
    );
    check(
      "board.json: a non-scalar is not an issue number (no [object Object])",
      [boardIssue({ issue: 501 }), boardIssue(["501"]), boardIssue(null), boardIssue(0)],
      [null, null, null, null],
    );
    check(
      "board.json: a plain positive integer still reads, whitespace and all",
      [boardIssue(501), boardIssue("501"), boardIssue(" 501 ")],
      [501, 501, 501],
    );
    check(
      "board.json: a leading-zero or signed value is refused rather than coerced",
      [boardIssue("0501"), boardIssue("-501"), boardIssue("501x"), boardIssue("#501")],
      [null, null, null, null],
    );

    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    try {
      cmds.file([
        "hostile board fixture",
        "--location",
        "apps/api/src/self-test.ts",
        "--severity",
        "low",
        "--batch",
        "F01",
        "--tier",
        "T1",
      ]);
      writeFileSync(BOARD(), JSON.stringify({ batches: { F01: HOSTILE } }));
      // The REAL CLI in a REAL child process: if the value reached a shell at
      // all, the injected `echo` would run before gh could fail.
      const shown = runCli(["next"], tmp);
      check("hostile board: `next` still exits 0", shown.code, 0);
      check(
        "hostile board: nothing was executed — the injected marker never appears",
        /INJECTED-BY-BOARD-JSON/.test(shown.out),
        false,
      );
      check(
        "hostile board: it is reported as a missing board card, the honest branch",
        /no board card for F01/.test(shown.out),
        true,
      );
      check(
        "hostile board: the claim instruction is a placeholder, not the hostile value",
        /claim it:\s+node scripts\/team\/team\.mjs claim <issue#>/.test(shown.out),
        true,
      );

      writeFileSync(BOARD(), JSON.stringify({ batches: { F01: { issue: 501 } } }));
      const objish = runCli(["next"], tmp);
      check(
        "hostile board: a non-scalar never prints as '(issue #[object Object])'",
        /\[object Object\]/.test(objish.out),
        false,
      );

      // `status` and `brief` used to read board.json RAW rather than through
      // boardIssue() — the exact same regression `next` was already fixed
      // for, just at two different call sites nobody had re-checked.
      writeFileSync(BOARD(), JSON.stringify({ batches: { F01: { n: 1 } } }));
      const briefOut = capture(() => cmds.brief(["F01"]));
      check(
        "board.json non-scalar: `brief` never prints '[object Object]'",
        briefOut.includes("[object Object]"),
        false,
      );
      const statusOut = capture(() => cmds.status(["F01"]));
      check(
        "board.json non-scalar: `status` never prints '[object Object]'",
        statusOut.includes("[object Object]"),
        false,
      );
      check(
        "board.json non-scalar: `status` falls back to the honest placeholder",
        statusOut.includes("  —  "),
        true,
      );
    } finally {
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ── the carve-out must not bypass occupancy ─────────────────────────────
  // The sensitive test used to run FIRST in selectBatches' loop and `continue`,
  // so a parked batch never reached the busy determination. A carve-out batch
  // that was in flight — or held under a live team.mjs lease — therefore
  // occupied no slot of the agent cap and had every hard conflict it carried
  // dropped from the colouring, and `next` handed the batch editing the SAME
  // non-hub file to a second agent. Parking is a LABEL now, not an exit.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    const SHARED = "apps/api/src/shared/totals.ts";
    const realLiveClaim = liveClaim;
    try {
      // F08's title trips the money carve-out; F09's does not. Both edit the
      // same non-hub file, so they hard-conflict.
      for (const [title, batch] of [
        ["carve-out fixture: invoice rounding", "F08"],
        ["adjacent fixture: same file, agent-safe", "F09"],
      ])
        cmds.file([
          title,
          "--location",
          SHARED,
          "--severity",
          "high",
          "--batch",
          batch,
          "--tier",
          "T1",
          "--files",
          SHARED,
        ]);
      writeFileSync(BOARD(), JSON.stringify({ batches: { F08: 601, F09: 602 } }));
      check(
        "carve-out occupancy fixture: F08 is parked and F09 is not",
        selectBatches(["--no-claims"]).parked.map((b) => b.batch),
        ["F08"],
      );
      check(
        "carve-out occupancy fixture: the two batches hard-conflict",
        [...(batchConflicts(HUB_DEFAULT).get("F08")?.keys() ?? [])],
        ["F09"],
      );

      // (i) the LOCAL path. The bypass needs F08 to be BOTH parked and in
      // flight, which is the ordinary state of a batch someone is part-way
      // through: claim it, then file another carve-out bug into it. Pre-fix,
      // the sensitive test hit `continue` before the in-flight test ever ran,
      // so busy came back EMPTY and `next` offered F09 outright.
      cmds.claim(["F08"]);
      cmds.file([
        "carve-out fixture: invoice rounding, second finding",
        "--location",
        SHARED,
        "--severity",
        "high",
        "--batch",
        "F08",
        "--tier",
        "T1",
        "--files",
        SHARED,
      ]);
      {
        const { waves, skipped, blocked, busy, parked } = selectBatches(["--no-claims"]);
        check(
          "carve-out occupancy: a parked batch that is in flight is BOTH parked and busy",
          [busy, parked.map((b) => b.batch), skipped.map((s) => s.batch)],
          [["F08"], ["F08"], ["F08"]],
        );
        check(
          "carve-out occupancy: F09 is NOT in wave 1 while the parked batch is in flight",
          waves[0]?.map((b) => b.batch) ?? [],
          [],
        );
        check(
          "carve-out occupancy: F09 is scheduled behind it, not dropped",
          waves[1]?.map((b) => b.batch) ?? [],
          ["F09"],
        );
        check(
          "carve-out occupancy: the reason names the parked batch holding it back",
          blocked.map((b) => [b.batch, b.blockedBy, b.files]),
          [["F09", ["F08"], [SHARED]]],
        );
        const shown = capture(() => cmds.next(["--no-claims"]));
        check(
          "carve-out occupancy: `next` does not offer F09 while F08 is in flight",
          /next agent-safe batch: F09/.test(shown),
          false,
        );
      }

      // (ii) the AUTHORITATIVE path: no local in-flight row at all, F08 held
      // only by a live team.mjs lease on its board card. Same conclusion.
      cmds.release(["F08"]);
      liveClaim = (issue) =>
        issue === 601
          ? { id: "rf-F08-owner", leaseUntil: new Date("2099-01-01T00:00:00.000Z") }
          : null;
      {
        const { waves, blocked, busy, parked } = selectBatches([]);
        check(
          "carve-out lease: a LEASED parked batch is busy, and still parked",
          [busy, parked.map((b) => b.batch)],
          [["F08"], ["F08"]],
        );
        check(
          "carve-out lease: F09 is NOT in wave 1 while the lease is live",
          waves[0]?.map((b) => b.batch) ?? [],
          [],
        );
        check(
          "carve-out lease: F09 keeps the conflict it inherited from the parked batch",
          blocked.map((b) => [b.batch, b.blockedBy]),
          [["F09", ["F08"]]],
        );
        const shown = capture(() => cmds.next([]));
        check(
          "carve-out lease: `next` does not offer F09 under a live lease on F08",
          /next agent-safe batch: F09/.test(shown),
          false,
        );
      }
      // A parked batch that is NOT busy must still never be offered, and must
      // not invent a blocker for its neighbour.
      liveClaim = () => null;
      {
        const { waves, busy } = selectBatches([]);
        check(
          "carve-out: an idle parked batch occupies nothing and blocks nothing",
          [busy, waves[0]?.map((b) => b.batch) ?? []],
          [[], ["F09"]],
        );
      }
    } finally {
      liveClaim = realLiveClaim;
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // brief must order its "## Bugs" blocks by discovery.md's own Ordering
  // line when one exists, not by ledger (id-ascending) order — the whole
  // point of the sequence is to tell a builder what to do FIRST.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const pipelineTmp = join(tmp, "pipeline");
    const prevRoot = process.env.BUGS_ROOT;
    const prevPipeline = process.env.BUGS_PIPELINE_DIR;
    process.env.BUGS_ROOT = tmp;
    process.env.BUGS_PIPELINE_DIR = pipelineTmp;
    try {
      // Filed in id order B1, B2, B3 — the Ordering below reverses that.
      for (const title of [
        "ordering fixture first",
        "ordering fixture second",
        "ordering fixture third",
      ])
        cmds.file([
          title,
          "--location",
          "apps/api/src/self-test.ts",
          "--severity",
          "low",
          "--batch",
          "F01",
          "--tier",
          "T1",
        ]);
      mkdirSync(join(pipelineTmp, "2026-01-01-F01-ordering-fixture"), { recursive: true });
      writeFileSync(
        join(pipelineTmp, "2026-01-01-F01-ordering-fixture", "discovery.md"),
        "## Verdict\n\nok\n\n## Ordering\n\n`B3 -> B2 + B1`\n\n## File conflicts\n\nnone\n",
      );
      const out = capture(() => cmds.brief(["F01"]));
      const positions = ["B1", "B2", "B3"].map((id) => out.indexOf(`### ${id} ·`));
      check(
        "brief: '## Bugs' blocks follow discovery.md's Ordering, not ledger id order",
        positions[2] < positions[1] && positions[1] < positions[0],
        true,
      );
    } finally {
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      if (prevPipeline === undefined) delete process.env.BUGS_PIPELINE_DIR;
      else process.env.BUGS_PIPELINE_DIR = prevPipeline;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // file: id allocation must consider ledger shards too, not just the
  // catalogue — a stale catalogue snapshot (the two-sessions-filing-at-once
  // case) used to hand out an id a shard already held, silently colliding.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    try {
      cmds.file(["first fixture", "--location", "apps/api/src/self-test.ts", "--severity", "low"]);
      // Simulate an id already reserved in a shard with NO catalogue row at
      // all — exactly the shape of a concurrent session's ledger write that
      // landed while this session's catalogue snapshot was already stale.
      upsertLedgerRow("F09", {
        id: "B2",
        batch: "F09",
        tier: "T1",
        state: "queued",
        pr: null,
        proof: null,
        evidence: null,
      });
      cmds.file(["second fixture", "--location", "apps/api/src/self-test.ts", "--severity", "low"]);
      check(
        "file: id allocation is the union of catalogue AND ledger shard ids",
        readCatalogue().find((r) => r.title === "second fixture")?.id,
        "B3",
      );
    } finally {
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // file: a genuine failure AFTER the catalogue write (not a validation
  // fail()) must restore the catalogue to its pre-write state, not leave a
  // dangling row with no record and no way back.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    try {
      const beforeRows = readCatalogue();
      check("file: starts from an empty catalogue", beforeRows.length, 0);
      // Force expand()'s writeRecord to throw a real exception: pre-create
      // the record PATH the next filed bug (B1) will land at, as a directory
      // rather than a file, so writeFileSync fails with EISDIR.
      mkdirSync(join(tmp, "bugs"), { recursive: true });
      mkdirSync(join(tmp, "bugs", "B1.md"));
      const attempt = runCli(
        [
          "file",
          "restore fixture",
          "--location",
          "apps/api/src/self-test.ts",
          "--severity",
          "low",
          "--batch",
          "F01",
          "--tier",
          "T1",
        ],
        tmp,
      );
      check(
        "file: a genuine post-catalogue-write failure exits non-zero",
        attempt.code !== 0,
        true,
      );
      check(
        "file: the catalogue is restored to its pre-write state on that failure",
        readCatalogue(),
        beforeRows,
      );
      // THE assertion: the ledger row `file` had just added (with --batch, it
      // always is one — mustBeNew:true guarantees it) must not survive as an
      // orphan. Before the fix, F01.jsonl kept a `{"id":"B1", ..., "state":
      // "queued"}` row here with no catalogue entry and no record.
      check(
        "file: the ledger row it just added is dropped too, not left as an orphan",
        readShard("F01").rows,
        [],
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

  // A subject carrying its OWN tab character must not truncate the scan —
  // `git log --format=%H%x09%s` is split on the FIRST tab only, not every
  // tab, or every id after the embedded tab becomes invisible.
  {
    const fixtureState = new Map([["B120", { id: "B120", batch: "F10" }]]);
    const tabbedLog = "dddddddddddd\tfix(routes): tabbed\tB120 theta\n";
    const { mentions: tabbed } = parseMentions(tabbedLog, fixtureState);
    check(
      "commit scan: a subject containing its own tab is not truncated at it",
      (tabbed.get("B120") ?? []).map((h) => h.sha),
      ["dddddddd"],
    );
  }

  // A commit subject carrying a literal HTML comment must not pre-occupy (or
  // corrupt) a History dedupe marker — appendHistory strips `<!--`/`-->` from
  // caller text before it ever becomes part of the body.
  {
    const poisoned = appendHistory(
      "\n## History\n",
      "commit-deadbee1",
      "commit",
      "poison <!--commit-deadbee1--> here",
    );
    check(
      "appendHistory: strips comment delimiters from caller text (marker injection)",
      poisoned.includes("<!--commit-deadbee1-->") &&
        (poisoned.match(/<!--commit-deadbee1-->/g) ?? []).length === 1,
      true,
    );
    // A later, GENUINE event for that same sha must still be able to land —
    // proof the poisoned text did not pre-occupy the marker a second time.
    const genuine = appendHistory(
      poisoned,
      "commit-deadbee1",
      "commit",
      "the real deadbee1 commit",
    );
    check(
      "appendHistory: a poisoned subject does not swallow the genuine marker",
      genuine === poisoned,
      true, // same key, so this IS the dedupe firing correctly — not a false negative
    );
  }

  // --rescan after a hand-stripped marker (the visible line survives, only
  // its <!--marker--> comment is gone) must heal — recognise the identical
  // marker-less line and skip it — rather than append a visible duplicate.
  {
    const original = appendHistory(
      "\n## History\n",
      "commit-5ca25cbb",
      "commit",
      "`5ca25cbb` a fix",
    );
    const handStripped = original.replace(" <!--commit-5ca25cbb-->", "");
    const rescanned = appendHistory(handStripped, "commit-5ca25cbb", "commit", "`5ca25cbb` a fix");
    check(
      "appendHistory: a hand-stripped marker heals instead of doubling the visible line",
      (rescanned.match(/a fix/g) ?? []).length,
      1,
    );
  }

  // `commitMentions`'s "no scan" note truncates a REAL sha to 8 chars but
  // must NOT truncate its literal fallback "the window" into "the wind".
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevAnchor = process.env.BUGS_SYNC_STATE;
    process.env.BUGS_SYNC_STATE = join(tmp, "sync-state.json");
    try {
      // --rescan forces the bounded-window branch (anchored = null)
      // regardless of any prior anchor state.
      const { note } = commitMentions(new Map(), ["--rescan"]);
      check(
        'commit scan: the literal fallback reads "the window", never "the wind"',
        note?.includes("the window"),
        true,
      );
    } finally {
      if (prevAnchor === undefined) delete process.env.BUGS_SYNC_STATE;
      else process.env.BUGS_SYNC_STATE = prevAnchor;
      rmSync(tmp, { recursive: true, force: true });
    }
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

  // The anchor must not advance until every record in this run has actually
  // been written. A mid-run crash (a corrupted record dying partway through
  // the per-bug loop) must leave the anchor at its PRE-scan position, so the
  // next run re-scans — and this time records — the same range instead of
  // silently skipping it forever. Drives a THROWAWAY git repo (never the
  // real one) so this can create real commits without side effects.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const campaignRoot = join(tmp, "campaign-fixture");
    const prevCwd = process.cwd();
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = campaignRoot;
    try {
      execSync("git init -q", { cwd: tmp });
      execSync('git config user.email "self-test@routeflow.local"', { cwd: tmp });
      execSync('git config user.name "Self Test"', { cwd: tmp });
      writeFileSync(join(tmp, "seed.txt"), "seed\n");
      execSync("git add seed.txt", { cwd: tmp });
      execSync('git commit -q -m "initial"', { cwd: tmp });

      writeCatalogue([
        {
          id: "B1",
          title: "anchor fixture — the one that gets corrupted",
          location: "apps/api/src/self-test.ts",
          severity: "low",
          register: "open",
          batch: "F01",
          source: "filed",
          filedAt: null,
          sensitive: false,
          sensitiveFor: [],
        },
        {
          id: "B2",
          title: "anchor fixture — carries the commit event",
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

      // commitMentions' own `git` calls use the PROCESS cwd — chdir for the
      // duration of the sync calls below, restored in `finally`.
      process.chdir(tmp);

      // First sync: no anchor exists yet, so the "first run" branch fires
      // and persists synchronously — nothing is scanned, so there is no loop
      // for it to race against.
      cmds.sync(["--quiet"]);
      const anchor0 = readSyncState().lastSha;
      check("anchor-after-success: the first run anchors at HEAD", typeof anchor0, "string");

      // A new commit lands mentioning B2 — the event that must survive a
      // crash later in the SAME sync run.
      writeFileSync(join(tmp, "seed.txt"), "seed 2\n");
      execSync("git add seed.txt", { cwd: tmp });
      execSync('git commit -q -m "fix(routes): B2 gamma event that must not be lost"', {
        cwd: tmp,
      });

      // Corrupt B1's record so the per-bug loop dies while processing it —
      // B1 sorts before B2, so B2's event is never reached this run.
      writeFileSync(recordPath("B1"), "---\nnot valid front matter at all\n");

      const dying = runCli(["sync", "--quiet"], campaignRoot);
      check(
        "anchor-after-success: a corrupted record makes sync die non-zero",
        dying.code !== 0,
        true,
      );
      check(
        "anchor-after-success: the anchor did NOT advance past the crash",
        readSyncState().lastSha,
        anchor0,
      );

      // Repair B1 and re-run — the anchor is unchanged, so the SAME range is
      // scanned again and B2's event is recovered, not lost.
      writeRecord(
        "B1",
        { id: "B1", title: "anchor fixture — the one that gets corrupted" },
        "\n## History\n",
      );
      cmds.sync(["--quiet"]);
      check(
        "anchor-after-success: the next run recovers the event the crash did not lose",
        readRecord("B2").body.includes("gamma event"),
        true,
      );
      check(
        "anchor-after-success: the anchor now advances, past the fully-completed run",
        readSyncState().lastSha !== anchor0,
        true,
      );
    } finally {
      process.chdir(prevCwd);
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // --quiet must not swallow the two "an unscanned range" notes — Gate 4 is
  // the ONLY place sync ever runs unattended, and it always passes --quiet,
  // so a lost/unknown anchor used to drop the whole range with ZERO output
  // there, looking perfectly healthy.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    try {
      // First run: no anchor exists yet — the "not re-derived" note.
      const first = runCli(["sync", "--quiet"], tmp);
      check(
        "sync --quiet: the first-run 'not re-derived' note still reaches stderr",
        /not re-derived/.test(first.out),
        true,
      );

      // An anchor git has never seen (rebased away, a foreign clone) — the
      // "re-anchored, no scan" note.
      mkdirSync(tmp, { recursive: true });
      writeFileSync(
        join(tmp, "sync-state.json"),
        JSON.stringify({ lastSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }),
      );
      const unknownAnchor = runCli(["sync", "--quiet"], tmp);
      check(
        "sync --quiet: the 're-anchored, no scan' note still reaches stderr",
        /no scan/.test(unknownAnchor.out),
        true,
      );
    } finally {
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
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

  // A ledger-only front-matter field with no representation in the header
  // line or History (tier) must still reach the record — sync used to gate
  // its write on `body !== before` alone, so a tier move landed in the
  // ledger and never in the record at all.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    try {
      cmds.file([
        "tier drift fixture",
        "--location",
        "apps/api/src/self-test.ts",
        "--severity",
        "low",
        "--batch",
        "F01",
        "--tier",
        "T1",
      ]);
      check("tier drift fixture: starts at T1", readRecord("B1").front.tier, "T1");
      upsertLedgerRow("F01", { ...readShard("F01").rows[0], tier: "T3" });
      cmds.sync(["--quiet"]);
      check(
        "sync: a tier-only ledger change reaches the record (front-matter drift, not body drift)",
        readRecord("B1").front.tier,
        "T3",
      );
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

  // A ledger row with no catalogue row at all is an ORPHAN — invisible to
  // `list`/`stats`/`next` and every gate — which is exactly what a
  // half-rolled-back `file` failure used to leave behind (the catalogue was
  // restored, the freshly-added ledger row was not).
  {
    const catalogueIds = new Set(readCatalogue().map((r) => r.id));
    const orphans = [];
    for (const f of readdirSync(STATUS_DIR()).filter((n) => n.endsWith(".jsonl")))
      for (const r of readShard(f.replace(/\.jsonl$/, "")).rows)
        if (!catalogueIds.has(r.id)) orphans.push(r.id);
    check("every ledger row has a matching catalogue row (no orphans)", orphans, []);
  }

  // The catalogue must never describe a different bug than its own ledger
  // row or record — `file` used to write the catalogue BEFORE the ledger
  // upsert that could fail(), so a refused concurrent write could leave a
  // catalogue row naming one session's title/batch while the ledger row (and
  // the record) belonged to another.
  {
    const state = readState();
    const drift = [];
    for (const b of readCatalogue()) {
      const st = state.get(b.id);
      if (st && st.batch !== b.batch)
        drift.push(`${b.id}: catalogue batch "${b.batch}" != ledger batch "${st.batch}"`);
      const rec = readRecord(b.id);
      if (rec && rec.front.title !== b.title)
        drift.push(`${b.id}: catalogue title "${b.title}" != record title "${rec.front.title}"`);
    }
    check("catalogue/ledger/record agree on batch and title for every row", drift, []);
  }

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

  // `discharge` must be atomic across its row loop: an IO failure part-way
  // through used to leave half the batch `done` and half still `proven`,
  // with no rollback, and exit with a raw Node stack trace instead of a
  // `bugs:` message. Force the SECOND row's own record read to throw by
  // replacing its record path with a directory.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    try {
      cmds.file([
        "atomic discharge fixture A",
        "--location",
        "apps/api/src/self-test.ts",
        "--severity",
        "low",
        "--batch",
        "F01",
        "--tier",
        "T1",
      ]);
      cmds.file([
        "atomic discharge fixture B",
        "--location",
        "apps/api/src/self-test.ts",
        "--severity",
        "low",
        "--batch",
        "F01",
        "--tier",
        "T1",
      ]);
      cmds.prove(["B1", "--pr", "910", "--proof", "REG-B1 jest: fixture A"]);
      cmds.prove(["B2", "--pr", "910", "--proof", "REG-B2 jest: fixture B"]);
      const before = readShard("F01").rows.map((r) => ({ id: r.id, state: r.state }));

      rmSync(recordPath("B2"), { recursive: true, force: true });
      mkdirSync(recordPath("B2"));

      const attempt = runCli(
        [
          "discharge",
          "F01",
          "--evidence",
          "Railway deploy 1234abcd SUCCESS; Actions run 999 green against it",
        ],
        tmp,
      );
      check("discharge: an IO failure mid-batch exits non-zero", attempt.code !== 0, true);
      check(
        "discharge: the failure prints a bugs: message, never a raw stack trace",
        [/^bugs: /m.test(attempt.out), /\bat .*\.m?js:\d+:\d+/.test(attempt.out)],
        [true, false],
      );
      check(
        "discharge: the shard is rolled back whole, not left half-done",
        readShard("F01").rows.map((r) => ({ id: r.id, state: r.state })),
        before,
      );
    } finally {
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // The CLI entry point must never let a genuinely UNANTICIPATED exception
  // (one `fail()` never saw coming) surface as a raw Node stack trace — this
  // is a CLI a hook shells out to. A malformed catalogue line throws a real
  // SyntaxError straight out of readCatalogue's unguarded JSON.parse, which
  // nothing downstream of it catches.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    try {
      mkdirSync(tmp, { recursive: true });
      writeFileSync(join(tmp, "bugs.jsonl"), "not json at all\n");
      const attempt = runCli(["list"], tmp);
      check(
        "unexpected failure: a genuinely unanticipated exception exits non-zero",
        attempt.code !== 0,
        true,
      );
      check(
        "unexpected failure: prints ONE 'bugs: unexpected failure in <cmd> —' line, never a stack trace",
        [
          /^bugs: unexpected failure in list —/m.test(attempt.out),
          /\bat .*\.m?js:\d+:\d+/.test(attempt.out),
        ],
        [true, false],
      );
    } finally {
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

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

  // discharge's rollback used to restore the SHARD only — a record already
  // written before a mid-batch failure kept `state: done`/`closed: yes` and a
  // permanent History line for a discharge that never happened, while the
  // shard (and the CLI's own message) claimed a full rollback. A read-only
  // record forces writeRecord to throw on the SECOND row, after the first
  // row's record has already been written — exactly the ordering that used
  // to leave one record correctly rolled back (never touched) and the other
  // permanently wrong (touched, then abandoned).
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    let lockedRecordPath = null;
    try {
      for (const title of ["rollback fixture A", "rollback fixture B", "rollback fixture C"])
        cmds.file([
          title,
          "--location",
          "apps/api/src/rollback-fixture.ts",
          "--severity",
          "low",
          "--batch",
          "F01",
          "--tier",
          "T1",
        ]);
      cmds.prove(["B1", "--pr", "970", "--proof", "REG-B1 jest: rollback fixture A"]);
      cmds.prove(["B2", "--pr", "971", "--proof", "REG-B2 jest: rollback fixture B"]);
      cmds.prove(["B3", "--pr", "972", "--proof", "REG-B3 jest: rollback fixture C"]);
      check(
        "rollback fixture: all three rows proven",
        readShard("F01").rows.map((r) => r.state),
        ["proven", "proven", "proven"],
      );

      const shardBefore = readFileSync(shardPath("F01"), "utf8");
      const recordsBefore = new Map(
        ["B1", "B2", "B3"].map((id) => [id, readFileSync(recordPath(id), "utf8")]),
      );

      // `ready` (built from readShard's row order, which is FILE order —
      // append order here) processes B1 before B2 — make B2's record
      // read-only so the failure lands strictly AFTER B1's record has
      // already been written, and strictly BEFORE B3's ever is.
      lockedRecordPath = recordPath("B2");
      chmodSync(lockedRecordPath, 0o444);

      const result = runCli(
        ["discharge", "F01", "--evidence", "rolled-back discharge fixture run, well over 40 chars"],
        tmp,
      );
      check("rollback: discharge fails loudly on the read-only record", result.code !== 0, true);

      const shardAfter = readFileSync(shardPath("F01"), "utf8");
      check("rollback: the shard is byte-identical to before the attempt", shardAfter, shardBefore);
      for (const id of ["B1", "B2", "B3"])
        check(
          `rollback: ${id}'s record is byte-identical to before the attempt`,
          readFileSync(recordPath(id), "utf8"),
          recordsBefore.get(id),
        );
      check(
        "rollback: every row is still `proven`, none stuck at `done` from the abandoned attempt",
        readShard("F01").rows.map((r) => r.state),
        ["proven", "proven", "proven"],
      );
    } finally {
      if (lockedRecordPath) {
        try {
          chmodSync(lockedRecordPath, 0o644);
        } catch {
          /* best effort — the rmSync below still cleans up the whole tmp tree */
        }
      }
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // discharge's identical-evidence guard must be normalized (trim, collapse
  // whitespace, lowercase) the SAME way campaign-check.mjs's own warning is —
  // a trailing space or a case difference must not let this guard admit two
  // rows' evidence as distinct when the gate would still see them as one.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    try {
      cmds.file([
        "T2 normalisation fixture A",
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
        "T2 normalisation fixture B",
        "--location",
        "apps/web/e2e/self-test.spec.ts",
        "--severity",
        "low",
        "--batch",
        "F01",
        "--tier",
        "T2",
      ]);
      cmds.prove(["B1", "--pr", "610", "--proof", "REG-B1 e2e: fixture A"]);
      cmds.prove(["B2", "--pr", "610", "--proof", "REG-B2 e2e: fixture B"]);

      const evA = "Actions run 999 job 42: spec 28 REG-B1 passed against deploy 1234abcd";
      const evB = `  ${evA.toUpperCase()}  `; // same text: differs only by case + surrounding space
      const attempt = runCli(
        [
          "discharge",
          "F01",
          "--evidence",
          "Railway deploy 1234abcd SUCCESS; Actions run 999 E2E green against it",
          "--evidence-B1",
          evA,
          "--evidence-B2",
          evB,
        ],
        tmp,
      );
      check(
        "discharge: refuses two rows given evidence differing only by case/whitespace",
        attempt.code !== 0,
        true,
      );
      check(
        "discharge: the refusal wrote nothing",
        readShard("F01").rows.map((r) => r.state),
        ["proven", "proven"],
      );
    } finally {
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // The byte-identical-evidence guard must be scoped to the WHOLE ledger, not
  // just one call — `discharge` is per-batch, so a string reused across TWO
  // SEPARATE discharge calls (a second batch, a later session) used to sail
  // through both, and campaign-check then had to call the second one
  // "grandfathered" instead of refusing it outright.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    const EV = "Actions run 999 job 42: spec 28 REG-B1 passed against deploy 1234abcd";
    try {
      cmds.file([
        "T2 cross-batch fixture A",
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
        "T2 cross-batch fixture B",
        "--location",
        "apps/web/e2e/self-test.spec.ts",
        "--severity",
        "low",
        "--batch",
        "F02",
        "--tier",
        "T2",
      ]);
      cmds.prove(["B1", "--pr", "620", "--proof", "REG-B1 e2e: fixture A"]);
      cmds.prove(["B2", "--pr", "620", "--proof", "REG-B2 e2e: fixture B"]);
      cmds.discharge([
        "F01",
        "--evidence",
        "Railway deploy 1234abcd SUCCESS; Actions run 999 green against it",
        "--evidence-B1",
        EV,
      ]);
      const cross = runCli(
        [
          "discharge",
          "F02",
          "--evidence",
          "Railway deploy 1234abcd SUCCESS; Actions run 999 green against it",
          "--evidence-B2",
          EV,
        ],
        tmp,
      );
      check(
        "discharge: refuses evidence reused across a SEPARATE batch's discharge call",
        cross.code !== 0,
        true,
      );
      check(
        "discharge: the cross-batch refusal wrote nothing to F02",
        readShard("F02").rows[0].state,
        "proven",
      );
    } finally {
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // T3 rows: `prove` must require and validate a `--build-plan` naming a real
  // file whose "## Manual verification" section carries this exact REG-B###
  // token — without it campaign-check can never discharge the row (no writer
  // exists for the `buildPlan` field it needs) and `npm run verify` goes red
  // repo-wide the first time such a row is proven.
  //
  // The plan file itself lives INSIDE the repo (not the throwaway BUGS_ROOT):
  // --build-plan is validated against REPO_ROOT, this script's own fixed
  // location, never the ledger override — so a real relative path is the only
  // way to prove the acceptance case, and an absolute path (even one inside
  // the repo) or a `../`-escaping one must be refused before either resolves.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    const relPlanPath = ".claude/campaign/self-test-buildplan/plan.md";
    const planDir = join(REPO_ROOT, ".claude", "campaign", "self-test-buildplan");
    const planPath = join(REPO_ROOT, ...relPlanPath.split("/"));
    mkdirSync(planDir, { recursive: true });
    try {
      cmds.file([
        "T3 build-plan fixture",
        "--location",
        "apps/api/src/self-test.ts",
        "--severity",
        "low",
        "--batch",
        "F01",
        "--tier",
        "T3",
      ]);

      const noPlan = runCli(
        ["prove", "B1", "--pr", "701", "--proof", "REG-B1 manual verification row"],
        tmp,
      );
      check("prove: refuses a T3 row with no --build-plan", noPlan.code !== 0, true);
      check("prove: the refusal wrote nothing", readShard("F01").rows[0].state, "queued");

      // Absolute — even a REAL file inside the repo must be refused: the
      // field is persisted verbatim, so an absolute path leaks a local
      // machine's username/drive letter into a repo that goes public for CI,
      // and resolves to nothing on any other checkout.
      writeFileSync(planPath, "## Manual verification\n\n| REG-B1 | verified by hand |\n");
      const absolute = runCli(
        [
          "prove",
          "B1",
          "--pr",
          "701",
          "--proof",
          "REG-B1 manual verification row",
          "--build-plan",
          planPath,
        ],
        tmp,
      );
      check("prove: refuses an absolute --build-plan path", absolute.code !== 0, true);
      check(
        "prove: the absolute-path refusal wrote nothing",
        readShard("F01").rows[0].state,
        "queued",
      );

      // ../-escape — relative, but outside the repo root.
      const escaping = runCli(
        [
          "prove",
          "B1",
          "--pr",
          "701",
          "--proof",
          "REG-B1 manual verification row",
          "--build-plan",
          "../outside/build-plan.md",
        ],
        tmp,
      );
      check(
        "prove: refuses a --build-plan path that escapes the repo root",
        escaping.code !== 0,
        true,
      );

      // A valid repo-relative path, wrong token first (proves the RESOLUTION
      // itself is not just skipped), then the real one.
      writeFileSync(planPath, "## Manual verification\n\n| REG-B999 | ok |\n");
      const wrongToken = runCli(
        [
          "prove",
          "B1",
          "--pr",
          "701",
          "--proof",
          "REG-B1 manual verification row",
          "--build-plan",
          relPlanPath,
        ],
        tmp,
      );
      check("prove: refuses a build-plan with no REG-B1 row in it", wrongToken.code !== 0, true);

      writeFileSync(planPath, "## Manual verification\n\n| REG-B1 | verified by hand |\n");
      cmds.prove([
        "B1",
        "--pr",
        "701",
        "--proof",
        "REG-B1 manual verification row",
        "--build-plan",
        relPlanPath,
      ]);
      const row = readShard("F01").rows[0];
      check("prove: a valid T3 build-plan lands the row as proven", row.state, "proven");
      check(
        "prove: the ledger row persists the normalised repo-relative POSIX path",
        row.buildPlan,
        relPlanPath,
      );
    } finally {
      rmSync(planDir, { recursive: true, force: true });
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

  // `brief` must surface a regressed row: the header counts WORKABLE rows
  // (queued + regressed), not just queued — a batch holding only a
  // regressed row used to read "0 queued", hiding open work — and the
  // reopen citation must reach the per-bug block, not stay buried in History.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    try {
      cmds.file([
        "regressed fixture",
        "--location",
        "apps/api/src/self-test.ts",
        "--severity",
        "low",
        "--batch",
        "F01",
        "--tier",
        "T1",
      ]);
      cmds.prove(["B1", "--pr", "800", "--proof", "REG-B1 jest: the guard holds"]);
      cmds.discharge([
        "F01",
        "--evidence",
        "Railway deploy 1234abcd SUCCESS; Actions run 999 green against it",
      ]);
      cmds.reopen([
        "B1",
        "--why",
        "REG-B1 failed in Actions run 33557237968 against deploy 1234abcd",
      ]);
      const out = capture(() => cmds.brief(["F01"]));
      check(
        "brief: the header counts workable rows, not just queued (0 queued would hide this)",
        out.includes("1 workable (1 regressed)"),
        true,
      );
      check("brief: a batch-level REGRESSED banner is shown", out.includes("REGRESSED"), true);
      check(
        "brief: the reopen citation reaches the bug's own block",
        out.includes("Actions run 33557237968"),
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
        "reopen: writeRecord refreshes the header line itself — no stale " +
          "'State done' surviving until the next sync",
        readRecord("B1").body.includes("**State** regressed"),
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

  // move: a legitimate move must still land (positive path), and a refused
  // move (a genuine duplicate elsewhere) must NEVER have dropped the
  // authoritative row first — the ordering bug this guards against destroyed
  // the source row before the refusal was even reported.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    try {
      cmds.file([
        "move fixture",
        "--location",
        "apps/api/src/self-test.ts",
        "--severity",
        "low",
        "--batch",
        "F01",
        "--tier",
        "T1",
      ]);
      cmds.move(["B1", "--to", "F02", "--why", "self-test positive path"]);
      check("move: the row lands in the destination shard", readShard("F02").rows[0]?.id, "B1");
      check("move: the source shard is empty", readShard("F01").rows.length, 0);
      check("move: the catalogue follows", readCatalogue().find((r) => r.id === "B1").batch, "F02");
      check(
        "move: the record carries the re-batched event",
        readRecord("B1").body.includes("**re-batched**"),
        true,
      );

      // Plant a duplicate in a THIRD shard (neither source nor target) — a
      // check that only asks `findShardOf(id) === from` would still pass,
      // since `from` (F02) is a real hit too; the fix must scan every shard.
      const dup = { ...readShard("F02").rows[0], batch: "F13" };
      writeFileSync(shardPath("F13"), JSON.stringify(dup) + "\n");

      const attempt = runCli(["move", "B1", "--to", "F20"], tmp);
      check("move: refuses when a duplicate exists in another shard", attempt.code !== 0, true);
      check(
        "move: the source row survives the refusal (no destructive write happened)",
        readShard("F02").rows.map((r) => r.id),
        ["B1"],
      );
      check("move: nothing was written to the target", readShard("F20").rows.length, 0);
      check("move: the interloper duplicate is untouched", readShard("F13").rows.length, 1);
    } finally {
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ── the shard lock ──────────────────────────────────────────────────────
  // THE regression this exists for: two sub-agents proving DIFFERENT rows of
  // one F##.jsonl at the same time. Both read the shard, both write their own
  // copy back, and the second erases the first — a proven, evidence-backed row
  // silently reverted to `queued` with both gates still green, because every
  // write path asserts its OWN row landed and none looks at the rest of the file.
  //
  // Driven through the REAL CLI in two REAL child processes (an in-process
  // simulation would share this process's re-entrant hold and prove nothing),
  // overlapped deterministically by BUGS_TEST_STALL_MS rather than by luck.
  // `Promise.all` lives in a small orchestrator script because this self-test
  // is synchronous.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    try {
      for (const [title, loc] of [
        ["concurrent writer A", "apps/api/src/conc-a.ts"],
        ["concurrent writer B", "apps/api/src/conc-b.ts"],
        ["slow holder", "apps/api/src/conc-slow.ts"],
        ["slow waiter", "apps/api/src/conc-wait.ts"],
        ["killed mid-write", "apps/api/src/conc-killed.ts"],
        ["lock stolen mid-write", "apps/api/src/conc-stolen.ts"],
        ["signal handler probe", "apps/api/src/conc-signal.ts"],
        ["interrupted mid-write", "apps/api/src/conc-sigint.ts"],
      ])
        cmds.file([
          title,
          "--location",
          loc,
          "--severity",
          "low",
          "--batch",
          "F01",
          "--tier",
          "T1",
        ]);
      check(
        "lock fixture: the rows this suite races over share one shard",
        readShard("F01").rows.map((r) => r.id),
        ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8"],
      );

      // The spec is passed as a FILE, never as a shell argument: execSync goes
      // through cmd.exe on win32, which does not understand the backslash
      // escaping JSON needs inside a quoted argument.
      const specPath = join(tmp, "race-spec.json");
      const orchestrator = join(tmp, "concurrent-prove.mjs");
      writeFileSync(
        orchestrator,
        [
          'import { spawn } from "node:child_process";',
          'import { readFileSync } from "node:fs";',
          "const [script, root, spec] = process.argv.slice(2);",
          'const jobs = JSON.parse(readFileSync(spec, "utf8"));',
          "const run = (job) =>",
          "  new Promise((res) => {",
          "    const start = () => {",
          "      const p = spawn(process.execPath, [script, ...job.args], {",
          "        env: {",
          "          ...process.env,",
          "          BUGS_ROOT: root,",
          '          BUGS_SELF_TEST: "1",',
          "          BUGS_TEST_STALL_MS: String(job.stall),",
          "        },",
          '        stdio: ["ignore", "pipe", "pipe"],',
          "      });",
          '      let out = "";',
          '      p.stdout.on("data", (d) => (out += d));',
          '      p.stderr.on("data", (d) => (out += d));',
          '      p.on("close", (code) => res({ code, out }));',
          "    };",
          "    if (job.delay) setTimeout(start, job.delay);",
          "    else start();",
          "  });",
          "const results = await Promise.all(jobs.map(run));",
          "console.log(JSON.stringify(results));",
        ].join("\n"),
      );
      const race = (jobs) => {
        writeFileSync(specPath, JSON.stringify(jobs));
        const argv = [orchestrator, SCRIPT_PATH, tmp, specPath]
          .map((a) => JSON.stringify(a))
          .join(" ");
        try {
          return {
            code: 0,
            out: execSync(`node ${argv}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
          };
        } catch (e) {
          return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
        }
      };
      const proveArgs = (id, pr) => [
        "prove",
        id,
        "--pr",
        String(pr),
        "--proof",
        `REG-${id} jest: writer ${id} asserts its own row`,
      ];

      const raced = race([
        { args: proveArgs("B1", 701), stall: 300 },
        { args: proveArgs("B2", 702), stall: 300 },
      ]);
      check("concurrent prove: the orchestrator exited 0", raced.code, 0);
      const children = JSON.parse(raced.out.trim().split("\n").pop());
      check(
        "concurrent prove: BOTH child processes exited 0",
        children.map((c) => c.code),
        [0, 0],
      );
      // The assertion the lock exists for. Without it the later writer's
      // `{ ...row }` spread of its stale read puts the other row back to queued.
      const after = new Map(readShard("F01").rows.map((r) => [r.id, r]));
      check(
        "concurrent prove: BOTH rows landed — neither write erased the other",
        [after.get("B1")?.state, after.get("B1")?.pr, after.get("B2")?.state, after.get("B2")?.pr],
        ["proven", 701, "proven", 702],
      );
      const lockDir = lockPath("F01");
      check(
        "concurrent prove: the lock directory is released, not left behind",
        existsSync(lockDir),
        false,
      );

      // (a) A LIVE holder whose critical section outlasts the OLD age-based
      // staleness threshold (5s) must NOT be robbed. Age is not liveness: the
      // waiter used to rm the lockdir at 5s, take it, and let the original
      // holder write its pre-theft snapshot back over the thief's committed
      // row — two writers inside one critical section, both exiting 0. The
      // holder stalls 6s (past that old threshold); the waiter starts 800ms in
      // with no stall of its own, so it MUST sit through the whole hold.
      const slow = race([
        { args: proveArgs("B3", 703), stall: 6000 },
        { args: proveArgs("B4", 704), stall: 0, delay: 800 },
      ]);
      check("live holder: the orchestrator exited 0", slow.code, 0);
      const slowKids = JSON.parse(slow.out.trim().split("\n").pop());
      check(
        "live holder: BOTH child processes exited 0",
        slowKids.map((c) => c.code),
        [0, 0],
      );
      check(
        "live holder: a lock held past the OLD 5s threshold is NOT broken",
        /breaking the lock on F01\.jsonl/.test(slow.out),
        false,
      );
      const afterSlow = new Map(readShard("F01").rows.map((r) => [r.id, r]));
      check(
        "live holder: the waiter waited — BOTH rows landed, neither reverted",
        [
          afterSlow.get("B3")?.state,
          afterSlow.get("B3")?.pr,
          afterSlow.get("B4")?.state,
          afterSlow.get("B4")?.pr,
        ],
        ["proven", 703, "proven", 704],
      );

      // Wait for a real child to be INSIDE its critical section. `owner.json`
      // is written immediately after the mkdir that wins the lock, so its
      // existence — not the lockdir's — is what proves the hold is established.
      const awaitHold = () => {
        for (let i = 0; i < 400 && !existsSync(ownerPath(lockDir)); i++) sleepSync(25);
        return existsSync(ownerPath(lockDir));
      };
      const awaitExit = (child, ms = 15000) => {
        for (let i = 0; i * 25 < ms && pidAlive(child.pid) !== false; i++) sleepSync(25);
        return pidAlive(child.pid) === false;
      };
      const holder = (id, stall, stdio) =>
        spawn(process.execPath, [SCRIPT_PATH, ...proveArgs(id, 700 + Number(id.slice(1)))], {
          env: { ...process.env, BUGS_ROOT: tmp, BUGS_SELF_TEST: "1", BUGS_TEST_STALL_MS: stall },
          stdio,
        });

      // (b) A holder killed OUTRIGHT leaves its lockdir behind, and the very
      // next waiter must break it within ONE invocation — on the owner pid
      // being gone, which `process.kill(pid, 0)` answers on win32 too. Before
      // the fix the waiter's 2s deadline expired long before the 5s age
      // threshold it was waiting for, so it exited 1 blaming "another bugs.mjs
      // process is writing F01.jsonl" when nothing was running at all.
      const victim = holder("B5", "20000", "ignore");
      const heldByVictim = awaitHold();
      victim.kill("SIGKILL");
      awaitExit(victim, 3000);
      const rescued = runCli(["tier", "B5", "T2", "--why", "dead-holder fixture"], tmp);
      check("dead holder: it really held the lock when it was killed", heldByVictim, true);
      check("dead holder: the NEXT waiter succeeds in one invocation", rescued.code, 0);
      check(
        "dead holder: breaking a dead owner's lock is reported, never silent",
        /breaking the lock on F01\.jsonl — its owner \(pid \d+\) is gone/.test(rescued.out),
        true,
      );
      check(
        "dead holder: the write it was blocking actually landed",
        readShard("F01").rows.find((r) => r.id === "B5")?.tier,
        "T2",
      );

      // (c) The other half of the theft, from the RELEASE side: a process whose
      // lock was broken used to rm the lock PATH unconditionally on the way
      // out, deleting the lock its SUCCESSOR now held and admitting a third
      // writer. Hand-write a different owner token into the lockdir while a
      // real `prove` is inside its critical section: it must leave the
      // directory alone and say so.
      check("stolen lock: the fixture starts with no lock held", existsSync(lockDir), false);
      const errFile = join(tmp, "stolen.err");
      const errFd = openSync(errFile, "w");
      const stolen = holder("B6", "3000", ["ignore", "ignore", errFd]);
      const heldByStolen = awaitHold();
      writeFileSync(
        ownerPath(lockDir),
        JSON.stringify({ pid: process.pid, token: "a-successor-token", at: Date.now() }),
      );
      awaitExit(stolen);
      closeSync(errFd);
      const stolenErr = readFileSync(errFile, "utf8");
      check("stolen lock: the victim really held the lock when it was stolen", heldByStolen, true);
      check(
        "stolen lock: the successor's lockdir SURVIVES the stolen-from writer's exit",
        existsSync(lockDir),
        true,
      );
      check(
        "stolen lock: the stolen-from writer says so on stderr",
        /our lock on F01\.jsonl was broken by another process; verify the shard/.test(stolenErr),
        true,
      );
      rmSync(lockDir, { recursive: true, force: true });

      // (c2) The exit code, from a THIRD process. Node only populates a
      // spawned child's OWN ChildProcess.exitCode once this process's event
      // loop gets a tick to reap it — which the busy-poll pattern above
      // (`awaitExit`, built on a raw `process.kill(pid, 0)` liveness check)
      // never yields for, so it cannot observe the real exit STATUS, only
      // that the process eventually died. `spawnSync` is Node's own
      // dedicated primitive for exactly that: it blocks this process until
      // the child truly exits and reports its real status, while a
      // completely separate, independently-scheduled OS process (spawned
      // async, fire-and-forget) performs the theft concurrently — proven by
      // that process itself capturing the ORIGINAL owner content before it
      // overwrites it.
      const stealerScript = join(tmp, "stealer.mjs");
      const stolenMarker = join(tmp, "stolen-marker.json");
      writeFileSync(
        stealerScript,
        [
          'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
          "const [dir, marker] = process.argv.slice(2);",
          'const ownerFile = dir + "/owner.json";',
          "const deadline = Date.now() + 10000;",
          "while (!existsSync(ownerFile) && Date.now() < deadline) {}",
          'const original = existsSync(ownerFile) ? readFileSync(ownerFile, "utf8") : "";',
          "writeFileSync(marker, original);",
          "if (original) {",
          "  writeFileSync(",
          "    ownerFile,",
          '    JSON.stringify({ pid: process.pid, token: "a-second-successor-token", at: Date.now() }),',
          "  );",
          "}",
        ].join("\n"),
      );
      spawn(process.execPath, [stealerScript, lockDir, stolenMarker], { stdio: "ignore" });
      const exitCodeProbe = spawnSync(
        process.execPath,
        [SCRIPT_PATH, "tier", "B6", "T2", "--why", "stolen-lock exit-code fixture"],
        {
          encoding: "utf8",
          env: { ...process.env, BUGS_ROOT: tmp, BUGS_SELF_TEST: "1", BUGS_TEST_STALL_MS: "3000" },
        },
      );
      const markerContent = existsSync(stolenMarker) ? readFileSync(stolenMarker, "utf8") : "";
      let markerOwner = null;
      try {
        markerOwner = JSON.parse(markerContent);
      } catch {
        /* stealer never saw an owner.json in time — the checks below catch it */
      }
      check(
        "stolen lock (exit code): the stealer really observed the victim's own owner stamp first",
        typeof markerOwner?.pid === "number",
        true,
      );
      check(
        "stolen lock (exit code): the successor's lockdir SURVIVES this writer's exit too",
        existsSync(lockDir),
        true,
      );
      check(
        "stolen lock (exit code): the stolen-from writer's real process exit status is non-zero",
        exitCodeProbe.status !== 0,
        true,
      );
      rmSync(lockDir, { recursive: true, force: true });

      // (d) Ctrl-C mid-write. Node's DEFAULT action for SIGINT/SIGTERM/SIGHUP
      // terminates the process WITHOUT running `exit` listeners, so an
      // interrupted writer left its lockdir behind. The handlers are asserted
      // on both platforms by driving the REAL CLI in a child that reports its
      // own listener counts; the real-signal assertion is POSIX-only, because
      // on win32 `child.kill("SIGINT")` is a TerminateProcess — case (b), not a
      // deliverable signal.
      const probe = join(tmp, "signal-probe.mjs");
      writeFileSync(
        probe,
        [
          'import { pathToFileURL } from "node:url";',
          "const [script, root] = process.argv.slice(2);",
          "process.env.BUGS_ROOT = root;",
          'process.argv = [process.execPath, script, "tier", "B7", "T2", "--why", "signal probe"];',
          "await import(pathToFileURL(script).href);",
          'console.log(JSON.stringify(["SIGINT", "SIGTERM", "SIGHUP"].map((s) => process.listenerCount(s))));',
        ].join("\n"),
      );
      let probeOut = "";
      try {
        probeOut = execSync(
          `node ${[probe, SCRIPT_PATH, tmp].map((a) => JSON.stringify(a)).join(" ")}`,
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );
      } catch (e) {
        probeOut = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      }
      check(
        "signals: a writer that took the lock installs SIGINT/SIGTERM/SIGHUP handlers",
        JSON.parse(probeOut.trim().split("\n").pop()),
        [1, 1, 1],
      );
      if (process.platform !== "win32") {
        const interrupted = holder("B8", "3000", "ignore");
        const heldByInterrupted = awaitHold();
        interrupted.kill("SIGINT");
        awaitExit(interrupted);
        check("SIGINT: it really held the lock when it was interrupted", heldByInterrupted, true);
        check("SIGINT: an interrupted writer leaves NO lock directory", existsSync(lockDir), false);
      }

      // A lockdir carrying no readable owner.json cannot be judged on liveness
      // at all — that is the ONLY case the age rule still decides, and only as
      // a loud last resort far past any real critical section.
      mkdirSync(lockDir);
      const old = new Date(Date.now() - LOCK_ABANDON_MS * 2);
      utimesSync(lockDir, old, old);
      const broke = runCli(["tier", "B1", "T2", "--why", "abandoned-lock fixture"], tmp);
      check("abandoned lock: the waiting writer still succeeds", broke.code, 0);
      check(
        "abandoned lock: breaking one is reported as a LAST RESORT, never silent",
        /LAST RESORT: it is \d+s old and carries no readable owner\.json/.test(broke.out),
        true,
      );
      check(
        "abandoned lock: the write it was blocking actually landed",
        readShard("F01").rows.find((r) => r.id === "B1")?.tier,
        "T2",
      );

      // (f) PID REUSE. A lockdir whose owner pid has been reused by some
      // UNRELATED live process must still be broken — before the boot stamp,
      // `alive === true` (the pid genuinely answers) meant "never break it",
      // permanently wedging every later caller on a lock nobody actually
      // holds. A real, currently-running (but entirely unrelated) child
      // process stands in for the impostor; its bootAt is stamped from a
      // fabricated boot far in the past, which is the one thing that can
      // prove "this cannot be the process that wrote this lock" even though
      // `process.kill(pid, 0)` alone would say it is alive.
      rmSync(lockDir, { recursive: true, force: true });
      const impostor = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], {
        stdio: "ignore",
      });
      mkdirSync(lockDir);
      writeFileSync(
        ownerPath(lockDir),
        JSON.stringify({
          pid: impostor.pid,
          token: "pid-reuse-fixture-token",
          at: Date.now() - LOCK_ABANDON_MS * 10,
          bootAt: Date.now() - LOCK_ABANDON_MS * 10,
        }),
      );
      const pidReuseCheck = pidAlive(impostor.pid);
      const rescuedFromReuse = runCli(["tier", "B1", "T1", "--why", "pid-reuse fixture"], tmp);
      impostor.kill();
      check(
        "pid reuse: the impostor pid genuinely answers to a liveness check with no boot stamp",
        pidReuseCheck,
        true,
      );
      check(
        "pid reuse: the NEXT waiter succeeds in one invocation, not after LOCK_ABANDON_MS",
        rescuedFromReuse.code,
        0,
      );
      check(
        "pid reuse: breaking it names the boot mismatch, never the age-based last resort",
        /breaking the lock on F01\.jsonl — its owner \(pid \d+\) predates this boot/.test(
          rescuedFromReuse.out,
        ),
        true,
      );
      check(
        "pid reuse: the write it was blocking actually landed",
        readShard("F01").rows.find((r) => r.id === "B1")?.tier,
        "T1",
      );

      // (g) OWNER-WRITE FAILURE. A crash between the mkdir that wins the lock
      // and the owner.json write that follows it (disk full, a permission
      // fault) used to leave the directory behind with no owner stamp at
      // all — exactly the "no readable owner.json" case, which every OTHER
      // waiter can only break as a LAST RESORT once it is a full
      // LOCK_ABANDON_MS old, wedging every caller for two minutes over a
      // fault that had nothing to do with contention. Driven through the
      // real CLI via the same gated test-seam pattern as BUGS_TEST_STALL_MS
      // — a real disk-full fault isn't reproducible on demand.
      const ownerWriteFailure = () => {
        try {
          execSync(
            `node ${[SCRIPT_PATH, "tier", "B1", "T2", "--why", "owner-write-fail fixture"].map((a) => JSON.stringify(a)).join(" ")}`,
            {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
              env: {
                ...process.env,
                BUGS_ROOT: tmp,
                BUGS_SELF_TEST: "1",
                BUGS_TEST_FAIL_OWNER_WRITE: "1",
              },
            },
          );
          return { code: 0, out: "" };
        } catch (e) {
          return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
        }
      };
      check(
        "owner-write failure: no lock exists before the fixture runs",
        existsSync(lockDir),
        false,
      );
      const ownerWriteResult = ownerWriteFailure();
      check(
        "owner-write failure: the command fails loudly, never silently",
        ownerWriteResult.code !== 0,
        true,
      );
      check(
        "owner-write failure: the lockdir it just created is cleaned up, not left to wedge every later caller",
        existsSync(lockDir),
        false,
      );
      check(
        "owner-write failure: a NEXT, unfixtured caller succeeds immediately — nothing was left behind to break",
        runCli(["tier", "B1", "T3", "--why", "owner-write-fail recovery check"], tmp).code,
        0,
      );

      // (h) GIVE-UP MESSAGE HONESTY. A lockdir with NO readable owner.json is
      // not stuck forever — it is exactly the LAST-RESORT case, just not yet
      // LOCK_ABANDON_MS old — but the give-up message a waiter prints when
      // ITS OWN LOCK_SPIN_MS deadline expires used to read as a permanent
      // wedge needing a manual `rm`, hiding that this self-heals. A FRESH,
      // owner-less lockdir forces the waiter to spin its full LOCK_SPIN_MS
      // before giving up (~10s — the one slow check in this suite, and
      // unavoidable: anything shorter wouldn't be testing the real deadline).
      mkdirSync(lockDir);
      const givesUp = runCli(["tier", "B1", "T2", "--why", "give-up message fixture"], tmp);
      check("give-up message: the waiter genuinely gives up (non-zero)", givesUp.code !== 0, true);
      check(
        "give-up message: it tells the operator this self-heals, not just to `rm` it",
        /it carries no owner stamp and will be broken automatically once it is 120s old/.test(
          givesUp.out,
        ),
        true,
      );
      rmSync(lockDir, { recursive: true, force: true });

      // (e) The seam itself. Unguarded, ONE env var made both blockers above
      // trivially reachable from a normal run: set above the old 5s threshold
      // it did not merely slow a write down, it MANUFACTURED the theft.
      const timeCli = (id, env) => {
        const t0 = Date.now();
        try {
          execSync(
            `node ${[SCRIPT_PATH, "tier", id, "T3", "--why", "stall seam timing"].map((a) => JSON.stringify(a)).join(" ")}`,
            {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
              env: { ...process.env, BUGS_ROOT: tmp, ...env },
            },
          );
        } catch {
          /* the elapsed time IS the assertion */
        }
        return Date.now() - t0;
      };
      const ungated = timeCli("B1", { BUGS_TEST_STALL_MS: "2500", BUGS_SELF_TEST: "" });
      const gated = timeCli("B2", { BUGS_TEST_STALL_MS: "2500", BUGS_SELF_TEST: "1" });
      check("stall seam: a production run ignores BUGS_TEST_STALL_MS", ungated < 2000, true);
      check("stall seam: BUGS_SELF_TEST=1 still un-gates it for this suite", gated >= 2500, true);
    } finally {
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // Lock directories are NOT gitignored by accident — the shards and the
  // catalogue they guard live in the TRACKED .claude/campaign/ tree, so
  // without an explicit rule a lockdir left behind by a crash (or committed
  // by an agent that ran `git add -A`) lands in a commit. Checked against the
  // REAL repo root, not a throwaway BUGS_ROOT — .gitignore rules are read
  // relative to the repo they live in, and a fixture root outside the repo
  // would prove nothing about whether git actually ignores the real paths.
  {
    const checkIgnore = (relPath) => {
      try {
        execFileSync("git", ["check-ignore", relPath], { cwd: REPO_ROOT, encoding: "utf8" });
        return true;
      } catch (e) {
        return e.status === 1 ? false : null; // 1 = genuinely not ignored; anything else is a real error
      }
    };
    check(
      "gitignore: a shard lockdir is ignored",
      checkIgnore(".claude/campaign/status/F01.jsonl.lock/owner.json"),
      true,
    );
    check(
      "gitignore: the catalogue lockdir is ignored",
      checkIgnore(".claude/campaign/bugs.jsonl.lock/owner.json"),
      true,
    );
  }

  // ── the catalogue lock ──────────────────────────────────────────────────
  // Two simultaneous `file --batch F01` calls used to read the same catalogue
  // snapshot, allocate the SAME id, both exit 0 printing `filed B2`, and lose
  // one bug entirely — catalogue row, ledger row and record — leaving a state
  // so self-consistent that neither gate could see anything was missing.
  // Driven through the REAL CLI in two REAL child processes, overlapped
  // deterministically by the (self-test-gated) stall seam inside the ledger
  // write, which sits exactly in the allocate→commit window.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    try {
      const orchestrator = join(tmp, "concurrent-file.mjs");
      writeFileSync(
        orchestrator,
        [
          'import { spawn } from "node:child_process";',
          "const [script, root, stall] = process.argv.slice(2);",
          "const run = (title) =>",
          "  new Promise((res) => {",
          "    const p = spawn(",
          "      process.execPath,",
          "      [",
          "        script,",
          '        "file",',
          "        title,",
          '        "--location",',
          "        `apps/api/src/${title}.ts`,",
          '        "--severity",',
          '        "low",',
          '        "--batch",',
          '        "F01",',
          '        "--tier",',
          '        "T1",',
          "      ],",
          "      {",
          "        env: {",
          "          ...process.env,",
          "          BUGS_ROOT: root,",
          '          BUGS_SELF_TEST: "1",',
          "          BUGS_TEST_STALL_MS: stall,",
          "        },",
          '        stdio: ["ignore", "pipe", "pipe"],',
          "      },",
          "    );",
          '    let out = "";',
          '    p.stdout.on("data", (d) => (out += d));',
          '    p.stderr.on("data", (d) => (out += d));',
          '    p.on("close", (code) => res({ code, out }));',
          "  });",
          'const results = await Promise.all([run("sessionone"), run("sessiontwo")]);',
          "console.log(JSON.stringify(results));",
        ].join("\n"),
      );
      const argv = [orchestrator, SCRIPT_PATH, tmp, "500"].map((a) => JSON.stringify(a)).join(" ");
      let raced = { code: 0, out: "" };
      try {
        raced = {
          code: 0,
          out: execSync(`node ${argv}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
        };
      } catch (e) {
        raced = { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
      }
      check("concurrent file: the orchestrator exited 0", raced.code, 0);
      const kids = JSON.parse(raced.out.trim().split("\n").pop());
      check(
        "concurrent file: BOTH child processes exited 0",
        kids.map((c) => c.code),
        [0, 0],
      );
      const filed = kids
        .map((c) => /filed (B\d+)/.exec(c.out)?.[1] ?? null)
        .sort((a, b) => String(a).localeCompare(String(b)));
      check("concurrent file: the two sessions were given DISTINCT ids", filed, ["B1", "B2"]);
      const cat = readCatalogue();
      check(
        "concurrent file: BOTH bugs are in the catalogue — neither was overwritten",
        cat.map((r) => r.title).sort(),
        ["sessionone", "sessiontwo"],
      );
      check(
        "concurrent file: the ledger carries one row per filed id",
        readShard("F01")
          .rows.map((r) => r.id)
          .sort(),
        ["B1", "B2"],
      );
      check(
        "concurrent file: BOTH records exist on disk",
        cat.map((r) => existsSync(recordPath(r.id))),
        [true, true],
      );
    } finally {
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ── move takes the catalogue lock too ───────────────────────────────────
  // `move` patches a catalogue row's `batch` field but used to read-modify-
  // write bugs.jsonl with NO lock of its own, nested only inside its shard
  // locks — a concurrent `file` (which DOES hold the catalogue lock across
  // its own ledger write AND its catalogue write) could land in the gap and
  // have its own change silently reverted.
  //
  // The concurrent filer deliberately targets F03 — a batch move never
  // touches (move only takes F01 and F02's shard locks) — so this is a race
  // on the CATALOGUE specifically, not one that happens to also serialize on
  // a shard lock the two commands share. Without that, move (even unfixed)
  // blocks on F01's shard lock for the length of file's stall regardless of
  // whether it holds the catalogue lock, and the catalogue-level race never
  // gets a chance to manifest — verified by hand: with the filer targeting
  // F01 instead, this same test passed even against the unfixed `move`.
  // file's stall sits INSIDE its hold of the catalogue lock, so for the
  // length of the stall file is holding the one lock move must now also take
  // before it can touch the catalogue at all; the fixed move blocks on it,
  // reads a catalogue that already has file's row, and its patch survives
  // file's own write. The unfixed move races ahead immediately (nothing of
  // file's blocks it), writes its patch, and file's later write — built from
  // the stale snapshot it read before the stall — overwrites it right back.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    try {
      cmds.file([
        "move fixture",
        "--location",
        "apps/api/src/move-fixture.ts",
        "--severity",
        "low",
        "--batch",
        "F01",
        "--tier",
        "T1",
      ]);
      check(
        "move-vs-file fixture: B1 seeded in F01",
        readShard("F01").rows.map((r) => r.id),
        ["B1"],
      );

      const orchestrator = join(tmp, "concurrent-move.mjs");
      writeFileSync(
        orchestrator,
        [
          'import { spawn } from "node:child_process";',
          "const [script, root, stall] = process.argv.slice(2);",
          "const run = (args, env, delay) =>",
          "  new Promise((res) => {",
          "    const start = () => {",
          "      const p = spawn(process.execPath, [script, ...args], {",
          "        env: { ...process.env, BUGS_ROOT: root, ...env },",
          '        stdio: ["ignore", "pipe", "pipe"],',
          "      });",
          '      let out = "";',
          '      p.stdout.on("data", (d) => (out += d));',
          '      p.stderr.on("data", (d) => (out += d));',
          '      p.on("close", (code) => res({ code, out }));',
          "    };",
          "    if (delay) setTimeout(start, delay);",
          "    else start();",
          "  });",
          "const results = await Promise.all([",
          "  run(",
          '    ["file", "concurrent blocker", "--location", "apps/api/src/conc-blocker.ts", "--severity", "low", "--batch", "F03", "--tier", "T1"],',
          '    { BUGS_SELF_TEST: "1", BUGS_TEST_STALL_MS: stall },',
          "    0,",
          "  ),",
          '  run(["move", "B1", "--to", "F02"], {}, 200),',
          "]);",
          "console.log(JSON.stringify(results));",
        ].join("\n"),
      );
      const argv = [orchestrator, SCRIPT_PATH, tmp, "1500"].map((a) => JSON.stringify(a)).join(" ");
      const t0 = Date.now();
      let raced;
      try {
        raced = {
          code: 0,
          out: execSync(`node ${argv}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
        };
      } catch (e) {
        raced = { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
      }
      const elapsedMs = Date.now() - t0;
      check("move vs file: the orchestrator exited 0", raced.code, 0);
      const kids = JSON.parse(raced.out.trim().split("\n").pop());
      check(
        "move vs file: BOTH child processes exited 0 (no deadlock, no refusal)",
        kids.map((k) => k.code),
        [0, 0],
      );
      check(
        "move vs file: the race finished well under the 10s lock-wait deadline",
        elapsedMs < 8000,
        true,
      );
      const cat = readCatalogue();
      check(
        "move vs file: the catalogue's batch for B1 matches where it actually landed — file's own catalogue write did not revert it",
        cat.find((r) => r.id === "B1")?.batch,
        "F02",
      );
      check(
        "move vs file: the ledger agrees — B1 landed in F02, F03 holds only the concurrent filer's new bug",
        [readShard("F02").rows.map((r) => r.id), readShard("F03").rows.map((r) => r.id)],
        [["B1"], ["B2"]],
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

  // ── index takes the catalogue lock too ──────────────────────────────────
  // `index` rewrites bugs.jsonl WHOLESALE with no lock at all — a whole
  // rebuild used to be silently discarded by a concurrent `file`: `file`
  // captures its own in-memory catalogue snapshot at the START of its
  // critical section, and if `index` reads, rebuilds and writes ENTIRELY
  // inside that window, `file`'s own later write (built from the now-stale
  // snapshot) overwrites index's rebuild right back out.
  //
  // The extra record (B50 — an id well clear of the fixture's own allocator,
  // so it cannot collide with the id the concurrent filer allocates) is
  // hand-written directly, bypassing `file`/`expand` entirely, and
  // deliberately has NO catalogue row at all — `expand` only ever touches
  // bugs already IN the catalogue, so the concurrent filer's own
  // unconditional `expand()` call cannot interfere with it. Only `index` ever
  // notices B50 exists, which is exactly what makes this the sharpest probe
  // for "did index's rebuild survive": if it did, B50 is in the final
  // catalogue; if `file`'s stale write clobbered it, B50 is gone.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    try {
      cmds.file(["seed bug", "--location", "apps/api/src/index-fixture.ts", "--severity", "low"]);
      check(
        "index-vs-file fixture: B1 seeded",
        readCatalogue().map((r) => r.id),
        ["B1"],
      );
      writeRecord(
        "B50",
        {
          id: "B50",
          title: "hand-added record",
          location: "apps/api/src/index-fixture-2.ts",
          severity: "low",
          batch: null,
          register: "open",
          sensitive: "false",
          sensitiveFor: "",
        },
        "\n# B50 · hand-added record\n\n## History\n",
      );
      check(
        "index-vs-file fixture: B50 has a record but NO catalogue row yet",
        [existsSync(recordPath("B50")), readCatalogue().some((r) => r.id === "B50")],
        [true, false],
      );

      const orchestrator = join(tmp, "concurrent-index.mjs");
      writeFileSync(
        orchestrator,
        [
          'import { spawn } from "node:child_process";',
          "const [script, root, stall] = process.argv.slice(2);",
          "const run = (args, env, delay) =>",
          "  new Promise((res) => {",
          "    const start = () => {",
          "      const p = spawn(process.execPath, [script, ...args], {",
          "        env: { ...process.env, BUGS_ROOT: root, ...env },",
          '        stdio: ["ignore", "pipe", "pipe"],',
          "      });",
          '      let out = "";',
          '      p.stdout.on("data", (d) => (out += d));',
          '      p.stderr.on("data", (d) => (out += d));',
          '      p.on("close", (code) => res({ code, out }));',
          "    };",
          "    if (delay) setTimeout(start, delay);",
          "    else start();",
          "  });",
          "const results = await Promise.all([",
          "  run(",
          '    ["file", "concurrent filer", "--location", "apps/api/src/conc-index.ts", "--severity", "low", "--batch", "F01", "--tier", "T1"],',
          '    { BUGS_SELF_TEST: "1", BUGS_TEST_STALL_MS: stall },',
          "    0,",
          "  ),",
          '  run(["index"], {}, 300),',
          "]);",
          "console.log(JSON.stringify(results));",
        ].join("\n"),
      );
      const argv = [orchestrator, SCRIPT_PATH, tmp, "1500"].map((a) => JSON.stringify(a)).join(" ");
      let raced;
      try {
        raced = {
          code: 0,
          out: execSync(`node ${argv}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
        };
      } catch (e) {
        raced = { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
      }
      check("index vs file: the orchestrator exited 0", raced.code, 0);
      const kids = JSON.parse(raced.out.trim().split("\n").pop());
      check(
        "index vs file: BOTH child processes exited 0",
        kids.map((k) => k.code),
        [0, 0],
      );
      check(
        "index vs file: the rebuild survives — B1, B50 and the concurrent filer's new bug all landed",
        readCatalogue()
          .map((r) => r.id)
          .sort(),
        ["B1", "B2", "B50"],
      );
    } finally {
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ── discharge takes the catalogue lock too ──────────────────────────────
  // discharge's whole-ledger "byte-identical evidence" scan (the `seen` map
  // above) reads every OTHER shard's dischargeEvidence while holding only
  // THIS batch's own shard lock — so two `discharge` calls on DIFFERENT
  // batches never serialised against each other: each could scan before the
  // other's write landed, and both could admit the same evidence string.
  // Raced across F01 and F02 (which share no shard lock at all — the ONLY
  // thing that can serialise them is the catalogue lock) with the identical
  // evidence string on both sides.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    try {
      cmds.file([
        "discharge-race fixture A",
        "--location",
        "apps/api/src/discharge-race-a.ts",
        "--severity",
        "low",
        "--batch",
        "F01",
        "--tier",
        "T1",
      ]);
      cmds.file([
        "discharge-race fixture B",
        "--location",
        "apps/api/src/discharge-race-b.ts",
        "--severity",
        "low",
        "--batch",
        "F02",
        "--tier",
        "T1",
      ]);
      cmds.prove(["B1", "--pr", "950", "--proof", "REG-B1 jest: fixture A"]);
      cmds.prove(["B2", "--pr", "951", "--proof", "REG-B2 jest: fixture B"]);
      check(
        "discharge-race fixture: both rows proven, one per batch",
        [readShard("F01").rows[0]?.state, readShard("F02").rows[0]?.state],
        ["proven", "proven"],
      );

      const SHARED_EVIDENCE = "shared discharge run https://example.invalid/run/1234567890";
      const orchestrator = join(tmp, "concurrent-discharge.mjs");
      writeFileSync(
        orchestrator,
        [
          'import { spawn } from "node:child_process";',
          "const [script, root, stall, evidence] = process.argv.slice(2);",
          "const run = (args, env, delay) =>",
          "  new Promise((res) => {",
          "    const start = () => {",
          "      const p = spawn(process.execPath, [script, ...args], {",
          "        env: { ...process.env, BUGS_ROOT: root, ...env },",
          '        stdio: ["ignore", "pipe", "pipe"],',
          "      });",
          '      let out = "";',
          '      p.stdout.on("data", (d) => (out += d));',
          '      p.stderr.on("data", (d) => (out += d));',
          '      p.on("close", (code) => res({ code, out }));',
          "    };",
          "    if (delay) setTimeout(start, delay);",
          "    else start();",
          "  });",
          "const results = await Promise.all([",
          "  run(",
          '    ["discharge", "F01", "--evidence", "batch-wide evidence for F01, well over 40 chars", "--evidence-B1", evidence],',
          '    { BUGS_SELF_TEST: "1", BUGS_TEST_STALL_MS: stall },',
          "    0,",
          "  ),",
          "  run(",
          '    ["discharge", "F02", "--evidence", "batch-wide evidence for F02, well over 40 chars", "--evidence-B2", evidence],',
          "    {},",
          "    300,",
          "  ),",
          "]);",
          "console.log(JSON.stringify(results));",
        ].join("\n"),
      );
      const argv = [orchestrator, SCRIPT_PATH, tmp, "1500", SHARED_EVIDENCE]
        .map((a) => JSON.stringify(a))
        .join(" ");
      let raced;
      try {
        raced = {
          code: 0,
          out: execSync(`node ${argv}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
        };
      } catch (e) {
        raced = { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
      }
      check("discharge race: the orchestrator exited 0", raced.code, 0);
      const kids = JSON.parse(raced.out.trim().split("\n").pop());
      check("discharge race: F01 (the one holding the lock first) succeeds", kids[0].code, 0);
      check(
        "discharge race: F02 is REFUSED the identical evidence — not silently admitted",
        kids[1].code !== 0,
        true,
      );
      check(
        "discharge race: the refusal names both rows",
        /B1 and B2|B2 and B1/.test(kids[1].out),
        true,
      );
      const byBatch = {
        F01: readShard("F01").rows[0],
        F02: readShard("F02").rows[0],
      };
      check(
        "discharge race: F01's row landed — done, with the shared evidence",
        [byBatch.F01?.state, byBatch.F01?.dischargeEvidence],
        ["done", SHARED_EVIDENCE],
      );
      check(
        "discharge race: F02's row was never written — still proven, refusal happened before any write",
        byBatch.F02?.state,
        "proven",
      );
    } finally {
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ── lock order: catalogue, then shard — enforced two ways ───────────────
  // Nothing above ever ASSERTS the order itself — every fix (file/move/
  // import/index/discharge) happened to get it right, but nothing would
  // notice a FUTURE command that took the locks the other way round until it
  // deadlocked in production. Two independent guards:
  //
  // (a) STATIC: parse this file's own source and fail if `withCatalogueLock(`
  //     appears lexically inside a `withShardLock(`/`withShardLocks(` call's
  //     own argument list (which is where its callback lives) — found by
  //     locating each opener's MATCHING close-paren via a paren-depth count
  //     from the opener, then searching that span as plain text. This is
  //     deliberately dumber than a real parser (no comment/string awareness),
  //     which is exactly what makes it trustworthy: nothing here needs to
  //     agree with what V8 thinks a token is, it only needs to see the same
  //     textual nesting a human reviewer would.
  {
    const src = readFileSync(SCRIPT_PATH, "utf8");
    const violations = [];
    const opener = /withShardLocks?\(/g;
    let m;
    while ((m = opener.exec(src))) {
      const parenStart = m.index + m[0].length - 1;
      let depth = 0;
      let end = -1;
      for (let i = parenStart; i < src.length; i++) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end === -1) continue; // unbalanced parens — a syntax error elsewhere, not this check's job
      const span = src.slice(parenStart, end);
      if (/withCatalogueLock\(/.test(span)) {
        const line = src.slice(0, m.index).split("\n").length;
        violations.push(`${m[0]} opener at line ${line} has withCatalogueLock( nested inside it`);
      }
    }
    check(
      "lock order (static): no withCatalogueLock( call is nested inside a withShardLock(/withShardLocks( callback",
      violations,
      [],
    );
  }

  // (b) RUNTIME: race two DIFFERENT commands that both take catalogue-then-
  //     shard — `move` (catalogue, then two shards) and `discharge`
  //     (catalogue, then one shard) — against each other on batches that
  //     share no shard lock at all, so the ONLY thing serializing them is the
  //     catalogue lock both correctly take first. If either ever regressed to
  //     the opposite order, this does not merely run slow: a cycle (one
  //     process holding shard-A waiting on the catalogue lock, another
  //     holding the catalogue lock waiting on shard-A) has no exit but each
  //     side's own LOCK_SPIN_MS timeout, so the pair would take upwards of
  //     10s and one side would exit non-zero — comfortably outside this
  //     probe's 5s budget.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const prevRoot = process.env.BUGS_ROOT;
    process.env.BUGS_ROOT = tmp;
    try {
      cmds.file([
        "lock-order fixture A",
        "--location",
        "apps/api/src/lock-order-a.ts",
        "--severity",
        "low",
        "--batch",
        "F01",
        "--tier",
        "T1",
      ]);
      cmds.file([
        "lock-order fixture B",
        "--location",
        "apps/api/src/lock-order-b.ts",
        "--severity",
        "low",
        "--batch",
        "F02",
        "--tier",
        "T1",
      ]);
      cmds.prove(["B2", "--pr", "960", "--proof", "REG-B2 jest: lock-order fixture"]);

      const orchestrator = join(tmp, "lock-order-race.mjs");
      writeFileSync(
        orchestrator,
        [
          'import { spawn } from "node:child_process";',
          "const [script, root, stall] = process.argv.slice(2);",
          "const run = (args, env, delay) =>",
          "  new Promise((res) => {",
          "    const start = () => {",
          "      const p = spawn(process.execPath, [script, ...args], {",
          "        env: { ...process.env, BUGS_ROOT: root, ...env },",
          '        stdio: ["ignore", "pipe", "pipe"],',
          "      });",
          '      let out = "";',
          '      p.stdout.on("data", (d) => (out += d));',
          '      p.stderr.on("data", (d) => (out += d));',
          '      p.on("close", (code) => res({ code, out }));',
          "    };",
          "    if (delay) setTimeout(start, delay);",
          "    else start();",
          "  });",
          "const results = await Promise.all([",
          "  run(",
          '    ["move", "B1", "--to", "F03"],',
          '    { BUGS_SELF_TEST: "1", BUGS_TEST_STALL_MS: stall },',
          "    0,",
          "  ),",
          "  run(",
          '    ["discharge", "F02", "--evidence", "batch-wide evidence for F02, well over 40 chars"],',
          "    {},",
          "    200,",
          "  ),",
          "]);",
          "console.log(JSON.stringify(results));",
        ].join("\n"),
      );
      const argv = [orchestrator, SCRIPT_PATH, tmp, "1200"].map((a) => JSON.stringify(a)).join(" ");
      const t0 = Date.now();
      let raced;
      try {
        raced = {
          code: 0,
          out: execSync(`node ${argv}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
        };
      } catch (e) {
        raced = { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
      }
      const elapsedMs = Date.now() - t0;
      check("lock order (runtime): the orchestrator exited 0", raced.code, 0);
      const kids = JSON.parse(raced.out.trim().split("\n").pop());
      check(
        "lock order (runtime): move and discharge BOTH exited 0 — no deadlock, no refusal",
        kids.map((k) => k.code),
        [0, 0],
      );
      check(
        "lock order (runtime): the race finished in well under 5s — a genuine deadlock costs ~10s+",
        elapsedMs < 5000,
        true,
      );
    } finally {
      if (prevRoot === undefined) delete process.env.BUGS_ROOT;
      else process.env.BUGS_ROOT = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // campaign-check's T2 gate: a partial (or merely unrelated) Playwright
  // artifact must not turn an already-discharged T2 row red just because
  // that ONE file has nothing to say about it — it must fall back to the
  // row's own dischargeEvidence exactly as if no artifact existed at all.
  // Drives the REAL campaign-check.mjs as a child process against a
  // throwaway status dir (CAMPAIGN_CHECK_STATUS_DIR) and runs dir, never a
  // re-implementation of its gate logic.
  {
    const tmp = mkdtempSync(join(tmpdir(), "bugs-self-test-"));
    const statusTmp = join(tmp, "status");
    const runsTmp = join(tmp, "runs");
    mkdirSync(statusTmp, { recursive: true });
    mkdirSync(runsTmp, { recursive: true });
    const row = {
      id: "B900",
      batch: "F01",
      tier: "T2",
      state: "done",
      pr: 900,
      proof: "REG-B900 e2e",
      evidence: null,
    };
    const runCampaignCheck = () => {
      try {
        return {
          code: 0,
          out: execSync(`node scripts/campaign-check.mjs --runs-dir ${JSON.stringify(runsTmp)}`, {
            encoding: "utf8",
            env: { ...process.env, CAMPAIGN_CHECK_STATUS_DIR: statusTmp },
            stdio: ["ignore", "pipe", "pipe"],
          }),
        };
      } catch (e) {
        return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
      }
    };

    try {
      writeFileSync(join(statusTmp, "F01.jsonl"), JSON.stringify(row) + "\n");
      const noEvidence = runCampaignCheck();
      check(
        "campaign-check: a T2 done row with no artifact and no dischargeEvidence fails",
        noEvidence.code !== 0,
        true,
      );

      const withEvidence = {
        ...row,
        dischargeEvidence: "Railway deploy 1234abcd SUCCESS; Actions run 999 job 1 REG-B900 passed",
      };
      writeFileSync(join(statusTmp, "F01.jsonl"), JSON.stringify(withEvidence) + "\n");
      const noArtifact = runCampaignCheck();
      check(
        "campaign-check: dischargeEvidence alone passes when no artifact exists at all",
        noArtifact.code,
        0,
      );

      // The regression this guards against: an artifact exists, but it does
      // not mention B900 at all (it covers some OTHER id). Before the fix
      // this turned B900 red even though its own dischargeEvidence was right
      // there.
      writeFileSync(
        join(runsTmp, "web-e2e.json"),
        JSON.stringify({
          suites: [
            {
              specs: [
                { title: "REG-B901 unrelated", tests: [{ results: [{ status: "passed" }] }] },
              ],
            },
          ],
        }),
      );
      const partialArtifact = runCampaignCheck();
      check(
        "campaign-check: an artifact silent on this id still falls back to dischargeEvidence",
        partialArtifact.code,
        0,
      );

      // The artifact IS authoritative for ids it actually covers — a REAL
      // hit still wins over dischargeEvidence, and a FAILING hit still fails
      // even with dischargeEvidence present.
      writeFileSync(
        join(runsTmp, "web-e2e.json"),
        JSON.stringify({
          suites: [
            { specs: [{ title: "REG-B900 e2e", tests: [{ results: [{ status: "failed" }] }] }] },
          ],
        }),
      );
      const failingHit = runCampaignCheck();
      check(
        "campaign-check: a REAL failing hit for this id still fails it, dischargeEvidence or not",
        failingHit.code !== 0,
        true,
      );

      // `deferred` is unrepresentable under one-row-per-id and was ruled out
      // (2026-09-02) — campaign-check must reject it as an invalid state, not
      // silently pass it through as "nothing to verify yet".
      writeFileSync(
        join(statusTmp, "F01.jsonl"),
        JSON.stringify({ ...row, state: "deferred" }) + "\n",
      );
      const deferredRow = runCampaignCheck();
      check(
        "campaign-check: rejects a row carrying the removed 'deferred' state",
        deferredRow.code !== 0,
        true,
      );

      // The token grammar (REG_TOKEN_RE, shared with bugs.mjs via
      // reg-token.mjs) allows up to 4 digits, and bugs.mjs's own id-argument
      // checks match it via BUG_ID_RE — but this gate's ROW-ID check used to
      // be hard-coded to exactly 1-3 digits, so a real `file`-minted B1000
      // row would be rejected by THIS check forever, an unrepairable claim.
      // An evidence-only state (already-fixed) reaches the row-id check with
      // no jest/e2e artifact needed at all.
      writeFileSync(
        join(statusTmp, "F01.jsonl"),
        JSON.stringify({
          id: "B1000",
          batch: "F01",
          tier: "T1",
          state: "already-fixed",
          pr: null,
          proof: null,
          evidence: "confirmed already fixed on master, see PR #123",
        }) + "\n",
      );
      const fourDigitRow = runCampaignCheck();
      check("campaign-check: a 4-digit id (B1000) passes the row-id grammar", fourDigitRow.code, 0);
    } finally {
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
  if (!BUG_ID_RE.test(typed)) fail('usage: move <B###> --to <F##> [--why "<reason>"]');
  const id = resolveId(typed);
  const to = normBatch(flag(args, "to"));

  const from = findShardOf(id);
  if (!from) fail(`${id} is in no ledger shard — nothing to move`);
  if (from === to) fail(`${id} is already in ${to}`);

  // The catalogue lock is OUTERMOST, exactly like `file`'s — `move` is a
  // catalogue writer too (it patches the row's `batch` field) and used to
  // read-modify-write bugs.jsonl with no lock of its own at all, so a
  // concurrent `file` landing between this read and this write silently lost
  // its own catalogue row. BOTH shards are then held for the whole transfer —
  // the duplicate check, the additive write to `to` and the drop from `from`
  // are one atomic unit, or a concurrent writer can observe (or create) the
  // transient duplicate. Taken in sorted order by `withShardLocks`, so two
  // opposite moves cannot deadlock against EACH OTHER; ordering against the
  // catalogue lock is one-way (catalogue, then shard — same as `file`), so
  // there is no cycle to deadlock on there either.
  withCatalogueLock(() =>
    withShardLocks([from, to], () => {
      const row = readShard(from).rows.find((r) => r.id === id);
      if (!row) fail(`${id} vanished from ${from}.jsonl while this move waited for the lock`);
      if (row.state !== "queued")
        fail(
          `${id} is ${row.state}, not queued — moving a bug that already carries a proof would orphan it from its batch's evidence`,
        );

      // Every check runs BEFORE any write. `findShardOf` alone only reports the
      // FIRST shard holding an id (readdir order), so a genuine duplicate landed
      // in some OTHER shard hides behind `from` whenever `from` happens to sort
      // first — this must still catch it, or a refused move turns one duplicate
      // into two instead of leaving the authoritative row untouched.
      const holders = readdirSync(STATUS_DIR())
        .filter((n) => n.endsWith(".jsonl"))
        .map((n) => n.replace(/\.jsonl$/, ""))
        .filter((b) => readShard(b).rows.some((r) => r.id === id));
      if (holders.length !== 1 || holders[0] !== from)
        fail(
          `refusing to move ${id}: it has a row in ${holders.join(", ")}, not only ${from} — this is ` +
            `the duplicate campaign-check rejects; repair the shards by hand before moving`,
        );

      // Write the TARGET first, additive. A refusal past this point (a duplicate
      // that slipped in between the check above and here) must never have
      // touched the source — `upsertLedgerRow`'s cross-shard guard would
      // otherwise reject this legitimate in-flight duplicate (the row still
      // lives in `from` until the drop below), so it is told explicitly that
      // `id` is allowed to exist in `from` for the length of this one call.
      const { row: landed } = upsertLedgerRow(to, { ...row, batch: to }, { allowExistingIn: from });
      if (landed?.batch !== to)
        fail(
          `ledger write for ${id} did not land in ${to} as intended — re-read row is ${JSON.stringify(landed)}`,
        );

      // Only NOW drop it from the source — the target write already landed and
      // was verified, so anything going wrong past this point leaves a loud,
      // campaign-check-visible duplicate rather than a vanished authoritative row.
      const old = readShard(from);
      const kept = old.rows.filter((r) => r.id !== id);
      writeFileSync(
        shardPath(from),
        kept.map((r) => JSON.stringify(r)).join(old.eol) + (kept.length ? old.eol : ""),
      );
      if (readShard(from).rows.some((r) => r.id === id))
        fail(`${id} is still present in ${shardPath(from)} after the drop — inspect it by hand`);

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
    }),
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
  // `=== "queued"` dropped the two states that matter most to a conflict
  // report: a REGRESSED row is open work, and an IN-FLIGHT row is being edited
  // right now. Claiming F11 used to delete the F11<->F12 pair from this output
  // at the exact moment someone needed to see it.
  const isOpen = (id) => CONFLICTING.has(g.state.get(id)?.state);

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
// An exception `fail()` did not anticipate (an IO error, a malformed shard a
// command forgot to guard) used to surface as a raw Node stack trace — this
// is a CLI a hook shells out to, and that reads as a crash rather than the
// one-line `bugs:` refusal every other failure prints. Set BUGS_DEBUG=1 to
// see the real stack while debugging.
try {
  cmds[cmd](rest);
} catch (e) {
  if (process.env.BUGS_DEBUG === "1") throw e;
  fail(`unexpected failure in ${cmd} — ${e.message}`);
}
