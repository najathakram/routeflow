#!/usr/bin/env node
// plane-client.mjs — the one Plane REST client plane-sync/intake/triage/apply
// import instead of each re-implementing retry/rate-limit/pagination (R9).
// Extracted from v1 plane-sync.mjs's inline planeRequest/throttleWrite/
// findBugsProject/fetchStates (behaviour kept byte-for-byte where a self-test
// pins it — the 429/5xx retry x3, the x-ratelimit-remaining:0 sleep-to-reset,
// and the ≤4 writes/s floor via MIN_WRITE_INTERVAL_MS=260 are all unchanged).
//
// NEW IN THIS FILE (build-plan.md WP1 / spec.md R2, R3, R9):
//   - a 50 req/min token-bucket ceiling across every request this client
//     issues (spec.md's binding rules: "Rate limit ≤ 50 req/min via the
//     shared client"), independent of the per-write 260ms floor;
//   - the denylist scan (R2) on every outbound POST/PATCH/DELETE body,
//     recursively over every string value that sits under a CONTENT_KEYS
//     field (name/description*/comment*/url/title/html) — never a Plane id
//     (state/labels/assignees/parent/type_id/issues/...), even a uuid-shaped
//     one — a hit makes NO request. Defect fixed 2026-09-12 (proven live):
//     the scan used to walk EVERY string regardless of key, so a uuid-shaped
//     state/label/assignee id tripped the tenant-uuid pattern purely by
//     coincidental shape — the first bulk sync created 0/72 and patched
//     0/160 (skipped(forbidden)=232), and plane-apply refused every op that
//     named a state or label. R2's "every outbound string" always meant
//     CONTENT a human or this codebase wrote, never an id Plane itself
//     handed back on a runtime resolve;
//   - the write budget + ledger (R3): a per-client write counter that defers
//     once `maxWrites` is reached, and appends one line per ACTUAL write to
//     `.claude/campaign/.plane-writes.jsonl` (never for a deferred or
//     forbidden write — see T4: 3 successful POSTs under `--max-writes 3`
//     produce exactly 3 ledger lines, not 5).
//
// NO PLANE UUIDS, EVER (same rule as v1) — projects resolve by `identifier`,
// states/labels/types/members resolve by name, all at runtime. See T11's
// literal-scan, extended to this file.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const THIS_FILE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DENYLIST_PATH = join(THIS_FILE_DIR, "plane-denylist.json");
const LEDGER_FILENAME = ".plane-writes.jsonl";
const RUNS_FILENAME = "runs.jsonl";

// PLANE_DENYLIST_PATH is a TEST-ONLY override (fix-round 2b, F3; hardened
// fix-round 3, NEW-1) — it lets a self-test point this at a path that does
// not exist (or an empty fixture) to prove the fail-closed behavior below
// without touching the real denylist file. Honoured ONLY when
// PLANE_SYNC_SELF_TEST=1 is ALSO set (house precedent: SCHEMA_DRIFT_PRISMA_CLI
// — a test-only override is worthless unarmed by a second, harder-to-set-by-
// accident marker). Resolved lazily inside loadDenylist(), never at module
// load, so an accidental env leak into a production process is inert unless
// the marker is set too — and even then, one line goes to stderr every time.
function resolveDenylistPath() {
  const override = process.env.PLANE_DENYLIST_PATH;
  if (!override) return DEFAULT_DENYLIST_PATH;
  if (process.env.PLANE_SYNC_SELF_TEST === "1") {
    console.error("Plane client WARNING: denylist override in effect (self-test)");
    return override;
  }
  console.error("Plane client WARNING: PLANE_DENYLIST_PATH ignored outside self-tests");
  return DEFAULT_DENYLIST_PATH;
}

