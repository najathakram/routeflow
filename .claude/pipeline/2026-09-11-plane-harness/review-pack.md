# Review radius pack — 2026-09-11-plane-harness

Run dir: `C:/ClaudeCode/routeflow/.claude/worktrees/rf-plane2/.claude/pipeline/2026-09-11-plane-harness`
Worktree: `C:/ClaudeCode/routeflow/.claude/worktrees/rf-plane2`, branch `feat/plane-harness` @ 59121377
(base `feat/plane-bugs-mirror`; merge-base `master` 70d15a87).

**Scope note**: covers ONLY `scripts/campaign/*` (the plane-\* engine + self-tests +
plane-fake-server.mjs + plane-denylist.json). Docs/config another agent is actively editing
(`.claude/skills/*`, `.claude/settings.json`, `package.json`, `.gitignore`,
`.claude/hooks/stop.mjs`, `.claude/code-map/*`) is OUT OF SCOPE — separate pack. Exception:
`.claude/hooks/stop.gate5.spec.mjs` (a test, not docs/config; the only proof for R12/T12, R14/T16b).

Code quotes strip long prose comments (paraphrased around them) but never touch logic/code lines.

---

## 1. Scope

`git status --short` (full worktree, for orientation only — the diff below is filtered to
`scripts/campaign/`):

```
 M .claude/code-map/INDEX.md
 M .claude/code-map/_meta.json
 M .claude/hooks/stop.gate5.spec.mjs
 M .claude/hooks/stop.mjs
 M .claude/settings.json
 M .claude/skills/bug-registry/SKILL.md
 M .claude/skills/rebuild/SKILL.md
 M .gitignore
 M package.json
 M scripts/campaign/plane-sync.mjs
 M scripts/campaign/plane-sync.self-test.mjs
?? .claude/pipeline/2026-09-11-plane-harness/
?? .claude/pipeline/agent-log.jsonl
?? .claude/skills/plane/
?? scripts/campaign/plane-apply.mjs
?? scripts/campaign/plane-apply.self-test.mjs
?? scripts/campaign/plane-client.mjs
?? scripts/campaign/plane-denylist.json
?? scripts/campaign/plane-docs.self-test.mjs
?? scripts/campaign/plane-fake-server.mjs
?? scripts/campaign/plane-intake.mjs
?? scripts/campaign/plane-intake.self-test.mjs
?? scripts/campaign/plane-triage.mjs
?? scripts/campaign/plane-triage.self-test.mjs
```

`git diff --stat HEAD -- scripts/campaign/` (modified files only — new files have no HEAD diff):

```
 scripts/campaign/plane-sync.mjs           | 492 +++++++++++++------  (+340/-152)
 scripts/campaign/plane-sync.self-test.mjs | 757 +++++++++++++++++++++++++-----  (+642/-115)
 2 files changed, 982 insertions(+), 267 deletions(-)
```

New files under `scripts/campaign/` (`wc -l`): plane-apply.mjs 451 · plane-apply.self-test.mjs 370
· plane-client.mjs 380 · plane-denylist.json 26 · plane-docs.self-test.mjs 172 ·
plane-fake-server.mjs 325 · plane-intake.mjs 405 · plane-intake.self-test.mjs 300 ·
plane-triage.mjs 298 · plane-triage.self-test.mjs 233. (`bugs.mjs`, `normalize-evidence.mjs`,
`reg-token.mjs` pre-existing, untouched.)

---

## 2. Binding rules + requirements (one line each) + ruling hard lines (verbatim)

### Binding rules (spec.md)

No Plane uuids/keys/slugs in tracked files — resolve by identifier/name at runtime · registry =
proof, Plane never writes registry state, intake (R6) is the only Plane→registry path · sync never
deletes/archives (only `plane-apply` may archive, and only an item the ops file names explicitly)
· every outbound string passes the denylist (R2), matched text never printed ·
`PLANE_API_KEY` env-only, header `X-API-Key`, base `PLANE_BASE_URL` (default
`https://api.plane.so`)/slug `PLANE_WORKSPACE_SLUG` (default `routeflow`) · rate limit ≤ 50
req/min via the shared client, retries on 429/5xx honour `X-RateLimit-Reset` · Gate 5 non-blocking
— every script exits 0 with no key EXCEPT `plane-apply` (exit 2) · no PQL/custom properties — plain
list endpoints + client-side filters only.

### R1–R14 (one line each)

- **R1** P0 Adoption: before creating a `B###` item, sync finds an existing null-`external_id` BUGS
  item named `B<n> · …` with the same number and PATCHes `{external_source, external_id}` once
  (counts as a write); 2 candidates ⇒ adopt lowest `sequence_id`, warn `duplicate candidate B###`,
  never delete the loser.
- **R2** P0 Denylist: tracked `plane-denylist.json` (tenant-uuid/invoice-number/email/connection-
  string/jwt/railway-host/api-key-ish); `scanForbidden(text)→{name}|null`; a hit skips that op
  (sync: counted `skipped(forbidden)`; apply/intake: op fails, exit 1) — matched text never printed.
