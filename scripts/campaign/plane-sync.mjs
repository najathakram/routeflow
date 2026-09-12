#!/usr/bin/env node
// plane-sync.mjs — mirrors the in-repo bug registry (`.claude/campaign/`) into
// Plane's BUGS project. See .claude/pipeline/2026-09-10-plane-sync/build-plan.md
// (DECIDE-27, owner ruling 2026-09-10) and .claude/pipeline/
// 2026-09-11-plane-harness/build-plan.md (WP2) for the full rationale.
//
// DIRECTION. The registry is the source of truth; Plane never writes back.
// This script derives one desired Plane work item per catalogue row, diffs it
// against what Plane already holds (matched by `external_id`, after an
// adoption pass that stamps `external_id` onto a matching human-created item —
// R1), and writes only the diffs. It never deletes — an item Plane holds with
// no matching registry row is left exactly as it is, reported and skipped,
// because deleting on the owner's behalf is not this script's call.
//
// SHARED CLIENT (WP1/R9). All HTTP — retry/backoff, the 50 req/min ceiling,
// the ≤4 writes/s floor, the denylist scan (R2), the write budget + ledger
// (R3), and identifier/name resolution — lives in plane-client.mjs, imported
// below. This file owns only the registry-to-Plane mapping, the adoption
// pass, the comment-on-close decision, and the CLI.
//
// WHY THIS RE-IMPLEMENTS TWO TINY READERS INSTEAD OF IMPORTING bugs.mjs.
// bugs.mjs's dispatcher runs at import time (its module-scope `cmds.*` table
// exists to be invoked by its own CLI tail, not to be imported as a library),
// so importing it here would run its dispatcher as a side effect of loading
// this file. The two rules this script needs from it — JSONL parsing, and
// "latest row wins per id, across every status shard" — are a few lines each
// (see readCatalogue/readLedgerState below); copied rather than imported, and
// kept in lockstep by the build plan's own reference to bugs.mjs's line
// numbers, not by a shared module.
//
// NEVER BLOCKS. Every failure mode here (no API key, a network error, a
// malformed registry) resolves to exit 0 with exactly one stderr line — never
// a thrown stack, never a non-zero exit — because Gate 5 in
// .claude/hooks/stop.mjs spawns this on every turn and must never fail a turn
// over Plane being unreachable. `--strict` (a human running this by hand)
// is the only way to get a non-zero exit out of a failure. `--help`/`-h` and
// an unknown flag are handled before any of that — see main() — so a bare
// `--help` can never fall through to a live run (the 2026-09-11 incident
// Landmine 3/R13 close).
//
// NO PLANE UUIDS, EVER. The BUGS project is resolved at runtime by its
// `identifier === "BUGS"`; Plane states are resolved at runtime by `name`.
// Hardcoding either id would work today and silently target the wrong
// project/state the day someone recreates the workspace. See T11/H11 in the
// self-test, which greps this file (and stop.mjs, plane-client.mjs, …) for a
// uuid-shaped literal.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  appendRun,
  createClient,
  CLOSED_MARKER,
  EXTERNAL_SOURCE,
  gitEnv,
  knob,
  loadDenylist,
  loadKnobs,
  NAME_ID_RE,
  repoRoot,
  stateDir,
} from "./plane-client.mjs";

// Resolved from this file's own location, independent of cwd — the same
// convention bugs.mjs uses for REPO_ROOT, so `node scripts/campaign/plane-sync.mjs`
// behaves the same whether invoked from the repo root (Gate 5) or elsewhere.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUGS_SCRIPT = join(REPO_ROOT, "scripts", "campaign", "bugs.mjs");
const SYNC_STATE_FILENAME = ".plane-sync-state.json";
const GITHUB_REPO = "najathakram/routeflow";

const sha256Hex = (s) => createHash("sha256").update(s).digest("hex");

// ── state / priority maps (build-plan.md WP1, verbatim) ────────────────────
export const STATE_BY_LEDGER = {
  queued: "Backlog",
  "in-flight": "In progress",
  proven: "Landing",
  "proven-pending-deploy": "Landing",
  done: "Live",
  regressed: "Backlog",
  refuted: "Cancelled",
  "already-fixed": "Cancelled",
  cancelled: "Cancelled",
};

// `none` is a real registry severity (a row filed with no severity assigned)
// AND one of Plane's own five priority values, so it maps straight through
// rather than tripping the unknown-severity warn below.
export const PRIORITY_BY_SEVERITY = {
  critical: "urgent",
  high: "high",
  medium: "medium",
  low: "low",
  none: "none",
};

// DIAGNOSTIC PREFIX. Every warn in this file says `Plane mirror warn:`, never
// the bare `Plane mirror:` prefix — Gate 5 in .claude/hooks/stop.mjs greps the
// child's merged output for /^Plane mirror:/ and relays that line as the
// turn's single report, so a warn sharing the prefix would compete with (and,
// before this rule, permanently mask) the summary/skip/failed line the gate
// exists to surface. Exactly one line per run carries the bare prefix.
//
// L-081 (state map is an explicit table): an unknown/unset ledger state maps
// to Backlog rather than throwing — a catalogue row with no ledger row yet
// (filed, never batched) is exactly "nothing has happened to it", i.e. Backlog.
export function mapState(ledgerState) {
  const key = ledgerState ?? "queued";
  const mapped = STATE_BY_LEDGER[key];
  if (mapped) return mapped;
  console.error(`Plane mirror warn: unknown ledger state "${key}" — mapping to Backlog`);
  return "Backlog";
}

export function mapPriority(severity) {
  const mapped = PRIORITY_BY_SEVERITY[severity];
  if (mapped) return mapped;
  console.error(`Plane mirror warn: unknown severity "${severity}" — mapping to medium priority`);
  return "medium";
}