const DEFAULT_BASE_URL = "https://api.plane.so";
const DEFAULT_SLUG = "routeflow";
// Landmine 4 (build-plan.md): ≤ 4 writes/s is a floor independent of response
// headers — kept from v1's MIN_WRITE_INTERVAL_MS, never bypassed.
const MIN_WRITE_INTERVAL_MS = 260;
// spec.md binding rules: "Rate limit ≤ 50 req/min via the shared client" —
// a sliding-window ceiling across every request (GET included), separate
// from the per-write floor above.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_PER_WINDOW = 50;
const MAX_RETRIES = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// git exports repo-scoped vars (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
// GIT_PREFIX, ...) into every child process it runs — including
// `npm run verify` under the husky pre-push hook. A `git` spawn anywhere in
// this family that inherits process.env verbatim can silently re-point at
// whatever repo the OUTER git invocation happens to be, instead of the cwd
// the caller actually intends (reference_git_worktreeconfig_bare_trap_
// 2026-09-04; gates/push.log ~11716 — the self-test's own throwaway-repo
// fixtures hit exactly this, "fatal: this operation must be run in a work
// tree", under the hook's env). Every git spawn in this family (plane-sync.mjs,
// plane-intake.mjs, and both self-tests' fixture setup) must pass
// `env: gitEnv()` alongside an explicit `cwd` — never inherit process.env
// into a git child unscrubbed. GIT_AUTHOR_*/GIT_COMMITTER_* are left alone:
// harmless (an explicit -c user.name/user.email is set at every commit site
// in this family regardless) and not part of the reported failure mode.
const GIT_ENV_DENYLIST_RE = /^GIT_/;
export function gitEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (GIT_ENV_DENYLIST_RE.test(key)) delete env[key];
  }
  return { ...env, ...extra };
}

export const EXTERNAL_SOURCE = "routeflow-registry";
// "B12 · title" — the seed's name shape; the ONE definition every reader
// imports (L-105: the id matcher has one definition every reader imports).
export const NAME_ID_RE = /^B(\d+)\s*·/;
export const CLOSED_MARKER = "plane-sync:closed";

// repoRoot() walks up from THIS FILE's own location — never process.cwd()
// (reference_bugs_mjs_cwd_trap_2026-09-08: a drifted shell cwd wrote registry
// rows to the wrong place). Stops at the first ancestor holding both
// package.json and .claude, which is the repo/worktree root this file lives
// under, whether invoked from the repo root, a worktree, or anywhere else.
export function repoRoot() {
  let dir = THIS_FILE_DIR;
  for (;;) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, ".claude"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      // Fell off the filesystem root without finding the marker pair — fall
      // back to the conventional scripts/campaign/<file> -> repo root shape
      // rather than throwing, matching every other script's leniency here.
      return join(THIS_FILE_DIR, "..", "..");
    }
    dir = parent;
  }
}

// machineRoot() anchors machine-local state (the write ledger, plane-sync's
// close-cache, run telemetry) on the ONE directory every worktree of this
// repo shares — `git rev-parse --git-common-dir` resolves to the main
// checkout's `.git` no matter which worktree (or the main checkout itself)
// it runs from, so its PARENT is that shared directory. Defect fixed
// 2026-09-12: stateDir()/runsPath() used to anchor on repoRoot() — THIS
// FILE's own ancestor, a DIFFERENT directory in every worktree — so the
// daily manual-write budget and the run telemetry both forked per tree (one
// worktree reported "manual 10/20" while the true machine-wide total across
// every tree was 25). Resolved via gitEnv() + an explicit `-C repoRoot()` —
// never an inherited/ambient cwd (reference_git_worktreeconfig_bare_trap_
// 2026-09-04, reference_bash_cwd_persists_use_git_C) — cached per process
// since the answer cannot change mid-run. Falls back to repoRoot() (this
// tree's own root, the pre-fix behaviour) when git itself is unavailable or
// the spawn fails, rather than throwing — a bare/no-git environment
// degrades to per-tree state instead of crashing every caller.
let machineRootCache = null;
export function machineRoot() {
  if (machineRootCache) return machineRootCache;
  try {
    const result = spawnSync("git", ["-C", repoRoot(), "rev-parse", "--git-common-dir"], {
      env: gitEnv(),
      encoding: "utf8",
    });
    if (result.status === 0 && result.stdout) {
      const gitCommonDir = result.stdout.trim();
      const absolute = isAbsolute(gitCommonDir) ? gitCommonDir : join(repoRoot(), gitCommonDir);
      machineRootCache = dirname(absolute);
      return machineRootCache;
    }
  } catch {
    // fall through to the repoRoot() fallback below
  }
  machineRootCache = repoRoot();
  return machineRootCache;
}

