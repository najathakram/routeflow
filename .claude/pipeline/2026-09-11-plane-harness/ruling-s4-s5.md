# S4/S5 ruling — 2026-09-11-plane-harness (Fable 5.1; Sonnet expands into test-plan.md + build-plan.md)

## Test harness

All tests: `node:test` + a `node:http` fake Plane server (the v1 pattern in `scripts/campaign/plane-sync.self-test.mjs`, extracted into `scripts/campaign/plane-fake-server.mjs`); temp registry via `PLANE_SYNC_REGISTRY_DIR`; temp ledger/cache via `PLANE_SYNC_STATE_DIR` (new env, default `.claude/campaign`); `PLANE_API_KEY` set to a dummy in tests; the fake records every request `{method, path, body}` and serves projects/states/labels/types/members/work-items (cursor pagination)/comments/links/relations/archive/intake. Each test group boots its own server on a random port and never touches the real API.

| T#  | R#    | Level       | Given / When / Then                                                                                                                                                                | Oracle (concrete)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ----- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1  | R1    | integration | fake BUGS has "B12 · x" (external_id null, Backlog) and "B13 · y" (external_id B13); registry has B12 (queued) + B13 (queued) → run sync twice                                     | run 1: PATCH count = 1 (path ends `/work-items/<B12 id>/`, body has external_source "routeflow-registry" + external_id "B12"), POST work-items = 0; run 2: writes = 0                                                                                                                                                                                                                                                                                                                |
| T2  | R1    | integration | fake has "B12 · a" seq 5 and "B12 · b" seq 9, both null                                                                                                                            | PATCH exactly the seq-5 item; output contains `duplicate candidate B12`; DELETE count = 0                                                                                                                                                                                                                                                                                                                                                                                            |
| T3  | R2    | integration | registry row B77 title "Invoice INV-2026-12345 double-charged" (queued), no Plane item                                                                                             | POST work-items for B77 = 0; summary line contains `skipped(forbidden)=1`; captured output does not contain "INV-2026-12345"; output contains `B77 forbidden (invoice-number)`                                                                                                                                                                                                                                                                                                       |
| T4  | R3    | integration | 5 queued rows, no Plane items, `--max-writes 3`                                                                                                                                    | POST count = 3; summary contains `deferred=2`; exit 0; ledger file has exactly 3 lines, each parses with keys ts,tool,method,path,ref and no `body` key                                                                                                                                                                                                                                                                                                                              |
| T5  | R4,R5 | integration | fake "B45 · z" in `Done` (group completed) and "B46 · w" in Backlog; ledger B45 done (pr 678, sha abc1234, test REG-B45), B46 done (pr 681)                                        | B45: PATCH state → Live id, comments POST for B45 = 0 (was already completed); B46: PATCH → Live, comments POST = 1 with comment_html containing "PR #681" and "plane-sync:closed", links POST = 1 with url ending `/pull/681`; run 2: 0 comment/link writes; delete the cache file, fake lists B46's comment → run 3: 0 comment/link writes                                                                                                                                         |
| T6  | R4    | integration | registry B50 done with pr 600, no Plane item                                                                                                                                       | POST work-items = 1 (created with the Live state id); comments POST = 0; links POST = 0                                                                                                                                                                                                                                                                                                                                                                                              |
| T7  | R6    | integration | fake BUGS has "Scanner crashes on iOS 19" (priority urgent, label mobile, null) and "B12 · x"; intake queue has one pending record                                                 | listing prints exactly `node scripts/campaign/bugs.mjs file "Scanner crashes on iOS 19" --location "Area · mobile" --severity critical --tier T1` and `awaiting owner triage: 1`; "B12" not listed; `--apply` in a temp git repo where `.claude/campaign` is dirty → exit 2, message contains `dirty`, writes 0; `--apply` with clean tree + origin/master ancestor → bugs.jsonl gains one row, PATCH count = 1 with external_id = the minted id and name starting `B<id> · Scanner` |
| T8  | R7    | integration | fake: OPS item target_date yesterday (Backlog); DECIDE item Backlog; ROAD item In progress updated_at 10 d ago; BUGS "B12 · x" Backlog while ledger says done                      | brief contains `overdue 1`, `open rulings 1`, `stale started 1`, `BUGS drift 1`; total GET count ≤ 12; brief bytes ≤ 1536; first line matches /\d{4}-\d{2}-\d{2}T/; with PLANE_API_KEY unset: stdout = `Plane triage: skipped (no PLANE_API_KEY)`, exit 0                                                                                                                                                                                                                            |
| T9  | R8,R3 | integration | ops file: update ROAD-15 state "In review"; comment OPS-23; create OPS task with parent "ROAD-68"; relation DECIDE-6 duplicate DECIDE-12; archive DECIDE-6 (Cancelled in the fake) | `--dry-run`: writes 0, plan has 5 lines with identifiers and no substring matching /[0-9a-f]{8}-[0-9a-f]{4}-/; real: writes 5 in order PATCH, POST comments, POST work-items, POST relations, POST archive; ops file with state "Nope" → exit 1, writes 0, message contains `#1` and `Nope`; ledger pre-seeded with 20 manual lines dated today → exit 3, writes 0; add `--over-budget "window 15"` → proceeds, a ledger line contains `window 15`                                   |
| T10 | R2    | integration | ops file comment html containing a uuid                                                                                                                                            | exit 1, writes 0, output contains `forbidden (tenant-uuid)` and not the uuid                                                                                                                                                                                                                                                                                                                                                                                                         |
| T11 | R9    | integration | the v1 tests (rate-limit sleep on X-RateLimit-Remaining 0; 5xx retry-then-succeed; dry-run makes 0 fetches; idempotent second run; no uuid/key literals in source)                 | all still pass through the shared client; the literal-scan test now also covers plane-client/intake/triage/apply                                                                                                                                                                                                                                                                                                                                                                     |
| T12 | R12   | unit        | stop.gate5.spec: the argv the hook passes to plane-sync                                                                                                                            | contains `--max-writes` immediately followed by `25`                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| T13 | R11   | unit        | package.json                                                                                                                                                                       | scripts has plane:sync, plane:check, plane:triage, plane:intake, plane:apply; `verify` contains the four self-test invocations                                                                                                                                                                                                                                                                                                                                                       |
| T14 | R10   | unit        | files                                                                                                                                                                              | `.claude/skills/plane/SKILL.md` exists, ≤ 6144 bytes, contains each of the four script names; `.claude/settings.json` has a SessionStart hook whose command contains `plane-triage.mjs --brief`; `.claude/skills/rebuild/SKILL.md` contains `plane:sync`; `.gitignore` contains `.plane-writes.jsonl`                                                                                                                                                                                |