// ── registry readers (JSONL parse + ledger latest-row-wins; see the file
// header for why these are re-implemented rather than imported) ───────────
function readCatalogue(registryDir) {
  const p = join(registryDir, "bugs.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// Latest state per bug id, read from every status shard — mirrors bugs.mjs's
// readState() (:166-185): later lines in a shard overwrite earlier ones for
// the same id, and every shard is folded into the one map.
function readLedgerState(registryDir) {
  const state = new Map();
  const statusDir = join(registryDir, "status");
  if (!existsSync(statusDir)) return state;
  for (const f of readdirSync(statusDir).filter((n) => n.endsWith(".jsonl"))) {
    const lines = readFileSync(join(statusDir, f), "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const row = JSON.parse(line);
      state.set(row.id, row);
    }
  }
  return state;
}

function readBoard(registryDir) {
  const p = join(registryDir, "board.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { batches: {} };
}

// Copy of bugs.mjs's boardIssue() (:500-507) — a board.json value is data an
// operator or a hostile fixture wrote, not necessarily a number: only a
// plain positive integer (string or number, no leading zero/sign) counts.
function boardIssue(raw) {
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  const t = String(raw).trim();
  return /^[1-9]\d*$/.test(t) ? Number(t) : null;
}

// Wave placement comes from spawning the real `bugs.mjs waves --json
// --no-claims` against THIS registry dir (never imported — see file header).
// `--no-claims` is mandatory here: without it, `waves` shells out to `gh` per
// candidate batch to check for a live lease, a network call this script must
// never make just to write a description line. Any failure (missing script,
// non-zero exit, unparsable JSON) yields an empty map, and every batch then
// reads "unknown" — the build plan's explicit fallback.
function computeWavePlacement(registryDir) {
  const placement = new Map();
  if (!existsSync(BUGS_SCRIPT)) return placement;
  let res;
  try {
    res = spawnSync(process.execPath, [BUGS_SCRIPT, "waves", "--json", "--no-claims"], {
      encoding: "utf8",
      env: { ...process.env, BUGS_ROOT: registryDir },
      timeout: 10_000,
    });
  } catch {
    return placement;
  }
  if (!res || res.status !== 0 || !res.stdout) return placement;
  let payload;
  try {
    payload = JSON.parse(res.stdout);
  } catch {
    return placement;
  }
  (payload.waves ?? []).forEach((wave, i) => {
    for (const b of wave ?? []) if (b?.batch) placement.set(b.batch, `wave ${i + 1}`);
  });
  for (const batch of payload.busy ?? []) if (!placement.has(batch)) placement.set(batch, "busy");
  for (const b of payload.blocked ?? []) {
    if (b?.batch) placement.set(b.batch, `blocked-by ${(b.blockedBy ?? []).join(", ")}`);
  }
  for (const b of payload.parked ?? []) {
    if (b?.batch && !placement.has(b.batch)) placement.set(b.batch, "parked");
  }
  for (const b of payload.skipped ?? []) {
    if (b?.batch && !placement.has(b.batch)) placement.set(b.batch, `skipped: ${b.why ?? ""}`);
  }
  return placement;
}

const esc = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

// R3's description block. Built WITHOUT the hash line first — the hash is a
// digest of the row/ledger/issue tuple, never of the HTML that quotes
// it — then the hash line is appended, so the description always ends with
// the exact `registry-hash: <sha256>` line the diff logic greps back out of
// `description_stripped`.
function buildDescriptionHtml({ row, ledgerRow, batch, issue, wavePlacement, hash }) {
  const lines = [
    `id: ${row.id}`,
    `title: ${row.title ?? ""}`,
    `location: ${row.location ?? ""}`,
    `severity: ${row.severity ?? "none"}`,
    `batch: ${batch ?? "—"}${issue ? ` (board issue #${issue})` : ""}`,
    `tier: ${ledgerRow?.tier ?? "—"}`,
    `state: ${ledgerRow?.state ?? "queued"}`,
    `pr: ${ledgerRow?.pr ? `#${ledgerRow.pr}` : "—"}`,
    `proof: ${ledgerRow?.proof ?? "—"}`,
    `evidence: ${ledgerRow?.evidence ?? "—"}`,
    `roundSha: ${ledgerRow?.roundSha ?? "—"}`,
    `sensitive: ${row.sensitiveFor?.length ? row.sensitiveFor.join(", ") : "none"}`,
    `wave: ${wavePlacement ?? "unknown"}`,
  ];
  const body = lines.map((l) => `<p>${esc(l)}</p>`).join("");
  return `${body}<p><code>registry-hash: ${hash}</code></p>`;
}

// R4's exact close-comment template, built only from the fields the ledger
// row actually carries — never invented. `state <ledger state>` is always
// present (it is what triggered the closure, e.g. "done" or "refuted"); every
// other bullet is conditional on the ledger row actually carrying that field.
function buildCloseCommentHtml(ledgerRow) {
  const bits = [`state ${esc(ledgerRow.state ?? "")}`];
  if (ledgerRow.batch) bits.push(`batch ${esc(ledgerRow.batch)}`);
  if (ledgerRow.pr) bits.push(`PR #${esc(ledgerRow.pr)}`);
  if (ledgerRow.roundSha) bits.push(`sha ${esc(String(ledgerRow.roundSha).slice(0, 7))}`);
  if (ledgerRow.proof) {
    bits.push(`proof ${esc(ledgerRow.proof)}${ledgerRow.tier ? ` / ${esc(ledgerRow.tier)}` : ""}`);
  }
  return `<p><b>Closed by the registry</b> · ${bits.join(" · ")}</p><p><small>${CLOSED_MARKER}</small></p>`;
}

// One desired Plane work item per catalogue row (R1/R2/R3). Never reads
// Plane itself — that is planDiff's/runSync's job — so this stays a pure,
// synchronous function of the registry directory's own content, which is
// exactly what makes it usable both as the sync's plan and as the digest
// self-test's oracle (T1).
//
// The wave line is INFORMATIONAL ONLY and deliberately outside the hash: it
// comes from a best-effort 10 s spawn of `bugs.mjs waves` whose failure mode
// is "every batch reads unknown", and folding that into the hash made one slow
// spawn flip the hash of every batched row — a full re-PATCH on a registry
// that never changed, then a second one when the next run succeeded. The wave
// text still renders in the description, re-asserted whenever anything the
// hash DOES cover changes. `wavePlacement` (a Map keyed by batch) can be
// injected to skip the spawn entirely.
//
// Each returned row also carries the raw `ledgerRow` (harness addition,
// 2026-09-11-plane-harness WP2) — the comment-on-close decision needs the
// ledger's own state/pr/proof/roundSha/tier verbatim, never re-derived from
// the mapped Plane fields. This changes no existing field and no hash input.
export function deriveDesired(registryDir, { wavePlacement: injectedWaves } = {}) {
  const catalogue = readCatalogue(registryDir);
  const ledger = readLedgerState(registryDir);
  const board = readBoard(registryDir);
  const wave = injectedWaves ?? computeWavePlacement(registryDir);

  return catalogue.map((row) => {
    const ledgerRow = ledger.get(row.id) ?? null;
    const batch = row.batch ?? ledgerRow?.batch ?? null;
    const issue = batch ? boardIssue(board.batches?.[batch]) : null;
    const wavePlacement = batch ? (wave.get(batch) ?? "unknown") : "unknown";
    const stateName = mapState(ledgerRow?.state);
    const priority = mapPriority(row.severity);
    const hash = sha256Hex(JSON.stringify([row, ledgerRow ?? null, issue ?? null]));
    const description_html = buildDescriptionHtml({
      row,
      ledgerRow,
      batch,
      issue,
      wavePlacement,
      hash,
    });
    return {
      external_source: EXTERNAL_SOURCE,
      external_id: row.id,
      name: `${row.id} · ${row.title}`,
      priority,
      stateName,
      description_html,
      hash,
      ledgerRow,
    };
  });
}

// sha256(bugs.jsonl + every status/*.jsonl, sorted, + board.json) — the
// digest Gate 5 short-circuits on. Deliberately does NOT include anything
// Plane-side (a real sha256 over exactly the files an ordinary `git diff` on
// `.claude/campaign` would touch), so an unrelated Plane-side edit can never
// mask a real registry change.
export function registryDigest(registryDir) {
  const parts = [];
  const bugsPath = join(registryDir, "bugs.jsonl");
  parts.push(existsSync(bugsPath) ? readFileSync(bugsPath, "utf8") : "");
  const statusDir = join(registryDir, "status");
  if (existsSync(statusDir)) {
    for (const f of readdirSync(statusDir)
      .filter((n) => n.endsWith(".jsonl"))
      .sort()) {
      parts.push(f);
      parts.push(readFileSync(join(statusDir, f), "utf8"));
    }
  }
  const boardPath = join(registryDir, "board.json");
  parts.push(existsSync(boardPath) ? readFileSync(boardPath, "utf8") : "");
  return sha256Hex(parts.join("\0"));
}

// The hash Plane's own `description_stripped` carries back, if any — the
// cheapest signal that the registry tuple behind a mirrored item has changed,
// used alongside (never instead of) the name/state/priority comparison below.
function extractExistingHash(descriptionStripped) {
  const m = /registry-hash:\s*([0-9a-f]{64})/i.exec(descriptionStripped ?? "");
  return m ? m[1].toLowerCase() : null;
}

// Diffs desired items against what Plane already holds, matched ONLY by
// `external_id` (R1 — never by name, which changes on a title edit). Never
// produces a delete: an existing item whose external_id has no desired
// counterpart is reported as an orphan and left exactly alone.
//
// The diff is on (name, state, priority, registry-hash) — R4 — in that order:
//
//  - name/state/priority come straight off the list response, so Plane-side
//    drift (an item created before a state existed, or a field hand-edited in
//    Plane) is re-asserted from the registry on the next run. A hash-only diff
//    left such an item wrong forever, `--check` reporting zero drift, because
//    the description still quoted the current registry hash.
//  - the registry-hash comparison runs ONLY when Plane actually returned
//    `description_stripped` (Landmine 1: the list response may omit it even
//    when `fields=` asks for it). An absent field means "unknown", not
//    "mismatch": treating it as a mismatch re-PATCHed every mirrored item on
//    every run, forever. Such a row is compared on name/state/priority alone
//    and otherwise presumed unchanged — the trade-off is that a
//    description-only change is re-asserted the next time one of those three
//    moves, which is strictly better than an unbounded write loop.
//
// A desired row whose Plane state name could not be resolved gets NO write at
// all (`skipped`) — creating it with an unset state would let Plane pick its
// own default and, once the hash matched, pin that wrong state permanently.
//
// UNVERIFIED (fix-round 1, F3). A row Plane returned WITHOUT
// `description_stripped` cannot have its registry-hash compared at all, so
// "presumed unchanged" is a presumption, not a verification. Such a row is
// counted as `unverified` and treated like `skipped` for bookkeeping: it is
// named in the summary, it is drift in `--check`/dry-run, and — above all —
// it never advances the digest, so the next run still does the full read
// instead of short-circuiting on a digest that never saw the gap.
export function planDiff(desired, existingItems) {
  const existingByExternalId = new Map(
    (existingItems ?? []).filter((it) => it.external_id).map((it) => [it.external_id, it]),
  );
  // Every desired row counts here, skipped ones included: a row this run
  // declined to write is still a row the registry knows about, never an orphan.
  const desiredIds = new Set(desired.map((d) => d.external_id));
  const creates = [];
  const patches = [];
  const skipped = [];
  const unverified = [];
  for (const d of desired) {
    if (d.stateId === undefined) {
      skipped.push(d.external_id);
      continue;
    }
    const existing = existingByExternalId.get(d.external_id);
    if (!existing) {
      creates.push(d);
      continue;
    }
    const fieldsDiffer =
      existing.name !== d.name || existing.state !== d.stateId || existing.priority !== d.priority;
    if (fieldsDiffer) {
      patches.push({ id: existing.id, desired: d, existing });
      continue;
    }
    if (typeof existing.description_stripped !== "string") {
      unverified.push(d.external_id);
      continue;
    }
    if (extractExistingHash(existing.description_stripped) !== d.hash) {
      patches.push({ id: existing.id, desired: d, existing });
    }
  }
  const orphans = (existingItems ?? [])
    .filter((it) => it.external_id && !desiredIds.has(it.external_id))
    .map((it) => it.external_id);
  return { creates, patches, orphans, skipped, unverified };
}

// ── comment-on-close local cache (R4) — .plane-sync-state.json under
// stateDir(), gitignored. `{closed: {"B###": ts}}`. A missing/unparsable file
// reads as "nothing cached" rather than throwing — the fallback (listing the
// item's own comments) still catches an already-closed item either way.
function loadSyncStateCache() {
  const p = join(stateDir(), SYNC_STATE_FILENAME);
  if (!existsSync(p)) return { closed: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return {
      closed: parsed && typeof parsed.closed === "object" && parsed.closed ? parsed.closed : {},
    };
  } catch {
    return { closed: {} };
  }
}

function saveSyncStateCache(cache) {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SYNC_STATE_FILENAME), JSON.stringify(cache));
}

// alreadyClosed(id): cache.closed[id] ?? (list comments -> some(c =>
// (c.comment_stripped || "").includes(CLOSED_MARKER))) — the hard line,
// verbatim. The fallback is read-only (GET), never a write, so a lost cache
// never re-triggers a duplicate comment even under `--max-writes 0`.
async function alreadyClosed(cache, id, client, projectId, itemId) {
  if (cache.closed?.[id]) return true;
  const comments = await client.listAll(`projects/${projectId}/work-items/${itemId}/comments/`);
  return comments.some((c) => (c.comment_stripped || "").includes(CLOSED_MARKER));
}

function planeConfig() {
  return {
    baseUrl: process.env.PLANE_BASE_URL || "https://api.plane.so",
    slug: process.env.PLANE_WORKSPACE_SLUG || "routeflow",
  };
}

// R14 — branch guard (incident 2026-09-11 23:26Z, L-074 class). The v1 Gate 5
// hook ran from a feature worktree at a turn end with the real key in the
// environment and created 282 live BUGS items (160 duplicates) — a hook
// inherits the session's cwd, so a write path must be dry by default off the
// integration branch. Resolved via `git rev-parse --abbrev-ref HEAD`, run
// with cwd = repoRoot() (never process.cwd(), for the same worktree-cwd
// reason) — never process.cwd(). Any failure (git missing, not a repo,
// non-zero exit, empty stdout) fails CLOSED: reported as branch "unknown",
// which is itself "not master", so the skip line says why without a second
// code path.
export function currentBranch() {
  let res;
  try {
    res = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot(),
      env: gitEnv(),
      encoding: "utf8",
      timeout: 5_000,
    });
  } catch {
    return "unknown";
  }
  if (!res || res.error || res.status !== 0) return "unknown";
  return (res.stdout || "").trim() || "unknown";
}