export function stateDir() {
  return process.env.PLANE_SYNC_STATE_DIR || join(machineRoot(), "local-assets", "plane");
}

// ── legacy per-tree state migration (fix 2026-09-12) ────────────────────────
// A worktree that wrote state before this fix landed has it sitting at one
// of two legacy homes: the very first location (`.claude/campaign/`) or a
// transitional per-tree `local-assets/plane/` (repoRoot()-anchored, same as
// runsPath() used before this fix). Called lazily by every read/write site
// below — never at module load — and is a no-op once the shared file
// already exists at its new home; cheap enough (one existsSync per legacy
// candidate) to call unconditionally rather than cache, and simpler than a
// one-shot cache that could go stale when a self-test deletes the migrated
// file mid-process. Skipped entirely under an explicit PLANE_SYNC_STATE_DIR
// override — a test fixture must never reach into this machine's real
// legacy files.
export function migrateLegacyStateFile(filename) {
  if (process.env.PLANE_SYNC_STATE_DIR) return;
  // Always the CANONICAL shared location, never stateDir()'s own value — a
  // caller that overrides stateDir() without also passing PLANE_SYNC_STATE_DIR
  // isn't a real scenario in this codebase (every self-test sets both), but
  // deriving from machineRoot() directly keeps this correct even if one day
  // it isn't.
  const target = join(machineRoot(), "local-assets", "plane", filename);
  if (existsSync(target)) return;
  const legacyDirs = [
    join(repoRoot(), ".claude", "campaign"),
    join(repoRoot(), "local-assets", "plane"),
  ];
  for (const dir of legacyDirs) {
    const legacy = join(dir, filename);
    if (legacy === target || !existsSync(legacy)) continue;
    mkdirSync(dirname(target), { recursive: true });
    renameSync(legacy, target);
    console.error(`Plane client: migrated ${filename} to local-assets/plane/`);
    return;
  }
}

// ── knobs (spec 2026-09-12-plane-learning R1) ───────────────────────────────
// PLANE_KNOBS_PATH is a TEST-ONLY override, same gating pattern as
// PLANE_DENYLIST_PATH above: honoured ONLY when PLANE_SYNC_SELF_TEST=1 is
// ALSO set, so an accidental env leak into a real run is inert. Cached per
// process (module-level) once a load succeeds validation — an invalid file
// is never cached, so every call re-reads and re-throws until fixed (T1: a
// tool must see `knobs invalid: <name>` on every attempt, not just the
// first).
let knobsCache = null;

function resolveKnobsPath() {
  if (process.env.PLANE_SYNC_SELF_TEST === "1" && process.env.PLANE_KNOBS_PATH) {
    return process.env.PLANE_KNOBS_PATH;
  }
  return join(repoRoot(), "scripts", "campaign", "plane-knobs.json");
}

// Validated: every knob's `value` must sit within [min, max], else this
// throws `knobs invalid: <name>` — a caller (any plane-*.mjs tool) is
// expected to let this propagate BEFORE issuing any request, per the spec's
// hard line. Never swallowed here.
export function loadKnobs() {
  if (knobsCache) return knobsCache;
  const path = resolveKnobsPath();
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  for (const [name, k] of Object.entries(parsed.knobs ?? {})) {
    if (!(Number(k.min) <= Number(k.value) && Number(k.value) <= Number(k.max))) {
      throw new Error(`knobs invalid: ${name}`);
    }
  }
  knobsCache = parsed;
  return knobsCache;
}

// Convenience accessor — `knob("triageGetBudget") -> 16`. Throws the same
// way loadKnobs() does when the file is invalid, plus `unknown knob: <name>`
// for a name not present.
export function knob(name) {
  const { knobs } = loadKnobs();
  if (!knobs || !(name in knobs)) throw new Error(`unknown knob: ${name}`);
  return knobs[name].value;
}

