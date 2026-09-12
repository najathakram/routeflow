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
//     recursively over every string value — a hit makes NO request;
//   - the write budget + ledger (R3): a per-client write counter that defers
//     once `maxWrites` is reached, and appends one line per ACTUAL write to
//     `.claude/campaign/.plane-writes.jsonl` (never for a deferred or
//     forbidden write — see T4: 3 successful POSTs under `--max-writes 3`
//     produce exactly 3 ledger lines, not 5).
//
// NO PLANE UUIDS, EVER (same rule as v1) — projects resolve by `identifier`,
// states/labels/types/members resolve by name, all at runtime. See T11's
// literal-scan, extended to this file.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const THIS_FILE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DENYLIST_PATH = join(THIS_FILE_DIR, "plane-denylist.json");
const LEDGER_FILENAME = ".plane-writes.jsonl";

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

export function stateDir() {
  return process.env.PLANE_SYNC_STATE_DIR || join(repoRoot(), ".claude", "campaign");
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

// Recurses into every string value of a request body (nested objects and
// arrays included) — R2's "every outbound string" applies to name,
// description_html, comment_html, url, wherever they sit in the payload.
function scanBodyDeep(value, patterns) {
  if (value == null) return null;
  if (typeof value === "string") return scanForbidden(value, patterns);
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = scanBodyDeep(v, patterns);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value)) {
      const hit = scanBodyDeep(v, patterns);
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
  let lastWriteAt = 0;
  let printedTarget = false;
  const requestTimes = []; // sliding window for the 50 req/min ceiling

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
      if (requestTimes.length < RATE_LIMIT_MAX_PER_WINDOW) return;
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
      const res = await fetch(url, {
        method,
        headers: { "X-API-Key": apiKey, "content-type": "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
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
        if (Number.isFinite(resetAtMs)) await sleep(Math.max(0, resetAtMs - Date.now() + 50));
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
      return { writes, deferred, forbidden };
    },
  };
}