function isWriteAllowedBranch(branch) {
  return branch === "master" || branch === "main";
}

// ── the sync itself ─────────────────────────────────────────────────────────
// Never throws outward: every failure funnels into the single non-blocking
// "failed" summary line (R5). `--strict` is the only caller-visible way to
// turn that into a non-zero exit.
export async function runSync({
  registryDir,
  apiKey = process.env.PLANE_API_KEY,
  dryRun = false,
  checkOnly = false,
  // Accepted (Gate 5 passes --quiet) but no longer switches streams: the one
  // summary line always goes to stderr, quiet or not. Kept so the CLI contract
  // R6/R7 describe stays intact.
  quiet = false,
  strict = false,
  // Fix-round 1, F1b: a wall-clock ceiling on the WRITE phase. Unset (the
  // manual `npm run bugs:plane`) means unbounded — a first run mirroring 282
  // rows at ~260 ms/write takes minutes and must be allowed to finish. Gate 5
  // passes 18000, below its own child timeout, so a long run ends with a
  // reported partial instead of a killed child and silence: the digest is not
  // advanced, and the next turn continues where this one stopped.
  budgetMs,
  // R3/R12: a write-COUNT ceiling, independent of the time budget above.
  // Sync default 250 (spec.md R3); Gate 5 passes 25 (R12). Once reached, the
  // shared client defers every further write (never throws, never blocks) —
  // this script just stops counting them as created/updated and reports the
  // total via client.summary().deferred.
  maxWrites = 250,
  // R14: off master/main, writes are dry by default — this override (Gate 5
  // never sets it, per spec.md R14) is the only way to write from another
  // branch. Never affects --dry-run/--check, which never write regardless.
  allowBranch = false,
} = {}) {
  void quiet;
  const startedAt = Date.now();
  const budgetSpent = () =>
    typeof budgetMs === "number" && Number.isFinite(budgetMs) && Date.now() - startedAt >= budgetMs;
  const { baseUrl, slug } = planeConfig();
  // ONE line, ONE stream. The summary/skip/failed line goes to stderr only —
  // the stream Gate 5 reads and the terminal shows anyway — because writing it
  // to both printed every run's summary twice to a human.
  const emit = (line) => {
    process.stderr.write(`${line}\n`);
  };
  // R2 telemetry's `forbidden: {count, byPattern}` — the count comes from
  // client.summary().forbidden, but the per-pattern breakdown has to be
  // tallied here, at the one place every forbidden write is already named.
  const forbiddenByPattern = new Map();
  const warnForbidden = (id, patternName) => {
    console.error(`Plane mirror warn: ${id} forbidden (${patternName})`);
    forbiddenByPattern.set(patternName, (forbiddenByPattern.get(patternName) ?? 0) + 1);
  };
  const zeroClientSummary = () => ({
    writes: 0,
    deferred: 0,
    forbidden: 0,
    gets: 0,
    rateLimitSleeps: 0,
    retries: 0,
  });
  const zeroSyncBlock = () => ({
    adopted: 0,
    created: 0,
    patched: 0,
    comments: 0,
    links: 0,
    drift: false,
    wouldAdopt: 0,
  });
  // R2 telemetry (spec 2026-09-12-plane-learning): `client` is declared here
  // (not `const` inside the try) so a thrown failure before/after its
  // creation can still report the accurate write/GET counters it reached —
  // undefined only when the throw happened before createClient() ran.
  let client;

  try {
    const rows = deriveDesired(registryDir);
    const registryIds = new Set(rows.map((d) => d.external_id));
    client = createClient({ baseUrl, slug, apiKey, tool: "plane-sync", maxWrites });
    const cache = loadSyncStateCache();
    let adoptedCount = 0;
    let commentsPosted = 0;
    let linksPosted = 0;

    const project = await client.resolveProject("BUGS");
    const statesMap = await client.resolveStates(project.id); // Map<name-lower, {id, group}>
    const idToGroup = new Map([...statesMap.values()].map((s) => [s.id, s.group]));
    // Reverse of statesMap (id -> display name) — used only to make the F7
    // "state unknown" warn line readable; a stale/renamed state id naturally
    // has no entry here either, so the warn falls back to the bare id.
    const idToName = new Map([...statesMap.entries()].map(([name, s]) => [s.id, name]));
    // Resolve each DISTINCT desired state name once (one warn per missing
    // state, not one per row) and carry the id on every row, so both the diff
    // and the write bodies compare/send the same resolved id.
    const stateIdByName = new Map();
    for (const name of new Set(rows.map((d) => d.stateName))) {
      const entry = statesMap.get(String(name ?? "").toLowerCase());
      if (!entry) {
        console.error(
          `Plane mirror warn: no Plane state named "${name}" in BUGS — rows in that state are skipped`,
        );
      }
      stateIdByName.set(name, entry?.id);
    }
    const desired = rows.map((d) => ({ ...d, stateId: stateIdByName.get(d.stateName) }));

    // Landmine 1: `description_stripped` may be missing from the list
    // response even with `fields=` requested — see planDiff's own note. No
    // `external_source` filter here (unlike v1): adoption needs to SEE the
    // items that do NOT yet carry it.
    const items = await client.listAll(`projects/${project.id}/work-items/`, {
      query: { fields: "id,name,state,priority,external_id,description_stripped,sequence_id" },
    });

    // R1 adoption CANDIDATES — pure computation, no writes yet (fix-round 2b,
    // F1: the actual PATCH that stamps external_source/external_id is a
    // WRITE, and moved below, past both the --dry-run/--check return and the
    // R14 branch guard — see the "R1 adoption pass" block near the write
    // loops). Before creating an item for registry id B###, find an existing
    // BUGS item whose external_id is null and whose name matches
    // "B<n> · ..." with the same number. Two candidates for one id -> the
    // lowest sequence_id wins (warned about here, since the warn itself is
    // not a write and a dry-run/check caller still wants to see it).
    const byExt = new Map();
    const candidates = new Map();
    for (const it of items) {
      if (it.external_id) {
        byExt.set(it.external_id, it);
        continue;
      }
      const m = NAME_ID_RE.exec(it.name || "");
      if (m) {
        const id = `B${m[1]}`;
        (candidates.get(id) ?? candidates.set(id, []).get(id)).push(it);
      }
    }
    const adoptionWinners = new Map(); // id -> item (lowest sequence_id)
    for (const [id, list] of candidates) {
      if (byExt.has(id) || !registryIds.has(id)) continue;
      list.sort((a, b) => a.sequence_id - b.sequence_id);
      if (list.length > 1) {
        console.error(
          `Plane mirror warn: duplicate candidate ${id}: BUGS-${list.map((i) => i.sequence_id).join(", BUGS-")} (adopting the oldest)`,
        );
      }
      adoptionWinners.set(id, list[0]);
    }
    const adoptIds = new Set(adoptionWinners.keys());

    // Diff EXCLUDING rows pending adoption — they are neither a create (an
    // item already exists) nor a patch (nothing has been written to it yet),
    // so they must not double-count as either; they surface separately as
    // `wouldAdopt`/adoption below. Used for the orphan/skip warnings and the
    // --dry-run/--check summary; the real write path recomputes a full diff
    // once adoption has actually run (see below).
    const desiredPendingAdoptionExcluded = desired.filter((d) => !adoptIds.has(d.external_id));
    const {
      creates: earlyCreates,
      patches: earlyPatches,
      orphans,
      skipped,
      unverified,
    } = planDiff(desiredPendingAdoptionExcluded, [...byExt.values()]);

    // `Plane mirror warn:` prefix (F5): every diagnostic this script writes
    // must be distinguishable from the ONE bare-prefixed report line Gate 5
    // relays — an unprefixed orphan line read like a stray summary in a
    // terminal and in any log scraped for the gate's own prefix.
    for (const externalId of orphans) {
      console.error(`Plane mirror warn: ${externalId} has no registry row (left as is)`);
    }
    // Which ROWS were dropped for an unresolvable state, not just which state
    // is missing — a run that mirrors 279 of 282 rows has to say which three.
    const stateNameByExternalId = new Map(desired.map((d) => [d.external_id, d.stateName]));
    for (const externalId of skipped) {
      console.error(
        `Plane mirror warn: ${externalId} skipped — ` +
          `no Plane state named "${stateNameByExternalId.get(externalId)}"`,
      );
    }

    const wouldAdopt = adoptionWinners.size;

    if (dryRun || checkOnly) {
      for (const c of earlyCreates) console.log(`CREATE ${c.external_id}`);
      for (const p of earlyPatches) console.log(`UPDATE ${p.desired.external_id}`);
      // Deliberately NOT the real-write sentence: a no-write run must never be
      // mistakable for a run that actually created or updated anything.
      const summary =
        `Plane mirror: would create ${earlyCreates.length}, would update ${earlyPatches.length}` +
        (wouldAdopt > 0 ? `, would adopt ${wouldAdopt}` : "") +
        (skipped.length > 0 ? `, ${skipped.length} skipped (no Plane state)` : "") +
        (unverified.length > 0 ? `, ${unverified.length} unverified` : "") +
        ` (${checkOnly ? "check" : "dry-run"})`;
      emit(summary);
      // F3: an unverifiable row is drift, not silence — `--check` exits 1 on it
      // so a run that cannot prove a mirrored row matches never reads as clean.
      // An adoption candidate is drift too — F1: it is a write this run would
      // make, just not one --check/--dry-run is allowed to issue.
      const drift =
        earlyCreates.length +
          earlyPatches.length +
          skipped.length +
          unverified.length +
          wouldAdopt >
        0;
      return {
        exitCode: checkOnly && drift ? 1 : 0,
        created: earlyCreates.length,
        updated: earlyPatches.length,
        skipped: skipped.length,
        unverified: unverified.length,
        sync: { ...zeroSyncBlock(), drift, wouldAdopt },
        clientSummary: client.summary(),
      };
    }

    // R14 branch guard — checked only once dry-run/check (which never write)
    // are ruled out above, and BEFORE the R1 adoption PATCH loop (F1: adoption
    // is a write like any other, so it must never fire off master/main without
    // --allow-branch either). Listing and diffing above still ran in full, so
    // a skip here still reports accurate would-be drift via the warn lines
    // already emitted (orphans/skipped) plus the would-adopt count folded into
    // the skip line itself, it just makes zero POST/PATCH.
    const branch = currentBranch();
    if (!allowBranch && !isWriteAllowedBranch(branch)) {
      // stdout, not emit()/stderr: ruling-s4-s5.md T16 (the R14 oracle) reads
      // this exact line off stdout. Every other summary/skip/failed line in
      // this file stays stderr-only (the emit() comment's "one line, one
      // stream" rule) — this is the one line the oracle pins to stdout, so it
      // is written directly rather than through emit(), and only here. The
      // "; would adopt N" suffix is appended only when there is one, so the
      // original (pre-F1) exact-match line is unchanged when there is none.
      process.stdout.write(
        `Plane mirror: skipped writes (branch ${branch} is not master; ` +
          `pass --allow-branch to override)` +
          (wouldAdopt > 0 ? `; would adopt ${wouldAdopt}` : "") +
          `\n`,
      );
      return {
        exitCode: 0,
        created: 0,
        updated: 0,
        skipped: skipped.length,
        unverified: unverified.length,
        sync: {
          ...zeroSyncBlock(),
          drift:
            earlyCreates.length +
              earlyPatches.length +
              skipped.length +
              unverified.length +
              wouldAdopt >
            0,
          wouldAdopt,
        },
        clientSummary: client.summary(),
      };
    }

    // R1 adoption pass — the actual WRITE (F1: moved past both gates above).
    // PATCH stamps external_source/external_id on the winning candidate;
    // never deletes the loser of a duplicate pair.
    for (const [id, item] of adoptionWinners) {
      const r = await client.patch(
        `projects/${project.id}/work-items/${item.id}/`,
        { external_source: EXTERNAL_SOURCE, external_id: id },
        { ref: id },
      );
      if (r.forbidden) warnForbidden(id, r.forbidden.name);
      else if (!r.deferred) {
        byExt.set(id, { ...item, external_source: EXTERNAL_SOURCE, external_id: id });
        adoptedCount++;
      }
    }
    const existingItems = [...byExt.values()];

    // Full diff, recomputed now that adoption has actually happened — an
    // adopted item may still need a further name/state/priority/hash PATCH,
    // exactly like any other existing item.
    const {
      creates,
      patches,
      skipped: skippedFinal,
      unverified: unverifiedFinal,
    } = planDiff(desired, existingItems);

    let created = 0;
    let updated = 0;
    let budgetExhausted = false;
    const plannedWrites = creates.length + patches.length;

    for (const c of creates) {
      if (budgetSpent()) {
        budgetExhausted = true;
        break;
      }
      const r = await client.post(
        `projects/${project.id}/work-items/`,
        {
          external_source: c.external_source,
          external_id: c.external_id,
          name: c.name,
          state: c.stateId,
          priority: c.priority,
          description_html: c.description_html,
        },
        { ref: c.external_id },
      );
      if (r.forbidden) {
        warnForbidden(c.external_id, r.forbidden.name);
        continue;
      }
      if (r.deferred) continue;
      created++;
      // R4/T6: an item CREATED already in a closed state (the registry filed
      // it as already done) posts no comment — the description block already
      // carries the proof. No transition happened here, so nothing to do.
    }

    for (const p of patches) {
      if (budgetExhausted || budgetSpent()) {
        budgetExhausted = true;
        break;
      }
      const r = await client.patch(
        `projects/${project.id}/work-items/${p.id}/`,
        {
          name: p.desired.name,
          state: p.desired.stateId,
          priority: p.desired.priority,
          description_html: p.desired.description_html,
        },
        { ref: p.desired.external_id },
      );
      if (r.forbidden) {
        warnForbidden(p.desired.external_id, r.forbidden.name);
        continue;
      }
      if (r.deferred) continue;
      updated++;

      // comment-on-close decision (R4/R5) — per diff that changes state.
      // R5: Done (completed) -> Live is STILL a diff (distinct states), so a
      // patch that only moves within the completed/cancelled groups (e.g.
      // Done -> Live) must NOT be treated as "was open, now closed".
      if (p.existing.state !== p.desired.stateId) {
        // F7 (Opus fix-round 2b): a state id absent from idToGroup means the
        // item's `state` is stale/renamed — not in the workspace's current
        // state list at all. Treating a missing lookup as "not completed/
        // cancelled" (JS `.includes(undefined)` is false) made wasOpen true
        // for a state we know nothing about, so a close comment could post on
        // an item that was never observed open. An unknown previous group
        // posts NO comment — just one warn line — rather than guessing.
        const existingGroup = idToGroup.get(p.existing.state);
        if (existingGroup === undefined) {
          console.error(
            `Plane mirror warn: state ${idToName.get(p.existing.state) ?? p.existing.state} ` +
              `unknown, skipping close comment for ${p.desired.external_id}`,
          );
        } else {
          const wasOpen = !["completed", "cancelled"].includes(existingGroup);
          const nowClosed = ["completed", "cancelled"].includes(idToGroup.get(p.desired.stateId));
          if (wasOpen && nowClosed) {
            const id = p.desired.external_id;
            if (!(await alreadyClosed(cache, id, client, project.id, p.id))) {
              const ledgerRow = p.desired.ledgerRow ?? {};
              const cr = await client.post(
                `projects/${project.id}/work-items/${p.id}/comments/`,
                { comment_html: buildCloseCommentHtml(ledgerRow) },
                { ref: id },
              );
              if (cr.forbidden) {
                warnForbidden(id, cr.forbidden.name);
              } else if (!cr.deferred) {
                commentsPosted++;
                if (ledgerRow.pr) {
                  const lr = await client.post(
                    `projects/${project.id}/work-items/${p.id}/links/`,
                    { url: `https://github.com/${GITHUB_REPO}/pull/${ledgerRow.pr}` },
                    { ref: id },
                  );
                  if (!lr.forbidden && !lr.deferred) linksPosted++;
                }
                cache.closed[id] = new Date().toISOString();
                saveSyncStateCache(cache);
              }
            }
          }
        }
      }
    }

    const clientSummary = client.summary();
    const { deferred: deferredTotal, forbidden: forbiddenTotal } = clientSummary;
    // R4 telemetry's `drift` reuses the exact condition the digest-write gate
    // just below checks — a run that left something unsynced (skipped state,
    // unverified hash, exhausted budget, deferred, or forbidden write) IS
    // drift, by the same definition the digest short-circuit relies on.
    const driftAfterWrite = () =>
      !(
        skippedFinal.length === 0 &&
        unverifiedFinal.length === 0 &&
        !budgetExhausted &&
        deferredTotal === 0 &&
        forbiddenTotal === 0
      );

    // Landmine 3 (build-plan.md): the digest is written ONLY after every
    // write above succeeded AND no row was skipped/unverified/deferred/
    // forbidden — a run that fails partway through, that leaves a row
    // unwritten for lack of a Plane state, that hit `--max-writes`, or that
    // had a write skipped by the denylist, must be retried in full (or for
    // the affected rows) next time, never short-circuited on a digest that
    // never saw the gap. Landmine 5: this is independent of the ledger file.
    if (
      skippedFinal.length === 0 &&
      unverifiedFinal.length === 0 &&
      !budgetExhausted &&
      deferredTotal === 0 &&
      forbiddenTotal === 0
    ) {
      writeFileSync(join(registryDir, ".plane-sync-digest"), registryDigest(registryDir));
    }

    if (budgetExhausted) {
      emit(
        `Plane mirror: synced ${created + updated} of ${plannedWrites} writes ` +
          `(budget exhausted, rerun to continue)`,
      );
      return {
        exitCode: strict ? 1 : 0,
        created,
        updated,
        skipped: skippedFinal.length,
        unverified: unverifiedFinal.length,
        budgetExhausted: true,
        sync: {
          adopted: adoptedCount,
          created,
          patched: updated,
          comments: commentsPosted,
          links: linksPosted,
          drift: driftAfterWrite(),
          wouldAdopt,
        },
        clientSummary,
        forbiddenByPattern: Object.fromEntries(forbiddenByPattern),
      };
    }

    let summaryLine = `Plane mirror: ${created} created, ${updated} updated`;
    if (skippedFinal.length > 0) summaryLine += `, ${skippedFinal.length} skipped (no Plane state)`;
    if (unverifiedFinal.length > 0) summaryLine += `, ${unverifiedFinal.length} unverified`;
    if (deferredTotal > 0) summaryLine += `, deferred=${deferredTotal}`;
    if (forbiddenTotal > 0) summaryLine += `, skipped(forbidden)=${forbiddenTotal}`;
    emit(summaryLine);
    return {
      exitCode: 0,
      created,
      updated,
      skipped: skippedFinal.length,
      unverified: unverifiedFinal.length,
      sync: {
        adopted: adoptedCount,
        created,
        patched: updated,
        comments: commentsPosted,
        links: linksPosted,
        drift: driftAfterWrite(),
        wouldAdopt,
      },
      clientSummary,
      forbiddenByPattern: Object.fromEntries(forbiddenByPattern),
    };
  } catch (err) {
    const message = `${err?.name ?? "Error"}: ${String(err?.message ?? err).slice(0, 200)}`;
    emit(`Plane mirror: failed (non-blocking) — ${err?.message ?? err}`);
    return {
      exitCode: strict ? 1 : 0,
      created: 0,
      updated: 0,
      skipped: 0,
      unverified: 0,
      sync: zeroSyncBlock(),
      error: message,
      forbiddenByPattern: Object.fromEntries(forbiddenByPattern),
      clientSummary: client ? client.summary() : zeroClientSummary(),
    };
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────
const USAGE =
  "Usage: plane-sync.mjs [--dry-run] [--check] [--quiet] [--strict] " +
  "[--if-digest-changed] [--budget-ms <n>] [--max-writes <n>] [--allow-branch] [--help]";

const KNOWN_FLAGS = new Set([
  "--dry-run",
  "--check",
  "--quiet",
  "--strict",
  "--if-digest-changed",
  "--budget-ms",
  "--max-writes",
  "--allow-branch",
]);

async function main() {
  const argv = process.argv.slice(2);

  // Landmine 3/R13/T15: --help/-h and an unknown flag are handled BEFORE
  // process.env.PLANE_API_KEY is read at all, before any network call — the
  // 2026-09-11 incident (a bare --help fell through to a live run and hit
  // HTTP 429) this requirement exists to close.
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 0;
    return;
  }
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--budget-ms" || tok === "--max-writes") {
      i++; // consume the value token, never validated as a flag itself
      continue;
    }
    if (!KNOWN_FLAGS.has(tok)) {
      process.stderr.write(`${USAGE}\n`);
      process.exitCode = 2;
      return;
    }
  }

  // R2 telemetry (spec 2026-09-12-plane-learning): started/rec are set up
  // BEFORE loadKnobs() so a `knobs invalid: <name>` throw still gets exactly
  // one runs.jsonl line via the finally below — the only exits that write NO
  // telemetry are the --help/usage ones handled above, before this point.
  const started = Date.now();
  const rec = { tool: "plane-sync", flags: argv, branch: currentBranch() };
  let clientSummaryForRun = {
    writes: 0,
    deferred: 0,
    forbidden: 0,
    gets: 0,
    rateLimitSleeps: 0,
    retries: 0,
  };
  let forbiddenByPatternForRun = {};

  try {
    // R1: loaded right after --help/usage handling, before any process.env
    // read or network request — a caller needing the exact "knobs invalid:
    // <name>" text sees it before anything else happens (T1). Printed
    // explicitly (not left to the outer catch) so that text always reaches
    // stderr, matching every other fail-closed check in this file.
    let knobs;
    try {
      knobs = loadKnobs();
    } catch (err) {
      // T1's contract is specifically an out-of-range VALUE in an otherwise
      // present knobs file — that case hard-fails, exit != 0, zero requests.
      // A missing/unreadable file (e.g. this script copied somewhere without
      // its sibling plane-knobs.json) is a different failure class: this
      // file's own "NEVER BLOCKS" rule wins instead, falling back to the
      // knob's documented default rather than refusing to run at all.
      if (/^knobs invalid:/.test(String(err?.message ?? ""))) {
        process.stderr.write(`Plane mirror: ${err.message}\n`);
        process.exitCode = 1;
        rec.error = `${err?.name ?? "Error"}: ${String(err.message).slice(0, 200)}`;
        return;
      }
      console.error(
        `Plane mirror warn: knobs unavailable (${err?.message ?? err}) — using defaults`,
      );
      knobs = { knobs: { syncMaxWrites: { value: 250 } } };
    }

    const dryRun = argv.includes("--dry-run");
    const checkOnly = argv.includes("--check");
    const quiet = argv.includes("--quiet");
    const strict = argv.includes("--strict");
    const ifDigestChanged = argv.includes("--if-digest-changed");
    // R14: Gate 5 never passes this (spec.md R14) — a human running the script
    // by hand off master/main is the only caller who can.
    const allowBranch = argv.includes("--allow-branch");
    // `--budget-ms <n>`: NO default. Unbounded is the right behavior for a human
    // running `npm run bugs:plane` (a first mirror of the whole registry must be
    // allowed to finish); only Gate 5 passes a budget, because only Gate 5 has a
    // turn to hand back.
    let budgetMs;
    const budgetIdx = argv.indexOf("--budget-ms");
    if (budgetIdx !== -1) {
      const raw = Number(argv[budgetIdx + 1]);
      if (Number.isFinite(raw) && raw >= 0) budgetMs = raw;
      else
        process.stderr.write(
          `Plane mirror warn: ignoring --budget-ms "${argv[budgetIdx + 1] ?? ""}" (not a non-negative number)\n`,
        );
    }
    // `--max-writes <n>` (R3/R12): default from the `syncMaxWrites` knob
    // (spec 2026-09-12-plane-learning R1); a CLI flag still overrides it.
    let maxWrites = knobs.knobs.syncMaxWrites.value;
    const mwIdx = argv.indexOf("--max-writes");
    if (mwIdx !== -1) {
      const raw = Number(argv[mwIdx + 1]);
      if (Number.isFinite(raw) && raw >= 0) maxWrites = raw;
      else
        process.stderr.write(
          `Plane mirror warn: ignoring --max-writes "${argv[mwIdx + 1] ?? ""}" (not a non-negative number)\n`,
        );
    }
    const registryDir =
      process.env.PLANE_SYNC_REGISTRY_DIR || join(REPO_ROOT, ".claude", "campaign");

    const apiKey = process.env.PLANE_API_KEY;
    if (!apiKey) {
      process.stderr.write("Plane mirror: skipped (no PLANE_API_KEY)\n");
      process.exitCode = 0;
      rec.skipped = "no PLANE_API_KEY";
      return;
    }

    // Fail-closed denylist check (F3, fix-round 2b): unlike a network hiccup
    // (which this script never blocks a turn over), a missing denylist file is
    // a broken checkout/config — R2's write-scan would fail open on it. Checked
    // here, before any network call, so this exits non-zero with zero writes
    // regardless of --strict.
    try {
      loadDenylist();
    } catch (err) {
      process.stderr.write(`Plane mirror: ${err?.message ?? err}\n`);
      process.exitCode = 1;
      rec.error = `${err?.name ?? "Error"}: ${String(err?.message ?? err).slice(0, 200)}`;
      return;
    }

    if (ifDigestChanged && !dryRun && !checkOnly) {
      const digestPath = join(registryDir, ".plane-sync-digest");
      let current;
      try {
        current = registryDigest(registryDir);
      } catch (err) {
        process.stderr.write(`Plane mirror: failed (non-blocking) — ${err?.message ?? err}\n`);
        process.exitCode = strict ? 1 : 0;
        rec.error = `${err?.name ?? "Error"}: ${String(err?.message ?? err).slice(0, 200)}`;
        return;
      }
      const stored = existsSync(digestPath) ? readFileSync(digestPath, "utf8").trim() : null;
      if (stored === current) {
        process.exitCode = 0;
        return;
      }
    }

    // NEVER process.exit() here: fetch (undici) can leave a keep-alive socket
    // mid-teardown, and a forced exit racing that teardown crashes Node with a
    // libuv assertion (observed on Windows: src/win/async.c, UV_HANDLE_CLOSING)
    // instead of exiting with the intended code. Setting exitCode and returning
    // lets the event loop drain and close its own handles before Node exits.
    const result = await runSync({
      registryDir,
      apiKey,
      dryRun,
      checkOnly,
      quiet,
      strict,
      budgetMs,
      maxWrites,
      allowBranch,
    });
    process.exitCode = result.exitCode;
    if (result.sync) rec.sync = result.sync;
    if (result.clientSummary) clientSummaryForRun = result.clientSummary;
    if (result.forbiddenByPattern) forbiddenByPatternForRun = result.forbiddenByPattern;
    // runSync catches its own network/registry failures internally (never
    // throws out — this script never blocks a turn over them) and reports
    // them via its own `error` field instead, so this outer catch alone
    // would never see them; propagate it here so the telemetry line still
    // names the failure (T2-sync-500).
    if (result.error) rec.error = result.error;
  } catch (err) {
    rec.error = `${err?.name ?? "Error"}: ${String(err?.message ?? err).slice(0, 200)}`;
  } finally {
    const { forbidden: forbiddenCount, ...restSummary } = clientSummaryForRun;
    appendRun({
      ...rec,
      exit: process.exitCode ?? 0,
      durationMs: Date.now() - started,
      ...restSummary,
      forbidden: { count: forbiddenCount ?? 0, byPattern: forbiddenByPatternForRun },
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