// ── run telemetry (R2) ──────────────────────────────────────────────────────
// Machine-local, gitignored via local-assets/, same machineRoot() anchor as
// stateDir() (fix 2026-09-12 — see migrateLegacyStateFile() above) so
// telemetry is counted machine-wide, not forked per worktree. PLANE_RUNS_PATH
// is a TEST-ONLY override, gated the same way as PLANE_KNOBS_PATH/
// PLANE_DENYLIST_PATH (PLANE_SYNC_SELF_TEST=1 required alongside it) — under
// that override, migration is skipped (a test fixture must never reach into
// this machine's real legacy runs.jsonl).
export function runsPath() {
  if (process.env.PLANE_SYNC_SELF_TEST === "1" && process.env.PLANE_RUNS_PATH) {
    return process.env.PLANE_RUNS_PATH;
  }
  migrateLegacyStateFile(RUNS_FILENAME);
  return join(machineRoot(), "local-assets", "plane", RUNS_FILENAME);
}

// One JSON line per tool run, appended at exit (success or failure — every
// caller wraps this in a `finally`). Denylist-scanned before it ever touches
// disk, and RE-scanned after redaction (fix-round rulings M1/m4) — a
// free-text field is not the only place a secret can ride along; `branch`
// (git branch names are caller-controlled and can embed anything, e.g. a
// worktree branch salted with a uuid) is exactly as risky as `error`/`flags`.
// First hit: strip `error`, `flags`, `skipped`, and sanitize `branch` to the
// literal string "redacted" (kept, not dropped, so callers/readers can still
// see a branch field exists), then re-serialise and re-scan. A SECOND hit
// (the sanitized fields did not remove the match — e.g. a uuid sitting in
// some other field this function does not know to strip) falls back to the
// minimal safe record: only `{ts, tool, version, exit, redacted: true}`.
//
// Never throws outward (m4): the whole body — including the default
// `loadDenylist()` resolution `scanForbidden()` triggers — is wrapped in
// try/catch. Telemetry is a nice-to-have, never a reason to fail a tool run;
// a missing/malformed denylist (loadDenylist()'s own fail-closed contract,
// unchanged for actual WRITE callers) is reported here as one stderr line
// (`Plane telemetry warn: <reason>`) and this function simply returns
// without writing a line at all — there is nothing safe to write when the
// scan itself could not run.
export function appendRun(record) {
  try {
    const base = { ts: new Date().toISOString(), version: 1, ...record };
    let out = base;
    let line = JSON.stringify(out);
    if (scanForbidden(line)) {
      const { error, flags, skipped, branch, ...rest } = out;
      out = { ...rest, redacted: true };
      if ("branch" in base) out.branch = "redacted";
      line = JSON.stringify(out);
      if (scanForbidden(line)) {
        out = {
          ts: base.ts,
          tool: base.tool,
          version: base.version,
          exit: base.exit,
          redacted: true,
        };
        line = JSON.stringify(out);
      }
    }
    mkdirSync(dirname(runsPath()), { recursive: true });
    appendFileSync(runsPath(), line + "\n");
  } catch (err) {
    console.error(`Plane telemetry warn: ${err?.message ?? err}`);
  }
}

// Fail CLOSED (fix-round 2b, F3; hardened fix-round 3, NEW-2): a missing
// OR malformed/empty denylist used to read as "no patterns" (R2 failing
// open — every write would have sailed through unscanned). The file is a
// required part of the repo, not optional configuration, so its absence,
// or a present file with no usable `patterns` array, throws with the
// resolved path rather than silently disabling the scan; every caller
// (plane-sync's main(), and any other tool that writes) must treat this as
// fatal before issuing a write.
export function loadDenylist() {
  const path = resolveDenylistPath();
  if (!existsSync(path)) {
    throw new Error(`denylist missing: ${path}`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed.patterns) || parsed.patterns.length === 0) {
    throw new Error(`denylist empty or malformed: ${path}`);
  }
  return parsed.patterns;
}

// Hard line, verbatim (ruling-s4-s5.md): never return or print the match
// itself — only the pattern's name, so a caller can say "B77 forbidden
// (invoice-number)" without ever putting the invoice number on a screen.
export function scanForbidden(text, patterns = loadDenylist()) {
  if (!text) return null;
  for (const p of patterns) {
    if (new RegExp(p.regex, p.flags ?? "").test(text)) return { name: p.name };
  }
  return null;
}

