#!/usr/bin/env node
// plane-sync.mjs — mirrors the in-repo bug registry (`.claude/campaign/`) into
// Plane's BUGS project. See .claude/pipeline/2026-09-10-plane-sync/build-plan.md
// (DECIDE-27, owner ruling 2026-09-10) for the full rationale.
//
// DIRECTION. The registry is the source of truth; Plane never writes back.
// This script derives one desired Plane work item per catalogue row, diffs it
// against what Plane already holds (matched by `external_id`, never by
// title), and writes only the diffs. It never deletes — an item Plane holds
// with no matching registry row is left exactly as it is, reported and
// skipped, because deleting on the owner's behalf is not this script's call.
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
// is the only way to get a non-zero exit out of a failure.
//
// NO PLANE UUIDS, EVER. The BUGS project is resolved at runtime by its
// `identifier === "BUGS"`; Plane states are resolved at runtime by `name`.
// Hardcoding either id would work today and silently target the wrong
// project/state the day someone recreates the workspace. See T11 in the
// self-test, which greps this file (and stop.mjs) for a uuid-shaped literal.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

// Resolved from this file's own location, independent of cwd — the same
// convention bugs.mjs uses for REPO_ROOT, so `node scripts/campaign/plane-sync.mjs`
// behaves the same whether invoked from the repo root (Gate 5) or elsewhere.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUGS_SCRIPT = join(REPO_ROOT, "scripts", "campaign", "bugs.mjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
      external_source: "routeflow-registry",
      external_id: row.id,
      name: `${row.id} · ${row.title}`,
      priority,
      stateName,
      description_html,
      hash,
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

// ── the Plane REST client (~40 lines, per the build plan — the gitignored
// kit's shape copied for X-API-Key/retry, but this script owns its own) ────
function planeConfig() {
  return {
    baseUrl: process.env.PLANE_BASE_URL || "https://api.plane.so",
    slug: process.env.PLANE_WORKSPACE_SLUG || "routeflow",
  };
}