## Packages (file ownership disjoint; shared file ⇒ dependsOn)

testPackages: TP1 `scripts/campaign/plane-sync.self-test.mjs` + `scripts/campaign/plane-fake-server.mjs` (extend: T1–T6, T11, T13) · TP2 `scripts/campaign/plane-intake.self-test.mjs` (T7; dependsOn TP1) · TP3 `scripts/campaign/plane-triage.self-test.mjs` (T8; dependsOn TP1) · TP4 `scripts/campaign/plane-apply.self-test.mjs` (T9, T10; dependsOn TP1) · TP5 `.claude/hooks/stop.gate5.spec.mjs` (extend: T12) · TP6 `scripts/campaign/plane-docs.self-test.mjs` (T14).

packages: WP1 `scripts/campaign/plane-client.mjs` + `scripts/campaign/plane-denylist.json` (R2, R3, R9; effort high) · WP2 `scripts/campaign/plane-sync.mjs` (R1, R4, R5, R12 flag; dependsOn WP1; effort high) · WP3 `scripts/campaign/plane-intake.mjs` (R6; dependsOn WP1) · WP4 `scripts/campaign/plane-triage.mjs` (R7; dependsOn WP1, WP2) · WP5 `scripts/campaign/plane-apply.mjs` (R8; dependsOn WP1) · WP6 docs + flows: `.claude/skills/plane/SKILL.md`, `.claude/settings.json`, `package.json`, `.gitignore`, `.claude/hooks/stop.mjs` (Gate 5 `--max-writes 25`), `.claude/skills/rebuild/SKILL.md`, `.claude/skills/bug-registry/SKILL.md`, `.claude/code-map/{INDEX.md,_meta.json,<area>.md}` (R10, R11, R12; dependsOn WP2, WP3, WP4, WP5).