// The ONLY fields the deep scan below ever inspects — free-text content a
// human or this codebase wrote. Every id-bearing field (state, labels,
// assignees, parent, type_id, issues, external_id, external_source, issue,
// cycle_id, module_id, relation_type) is deliberately absent: those carry
// ids Plane itself handed back from a runtime resolve (resolveStates/
// resolveLabels/resolveMember/resolveTypes, or DECIDE-27's own
// external_id/external_source stamp), and a real Plane id is uuid-shaped —
// exactly the tenant-uuid pattern's shape — so scanning it produced a false
// positive on every single write that named a state or label (defect fixed
// 2026-09-12). Exported so a self-test can pin the exact set.
export const CONTENT_KEYS = new Set([
  "name",
  "description_html",
  "description_stripped",
  "description",
  "comment_html",
  "comment_stripped",
  "url",
  "title",
  "html",
]);

// Recurses into every string value of a request body (nested objects and
// arrays included), but ONLY once it has passed through a CONTENT_KEYS field
// — `underContent` is false at the body's own top level (an object has no
// "key" of its own) and only flips true when a key it walks into is a
// content key; that flag then propagates to every string nested below,
// however deep. A value sitting under a non-content (id-bearing) key is
// walked for structure only — its strings are never scanned — so a
// uuid-shaped state/label/assignee id can never trip a pattern meant for
// content.
function scanBodyDeep(value, patterns, underContent = false) {
  if (value == null) return null;
  if (typeof value === "string") {
    return underContent ? scanForbidden(value, patterns) : null;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = scanBodyDeep(v, patterns, underContent);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const hit = scanBodyDeep(v, patterns, underContent || CONTENT_KEYS.has(k));
      if (hit) return hit;
    }
    return null;
  }
  return null;
}

// L-068 (hold a lock across read+write; additive write first): one
// appendFileSync per line is the atomic unit — never read-modify-write the
// ledger. Never called for a deferred or forbidden write (see write() below).
export function appendWrite({ tool, method, path: p, ref, reason }) {
  migrateLegacyStateFile(LEDGER_FILENAME);
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      tool,
      method,
      path: p,
      ref,
      ...(reason ? { reason } : {}),
    }) + "\n";
  appendFileSync(join(dir, LEDGER_FILENAME), line);
}

// day is the UTC calendar day of the ledger's own ts (ISO, always UTC) — no
// local-timezone slippage between a write made near midnight and a read made
// moments later.
export function writesToday({ exclude = [] } = {}) {
  migrateLegacyStateFile(LEDGER_FILENAME);
  const file = join(stateDir(), LEDGER_FILENAME);
  if (!existsSync(file)) return 0;
  const day = new Date().toISOString().slice(0, 10);
  let count = 0;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // a malformed ledger line is skipped, never a thrown crash
    }
    if (typeof row.ts === "string" && row.ts.startsWith(day) && !exclude.includes(row.tool)) {
      count++;
    }
  }
  return count;
}