// Retries 429/5xx up to 3x, honouring `x-ratelimit-reset` (epoch seconds) when
// present; falls back to a short linear backoff otherwise. Anything else that
// isn't 2xx throws, which runSync turns into the one non-blocking failure
// line (R5).
async function planeRequest(baseUrl, apiKey, method, path, { body, query } = {}) {
  const url = new URL(path, baseUrl);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const maxRetries = 3;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { "X-API-Key": apiKey, "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
      const resetHeader = res.headers.get("x-ratelimit-reset");
      let waitMs = 300 * (attempt + 1);
      if (resetHeader) {
        const resetAtMs = Number(resetHeader) * 1000;
        if (Number.isFinite(resetAtMs)) waitMs = Math.max(waitMs, resetAtMs - Date.now() + 50);
      }
      await sleep(Math.min(Math.max(waitMs, 0), 5000));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `${method} ${path} -> HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      );
    }
    if (res.status === 204) return null;
    // Landmine 2: a caller told "no budget left" should not immediately fire
    // its next request into the same window.
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining === "0") {
      const resetHeader = res.headers.get("x-ratelimit-reset");
      const resetAtMs = resetHeader ? Number(resetHeader) * 1000 : NaN;
      if (Number.isFinite(resetAtMs)) await sleep(Math.max(0, resetAtMs - Date.now() + 50));
    }
    return res.json();
  }
}

// Landmine 2 (rate limit ≤ 4 writes/s): a floor on the gap between two
// consecutive POST/PATCH calls, independent of whatever the response headers
// say — cheap insurance against ever bursting past Plane's write budget.
let lastWriteAt = 0;
const MIN_WRITE_INTERVAL_MS = 260;
async function throttleWrite() {
  const wait = lastWriteAt + MIN_WRITE_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastWriteAt = Date.now();
}

async function findBugsProject(baseUrl, apiKey, slug) {
  const page = await planeRequest(baseUrl, apiKey, "GET", `/api/v1/workspaces/${slug}/projects/`);
  const project = (page.results ?? []).find((p) => p.identifier === "BUGS");
  if (!project) throw new Error(`no project with identifier "BUGS" in workspace "${slug}"`);
  return project;
}

async function fetchStates(baseUrl, apiKey, slug, projectId) {
  const page = await planeRequest(
    baseUrl,
    apiKey,
    "GET",
    `/api/v1/workspaces/${slug}/projects/${projectId}/states/`,
  );
  return page.results ?? [];
}

// Case-insensitive on purpose: Plane's stock board ships "In Progress" while
// STATE_BY_LEDGER spells it "In progress", and a case-sensitive miss used to
// mean "create the item with no state at all".
function resolveStateId(states, stateName) {
  const wanted = String(stateName ?? "").toLowerCase();
  const match = states.find((s) => String(s.name ?? "").toLowerCase() === wanted);
  if (!match) {
    console.error(
      `Plane mirror warn: no Plane state named "${stateName}" in BUGS — rows in that state are skipped`,
    );
    return undefined;
  }
  return match.id;
}

const workItemsPath = (slug, projectId) =>
  `/api/v1/workspaces/${slug}/projects/${projectId}/work-items/`;

// Landmine 1: `description_stripped` may be missing from the list response
// even with `fields=` requested. There is deliberately NO per-item GET to
// recover it: an item whose list row lacks the field is compared on
// name/state/priority only and otherwise presumed unchanged (see planDiff).
// Trading a per-item GET per mirrored row — 282 of them, against Gate 5's
// 25 s budget — for "a description-only change is re-asserted the next time
// name/state/priority move" is the cheaper side of that trade.
async function fetchAllWorkItems(baseUrl, apiKey, slug, projectId) {
  const items = [];
  let cursor;
  do {
    const page = await planeRequest(baseUrl, apiKey, "GET", workItemsPath(slug, projectId), {
      query: {
        external_source: "routeflow-registry",
        per_page: "100",
        fields: "id,name,state,priority,external_id,description_stripped",
        ...(cursor ? { cursor } : {}),
      },
    });
    items.push(...(page.results ?? []));
    cursor = page.next_page_results ? page.next_cursor : null;
  } while (cursor);
  return items;
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

  try {
    const rows = deriveDesired(registryDir);
    const project = await findBugsProject(baseUrl, apiKey, slug);
    const states = await fetchStates(baseUrl, apiKey, slug, project.id);
    // Resolve each DISTINCT desired state name once (one warn per missing
    // state, not one per row) and carry the id on every row, so both the diff
    // and the write bodies compare/send the same resolved id.
    const stateIdByName = new Map();
    for (const name of new Set(rows.map((d) => d.stateName))) {
      stateIdByName.set(name, resolveStateId(states, name));
    }
    const desired = rows.map((d) => ({ ...d, stateId: stateIdByName.get(d.stateName) }));
    const existingItems = await fetchAllWorkItems(baseUrl, apiKey, slug, project.id);
    const { creates, patches, orphans, skipped, unverified } = planDiff(desired, existingItems);

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

    if (dryRun || checkOnly) {
      for (const c of creates) console.log(`CREATE ${c.external_id}`);
      for (const p of patches) console.log(`UPDATE ${p.desired.external_id}`);
      // Deliberately NOT the real-write sentence: a no-write run must never be
      // mistakable for a run that actually created or updated anything.
      const summary =
        `Plane mirror: would create ${creates.length}, would update ${patches.length}` +
        (skipped.length > 0 ? `, ${skipped.length} skipped (no Plane state)` : "") +
        (unverified.length > 0 ? `, ${unverified.length} unverified` : "") +
        ` (${checkOnly ? "check" : "dry-run"})`;
      emit(summary);
      // F3: an unverifiable row is drift, not silence — `--check` exits 1 on it
      // so a run that cannot prove a mirrored row matches never reads as clean.
      const drift = creates.length + patches.length + skipped.length + unverified.length > 0;
      return {
        exitCode: checkOnly && drift ? 1 : 0,
        created: creates.length,
        updated: patches.length,
        skipped: skipped.length,
        unverified: unverified.length,
      };
    }

    let created = 0;
    let updated = 0;
    let budgetExhausted = false;
    const plannedWrites = creates.length + patches.length;
    for (const c of creates) {
      if (budgetSpent()) {
        budgetExhausted = true;
        break;
      }
      await throttleWrite();
      await planeRequest(baseUrl, apiKey, "POST", workItemsPath(slug, project.id), {
        body: {
          external_source: c.external_source,
          external_id: c.external_id,
          name: c.name,
          state: c.stateId,
          priority: c.priority,
          description_html: c.description_html,
        },
      });
      created++;
    }
    for (const p of patches) {
      if (budgetExhausted || budgetSpent()) {
        budgetExhausted = true;
        break;
      }
      await throttleWrite();
      await planeRequest(baseUrl, apiKey, "PATCH", `${workItemsPath(slug, project.id)}${p.id}/`, {
        body: {
          name: p.desired.name,
          state: p.desired.stateId,
          priority: p.desired.priority,
          description_html: p.desired.description_html,
        },
      });
      updated++;
    }

    // Landmine 3: the digest is written ONLY after every write above
    // succeeded AND no row was skipped — a run that fails partway through, or
    // that leaves a row unwritten for lack of a Plane state, must be retried
    // in full (or re-tried for the skipped rows) next time, not
    // short-circuited on a digest that never saw the gap.
    //
    // Fix-round 1 adds two more gaps with exactly the same rule: a row whose
    // Plane copy could not be verified (F3, no `description_stripped`), and a
    // run that stopped early on `--budget-ms` (F1b). Either one means the
    // digest would certify state this run never established.
    if (skipped.length === 0 && unverified.length === 0 && !budgetExhausted) {
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
        skipped: skipped.length,
        unverified: unverified.length,
        budgetExhausted: true,
      };
    }

    emit(
      `Plane mirror: ${created} created, ${updated} updated` +
        (skipped.length > 0 ? `, ${skipped.length} skipped (no Plane state)` : "") +
        (unverified.length > 0 ? `, ${unverified.length} unverified` : ""),
    );
    return {
      exitCode: 0,
      created,
      updated,
      skipped: skipped.length,
      unverified: unverified.length,
    };
  } catch (err) {
    emit(`Plane mirror: failed (non-blocking) — ${err?.message ?? err}`);
    return { exitCode: strict ? 1 : 0, created: 0, updated: 0, skipped: 0, unverified: 0 };
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const checkOnly = argv.includes("--check");
  const quiet = argv.includes("--quiet");
  const strict = argv.includes("--strict");
  const ifDigestChanged = argv.includes("--if-digest-changed");
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
  const registryDir = process.env.PLANE_SYNC_REGISTRY_DIR || join(REPO_ROOT, ".claude", "campaign");

  const apiKey = process.env.PLANE_API_KEY;
  if (!apiKey) {
    process.stderr.write("Plane mirror: skipped (no PLANE_API_KEY)\n");
    process.exitCode = 0;
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
  });
  process.exitCode = result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
