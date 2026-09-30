# Build plan — fix/tooling-flaky-gates

PR-A of the tooling batch (lead routeflow-c4, 2026-09-14; restructured 2026-09-15 to match the
rebuilt engine's task-graph contract — every `fix` task now requires `root-cause` and
`repro-test` ancestors via `dependsOn`; `task-brief.mjs` requires an exact `### <id>` heading per
task, which the 2026-09-14 draft did not have). Mode: bugfix. Risk: LOW for every task
(test-assertion-only changes, no money/tenancy/auth/schema).

Shared theme across every chain: a test asserts an AMBIENT, load-sensitive quantity (a wall-clock
bound, a global tmpdir count, a fixed observation-window poll, an exact dependency-version
literal) instead of the run's own artifacts (its exit code, its own registered paths, its own
process's output, a major-version line). This batch's lesson (id TBD — ask routeflow-c4 before
minting) generalizes that class.

B225/B231/B244/B352/B411/B415/B418 are filed (real ids, batched F53/F51 as applicable — verify
each against a master-current tree before citing, per this project's registry-minter practice).

Each bug below is a root-cause → repro-test → fix chain (`RC#`/`RT#`/`FIX#`), per the engine's
`validateTasks` requirement. See `tasks.json` for the exact task graph, files/tests ownership and
`dependsOn` edges — this document is the narrative the task briefs are sliced from.

### RC1

Root-cause for B225 (`REG-E2EGUARD-403`) + B244 — `apps/api/src/common/ci-freshness-guard-script.spec.ts`.
The `'(pin) hang'` case (line 260-276) sets `CI_FRESHNESS_GH_TIMEOUT_MS=500` (fake `gh` sleeps
10s, the script's own timeout fires at 500ms) and asserts `elapsedMs<5000` (line 274) around the
whole `spawnSync` call — a 4.5s margin meant to absorb node/subprocess startup on a loaded
runner, not a real regression signal. Confirm by inducing real CPU contention (background
busy-loop children saturating every core) and observing the assertion trip while behavioral
outputs stay correct.

### RT1

Add `REG-B225`/`REG-B244` to the same describe block, reusing RC1's contention harness around the
identical `hang` scenario, asserting only `outputs.run`/warning marker/`res.status` — never
`elapsedMs`. Must go RED on the current file via the EXISTING `elapsedMs<5000` assertion (line 274) tripping under the induced contention while the new behavioral-only assertions pass.

### FIX1

Delete `start`/`elapsedMs`/`expect(elapsedMs).toBeLessThan(5000)` (lines 261, 265, 274) from
`'(pin) hang'`; keep every behavioral assertion. If RC1 found the `REG-E2EGUARD-403` case (line 194) shares this mechanism, fix it the same way; otherwise report it separately, unfixed.

### RC2

Root-cause for B231 + B415 — `scripts/campaign/bugs.mjs` self-test. Two sites: `elapsedMs<5000`
in the "lock order (runtime)" check (line ~6779, a real `execSync` race between two child
processes) and `awaitExit(victim, 3000)` in the lock-liveness dead-holder check (line ~5757,
tighter than the same helper's own 15000ms default at line ~5706). Confirm via repeated runs of
`node scripts/campaign/bugs.mjs self-test` under induced host contention.

### RT2

Create `apps/api/src/common/bugs-self-test-script.spec.ts` (new file — `introducesObservable`,
honest RED = does not exist yet): a thin jest wrapper spawning `node scripts/campaign/bugs.mjs
self-test` and asserting exit 0 + the success marker, titled with `REG-B231`/`REG-B415` so
`campaign-check` has a literal jest test to prove against (the self-test harness itself is not
jest).

### FIX2

In `scripts/campaign/bugs.mjs`: drop the `elapsedMs<5000` lock-order check (line ~6779), keep the
exit-code assertions as the sole oracle; raise `awaitExit(victim, 3000)` (line ~5757) to `15000`
to match the block's own convention. Re-run the self-test directly to confirm it still reports all
checks passed.

### RC3

Root-cause for B418 — `apps/api/src/common/prod-migrate-script.spec.ts`. `run()` (line 43-50)
calls `spawnSync(process.execPath, [SCRIPT], {timeout:30_000,...})`; line 148 asserts
`expect(res.status).toBe(2)` on a real, DB-free invocation. Node's own contract: a `timeout` kill
returns `status:null`, not the real code — under severe contention this specific case can exceed
30s. Confirm deterministically with a throwaway never-exiting fixture script (NOT the real
`prod-migrate.mjs`) under the identical `{timeout:30_000}` shape — this needs no host contention,
Node's own timeout-kill is exact.

### RT3

Add `REG-B418`: a new case using a never-exiting fixture script (kept local to the spec, never
touching `scripts/prod-migrate.mjs`), spawned with the same timeout shape, asserting the CURRENT
bare `expect(res.status).toBe(2)` pattern fails with `Expected: 2, Received: null` — a genuinely
deterministic repro of RC3's finding, no ambient load needed.

### FIX3

Add an `expect(res.signal).toBeNull()` precondition before the status check at line 148 (and in
RT3's new case) so a timeout-kill now reports a clear, distinguishable message instead of the bare
`Expected 2, Received null`. RT3's case is expected to still fail, but with the new, readable
message — state which outcome resulted.

### RC4

Already root-caused on the B411 registry record (`.claude/campaign/bugs/B411.md`) — read its Root
cause / Fix approach sections first. `.claude/hooks/stop.gate5.spec.mjs`: `REPO_DIRS` (line 149)
holds this run's own scaffold dirs; `tmpDirsBefore` (line 164) snapshots a global tmpdir count; F4
(line 647-652) compares that count before/after in the SAME process, so a stale dir from an
earlier completed run cancels out — the real trigger is a CONCURRENT sibling run creating
`stop-gate5-spec-*` dirs mid-window. Confirm by creating an unrelated such dir directly during the
window and observing F4 fail despite this run's own dirs being genuinely clean.

### RT4

Add `REG-B411`: a case creating an unrelated `stop-gate5-spec-*` dir during F4's before/after
window, asserting F4 currently fails even though this run's own `REPO_DIRS` are all cleaned up.
Deterministic, no contention needed; clean up the extra dir at the end regardless of outcome.

### FIX4

Rewrite F4 (line 647-652) to iterate `REPO_DIRS` and assert each entry no longer exists, dropping
the ambient tmpdir-count comparison. Re-run RT4's case and confirm it now passes.

### RC5

Root-cause for B352 — `apps/api/src/common/next-version.spec.ts` reads the REAL
`apps/web/package.json` and pins three exact literals (lines 30, 35, 41). Same class as #745/L-129
(this session's own lesson for the equivalent React-skew guard): the guard only needs to confirm
the Next-14 pin hack never returns, not pin the exact patch. Confirm by reading #745's fix. Do
**not** bump the real `apps/web/package.json` version as part of this probe.

### RT5

Add `REG-B352` as a new describe block testing a small local helper `pinnedToMajorLine(version,
major)` (does not exist yet — `introducesObservable`, honest RED, mirrors #745's own fix shape):
asserts it accepts `'15.6.0'`/`'^15.6.0'` and rejects `'14.2.35'`. Does not touch
`apps/web/package.json` or the three existing assertions.

### FIX5

Using RT5's helper, rewrite the three exact-match assertions (lines 30/35/41) to a major-line
`toMatch` check against the unchanged real manifest data — mirrors #745 exactly. Do not touch
`apps/web/package.json`. Keep RT5's synthetic-value block as the permanent regression pin.