// ── the shared REST client ──────────────────────────────────────────────────
// createClient({baseUrl, slug, apiKey, tool, maxWrites, log}) — one instance
// per script invocation. `tool` is the ledger's own `tool` field (e.g.
// "plane-sync", "plane-apply"); `maxWrites` has no built-in default here —
// each caller sets its own (sync 250 / intake 20 / apply 20 / Gate 5 25 per
// spec.md R3) — Infinity when the caller passes none.
export function createClient({
  baseUrl = process.env.PLANE_BASE_URL || DEFAULT_BASE_URL,
  slug = process.env.PLANE_WORKSPACE_SLUG || DEFAULT_SLUG,
  apiKey,
  tool,
  maxWrites = Infinity,
  log = (msg) => console.error(msg),
} = {}) {
  let writes = 0;
  let deferred = 0;
  let forbidden = 0;
  let gets = 0;
  let rateLimitSleeps = 0;
  let retries = 0;
  let lastWriteAt = 0;
  let printedTarget = false;
  const requestTimes = []; // sliding window for the req/min ceiling

  // spec 2026-09-12-plane-learning R1: the ceiling is knob-driven
  // (`clientRatePerMin`) with a silent fallback to the original 50/min when
  // knobs cannot load — a tool that needs to SEE `knobs invalid: <name>`
  // calls loadKnobs()/knob() itself before creating a client (see plane-
  // client.mjs's loadKnobs() doc comment); this client never surfaces that
  // error itself, it only consumes the value.
  let rateLimitMaxPerWindow = RATE_LIMIT_MAX_PER_WINDOW;
  try {
    rateLimitMaxPerWindow = knob("clientRatePerMin");
  } catch {
    rateLimitMaxPerWindow = RATE_LIMIT_MAX_PER_WINDOW;
  }

  const originForUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

  function buildUrl(path, query) {
    const rel = String(path).replace(/^\/+/, "");
    const url = new URL(`api/v1/workspaces/${slug}/${rel}`, originForUrl);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
      }
    }
    return url;
  }

  // Blocks until issuing one more request keeps this client at or under
  // RATE_LIMIT_MAX_PER_WINDOW requests in the trailing RATE_LIMIT_WINDOW_MS —
  // independent of (and in addition to) the per-write floor and whatever the
  // response headers say.
  async function waitForRateWindow() {
    for (;;) {
      const now = Date.now();
      while (requestTimes.length && now - requestTimes[0] >= RATE_LIMIT_WINDOW_MS) {
        requestTimes.shift();
      }
      if (requestTimes.length < rateLimitMaxPerWindow) return;
      const waitMs = requestTimes[0] + RATE_LIMIT_WINDOW_MS - now;
      if (waitMs > 0) await sleep(waitMs);
    }
  }

  // Landmine 4: a floor on the gap between two consecutive writes, kept from
  // v1 verbatim (260ms ⇒ ≤ ~4 writes/s), never bypassed by a direct fetch.
  async function throttleWrite() {
    const wait = lastWriteAt + MIN_WRITE_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastWriteAt = Date.now();
  }

  // Retries 429/5xx up to 3x honouring `x-ratelimit-reset` (epoch seconds);
  // sleeps to reset when a response reports zero remaining budget — both
  // kept byte-for-byte from v1's planeRequest. Anything else non-2xx throws.
  async function request(method, path, { body, query } = {}) {
    const url = buildUrl(path, query);
    for (let attempt = 0; ; attempt++) {
      await waitForRateWindow();
      requestTimes.push(Date.now());
      if (method === "GET") gets++;
      const res = await fetch(url, {
        method,
        headers: { "X-API-Key": apiKey, "content-type": "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        retries++;
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
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (remaining === "0") {
        const resetHeader = res.headers.get("x-ratelimit-reset");
        const resetAtMs = resetHeader ? Number(resetHeader) * 1000 : NaN;
        if (Number.isFinite(resetAtMs)) {
          rateLimitSleeps++;
          await sleep(Math.max(0, resetAtMs - Date.now() + 50));
        }
      }
      return res.json();
    }
  }

  async function get(path, { query } = {}) {
    return request("GET", path, { query });
  }

  // Cursor pagination, per_page 100 — never touches the write budget/ledger.
  //
  // Defect 1 (proven live 2026-09-12): `members/`, `projects/{id}/members/`,
  // and `projects/{id}/work-item-types/` (the `issue-types/` alias too, where
  // Plane serves one) return a BARE ARRAY on the real API — not the
  // `{results, next_cursor, next_page_results, …}` envelope every other
  // listed endpoint (`work-items/`, `states/`, `labels/`, `comments/`,
  // `links/`, `intake-issues/`, `projects/`) uses. A bare array IS the whole
  // list already — Plane never paginates these — so it's returned immediately
  // on sight, whichever page it showed up on. This was the root cause of
  // `resolveTypes` finding zero types against the live workspace: it read
  // `page?.results` off an array, which is always undefined.
  async function listAll(path, { query } = {}) {
    const items = [];
    let cursor;
    do {
      const page = await request("GET", path, {
        query: { per_page: "100", ...(query ?? {}), ...(cursor ? { cursor } : {}) },
      });
      if (Array.isArray(page)) return page;
      items.push(...(page?.results ?? []));
      cursor = page?.next_page_results ? page.next_cursor : null;
    } while (cursor);
    return items;
  }

  // (a) denylist scan, no request on a hit; (b) budget guard, no request past
  // maxWrites; (c) on success only, bump the counter and appendWrite — a
  // deferred or forbidden attempt never reaches the ledger (T4/T3, verbatim).
  async function write(method, path, body, { ref, reason } = {}) {
    const hit = scanBodyDeep(body, loadDenylist());
    if (hit) {
      forbidden++;
      return { forbidden: hit };
    }
    if (writes >= maxWrites) {
      deferred++;
      return { deferred: true };
    }
    if (!printedTarget) {
      printedTarget = true;
      // L-074: a script that can target a real workspace prints the resolved
      // base URL + slug before the first write — never the key.
      log(`Plane target: ${baseUrl} (workspace: ${slug})`);
    }
    await throttleWrite();
    const result = await request(method, path, { body });
    writes++;
    appendWrite({ tool, method, path: buildUrl(path).pathname, ref, reason });
    return result;
  }

  // resolveProject/resolveStates/resolveLabels/resolveTypes/resolveMember
  // never touch a Plane uuid literal in source — every id comes back from a
  // runtime lookup by identifier/name (T11's literal-scan).
  async function resolveProject(identifier) {
    const projects = await listAll("projects/");
    const project = projects.find((p) => p.identifier === identifier);
    if (!project) {
      throw new Error(`no project with identifier "${identifier}" in workspace "${slug}"`);
    }
    return project;
  }

  // name -> {id, group} — group is Plane's own state-group field
  // (backlog/unstarted/started/completed/cancelled), needed by callers that
  // must tell "already closed" from "still open" (R4/R5) without a second
  // resolve. Case-insensitive lookup: Plane's stock board ships "In Progress"
  // while STATE_BY_LEDGER spells it "In progress" (v1's resolveStateId note).
  async function resolveStates(projectId) {
    const states = await listAll(`projects/${projectId}/states/`);
    const map = new Map();
    for (const s of states)
      map.set(String(s.name ?? "").toLowerCase(), { id: s.id, group: s.group });
    return map;
  }

  async function resolveLabels(projectId) {
    const labels = await listAll(`projects/${projectId}/labels/`);
    const map = new Map();
    for (const l of labels) map.set(String(l.name ?? "").toLowerCase(), l.id);
    return map;
  }

  async function resolveTypes(projectId) {
    const types = await listAll(`projects/${projectId}/work-item-types/`);
    const map = new Map();
    for (const t of types) map.set(String(t.name ?? "").toLowerCase(), t.id);
    return map;
  }

  // Workspace member lookup by display name — same resolve-by-name pattern
  // as v1's resolveStateId: case-insensitive match, warn + undefined on a
  // miss, never throw. NOTE: the exact Plane member-list field carrying the
  // human-readable name is unconfirmed against the live API (flagged, not
  // guessed past this point — same discipline as build-plan.md Landmine 14);
  // this checks the field names Plane's docs describe (`display_name`,
  // `first_name`, `email`) in that order.
  async function resolveMember(displayName) {
    const members = await listAll("members/");
    const wanted = String(displayName ?? "").toLowerCase();
    const match = members.find((m) => {
      const name = m.display_name ?? m.first_name ?? m.email ?? "";
      return String(name).toLowerCase() === wanted;
    });
    if (!match) {
      log(`Plane mirror warn: no member named "${displayName}" in workspace "${slug}"`);
      return undefined;
    }
    return match.member ?? match.id;
  }

  return {
    get,
    post: (path, body, opts) => write("POST", path, body, opts),
    patch: (path, body, opts) => write("PATCH", path, body, opts),
    del: (path, opts) => write("DELETE", path, undefined, opts),
    listAll,
    resolveProject,
    resolveStates,
    resolveLabels,
    resolveTypes,
    resolveMember,
    get writes() {
      return writes;
    },
    get deferred() {
      return deferred;
    },
    summary() {
      return { writes, deferred, forbidden, gets, rateLimitSleeps, retries };
    },
  };
}
