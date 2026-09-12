# Build plan — Plane harness: sync/intake/triage/apply + shared client (dev-pipeline, major)

Status: DRAFT. Author: Fable 5.1 (ruling), transcribed by Sonnet 5, 2026-09-11.
Grounded at `feat/plane-bugs-mirror` @ `59121377` (worktree `rf-plane2`, branch
`feat/plane-harness`) from a direct read of `scripts/campaign/plane-sync.mjs`,
`plane-sync.self-test.mjs`, `.claude/hooks/stop.mjs` Gate 5, `package.json`,
`.claude/settings.json`, `.gitignore`, `.claude/skills/rebuild/SKILL.md`,
`.claude/skills/bug-registry/SKILL.md`, `.claude/code-map/INDEX.md`/`_meta.json`, and
`scripts/campaign/bugs.mjs`'s `file`/`note` commands. Mode `feature`, scale `major`, `ui: false`.
Inputs: [discovery.md](./discovery.md), [spec.md](./spec.md) (R1–R13), [test-plan.md](./test-plan.md) (T1–T15).

**Preamble omitted** — major scale; discovery.md and spec.md carry the problem/requirements.

---

## Objective

The owner's Plane Cloud workspace (`routeflow`; BUGS/ROAD/OPS/DECIDE/CLIENT) has drifted from
the in-repo bug registry because every write today is a hand-made MCP call the auto-mode
classifier silently blocks (`workitem update`), and the existing `plane-sync.mjs` (v1, merged
unreleased on this branch) cannot adopt the 160 pre-existing Plane items that all carry a null
`external_id` — its first real run would duplicate them. This change adds: (1) adoption so v1's
sync can safely run once against the real, already-populated workspace; (2) a shared,
denylisted, budgeted REST client three new scripts reuse instead of three copies of the same
~150 lines; (3) `plane-intake.mjs`, the one permitted Plane→registry path (human-created Plane
items become ready `bugs.mjs file` commands, never automatic registry writes); (4)
`plane-triage.mjs`, a ≤1.5 KB read-only session-start brief; (5) `plane-apply.mjs`, the one
scripted path for the writes MCP cannot make (state moves, comments, relations, archive); and
(6) the skill/docs/Gate-5-budget wiring that makes all four discoverable and safe to run
unattended.

**In scope:** everything named in R1–R13 (spec.md) — adoption, the denylist, the write
budget + ledger, comment-on-close, state-map completeness, intake, triage, scripted apply, the
shared client, the skill + flows, the `package.json`/`.gitignore` wiring, Gate 5's write cap,
and `--help` on all four scripts.

**Explicitly out of scope (spec.md non-goals):** webhooks; any Plane → registry state-changing
path other than intake; custom Plane properties; PQL; Project Updates/Initiatives; cycle/module
automation for ROAD; any change to `bugs.mjs`'s own semantics; global `~/.claude` edits.

---

## Constraints & conventions

- **Stack:** standalone Node ESM scripts, no new npm dependencies — `fetch` is global on
  Node ≥ 18 (repo requires Node ≥ 18, CI pins 20). No TypeScript in `scripts/campaign/` today;
  keep it that way.
- **Test runner and layout:** the repo's existing **hand-rolled self-test convention** — a
  plain `.mjs` file run directly (`node <file>.self-test.mjs`), printing `  ok  <name>` /
  `  FAIL <name>` lines via a local `check(name, got, want)` helper, exiting
  `process.exit(failures ? 1 : 0)`. This is **not** the built-in `node:test` module — no file
  in this repo imports `node:test`, and CLAUDE.md's do-not-introduce list bars "a root-level
  test runner," which is exactly why `bugs.mjs self-test`, `plane-sync.self-test.mjs`, and
  `.claude/hooks/stop.gates.spec.mjs`/`stop.gate5.spec.mjs` all use this shape instead of a
  Jest project. New self-test files (TP2–TP4, TP6) copy this shape exactly; do not introduce
  `node:test`, Jest, or Vitest anywhere under `scripts/campaign/`.
- **Lint/format:** root `prettier.config.js` — semicolons, double quotes, `printWidth: 100`,
  trailing commas. Every touched/created file under `scripts/campaign/`, `.claude/hooks/`,
  `.claude/skills/`, `package.json`, `.claude/settings.json` must pass
  `npx prettier --check`.
- **Existing patterns to copy rather than invent:** `scripts/campaign/plane-sync.mjs` (the
  REST client shape being extracted — retry/backoff, rate-limit sleep, resolve-by-identifier,
  the `Plane mirror:`/`Plane mirror warn:` prefix split) and `plane-sync.self-test.mjs` (the
  fake-server-plus-spawn harness, the `FIXTURE_DIRS`/sweep-in-`finally` pattern, the composite
  positive-control-plus-oracle check style). `.claude/hooks/stop.gate5.spec.mjs`'s
  repo-scaffold helper for any test that needs a throwaway git repo.
- **Design system:** n/a — `ui: false`, no rendered surface.
- **Must NOT change:** `bugs.mjs`'s own command semantics (its `file`/`note`/`waves` CLI
  contracts are read-only inputs to this feature, never edited); the wire shape of
  `.claude/campaign/bugs.jsonl`/`status/*.jsonl`/`board.json` (read-only inputs); the existing
  `.plane-sync-digest` short-circuit behavior (kept, untouched, alongside the new
  `.plane-writes.jsonl` ledger — they are independent files serving independent purposes).
- **Do-not-introduce list (CLAUDE.md):** Vitest, Biome, Supabase, Vercel, a second HTTP
  client, a root-level test runner or root ESLint config.