## Hard lines (exact)

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

## Verify commands (tiered)

perRound: `node -e "for (const f of ['scripts/campaign/plane-client.mjs','scripts/campaign/plane-sync.mjs','scripts/campaign/plane-intake.mjs','scripts/campaign/plane-triage.mjs','scripts/campaign/plane-apply.mjs','scripts/campaign/plane-fake-server.mjs']) if (require('fs').existsSync(f)) require('child_process').execFileSync(process.execPath,['--check',f],{stdio:'inherit'})"` · `npx prettier --check scripts/campaign .claude/hooks .claude/skills package.json .claude/settings.json`
final (each self-test guarded with existsSync exactly like v1): `node scripts/campaign/plane-sync.self-test.mjs` · `node scripts/campaign/plane-intake.self-test.mjs` · `node scripts/campaign/plane-triage.self-test.mjs` · `node scripts/campaign/plane-apply.self-test.mjs` · `node scripts/campaign/plane-docs.self-test.mjs` · `node .claude/hooks/stop.gate5.spec.mjs` · `node scripts/campaign/bugs.mjs self-test` · `node .claude/hooks/stop.gates.spec.mjs` · `node scripts/validate-code-map.mjs`.
redGate: the five self-tests (sync/intake/triage/apply/docs) + stop.gate5.spec, `expect: fail`.
mutationProbe (major): { file: scripts/campaign/plane-sync.mjs, behavior: "adoption stamps external ids instead of creating", test: T1 } · { file: scripts/campaign/plane-client.mjs, behavior: "a denylist hit skips the write", test: T3 } · { file: scripts/campaign/plane-client.mjs, behavior: "max-writes defers instead of writing", test: T4 } · { file: scripts/campaign/plane-apply.mjs, behavior: "validation completes before the first write", test: T9 }.

## Lessons carried

L-067 (a write proves its own effect — `deferred` is a return value, not a log line; compare before/after) · L-068 (ledger append atomic per line; the cache is rewritten whole) · L-074 (a script that can target a real workspace prints the resolved base URL + slug before the first write) · L-083 (the brief carries its own timestamp) · L-103 (never pipe a gate through `| tail`) · L-105 (the id matcher has one definition every reader imports).

## Addendum (2026-09-11 23:30Z)

| T15 | R13 | unit | run each of the four scripts with `--help` and with PLANE_API_KEY unset and PLANE_BASE_URL pointing at a port nothing listens on | exit 0; stdout contains `Usage:` and the script's own name; the fake server (if started) records 0 requests; an unknown flag `--bogus` → exit 2 with `Usage:` on stderr |
T15 belongs to TP1 (sync), TP2 (intake), TP3 (triage), TP4 (apply) respectively; add it to each package's provenBy and WP2–WP5's satisfies (R13).

| T16 | R14 | integration | temp git repo on branch `feat/x` with a fake BUGS project needing 3 creates; run sync without flags, then with `--allow-branch`, then on branch `master` | run 1: POST count 0, stdout contains `Plane mirror: skipped writes (branch feat/x is not master; pass --allow-branch to override)`, exit 0; run 2: POST count 3; run 3 (after `git checkout -b master`): POST count 3. stop.gate5.spec T16b: the Gate 5 argv never contains `--allow-branch`. |
T16 belongs to TP1 (sync self-test) and T16b to TP5; WP2 satisfies R14; WP6 (Gate 5) is proven by T16b.

| T17 | R9 | integration | fake serves `work-item-types/` and `members/` as bare arrays (live shape); a second fake serves them as envelopes | `resolveTypes(project)` returns 2 types with name→id for "Task"; `resolveMember("ClaudeLead")` returns the seeded id; both shapes resolve identically |
| T8b | R7 | integration | fake BUGS project with 250 items across 3 pages; registry seeded so exactly 3 rows on page 3 drift | per-group counts sum to 250; `BUGS drift 3`; GET count ≤ 16 |