- **R3** P0 Write budget + ledger: shared client counts POST/PATCH/DELETE; `--max-writes` (sync
  250 / intake 20 / apply 20 / Gate 5 25) defers the rest (`deferred=<n>`, exit 0 for sync/triage);
  every ACTUAL write appends one JSON line to `.claude/campaign/.plane-writes.jsonl` (ids only, no
  body); manual budget: apply/intake `--apply` refuse when
  `writesToday(exclude plane-sync) + planned > 20` unless `--over-budget "<reason>"`.
- **R4** P0 Comment-on-close + PR link: when sync itself transitions an item open→completed/
  cancelled, post exactly one comment (exact template) + one link if a PR is known; idempotent via
  `.plane-sync-state.json` cache, falling back to a comments-list scan for `CLOSED_MARKER`;
  adoption of an already-completed item or creation of an already-`done` item posts nothing.
- **R5** P1 `STATE_BY_LEDGER` unchanged; Done(completed)→Live IS a diff and gets patched (distinct
  states).
- **R6** P0 Intake: `plane-intake.mjs [--apply][--batch F##][--json]` lists null-`external_id` BUGS
  items whose name does NOT match `/^B\d+\s*·/`, plus a pending(-2) intake-issues count; prints a
  ready `bugs.mjs file …` command per item; `--apply` preconditions IN ORDER (clean
  `.claude/campaign`, HEAD descends `origin/master`, key present), each exit 2/zero writes on
  failure; then per item: spawn `bugs.mjs file` → parse minted `B###` → PATCH the item → spawn
  `bugs.mjs note` (swallow failure); ledgered, R3 applies.