- **Landmines:**
  1. **`bugs.mjs` reads its registry root from `BUGS_ROOT`, not `PLANE_SYNC_REGISTRY_DIR`.**
     `plane-intake.mjs`'s `--apply` path spawns `bugs.mjs file ...`; when
     `process.env.PLANE_SYNC_REGISTRY_DIR` is set (the self-test's temp registry), the spawn's
     `env` must translate it: `{ ...process.env, BUGS_ROOT: process.env.PLANE_SYNC_REGISTRY_DIR ?? process.env.BUGS_ROOT }`.
     Forgetting this makes every intake self-test case write into the REAL `.claude/campaign`
     instead of the throwaway fixture.
  2. **`bugs.mjs note` requires a full record file** (`readRecord(id)` fails without one — see
     `bugs.mjs:1596-1616`). R6's "skip the note silently if `note` is unavailable in the test
     registry" means: catch the child's non-zero exit from `note` and continue without
     treating it as a fatal error, exactly as R6 states.
  3. **`--help` must short-circuit before any env read or network call (R13/T15).** v1's
     `plane-sync.mjs` argv parsing (main(), ~line 671 in the current file) reads
     `process.env.PLANE_API_KEY` and, once set, runs straight into `runSync()` with no branch
     for `--help`/`-h` at all — the 2026-09-11 incident this requirement exists to close: a
     bare `--help` invocation fell through to a live run and hit HTTP 429 against the real
     workspace. The `--help`/unknown-flag check must be the FIRST thing every one of the four
     `main()` functions does, before `process.env.PLANE_API_KEY` is even read.
  4. **Rate limit ≤ 4 writes/s** (v1's `MIN_WRITE_INTERVAL_MS = 260`, `throttleWrite()`) is a
     floor independent of response headers — keep it in the shared client; do not let any new
     script bypass it via a direct `fetch`.
  5. **The digest file (`.plane-sync-digest`) and the new ledger (`.plane-writes.jsonl`) are
     independent.** Do not fold the new write-count budget into the existing digest
     short-circuit, and do not let a deferred write (over `--max-writes`) advance the digest —
     same rule v1 already applies to `skipped`/`unverified` rows.
  6. **Windows paths.** Every path in this plan and in the scripts themselves must go through
     `node:path`'s `join`/`dirname` (never a hand-built `/`-joined string) — the worktree runs
     on Windows (`C:\ClaudeCode\routeflow\...`), and `fileURLToPath`/`pathToFileURL` (already
     used in v1) are the only correct way to round-trip a file URL on this platform.
  7. **Never `| tail` a gate command** (L-103) — every verification command in this plan runs
     to completion and is read from its own exit code, never piped and truncated.
  8. **No uuids, keys, or secrets in any tracked file** — enforced by the extended literal-scan
     (T11) across `plane-client.mjs`/`plane-intake.mjs`/`plane-triage.mjs`/`plane-apply.mjs` in
     addition to `plane-sync.mjs`/`stop.mjs`.
  9. **`prettier --check` must pass on every touched file** — including `.claude/settings.json`
     and `package.json` after WP6's edits; a trailing comma or quote-style slip fails
     `npm run verify` on an otherwise-correct change.
  10. **Self-test files exit non-zero on failure** (`process.exitCode`/`process.exit`, never a
      silently-resolved promise) — a new self-test that forgets this reports green in CI no
      matter what it found.
  11. **The `SessionStart` hook must exit 0 in under ~8 s even fully offline** (R10 adds one to
      `.claude/settings.json` running `plane-triage.mjs --brief`) — `plane-triage.mjs`'s own
      "no key" (`skipped`) and "network error" (`partial`) exits are both 0 already (R7), so
      this is satisfied by R7's own contract; do not add a retry loop or a blocking wait inside
      the triage script that could push a cold session past that budget.
  12. **`.claude/settings.json` must remain valid JSON with the existing `PostToolUse`/`Stop`
      hooks intact** — WP6 adds a `SessionStart` array alongside them, never replacing the
      `hooks` object; validate with `node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json','utf8'))"`
      after editing.
  13. **Never statically `import` a not-yet-existing module from its own test file** (see
      test-plan.md §6) — every TP2–TP4 case drives its target CLI via `spawn`, and every
      literal-scan read is `existsSync`-guarded, so a missing implementation file surfaces as
      an assertion miss, never a crash of the whole test file.
  14. **The real Plane REST paths for the Intake-queue resource and for `archive` are not named
      in spec.md/the ruling.** WP3 (intake) and WP5 (apply/archive) must confirm the actual
      endpoint shapes against Plane's own API reference before wiring the real request — the
      fake-server fixture in TP1/TP2/TP4 models only the documented behavior (a listable
      status-`-2` record set; an archive op gated on the target's current state group). Flagged
      to the coordinator, not guessed here.

---

## Test packages (authored before implementation)

### TP1 — `scripts/campaign/plane-sync.self-test.mjs` (extend) + `scripts/campaign/plane-fake-server.mjs` (new)

- **writes:** `scripts/campaign/plane-sync.self-test.mjs`, `scripts/campaign/plane-fake-server.mjs`
- **tests:** T1, T2, T3, T4, T5, T6, T11, T15 (sync's `--help` case)
- **brief:** extract v1's inline `startFakeServer` into `plane-fake-server.mjs` (same routes,
  plus: comments list/create, links create, `POST projects/{project}/work-items/{id}/archive/`
  gated on state group, labels/types/members list stubs, `GET projects/{project}/intake-issues/`
  returning Intake records — `status` -2 pending / -1 declined / 0 snoozed / 1 accepted /
  2 duplicate, plus an `issue` field = the work item id (Landmine 14's two pinned endpoints;
  serve both paths exactly so)) so TP2–TP4 import it
  rather than re-implementing it; add T1/T2 (adoption + duplicate-candidate), T3 (denylist),
  T4 (`--max-writes` + ledger), T5 (comment-on-close, 3 runs), T6 (create-already-done posts no
  comment), T15 (`--help`/`-h` before any env read, unknown flag → exit 2), and extend T11's
  literal-scan to the four new files (guarded by `existsSync`, per the "never statically
  import" rule above). Every new oracle is a request-sequence assertion against
  `plane-fake-server.mjs`'s recorded `requests` array, never a re-implementation of the sync's
  own logic.
- **must fail with:** T1 — got `{POST: 1, PATCH: 0}`, want `{POST: 0, PATCH: 1}` (v1 creates a
  duplicate instead of adopting); T3 — got 1 POST (no denylist scan exists), want 0; T4 — got
  `.plane-writes.jsonl` absent, want 3 lines; T15 — got a live-network attempt or exit ≠ 0,
  want exit 0 + `Usage:` with zero requests recorded.

### TP2 — `scripts/campaign/plane-intake.self-test.mjs`

- **writes:** `scripts/campaign/plane-intake.self-test.mjs`
- **tests:** T7, T15 (intake's `--help` case)
- **dependsOn:** TP1 (imports `plane-fake-server.mjs`)
- **brief:** the four-phase T7 case from test-plan.md §2.1 (list, `--apply` on a dirty tree,
  `--apply` on a clean master-descended tree, the minted-id/PATCH/note sequence) plus T15.
  Every case spawns `node scripts/campaign/plane-intake.mjs ...` as a child process (never a
  static import of it) against a throwaway git repo (reuse `stop.gate5.spec.mjs`'s
  repo-scaffold helper) and a throwaway registry dir via `PLANE_SYNC_REGISTRY_DIR` translated
  to `BUGS_ROOT` for the `bugs.mjs file`/`note` sub-spawns (Landmine 1).
- **must fail with:** got empty stdout / non-zero exit (module not found), want the exact
  ready-command string / `awaiting owner triage: 1` / exit-2-with-`dirty`.

### TP3 — `scripts/campaign/plane-triage.self-test.mjs`

- **writes:** `scripts/campaign/plane-triage.self-test.mjs`
- **tests:** T8, T15 (triage's `--help` case)
- **dependsOn:** TP1
- **brief:** the T8 case — seed the fake server with one overdue OPS item, one Backlog DECIDE
  item, one stale-started ROAD item (`updated_at` computed relative to `Date.now()`, never a
  hardcoded date), and a BUGS drift fixture (Plane says Backlog, ledger says `done`); assert
  the brief's section counts, the ≤12 total GET count (count every request the fake server
  recorded across the whole run), the ≤1536-byte cap, and the first-line UTC-timestamp regex.
  A second block runs with `PLANE_API_KEY` unset and asserts the exact skip line + exit 0.
- **must fail with:** got empty/absent brief (module not found), want the four section counts
  and the byte/GET-count ceilings.

### TP4 — `scripts/campaign/plane-apply.self-test.mjs`

- **writes:** `scripts/campaign/plane-apply.self-test.mjs`
- **tests:** T9, T9b, T10, T15 (apply's `--help` case)
- **dependsOn:** TP1
- **brief:** the five-phase T9 case (dry-run, real run with ordered writes, invalid-ref
  validation-before-write, manual-budget refusal, `--over-budget` override) plus T9b (archive
  targeting an item whose state group is `started`, not completed/cancelled — exit 1 before any
  write, message contains `#<index>`, `archive`, `completed or cancelled`), T10 (denylist on the
  apply path), and T15. The fake server's `archive` route must be seeded so DECIDE-6 is already
  in a `Cancelled`/completed group before the T9 archive op runs (R8's precondition), and must
  also serve an item in a `started` group for T9b.
- **must fail with:** got 0 total writes in either direction (module not found) vs. the exact
  ordered 5-write sequence; got exit 0 on the invalid-ref case vs. exit 1; T9b — got exit 0 (or
  a write) vs. exit 1 with zero writes.

### TP5 — `.claude/hooks/stop.gate5.spec.mjs` (extend)

- **writes:** `.claude/hooks/stop.gate5.spec.mjs`
- **tests:** T12
- **brief:** add one case reusing the file's existing throwaway-repo-plus-fixture-sync-script
  harness: assert the argv array passed to the spawned child contains the two adjacent
  elements `"--max-writes"`, `"25"`. Do not touch the existing T12a/T12b cases (v1, still
  proving R7's spawn/relay/never-blocks contract) — this is an additive case in the same file.
- **must fail with:** got argv with no `--max-writes` element at all, want the pair present.

### TP6 — `scripts/campaign/plane-docs.self-test.mjs` (new)

- **writes:** `scripts/campaign/plane-docs.self-test.mjs`
- **tests:** T13, T14
- **brief:** pure file-content assertions, no server/spawn needed — `existsSync`/`readFileSync`
  (guarded) against `.claude/skills/plane/SKILL.md` (existence, byte size ≤ 6144, contains all
  four script basenames), `.claude/settings.json` (parse as JSON, find a `SessionStart` hook
  whose command string contains `plane-triage.mjs --brief`), `.claude/skills/rebuild/SKILL.md`
  (contains `plane:sync`), `.gitignore` (contains `.plane-writes.jsonl`), and `package.json`
  (parse as JSON, check `scripts` keys and the `verify` string).
- **must fail with:** every `existsSync`/`includes` check reports `false`/absent pre-WP6.

**Red gate command** (every case above must fail on the stated assertion, none may pass):

```bash
node scripts/campaign/plane-sync.self-test.mjs
node scripts/campaign/plane-intake.self-test.mjs
node scripts/campaign/plane-triage.self-test.mjs
node scripts/campaign/plane-apply.self-test.mjs
node scripts/campaign/plane-docs.self-test.mjs
node .claude/hooks/stop.gate5.spec.mjs
```

---

## Work packages

### WP1 — `scripts/campaign/plane-client.mjs` + `scripts/campaign/plane-denylist.json`

- **files:** `scripts/campaign/plane-client.mjs` (new), `scripts/campaign/plane-denylist.json` (new)
- **satisfies:** R2, R3, R9
- **provenBy:** T3, T4, T10, T11
- **dependsOn:** none
- **effort:** high
- **brief:** extract v1's REST client (`planeRequest`/`throttleWrite`/`findBugsProject`/
  `fetchStates`/pagination helper) into a `createClient({baseUrl, slug, apiKey, tool,
maxWrites})` factory returning `{ get, post, patch, del, listAll(path), resolveProject,
resolveStates, resolveLabels, resolveTypes, resolveMember, scanForbidden, writesToday,
summary() }`. `resolveLabels`/`resolveTypes`/`resolveMember` follow the same
  resolve-by-name pattern as v1's `resolveStateId` (case-insensitive match, warn + `undefined`
  on a miss — never throw, never a uuid literal). `post`/`patch`/`del` each increment a
  per-client write counter and call `appendWrite` (below) on every successful or deferred
  write attempt; `get`/`listAll` never touch the budget. `plane-denylist.json` seeds exactly
  the seven patterns spec.md's R2 lists (`tenant-uuid`, `invoice-number`, `email`,
  `connection-string`, `jwt`, `railway-host`, `api-key-ish`) in the `{patterns:[{name,regex,
flags}]}` shape `scanForbidden` reads.
- **exact code:**

```js
// plane-client.mjs
export const EXTERNAL_SOURCE = "routeflow-registry";
export const NAME_ID_RE = /^B(\d+)\s*·/; // "B12 · title" — the seed's name shape; the ONE definition every reader imports
export const CLOSED_MARKER = "plane-sync:closed";
export function scanForbidden(text, patterns = loadDenylist()) {
  if (!text) return null;
  for (const p of patterns)
    if (new RegExp(p.regex, p.flags ?? "").test(text)) return { name: p.name };
  return null; // never return or print the match itself
}
export function stateDir() {
  return process.env.PLANE_SYNC_STATE_DIR || path.join(repoRoot(), ".claude", "campaign");
}
export function appendWrite({ tool, method, path: p, ref, reason }) {
  fs.appendFileSync(
    path.join(stateDir(), ".plane-writes.jsonl"),
    JSON.stringify({
      ts: new Date().toISOString(),
      tool,
      method,
      path: p,
      ref,
      ...(reason ? { reason } : {}),
    }) + "\n",
  );
}
export function writesToday({ exclude = [] } = {}) {
  const day = new Date().toISOString().slice(0, 10); // UTC day; the ledger ts is UTC
  // read the ledger if it exists; count lines whose ts startsWith(day) && !exclude.includes(tool)
}
// budget guard inside client.post/patch/del:
//   if (this.writes >= this.maxWrites) { this.deferred++; return { deferred: true }; }
//   ledger path = request path with the base URL and any query string stripped (ids stay; the ledger is gitignored)
```

`plane-denylist.json` (exact seed, R2 verbatim):

```json
{
  "patterns": [
    {
      "name": "tenant-uuid",
      "regex": "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
      "flags": "i"
    },
    { "name": "invoice-number", "regex": "\\bINV-\\d{4}-\\d+\\b" },
    { "name": "email", "regex": "[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}", "flags": "i" },
    { "name": "connection-string", "regex": "\\b(postgres(ql)?|redis|mysql)://", "flags": "i" },
    { "name": "jwt", "regex": "\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}" },
    { "name": "railway-host", "regex": "\\.up\\.railway\\.app\\b" },
    { "name": "api-key-ish", "regex": "\\b(sk|pk|plane_api|plane_wh)_[A-Za-z0-9]{12,}" }
  ]
}
```

- **`--help`/`-h` (R13):** `plane-client.mjs` itself has no CLI entry point (it is a library),
  so R13 does not apply to this package directly — it applies to WP2–WP5, each of which must
  check `--help`/`-h`/an unknown flag BEFORE calling into this client at all (Landmine 3).

### WP2 — `scripts/campaign/plane-sync.mjs` (extend)

- **files:** `scripts/campaign/plane-sync.mjs`
- **satisfies:** R1, R4, R5, R12 (the `--max-writes` flag it must accept), R13
- **provenBy:** T1, T2, T5, T6, T15
- **dependsOn:** WP1
- **effort:** high
- **brief:** switch to `plane-client.mjs`'s `createClient` for all HTTP (dropping the inline
  `planeRequest`/`throttleWrite`/`findBugsProject`/`fetchStates`); add the adoption pass (exact
  code below) between listing BUGS items and calling `planDiff`; add the comment-on-close
  decision (exact code below) for every diff that changes `state`; add `--max-writes <n>`
  (default 250) threaded into `createClient({maxWrites})`, and the ledger append on every
  write; add `--help`/`-h` and unknown-flag handling as the FIRST thing `main()` does (before
  `process.env.PLANE_API_KEY` is read at all — Landmine 3), printing a `Usage:` line naming
  `plane-sync.mjs` and every existing flag (`--dry-run --check --quiet --strict
--if-digest-changed --budget-ms <n> --max-writes <n> --help`), exit 0; an unrecognized
  `--flag` prints the same usage to stderr and exits 2. Keep v1's `.plane-sync-digest`
  short-circuit, `--budget-ms` time budget, and `Plane mirror:`/`Plane mirror warn:` prefix
  split completely unchanged — this package only ADDS adoption/comments/budget/help, it does
  not touch the digest or time-budget logic.
- **exact code:**

```js
// plane-sync.mjs adoption (inside runSync, after listing BUGS items, before planDiff)
const byExt = new Map(),
  candidates = new Map();
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
for (const [id, list] of candidates) {
  if (byExt.has(id) || !registryIds.has(id)) continue;
  list.sort((a, b) => a.sequence_id - b.sequence_id);
  if (list.length > 1)
    warn(
      `duplicate candidate ${id}: BUGS-${list.map((i) => i.sequence_id).join(", BUGS-")} (adopting the oldest)`,
    );
  const r = await client.patch(
    `projects/${project.id}/work-items/${list[0].id}/`,
    { external_source: EXTERNAL_SOURCE, external_id: id },
    { ref: id },
  );
  if (!r.deferred) byExt.set(id, { ...list[0], external_source: EXTERNAL_SOURCE, external_id: id });
}
```

```js
// comment-on-close decision (per diff that changes state)
const wasOpen = !["completed", "cancelled"].includes(groupOf(item.state));
const nowClosed = ["completed", "cancelled"].includes(groupOf(desired.state));
if (wasOpen && nowClosed && !(await alreadyClosed(id))) {
  await postCloseComment(...);
  if (pr) await postLink(...);
  markClosed(id);
}
// alreadyClosed(id): cache.closed[id] ?? (list comments → some(c => (c.comment_stripped || "").includes(CLOSED_MARKER)))
```

The close-comment body is R4's exact template:
`<p><b>Closed by the registry</b> · state <ledger state> · batch F## · PR #NNN · sha <7> · proof <REG-B### / tier></p><p><small>plane-sync:closed</small></p>`
— include only the fields the ledger row actually carries (never invent a field the ledger
row lacks); a refuted→cancelled transition uses the same template with `state refuted`.

### WP3 — `scripts/campaign/plane-intake.mjs`

- **files:** `scripts/campaign/plane-intake.mjs` (new)
- **satisfies:** R6, R13
- **provenBy:** T7, T15
- **dependsOn:** WP1
- **effort:** medium
- **brief:** `[--apply] [--batch F##] [--json]`. List BUGS items with `external_id` null whose
  `name` does NOT match `NAME_ID_RE` (imported from `plane-client.mjs`) — human-created — plus
  Intake-queue records with `status === -2` (report-only, printed as `awaiting owner triage:
<n>`; Landmine 14 — the queue is `GET projects/{project}/intake-issues/`, Plane REST's
  "Intake" resource: records carry `status` -2 pending / -1 declined / 0 snoozed / 1 accepted /
  2 duplicate and an `issue` field = the work item id; a 404 from this GET is not a failure —
  log `intake: endpoint unavailable (404)` and continue with 0 pending). For each listable item, print
  `node scripts/campaign/bugs.mjs file "<name>" --location "<loc>" --severity <sev> [--batch F##] --tier T1`
  where `sev` = urgent→critical, high→high, medium→medium, low/none→low; `loc` =
  `Area · <first area label among api/web/mobile/infra/docs>` else `Unknown · triage`; the name
  has `"` escaped and is checked with `scanForbidden` (a forbidden name is skipped from the
  listing with a `Plane intake warn:` line, never printed raw). `--apply` preconditions, in
  order, each ending the run at exit 2 with zero writes on failure: (1)
  `git status --porcelain -- .claude/campaign` empty ("dirty" in the message); (2)
  `git merge-base --is-ancestor origin/master HEAD` true; (3) `PLANE_API_KEY` present. Then per
  item: spawn `bugs.mjs file ...` with `cwd` = repo root and `env.BUGS_ROOT` set from
  `PLANE_SYNC_REGISTRY_DIR` when present (Landmine 1), parse the minted `B###` from its
  stdout, PATCH the Plane item `{external_source: EXTERNAL_SOURCE, external_id, name: "B### · <name>"}`,
  then spawn `bugs.mjs note B### "Plane: BUGS-<sequence_id>" --section "Links"`, swallowing a
  non-zero exit silently (Landmine 2) rather than failing the run. `--help`/`-h` and an
  unknown flag: same contract as WP2 (usage banner naming `plane-intake.mjs` and its flags,
  exit 0/2, before any env read).

### WP4 — `scripts/campaign/plane-triage.mjs`

- **files:** `scripts/campaign/plane-triage.mjs` (new)
- **satisfies:** R7, R13
- **provenBy:** T8, T15
- **dependsOn:** WP1, WP2
- **effort:** medium
- **brief:** `[--brief|--json] [--days 7]`. Reuse `plane-sync.mjs`'s exported `planDiff` in
  check mode for the `BUGS drift` section — "never a second diff implementation" (spec.md R7)
  — so this package imports from `plane-sync.mjs`, hence `dependsOn: [WP1, WP2]`. Call budget
  (exact accounting below) ≤ 12 GETs total. Sections: `overdue` (any project,
  `target_date < today`, state group ∉ {completed, cancelled}); `due ≤ N days` (OPS + ROAD);
  `open rulings` (DECIDE items in group backlog/unstarted); `stale started` (ROAD/OPS/BUGS
  items in group started, `updated_at` older than N days); `BUGS drift` (count + first 10 ids);
  `writes today` (`manual <n>/20` from the ledger, sync vs. non-sync tools); one-line
  per-project state-group counts. `--brief` ≤ 1536 bytes, first line carries its own UTC
  timestamp (`new Date().toISOString()`); `--json` is the full payload. No key →
  `Plane triage: skipped (no PLANE_API_KEY)`, exit 0, BEFORE any network call. Any network
  error → print what was gathered so far plus `Plane triage: partial (<reason>)`, exit 0.
  Never call comments/links/properties endpoints (they're outside the 12-GET budget and this
  script is read-only by design). `--help`/`-h`/unknown flag: same contract as WP2/WP3.
- **exact code:**

```js
// plane-triage call budget: 1 GET projects + 5 GET states (one per project) + 4 GET work-items page 1 (ROAD/OPS/DECIDE/CLIENT)
// + BUGS pages (≤ 2 today) = ≤ 12. Never call comments/links/properties.
```

### WP5 — `scripts/campaign/plane-apply.mjs`

- **files:** `scripts/campaign/plane-apply.mjs` (new)
- **satisfies:** R8, R13
- **provenBy:** T9, T9b, T10, T15
- **dependsOn:** WP1
- **effort:** medium
- **brief:** `<ops.json> [--dry-run] [--max-writes n] [--over-budget "<reason>"]`. Ops schema
  `{"ops":[...]}`, `op` ∈ `update|comment|create|relation|archive|link`; every ref/name resolves
  BEFORE the first write (exact resolution order below) — a miss throws `{opIndex, message}`,
  caught at the top level as `#<opIndex> <message>`, exit 1, zero writes made. `--dry-run`
  prints the resolved plan (identifiers/names only, never a uuid) and performs zero writes.
  Each applied op prints `#i <op> <ref> → <status>`; the FIRST failing write stops the run
  (exit 1) after printing what already applied. `archive` additionally validates the target's
  current state group ∈ {completed, cancelled} at resolution time (before any write) — a
  mismatch is the same `{opIndex, message}` validation-error path as an unresolvable ref
  (Landmine 14: archive = `POST projects/{project}/work-items/{id}/archive/`, verified live
  2026-09-11, HTTP 200 on three items).
  Denylist (R2, via `plane-client.mjs`'s `scanForbidden`) on every outbound string. Manual
  write-budget refusal (R3): before the first write, if `writesToday({exclude: ["plane-sync"]})`
  would exceed 20 and no `--over-budget` was passed, exit 3 with zero writes; `--over-budget
"<reason>"` writes the reason into every ledger line this run produces and proceeds. Missing
  `PLANE_API_KEY` → exit 2 (this script's whole purpose is to write — spec.md's binding rules
  make it the one script that does NOT exit 0 on a missing key). Print the resolved base URL +
  workspace slug before the first write (L-074). `--help`/`-h`/unknown flag: same contract as
  WP2–WP4, checked before the key/ops-file is even read.
- **exact code:**

```js
// plane-apply resolution order: projects → states/labels/types/members per referenced project → every ref (identifier → item via
// GET work-items/?per_page=100 pages of that project, matched on sequence_id) — ALL before the first write; a miss throws
// { opIndex, message } → print `#<i> <message>`, exit 1, zero writes made.
```

### WP6 — Docs, flows, Gate 5 budget, scripts, gitignore

- **files:** `.claude/skills/plane/SKILL.md` (new), `.claude/settings.json`, `package.json`,
  `.gitignore`, `.claude/hooks/stop.mjs`, `.claude/skills/rebuild/SKILL.md`,
  `.claude/skills/bug-registry/SKILL.md`, `.claude/code-map/INDEX.md`,
  `.claude/code-map/_meta.json`
- **satisfies:** R10, R11, R12
- **provenBy:** T12, T13, T14
- **dependsOn:** WP2, WP3, WP4, WP5
- **effort:** medium
- **brief:**
  - **`.claude/skills/plane/SKILL.md`** (new, ≤ 6 KB): the daily routine (read
    `plane:triage --brief` at session start; one `plane:sync` + one ops file per landing; ids
    minted on master-merged trees only via `plane:intake --apply`); what lives in each project
    (BUGS/ROAD/OPS/DECIDE/CLIENT); the write budgets (250 sync / 20 intake / 20 apply / 25 Gate
    5); the denylist's existence and where it lives; the classifier reality (MCP create/
    comment/relation calls pass, `workitem update` does not — state moves go through
    `plane:apply` only); the no-PQL caveat; a pointer to
    `local-assets/plane/OWNER-STEPS.md` for the key/MCP re-registration trap; the daily
    scheduled routine `routeflow-plane-daily` and the Monday cycle close. Must name all four
    scripts (`plane-sync.mjs`, `plane-intake.mjs`, `plane-triage.mjs`, `plane-apply.mjs`) for T14.
  - **`.claude/settings.json`:** add a `SessionStart` hook block alongside the existing
    `PostToolUse`/`Stop` (Landmine 12):
    ```json
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node scripts/campaign/plane-triage.mjs --brief" }] }
    ]
    ```
  - **`.claude/skills/rebuild/SKILL.md`:** after the existing "Step 3 — Post-deploy Layer 2
    smoke check" section, add a short step: after `npm run post-deploy-check` passes, run
    `npm run plane:sync` then `npm run plane:apply -- local-assets/plane/ops/<window>.json`
    (the ops file for that landing window, if one exists).
  - **`.claude/skills/bug-registry/SKILL.md`:** add a short "Plane" section: front door is
    `plane:intake` (Plane-created items → ready `bugs.mjs file` commands); the mirror is
    `plane:sync` (registry → Plane, one-way); never edit registry state from Plane.
  - **`package.json`:** keep `bugs:plane`; add
    `"plane:sync": "node scripts/campaign/plane-sync.mjs"` (mirrors `bugs:plane` — both names
    stay, per spec.md R11's "keep `bugs:plane`; add `plane:sync` (= `bugs:plane`)"),
    `"plane:check": "node scripts/campaign/plane-sync.mjs --check"`,
    `"plane:triage": "node scripts/campaign/plane-triage.mjs"`,
    `"plane:intake": "node scripts/campaign/plane-intake.mjs"`,
    `"plane:apply": "node scripts/campaign/plane-apply.mjs"`. `verify`'s chain gains, right
    after `node scripts/campaign/bugs.mjs self-test` and before the existing
    `node scripts/campaign/plane-sync.self-test.mjs`:
    `&& node scripts/campaign/plane-intake.self-test.mjs && node scripts/campaign/plane-triage.self-test.mjs && node scripts/campaign/plane-apply.self-test.mjs`
    (the docs self-test and `stop.gate5.spec.mjs` stay where v1 already put them, later in the
    same chain).
  - **`.gitignore`:** under the existing "Plane BUGS mirror digest" section, add
    `.claude/campaign/.plane-writes.jsonl` and `.claude/campaign/.plane-sync-state.json`.
  - **`.claude/hooks/stop.mjs`** Gate 5: append `"--max-writes", "25"` to the argv array
    already passed to the spawned `plane-sync.mjs` child (alongside the existing `--quiet
--budget-ms 18000 [--if-digest-changed]`) — R12, verbatim. No other Gate 5 behavior
    changes.
  - **Code map:** update the existing "Plane BUGS mirror" row in `.claude/code-map/INDEX.md`
    (or split it into one row per script if it grows past a readable single line) to cover
    `plane-client.mjs`, `plane-denylist.json`, `plane-intake.mjs`, `plane-triage.mjs`,
    `plane-apply.mjs`, `plane-fake-server.mjs`, and the new `.claude/skills/plane/SKILL.md`;
    bump `_meta.json.mappedSha` to this change's merge sha and prepend a dated note (the
    existing `_meta.json.notes` history-prepend convention, see the 2026-09-11 entry already
    there for the shape to copy).

### Package map

| WP/TP | satisfies            | provenBy                         | dependsOn          | Wave |
| ----- | -------------------- | -------------------------------- | ------------------ | ---- |
| WP1   | R2, R3, R9           | T3, T4, T10, T11                 | —                  | 1    |
| TP1   | — (test)             | T1, T2, T3, T4, T5, T6, T11, T15 | —                  | 1    |
| TP2   | — (test)             | T7, T15                          | TP1                | 2    |
| TP3   | — (test)             | T8, T15                          | TP1                | 2    |
| TP4   | — (test)             | T9, T9b, T10, T15                | TP1                | 2    |
| TP5   | — (test)             | T12                              | —                  | 1    |
| TP6   | — (test)             | T13, T14                         | —                  | 1    |
| WP2   | R1, R4, R5, R12, R13 | T1, T2, T5, T6, T15              | WP1                | 2    |
| WP3   | R6, R13              | T7, T15                          | WP1                | 2    |
| WP4   | R7, R13              | T8, T15                          | WP1, WP2           | 3    |
| WP5   | R8, R13              | T9, T9b, T10, T15                | WP1                | 2    |
| WP6   | R10, R11, R12        | T12, T13, T14                    | WP2, WP3, WP4, WP5 | 4    |

Cross-check: every `R#` (R1–R13) appears in some package's `satisfies:` above. Every `T#`
(T1–T15) appears in some package's `provenBy:` above.

---

## Acceptance criteria

1. `R1` — running `plane-sync.mjs` twice against a fixture with pre-existing null-external-id
   Plane items adopts them (PATCH, never a duplicate POST) on run 1 and writes nothing on
   run 2.
2. `R2` — no outbound string that matches `plane-denylist.json` ever appears in this process's
   own stdout/stderr or in any HTTP request body; the skip is counted and named instead.
3. `R3` — no script ever issues more live writes than `--max-writes` allows in one run; every
   write appends exactly one ledger line with no request body in it.
4. `R4` — exactly one close comment (+ link, when a PR number is known) is posted per
   registry-driven open→closed transition, never twice, whether proven by the local cache or
   by re-listing Plane's own comments.
5. `R5` — an item Plane already shows as `Done` still receives a PATCH when the registry says
   `done` maps it to the distinct `Live` state.
6. `R6` — `plane-intake.mjs --apply` never runs against a dirty `.claude/campaign` tree or a
   tree that does not descend from `origin/master`; when it does run, every minted id is
   PATCHed back onto the originating Plane item.
7. `R7` — `plane-triage.mjs --brief` never exceeds 12 GET requests or 1536 bytes, and always
   exits 0 (skipped/partial/full).
8. `R8` — `plane-apply.mjs` makes zero writes when any op in the file fails to resolve, and
   applies the rest in file order otherwise, stopping at the first failing write.
9. `R9` — the four scripts share one REST client; none re-implements retry/rate-limit logic.
10. `R10`/`R11` — `.claude/skills/plane/SKILL.md`, the `SessionStart` hook, the `plane:*`
    `package.json` scripts, and the `verify` chain all exist and are discoverable without
    reading this build plan.
11. `R12` — Gate 5 never issues more than 25 writes through `plane-sync.mjs` in a single Stop
    hook invocation.
12. `R13` — every one of the four scripts prints usage and exits 0 on `--help`/`-h` without
    reading `PLANE_API_KEY` or making any network call; an unknown flag exits 2.
13. **Negative case:** a denylist-forbidden string, a manual-budget-exceeding write, and an
    unresolvable `plane-apply` ref are each refused with zero writes and zero leaked matched
    text (§4 of test-plan.md).
14. **Deploy day:** the existing 160 Plane items and 282 registry rows are untouched by this
    change landing — nothing here runs against the real workspace until the owner-watched bulk
    `npm run plane:sync -- --max-writes 400` (spec.md "Deploy-day").

---

## Verification commands

Per round (after each implementation wave):

```bash
node -e "for (const f of ['scripts/campaign/plane-client.mjs','scripts/campaign/plane-sync.mjs','scripts/campaign/plane-intake.mjs','scripts/campaign/plane-triage.mjs','scripts/campaign/plane-apply.mjs','scripts/campaign/plane-fake-server.mjs']) if (require('fs').existsSync(f)) require('child_process').execFileSync(process.execPath,['--check',f],{stdio:'inherit'})"
npx prettier --check scripts/campaign .claude/hooks package.json .claude/settings.json
```

(S5.5 grounding, 2026-09-11: `.claude/skills` dropped from this gate's scope — it recurses the
whole skills tree and today fails on 7 files unrelated to this feature, so the wide glob was a
baseline false-red; the new `.claude/skills/plane/SKILL.md` is covered by TP6's own content
checks instead, and its formatting should still be swept with `npx prettier --write` before the
WP6 commit.)

Final (once, deciding):

```bash
node scripts/campaign/plane-sync.self-test.mjs
node scripts/campaign/plane-intake.self-test.mjs
node scripts/campaign/plane-triage.self-test.mjs
node scripts/campaign/plane-apply.self-test.mjs
node scripts/campaign/plane-docs.self-test.mjs
node .claude/hooks/stop.gate5.spec.mjs
node scripts/campaign/bugs.mjs self-test
node .claude/hooks/stop.gates.spec.mjs
```

Every final command above already exists in the repo's own convention (mirrors v1's
guarded-final-command shape) except the five new self-test files this plan creates, which do
not exist until their own TP package runs — same "not yet created" existence guard v1 used,
folded into the `perRound` `--check` loop above rather than repeated per command.

(S5.5 grounding, 2026-09-11: `node scripts/validate-code-map.mjs` removed from this list —
the script does not exist on this branch (`feat/plane-harness` @ `59121377`, based on master
`70d15a87`) and there is no `package.json` script wrapping it either, so the command would fail
closed at Baseline for a reason unrelated to this feature.)

---

## UI verification

Not applicable — `ui: false`; no rendered surface in this change.

---

## Risks & rollback

| Risk                                                                                                    | Likelihood                                                                | Blast radius                                                                      | Mitigation / what the reviewer should watch                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adoption PATCHes the wrong Plane item (duplicate-candidate mis-pick)                                    | low                                                                       | cosmetic-to-moderate (a Plane item gets an `external_id` it shouldn't)            | oldest-`sequence_id`-wins rule is deterministic and logged (`duplicate candidate` warn); reversible by hand (R1's non-scripted PATCH `external_id: null`, documented in spec.md's lifecycle sweep) |
| A denylist gap lets a tenant uuid/invoice number/email reach the real Plane workspace                   | low (7 patterns cover the known shapes)                                   | data leak to a third-party SaaS, visible to the whole team, hard to fully retract | every outbound string passes `scanForbidden` before any request body is built; T3/T10 assert the matched text never appears in this process's own output either                                    |
| A write-budget bug lets Gate 5 or a manual run burn through Plane's API quota or spam comments          | low                                                                       | moderate — noisy Plane activity feed, wasted API quota                            | the client's own counter defers past `--max-writes` (not a caller-side check that can be skipped); T4/T9 assert the exact write count under a small budget                                         |
| `plane-triage`'s `SessionStart` hook makes every cold session slower or hangs offline                   | low                                                                       | annoyance (session-start latency), never data loss                                | R7's own no-key/network-error contract already exits 0 immediately in both failure modes; no retry loop is added (Landmine 11)                                                                     |
| `plane-apply` archives or state-moves the wrong item because two projects share an identifier collision | very low (identifiers are unique per workspace by Plane's own constraint) | a wrong item mutated in Plane                                                     | validate-before-write resolves every ref up front and prints the resolved plan under `--dry-run`; the reviewer should run `--dry-run` against any real ops file before the real run                |

- **Rollback:** revert this PR's diff — `plane-sync.mjs` returns to its v1 (pre-adoption)
  behavior, and the three new scripts + shared client disappear; no data migration exists to
  reverse. Plane items that were adopted or created before a revert keep their `external_id`
  stamps (harmless — the spec's own "Rollback" note: "Plane keeps the stamped `external_id`s ...
  the next run reuses them").
- **Migration reversibility:** n/a — no schema/DB change.
- **Feature flag / entitlement:** none — this is a repo-tooling change with no runtime gate;
  the "flag" is operational (the owner chooses when to run `plane:sync -- --max-writes 400`
  for the first real bulk sync).
- **Deploy day:** nothing changes for any RouteFlow user or tenant — this never touches
  `apps/*`. The only real-world effect is Plane's own workspace state, and only once a human
  runs the bulk sync with the owner watching (spec.md "Deploy-day").
- **Observability:** every write appends one ledger line (`ts, tool, method, path, ref`);
  `plane:triage --brief`'s `writes today` section and `BUGS drift` count are the two-am signal
  that something is wrong (a runaway write count, or drift that isn't shrinking after a sync).

---

## Pipeline args

See `pipeline-args.json` beside this plan.

## Landmine 15 — live endpoint shapes (verified read-only against the real workspace, 2026-09-12 00:4xZ; the fake server MUST mirror these)

| endpoint (under `/api/v1/workspaces/{slug}/`)           | shape                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `members/` and `projects/{id}/members/`                 | plain ARRAY (not paginated); item `{ id, first_name, last_name, email, display_name, role, role_slug, is_active, is_bot }` — `display_name` is on the item itself, no nested `member`                                                                                                                                            |
| `projects/{id}/work-item-types/` (alias `issue-types/`) | ARRAY; item `{ id, name, is_epic, is_default, is_active, … }` — use `work-item-types/`                                                                                                                                                                                                                                           |
| `projects/{id}/intake-issues/`                          | paginated envelope; record carries `status` (-2 pending … 2 duplicate), `issue` (= work item id), `snoozed_till`; `intake-work-items/` does NOT exist (404)                                                                                                                                                                      |
| `projects/{id}/work-items/`                             | paginated envelope `{ results, next_cursor, next_page_results, prev_cursor, count, total_count }`; item `{ id, sequence_id, name, priority, state, state_group, labels[], assignees[], parent, type_id, external_source, external_id, target_date, start_date, updated_at, created_at, description_html, description_stripped }` |
| `…/work-items/{id}/comments/`, `…/links/`               | paginated envelope; comment `{ id, comment_html, comment_stripped, … }`; link `{ id, url, title? }`                                                                                                                                                                                                                              |
| `…/work-items/{id}/relations/`                          | GET returns a FLAT object `{ blocking, blocked_by, start_after, start_before, finish_after, finish_before, relates_to, duplicate }` (arrays of item ids) — not paginated                                                                                                                                                         |
| `…/work-items/{id}/archive/`                            | POST → 200 (verified on three items 2026-09-11)                                                                                                                                                                                                                                                                                  |
| `projects/{id}/labels/`, `states/`                      | paginated envelope; state `{ id, name, group, default, is_triage }`; label `{ id, name, parent }`                                                                                                                                                                                                                                |
| `projects/`                                             | paginated envelope; item carries `identifier`                                                                                                                                                                                                                                                                                    |

Consequences: `resolveMember` reads `display_name` from the array items; `resolveTypes` uses `work-item-types/`; intake lists `intake-issues/` (404 ⇒ `intake: endpoint unavailable (404)`, 0 pending, continue); plane-apply `relation` POSTs `…/relations/` with `{ relation_type, issues: [id] }` for built-in dependencies and the custom-definition form for `duplicate` (see the MCP tool contract) — validate the response status, not its shape.