- **R7** P0 Triage brief (read-only): ≤ 12 GETs total; overdue / due≤Nd / open rulings / stale
  started / BUGS drift (via plane-sync's exported `planDiff`, never a 2nd diff impl) / writes today
  / per-project counts; `--brief` ≤ 1536 bytes with its own UTC timestamp; no key ⇒ skip, exit 0;
  network error ⇒ partial, exit 0.
- **R8** P0 `plane-apply.mjs <ops.json> [--dry-run][--max-writes n][--over-budget]`: ops
  `update|comment|create|relation|archive|link` by identifier/name. VALIDATION FIRST, THEN
  WRITES — every ref/name resolves before the first write; a miss exits 1 with the op index, zero
  writes. `--dry-run` prints the plan, zero writes. First failing write stops the run (exit 1).
  Missing key ⇒ exit 2; resolved base URL+slug print before the first write (L-074).
- **R9** P1 Shared client `plane-client.mjs`: `createClient({...})` w/ get/post/patch/del
  (retry+pagination), `resolveProject/States/Labels/Types/Member`, `scanForbidden`, `writesToday`,
  `summary()`; v1 self-tests keep passing unchanged.
- **R10/R11** P1 Skill+flows+package.json scripts+`.gitignore` — **out of scope for this pack**
  (docs/config, separate pass).
- **R12** P2 Gate 5 passes `--max-writes 25` to plane-sync.
- **R13** P1 `--help`/`-h` on every script: usage+exit 0 BEFORE any env read or network call;
  unknown flag → usage on stderr, exit 2.
- **R14** P0 Branch guard (incident 2026-09-11 23:26Z): plane-sync writes ONLY on `master`/`main`,
  or with `--allow-branch`; else lists/diffs but zero POST/PATCH, exact skip line, exit 0. Gate 5
  never passes `--allow-branch`.

### Hard lines (ruling-s4-s5.md, verbatim)

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
if (wasOpen && nowClosed && !(await alreadyClosed(id))) { await postCloseComment(...); if (pr) await postLink(...); markClosed(id); }
// alreadyClosed(id): cache.closed[id] ?? (list comments → some(c => (c.comment_stripped || "").includes(CLOSED_MARKER)))
```

```js
// plane-apply resolution order: projects → states/labels/types/members per referenced project → every ref (identifier → item via
// GET work-items/?per_page=100 pages of that project, matched on sequence_id) — ALL before the first write; a miss throws
// { opIndex, message } → print `#<i> <message>`, exit 1, zero writes made.
```

```js
// plane-triage call budget: 1 GET projects + 5 GET states (one per project) + 4 GET work-items page 1 (ROAD/OPS/DECIDE/CLIENT)
// + BUGS pages (≤ 2 today) = ≤ 12. Never call comments/links/properties.
```

Lessons: **L-067** a write proves its own effect (`deferred` is a return value) · **L-068** ledger
append atomic per line, cache rewritten whole · **L-074** a script targeting a real workspace
prints resolved base URL+slug before the first write · **L-083** the brief carries its own
timestamp · **L-103** never pipe a gate through `| tail` · **L-105** the id matcher has one
definition every reader imports.

---

## 3. Per-file function excerpts (file:line ranges; comments trimmed, logic verbatim)

### scripts/campaign/plane-client.mjs

**`scanForbidden` (b) — L85-91** — quoted verbatim in §2's hard-lines block; unchanged here.

**`write(method, path, body, {ref, reason})` (b+e, inside `createClient`) — L276-297** — denylist
scan → budget check → throttle → request → ledger append, in that order.

```js
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
    log(`Plane target: ${baseUrl} (workspace: ${slug})`);
  }
  await throttleWrite();
  const result = await request(method, path, { body });
  writes++;
  appendWrite({ tool, method, path: buildUrl(path).pathname, ref, reason });
  return result;
}
```

**`appendWrite` (e) — L119-132** — quoted verbatim in §2's hard-lines block (atomic
`appendFileSync`, one JSON line per write, unchanged here).

**`writesToday` (e) — L137-155** — reads the ledger file line by line (missing file ⇒ 0, a
malformed JSON line is skipped not thrown), counts lines whose `ts` (ISO) starts with today's UTC
date AND whose `tool` is not in `exclude`.
**`resolveProject`/`resolveStates`/`resolveLabels`/`resolveTypes` (c) — L302-336** — all
case-insensitive name→id(+group) maps built from `listAll`.

```js
async function resolveProject(identifier) {
  const projects = await listAll("projects/");
  const project = projects.find((p) => p.identifier === identifier);
  if (!project)
    throw new Error(`no project with identifier "${identifier}" in workspace "${slug}"`);
  return project;
}
async function resolveStates(projectId) {
  const states = await listAll(`projects/${projectId}/states/`);
  const map = new Map();
  for (const s of states) map.set(String(s.name ?? "").toLowerCase(), { id: s.id, group: s.group });
  return map;
}
// resolveLabels/resolveTypes: identical shape, name(lower) -> id, over labels/ and work-item-types/
```

**`resolveMember` (c) — L345-357** — `listAll("members/")`, then finds a member whose
`display_name ?? first_name ?? email` (in that order) case-insensitively equals the wanted display
name; on a miss, WARNS and returns `undefined` (never throws) — see §4 for the live-shape mismatch
this depends on (`listAll` against a bare array).
**`listAll`** (support for c/reads) — L260-271 — cursor pagination assuming
`{results, next_cursor, next_page_results}`; see §4, this is what breaks against a bare-array
endpoint.

One-liners: `repoRoot` (L57-70, walks up for a package.json+.claude marker pair) · `scanBodyDeep`
(L96-114, recurses body values for R2) · `loadDenylist` (L76-80) · `buildUrl`/`waitForRateWindow`/
`throttleWrite`/`request`/`get` (L180-257, URL build + 50/min + 260ms floors + 429/5xx retry) ·
`createClient`'s closure/return object (L163-380).

### scripts/campaign/plane-sync.mjs

**`deriveDesired` (a) — L270-303** — pure fn of the registry dir; per catalogue row: reads its
ledger row + board batch/issue + wave placement, maps `stateName`=`mapState(ledgerRow?.state)` and
`priority`=`mapPriority(row.severity)`, computes `hash = sha256Hex(JSON.stringify([row, ledgerRow,
issue]))` (wave placement deliberately OUTSIDE the hash — a slow/failed wave spawn must never flip
every batched row's hash), calls `buildDescriptionHtml`, and returns
`{external_source, external_id: row.id, name: "<id> · <title>", priority, stateName,
description_html, hash, ledgerRow}` — `stateId` is added later in `runSync` once Plane's actual
state ids are known.

**`buildCloseCommentHtml` (a) — L240-249**

```js
function buildCloseCommentHtml(ledgerRow) {
  const bits = [`state ${esc(ledgerRow.state ?? "")}`];
  if (ledgerRow.batch) bits.push(`batch ${esc(ledgerRow.batch)}`);
  if (ledgerRow.pr) bits.push(`PR #${esc(ledgerRow.pr)}`);
  if (ledgerRow.roundSha) bits.push(`sha ${esc(String(ledgerRow.roundSha).slice(0, 7))}`);
  if (ledgerRow.proof)
    bits.push(`proof ${esc(ledgerRow.proof)}${ledgerRow.tier ? ` / ${esc(ledgerRow.tier)}` : ""}`);
  return `<p><b>Closed by the registry</b> · ${bits.join(" · ")}</p><p><small>${CLOSED_MARKER}</small></p>`;
}
```

(`buildDescriptionHtml`, L216-234: same shape — 13 `id/title/.../wave` lines joined, then the
`registry-hash:` line appended last, so the hash is always of the tuple, never of the HTML quoting it.)

**`planDiff` (b) — L368-407** — matches ONLY by `external_id`; hash-compare gated on
`description_stripped` actually being a string (Landmine 1).

```js
export function planDiff(desired, existingItems) {
  const existingByExternalId = new Map(
    (existingItems ?? []).filter((it) => it.external_id).map((it) => [it.external_id, it]),
  );
  const desiredIds = new Set(desired.map((d) => d.external_id));
  const creates = [],
    patches = [],
    skipped = [],
    unverified = [];
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
```

**`loadSyncStateCache`/`saveSyncStateCache` (e) — L413-430** — read/write
`.plane-sync-state.json`; a missing or unparsable file reads as `{closed:{}}` (never throws), and
save is a whole-file `writeFileSync` (last-writer-wins, per L-068).
**`alreadyClosed` (e) — L436-440** — exact hard line from §2, unchanged:
`cache.closed?.[id]` short-circuits true; else lists the item's own comments and checks for
`CLOSED_MARKER` in `comment_stripped` (a lost cache never re-triggers a duplicate close comment).
**`currentBranch`/`isWriteAllowedBranch` (b, R14) — L459-476**

```js
function currentBranch() {
  let res;
  try {
    res = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot(),
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
```

**`runSync` (a+b+c+e, the core orchestrator) — L482-801.** Not fully quoted; key sub-blocks:

- L536-545 (c): resolves each DISTINCT desired state NAME once → `stateIdByName`, one warn per
  missing state (not per row).
- L552-554: lists work items with an explicit `fields=` list, no `external_source` filter
  (adoption needs to see un-stamped items).
- L556-593 (c): the adoption pass — identical to the hard-line block in §2.
- L614-635 (b, dry-run/check): prints `CREATE`/`UPDATE` lines + a "would create/update" summary
  (worded distinctly from a real-write summary so the two can never be mistaken in a log) and
  returns BEFORE the branch guard, zero writes either way; `--check` exits 1 when
  `creates+patches+skipped+unverified>0` (drift present), `--dry-run` always exits 0.
- L637-659 (b, R14 branch guard, checked only once dry-run/check are ruled out) —
  `if (!allowBranch && !isWriteAllowedBranch(branch)) { process.stdout.write("Plane mirror: skipped writes (branch <b> is not master; pass --allow-branch to override)\n"); return {exitCode:0,...}; }`
  — written DIRECTLY to `process.stdout`, not the file's stderr-only `emit()` — deliberate, T16's
  oracle reads stdout.
- L666-692 (a+b, create loop): per create, checks `budgetSpent()`, POSTs `{external_source,
external_id, name, state: stateId, priority, description_html}`; a created item already in a
  closed state posts no comment (comment-on-close fires only on a _transition_).
- L694-748 (a+b, patch loop + comment-on-close — the highest-defect-risk block in this file).
  Per patch (after the budget check): PATCHes `{name, state: stateId, priority,
description_html}`; on success, if `p.existing.state !== p.desired.stateId`, computes
  `wasOpen = !["completed","cancelled"].includes(idToGroup.get(p.existing.state))` and
  `nowClosed = ["completed","cancelled"].includes(idToGroup.get(p.desired.stateId))` and, only when
  `wasOpen && nowClosed && !alreadyClosed(...)`, posts the close comment (via
  `buildCloseCommentHtml`), then a PR link if `ledgerRow.pr` is set, then updates+saves the cache.
  NOTE: `idToGroup.get(p.existing.state)` — if Plane ever returns a `state` id this run's
  `statesMap` doesn't contain (stale/renamed state), the lookup is `undefined`, and
  `!["completed","cancelled"].includes(undefined)` is `true` — `wasOpen` defaults to true
  regardless of the item's real status. (`p.desired.stateId` can't reach this loop unresolved —
  `planDiff` routes that case to `skipped` — so the risk is one-sided, on `p.existing.state`.)
- L752-767 (e, digest write) — written ONLY when zero rows were
  skipped/unverified/deferred/forbidden and the run wasn't budget-exhausted (Landmine 3).
- L797-800: any thrown error ⇒ non-blocking `emit("...failed...")`, `exitCode: strict ? 1 : 0`.

**`main` (d) — L819-920.** `--help`/`-h` checked FIRST (L826-830); unknown-flag loop (L831-842)
consumes `--budget-ms`/`--max-writes` value tokens without validating them as flags; `PLANE_API_KEY`
read (L879) only after all flag parsing; `--if-digest-changed` (L886-901) compares
`registryDigest()` to the stored file and returns BEFORE calling `runSync` on a match — zero
network calls. Never calls `process.exit()` (sets `exitCode` + returns, to avoid racing undici's
socket teardown on Windows per the file's own comment).

One-liners: `mapState`/`mapPriority` (L105-118, table lookup + Backlog/medium fallback + one warn)
· `readCatalogue`/`readLedgerState`/`readBoard`/`boardIssue` (L122-160, registry-file readers,
copied from bugs.mjs per the file's header, not imported) · `computeWavePlacement` (L169-203,
best-effort 10s spawn of `bugs.mjs waves --json --no-claims`, empty map on any failure) ·
`registryDigest` (L310-326, sha256 of bugs.jsonl+status/*.jsonl+board.json, deliberately excludes
Plane-side data) · `extractExistingHash` (L331-334, regex pull of `registry-hash:`) ·
`esc`/`planeConfig` (formatting/env one-liners).

### scripts/campaign/plane-intake.mjs

**`gatherIntake` (c, + b's denylist) — L140-179.** Resolves the BUGS project, lists all work-items

- labels (building a label id→name map), and for each item with a null `external_id` whose name
  does NOT match `NAME_ID_RE`: runs `scanForbidden(item.name)` (a hit is dropped with a
  `Plane intake warn: BUGS-<seq> forbidden (<pattern>)` line, never the item's own name) else pushes
  `{item, severity: severityFor(item.priority), location: locationFor(item, labelNameById)}`.
  Separately lists `intake-issues/` and counts `status === -2`; a 404 is caught and logged as
  `Plane intake: endpoint unavailable (404)`, pending forced to 0 (Landmine 14/15 — not a failure).

**`fileArgv` (a) — L130-135** — the argv `--apply` actually spawns (`["file", name, "--location",
location, "--severity", severity, ...(batch ? ["--batch", batch] : []), "--tier", "T1"]`);
`readyCommand` (L110-125) builds the PRINTED string from the same fields via a separate,
hand-quoted string-concat — two independent builders that must stay in lockstep (the file's own
comment flags this risk).

**`applyCandidates` (a+b+e) — L203-285** — per item, in order: (1) manual-budget check
(`writesToday({exclude:["plane-sync"]}) + candidates.length > 20` ⇒ exit 3 with 0 writes unless
`--over-budget`); (2) `spawnSync(bugs.mjs, fileArgv(...))`, parse the minted id via
`/filed (B\d+)/` off stdout — a miss or non-zero exit returns 1 immediately; (3) PATCH the SAME
Plane item to `{external_source, external_id: mintedId, name: "<mintedId> · <item.name>"}` — a
`forbidden` result also returns 1 immediately; (4) `spawnSync(bugs.mjs note ...)`, wrapped in a
`try/catch` that swallows any failure (Landmine 2 — a fresh record may lack the "Summary" section).

NOTE: the loop is NOT transactional across items. If item #3 of 5's `bugs.mjs file` succeeds but
its PATCH then fails/`forbidden`s, the function returns immediately — #1-#2 are already filed AND
patched, #3 is filed in the registry but LEFT UN-STAMPED in Plane, and #4-#5 are never attempted. A
retry re-lists #3-#5 (all still un-stamped in Plane, since #3's Plane item was never patched) and
could mint a SECOND registry row for #3's same Plane item on the next `--apply`. Worth checking
against R6's "front door" invariant (one Plane item → one registry row).

**`main` (d) — L287-403.** `--help`/`-h` first (L292-296). `--apply` preconditions run in the exact
spec order: dirty-tree check (L342-359) → `git merge-base --is-ancestor origin/master HEAD`
(L361-370) → key present (L372-376) — each exit 2, all before `createClient` is even constructed.
Non-apply with no key ⇒ skip line, exit 0 (L377-381).

One-liners: `severityFor`/`locationFor` (L89-103, priority/label→severity/location maps) ·
`printListing` (L181-197, stdout formatting) · `readyCommand` (L110-125, printed-string twin of
`fileArgv`).

### scripts/campaign/plane-triage.mjs

**`gatherTriage` (the GET-budget-critical function; feeds c via `computeBugsDrift`, e via the
ledger read) — L63-197.** Sequence: (1) ledger reads (e) — `writesToday()` and
`writesToday({exclude:["plane-sync"]})`, wrapped in a `try/catch` reading as zero on any error,
independent of Plane reachability; (2) `createClient({apiKey, tool:"plane-triage"})` with no
`maxWrites` (read-only, never writes); (3) `client.listAll("projects/")` — 1 GET; (4) per
WANTED_PROJECTS (BUGS/ROAD/OPS/DECIDE/CLIENT) that resolved, `client.resolveStates(proj.id)` —
≤5 GETs, populating `groupById` — `classify()` reads group ONLY via this map, never an item's own
`state_group` field (Landmine 15); (5) per ROAD/OPS/DECIDE/CLIENT, ONE `client.get(...work-items/,
{per_page:100})` call (NOT `listAll` — no pagination here) — 4 GETs, `classify(ident, item)` per
result; (6) BUGS: one `client.get` page, plus a SECOND page only if
`page1.next_page_results && page1.next_cursor` — ≤2 GETs — then `classify("BUGS", item)` per item
and `computeBugsDrift(registryDir, statesByIdent.get("BUGS"), bugsItems)`. Any thrown error is
caught into `payload.error`, and whatever was already gathered is still returned. Worst case
1+5+4+2=12 GETs total, matching R7/T8. Because steps 5-6 use `client.get` directly rather than
`listAll`, a project with >100 open items past page 1 is silently under-counted — accepted in the
file's own comment as "under-counted this run, not over-budget."

**`computeBugsDrift` (c) — L38-58** — reuses `plane-sync.mjs`'s exported `deriveDesired`/
`planDiff` (R7: "never a second diff implementation"); resolves each desired state NAME against
the BUGS project's OWN states map (same pattern `runSync` uses), then calls the imported,
unmodified `planDiff`.

**`main` (d) — L242-298** — `--help`/`-h` first; `--days` guarded to positive numbers; no key ⇒
skip line on **stdout** (L278-282) — note this differs from plane-sync/plane-intake, which write
their no-key skip line to **stderr**; inconsistent stream choice across the family, likely
harmless for a human but worth confirming against any script that greps one stream only.

One-liners: `fmtSection`/`capToBudget`/`renderBrief` (L200-236, byte-cap degrades
ids-then-truncate, assumes ASCII-only output).

### scripts/campaign/plane-apply.mjs

**`buildPlan` (a+b+c, the single most load-bearing function in the diff) — L62-294.** Builds one
`{index, label, execute}` closure per op AFTER resolving every ref/name — no network write happens
until the caller iterates `plan` later. `getProjectCtx(identifier, index)` (c, L78-97, cached per
identifier) resolves a project then, in ONE `Promise.all`, its states/labels/types maps and every
one of its work-items (`per_page:100`, no second page — same >100-items caveat as triage) indexed
by `sequence_id`; a `resolveProject` throw is caught and turned into `fail(index, message)`.
`checkDenylist(index, label, strings)` (b, L132-138) scans every outbound string at VALIDATION
time (never at write time, unlike plane-sync's per-op skip). Each op type resolves its
ref(s)/name(s) via `getProjectCtx`+`resolveItem`/`resolveStateId`/`resolveLabelIds`/
`resolveMemberId`, builds its body, runs `checkDenylist`, then pushes `{index, label, execute}`.
`archive` (b, L249-270) is the ONLY op with a state-based precondition: it reads
`ctx.idToGroup.get(item.state)` off the CURRENT (pre-write) item and `fail()`s unless that group is
`completed`/`cancelled` — validated before any write, so `T9b`'s case (archiving a `started` item)
never reaches the network. `relation` (L225-247) POSTs `{relation_type: op.type, issues:
[toItem.id]}` for a built-in dependency — the file's own comment flags that a CUSTOM relation
definition (e.g. `"duplicate"`) needs a definition id no resolver here exposes, so only the
response STATUS is validated for that op, never its body shape (Landmine 15). `create`'s `type`
resolution (L203-207) is the only place a work-item-type-name miss can `fail()`.

**`runApply` (b) — L297-383** — read+parse ops file → `buildPlan` (validation-first) →
`--dry-run` short-circuit (zero writes) → manual budget refusal (L351-360, exit 3, checked AFTER
validation but BEFORE any write) → sequential execute loop: each `p.execute()` result checked for
`.forbidden` (belt-and-braces — `checkDenylist` should already have caught it during validation;
if it still fires here, exit 1 rather than silently treating it as success); the first thrown error
prints `#<i> <label> → failed: <message>` + `stopped after <applied> of <n> writes` and returns
exit 1 — no further ops in `plan` are attempted.
**`main` (d) — L389-447** — `--help`/`-h` first, before the ops file is even read; positional-arg
count enforced to exactly 1; missing `PLANE_API_KEY` ⇒ exit 2 (L436-441 — the one script in the
family where a missing key is NOT a silent skip, per R8).

---

## 4. plane-fake-server.mjs route table + Landmine 15 cross-check

| method + path                             | behaviour                                                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| GET `members`                             | `send(200, { results: members })` — **wraps in an envelope**                                                                        |
| GET `projects`                            | `send(200, { results: projects, next_cursor: null, next_page_results: false })`                                                     |
| GET `projects/<id>/states`                | `send(200, { results: states[identifier] })`                                                                                        |
| GET `projects/<id>/labels`                | `send(200, { results: labels[identifier] })`                                                                                        |
| GET `projects/<id>/work-item-types`       | `send(200, { results: types[identifier] })`                                                                                         |
| GET `projects/<id>/intake-issues`         | 404 if `seed.intake404`; else paginated `listPayload(...)`                                                                          |
| GET `projects/<id>/work-items`            | paginated `listPayload` (numeric-offset cursor, `per_page` honoured)                                                                |
| POST `projects/<id>/work-items`           | 429-once if `seed.failFirstCreate` (with `x-ratelimit-reset`); else 201, assigns `id`/`sequence_id`, derives `description_stripped` |
| PATCH `projects/<id>/work-items/<itemId>` | 200, shallow-merges `body`; re-derives `description_stripped` if `body.description_html` present                                    |
| POST `.../work-items/<itemId>/archive`    | 400 unless current state's `group` is completed/cancelled; else 200, sets `archived_at`                                             |
| GET/POST `.../comments`                   | GET lists; POST 201s `{id, comment_html, comment_stripped, created_at}`                                                             |
| GET/POST `.../links`                      | GET lists; POST 201s `{id, url}`                                                                                                    |
| POST `.../relations`                      | 201s `{id: "relation-<ts>", ...body}` — accepts ANY body shape                                                                      |
| anything else                             | 404 naming method+path                                                                                                              |

**Landmine 15 (build-plan.md, live shapes verified 2026-09-12) — paste:**

| endpoint (under `/api/v1/workspaces/{slug}/`)           | shape                                                                                                                      |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `members/` and `projects/{id}/members/`                 | plain ARRAY (not paginated); item `{ id, first_name, last_name, email, display_name, role, role_slug, is_active, is_bot }` |
| `projects/{id}/work-item-types/` (alias `issue-types/`) | ARRAY                                                                                                                      |
| `projects/{id}/intake-issues/`                          | paginated envelope; `intake-work-items/` does NOT exist (404)                                                              |
| `projects/{id}/work-items/`                             | paginated envelope `{results, next_cursor, next_page_results, prev_cursor, count, total_count}`                            |
| `…/work-items/{id}/comments/`, `…/links/`               | paginated envelope                                                                                                         |
| `…/work-items/{id}/relations/`                          | GET returns a FLAT object (N/A here — only POST is exercised)                                                              |
| `…/work-items/{id}/archive/`                            | POST → 200                                                                                                                 |
| `projects/{id}/labels/`, `states/`                      | paginated envelope                                                                                                         |
| `projects/`                                             | paginated envelope                                                                                                         |

**Mismatch worth the reviewer's weight:** `members/` is documented (Landmine 15, live-verified) as
a **plain array**, but the fake's `GET members` route returns `{results: members}` (envelope).
`resolveMember` calls `listAll("members/")`, reading `page?.results`/`page?.next_page_results` —
works against the fake (one page, `next_page_results` undefined ⇒ loop ends) but against the REAL
array-returning API, `page?.results` is `undefined`, so `resolveMember` would silently resolve
every lookup to "not found" in production (warns, never throws) while the self-test suite stays
green. `work-item-types/` has the identical latent gap (also via `listAll`, also envelope-wrapped
by the fake) — only `resolveProject`/`resolveStates`/`resolveLabels`/`work-items` are
confirmed-paginated on both sides.

---

## 5. Self-test case inventory (names/ids + concrete oracle; no vacuous assertions found)

All self-test files use a repo-convention `check(name, got, want)` deep-equal helper
(`stop.gate5.spec.mjs`: `report(name, passed, details)`) — not `node:test`/`assert`. Every
assertion compares a concrete computed value to a concrete expected one; a grep for vacuous
patterns (`ok(true)`, `toBeDefined`, count `>= 0`) across all `*.self-test.mjs` returned **zero
matches**. Every case below also asserts F4 (no leftover fixture temp dir), omitted per-line below.

`plane-sync.self-test.mjs` carries TWO numbering schemes: legacy **T1-T20** (L207-1011, the
PRE-HARNESS v1 spec, unrelated to R1-R14) and the harness's own **H1-H6, H11, H15, T16**
(L1065-1637), named to avoid colliding with the legacy numbers. Only harness cases are listed.

**plane-sync.self-test.mjs**: H1(T1/R1) run1 exactly 1 PATCH stamping
`{external_source:"routeflow-registry", external_id:"B12"}`, 0 POSTs; run2 0 writes · H2(T2/R1) two
candidates (seq 5,9): exactly 1 PATCH targeting seq-5, output contains `duplicate candidate B12`, 0
DELETEs · H3(T3/R2) B77 (invoice number in title): 0 POSTs, `skipped(forbidden)=1`, output never
contains the invoice number, contains `B77 forbidden (invoice-number)` · H4(T4/R3) `--max-writes 3`
vs 5 creates: exactly 3 POSTs, exit 0, `deferred=2`, ledger has exactly 3 lines each
`{ts,tool,method,path,ref}` and no `body` · H5(T5/R4,R5) 3 runs: run1 patches B45(Done→Live, 0
comments) and B46(Backlog→Live, 1 comment w/ `PR #681`+`plane-sync:closed`, 1 link ending
`/pull/681`); run2 (cache present) 0 comment/link writes; run3 (cache deleted, fake still lists
B46's comment) 0 comment/link writes · H6(T6/R4) create an already-`done` item: 1 create (state
Live), 0 comment/link posts · H11(T11/R9) every new file exists, no uuid/`PLANE_API_KEY="..."`
literal · H15a/b/c(T15/R13) `--help` exit0+Usage+0 requests even w/ valid key+reachable server;
`-h` exit0+Usage w/ no key+unreachable URL; `--bogus` exit2+Usage on stderr · T16(R14) 3 runs
against a REAL scaffolded throwaway git repo (never this worktree — the guard resolves
`repoRoot()` from the script's own file location): run1 on `feat/x` no flags ⇒ 0 POSTs, exact skip
line on stdout, exit0; run2 `--allow-branch` on `feat/x` ⇒ 3 POSTs, exit0; run3 on `master` (fresh
fake server) no flags ⇒ 3 POSTs, exit0.

**plane-intake.self-test.mjs**: T7 phase1 exit0, prints the exact ready command for the
human-created item, reports `awaiting owner triage: 1`, `B12` NOT listed · T7 phase2 (dirty tree)
`--apply` exit2, message matches `/dirty/i`, 0 network requests, `bugs.jsonl` unchanged · T7 phase3
(clean, master-descended) `--apply` exit0, `bugs.jsonl` gains exactly 1 row id `B1`, exactly 1
PATCH stamping `external_id:"B1"`, PATCH name starts `"B1 · Scanner"` · T15a/b/c same shape as
plane-sync's.

**plane-triage.self-test.mjs**: T8 `--brief` exit0; contains `overdue 1`, `open rulings 1`,
`stale started 1`, `BUGS drift 1`; total GETs ≤ 12; brief ≤ 1536 bytes; first line matches
`/^\d{4}-\d{2}-\d{2}T/`; no key ⇒ stdout EXACTLY `Plane triage: skipped (no PLANE_API_KEY)`, exit0
· T15a/b/c same shape.

**plane-apply.self-test.mjs**: T9 phase1(`--dry-run`) exit0, 0 writes, plan names every identifier

- new item name, never a uuid · T9 phase2(real run) exit0, exactly 5 writes, order
  `[update,comment,create,relation,archive]` · T9 phase3(invalid ref `state:"Nope"`) exit1, 0 writes,
  output has `#1` and `Nope` · T9 phase4(20 manual writes pre-seeded, no override) exit3, 0 writes ·
  T9 phase5(`--over-budget "window 15"`) exit0, 5 writes proceed, a ledger line's `reason` contains
  `window 15` · T9b(archive on a `started`-group item) exit1, 0 writes, output has `#1`, `archive`,
  `completed or cancelled` · T10(ops comment HTML w/ a uuid) exit1, 0 writes, output has
  `forbidden (tenant-uuid)`, never the literal uuid · T15a/b/c same shape.

**plane-docs.self-test.mjs** (T13/T14 — targets `.claude/skills/plane/SKILL.md`,
`.claude/settings.json`, `.claude/skills/rebuild/SKILL.md`, `.gitignore`, `package.json`: all OUT
OF SCOPE for this pack, "another agent is actively editing them" — listed only because the test
file itself lives in `scripts/campaign/`; its PASS/FAIL belongs to the separate docs/config pack).

**stop.gate5.spec.mjs** (`report(name, passed, details)`): unit-`scrubbedEnv` ambient key never
leaks, `extra` override always wins · T12a/R7 key unset: never blocks, prints skip line · T12b/R7
key+fake server: relays `"1 created, 0 updated"`, gate reads only the LAST bare-`Plane mirror:`
line, ignoring `Plane mirror warn:`/`(decoy)`/`fixture noise` · T12c/F1a child never answers: one
non-blocking line, never hangs · T12d/F2 a FAILING `git` must not throw out of Gate 5 ·
**T12/R12(harness)** Gate 5's spawned argv (relayed via a debug `Plane mirror: argv [...]` line)
contains `"--max-writes","25"` adjacent · **T16b/R14(harness)** regression lock: argv never
contains `"--allow-branch"` — NOTE (file's own comment, L480-483): this is "GREEN today" purely
because pre-implementation Gate 5 already had no `--allow-branch` element; it can only catch a
FUTURE regression that adds the flag, not prove today's Gate 5 correctly wires R14's absence — real
but one-directional coverage, weaker than T12/R12 (a positive, currently-failing-until-implemented
assertion per the file's own "true RED" comment).

---

## 6. Verify commands (pipeline-args.json) + gate status

**perRound** (pipeline-args.json `verifyCommands.perRound`):

```
node -e "for f of plane-client/sync/intake/triage/apply/fake-server.mjs: if existsSync(f), execFileSync(node --check f)"
npx prettier --check scripts/campaign .claude/hooks package.json .claude/settings.json
```

**final** (`verifyCommands.final`): `node scripts/campaign/plane-sync.self-test.mjs` ·
existsSync-guarded intake/triage/apply/docs self-tests · `node .claude/hooks/stop.gate5.spec.mjs`
· `node scripts/campaign/bugs.mjs self-test` · `node .claude/hooks/stop.gates.spec.mjs`. (NOTE:
ruling-s4-s5.md's `final` also names `validate-code-map.mjs` — absent from pipeline-args.json;
a discrepancy between the two artifacts, out of this pack's scripts/campaign scope.)

**redGate** (expected to FAIL pre-implementation, per build-plan.md's "must fail with" table):
the same five self-tests + `stop.gate5.spec.mjs`. expect: fail.

**Gate results**: PENDING. RESUME.md (same run dir) records the dev-pipeline engine as NOT RUNNING
(two launch attempts 2026-09-12 00:06Z/00:12Z were rejected by the Workflow tool's permission
handler / auto-mode classifier) — the build ran as a manually-orchestrated "light loop" instead,
and no perRound/final/redGate output is recorded anywhere in this run dir as of this pack's
authoring. Do not infer a pass/fail from file presence alone.
