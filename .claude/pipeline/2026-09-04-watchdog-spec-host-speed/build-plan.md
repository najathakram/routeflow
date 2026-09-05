# Build plan: watchdog spec host-speed race

> **Stage S5 — "how".** Authored by Fable 5 on `2026-09-04`.
> Status: `DRAFT`
> Mode: `bugfix` (bug-pipeline, shared dev-pipeline engine). Written AFTER
> [bug-test-plan.md](./bug-test-plan.md) and [cause-ruling.md](./cause-ruling.md) — the ruling and the
> tests decide the shape of the work, not the reverse.
> This file is the ONLY context the implementation and review agents receive. It must stand alone: no
> "the conversation", no "as discussed".
> Inputs: [cause-brief.md](./cause-brief.md) (evidence), [refutation.md](./refutation.md) (S2 verdict),
> [cause-ruling.md](./cause-ruling.md) (S3 ruling), [bug-test-plan.md](./bug-test-plan.md) (`T#`).
> Scale is small — the Preamble below stands in for `discovery.md`/`spec.md`.

**Gate to pass before S6:** every work package declares `satisfies:` and `provenBy:` (`T#`s). A
package that satisfies nothing is scope creep; a package proven by nothing is unverifiable.

**Ground rule — nothing named here may be invented.** Every file path and shell command in this file
is checked against the repo by the pipeline's Baseline phase before any agent writes a line. The only
exception is a path this change CREATES — flagged as such below.

---

## Preamble (small scale)

- **Problem:** the "defaults" test in
  `apps/api/src/common/visibility-watchdog-script.spec.ts` gates readiness with a fixed 500 ms
  `setTimeout` instead of an observable signal. Bare Node bootstrap alone measures 0.6–1.1 s on a
  loaded/slow host, so the log is still empty at 500 ms and the test fails
  (`expected substring "minutes=45 repo=najathakram/routeflow", received ""`) even though
  `scripts/visibility-watchdog.mjs` behaves correctly. This blocks the local pre-push gate
  (`npm run verify`) and, transitively, the push for PR #597 (the in-repo bug registry).
- **Who hits it:** any developer or agent running the `apps/api` Jest lane (directly, via
  `npm run verify`, or via the local pre-push gate) on a loaded or slow host. Green on CI's faster
  runner masks it there.
- **Success signal:** the "defaults" test's pass/fail depends only on whether
  `scripts/visibility-watchdog.mjs` actually applied `--minutes 45 --repo najathakram/routeflow` —
  never on how fast the host booted Node — and this is proven by a deterministic 1.5 s slow-boot
  injection test that fails today and passes after the fix, without any lane-wide Jest timeout
  change.
- **Requirements** _(the identifier each package's `satisfies:` and each `T#` point at)_:
  - `watchdog-spec-host-speed` — the "defaults" test's readiness wait is based on an observable
    signal (the log's `" start "` line via a capped poll), the child is always killed (resolve, cap,
    and `error` paths, via `finally`), the async test(s) declare an explicit per-test timeout
    (`35_000`) above the poll cap so the cap fires first, a deterministic repro test proves the fix
    survives a 1.5 s child-boot delay and fails on today's fixed-delay behavior, and the
    stdout-mirror sibling gains a non-empty guard against a vacuous pass.
- **Non-goals (the scope fence):** no change to `scripts/visibility-watchdog.mjs`; no lane-wide
  `testTimeout` added to `apps/api/package.json`'s jest config; no change to the four other sibling
  tests' shape or to `fakeEnv`/`readLog` semantics; no B-id filing here (the registry doesn't exist on
  master yet — the PR body asks the owner to file one once #597 lands); no data repair (none needed).

**Sufficient when every one of these holds:** `scale: 'small'` — confirmed: 1 production file (the
spec itself, since the "production code" under test IS this harness) plus one new fixture; no UI
surface; nothing in a HIGH-risk area (money/pricing/tax, auth, tenancy, migrations, PII, payments);
the problem is agreed (owner report + S1/S2 evidence) and statable in one sentence; one requirement.

---

## Objective

Make the `visibility-watchdog.mjs` contract spec's "defaults" test deterministic on any host by
replacing its fixed 500 ms wait with a capped poll on the script's own `" start "` log line, paired
with an explicit per-test Jest timeout above that cap — so the test proves the script applied its
defaults, never that the host booted fast enough.

**In scope:** `apps/api/src/common/visibility-watchdog-script.spec.ts` (the shared
`awaitStartLine` helper, the converted "defaults" test, a new deterministic repro test, a
non-empty guard on the stdout-mirror test) and a new fixture,
`apps/api/src/common/testing/slow-boot.cjs`.

**Explicitly out of scope:** `scripts/visibility-watchdog.mjs` itself; the four other `it` blocks'
shape; any lane-wide Jest configuration change; filing a bug-registry id (owed to the owner via the
PR body, post-#597).

---

## Constraints & conventions

- **Stack / framework:** NestJS/Jest workspace (`apps/api`). The file under change is a Jest
  spec (`ts-jest`), not application source — the "production code" being fixed here is test harness
  code that spawns a real Node child process.
- **Test runner and layout:** Jest. Config lives in the `"jest"` block of `apps/api/package.json`
  (`testRegex: ".*\\.spec\\.ts$"`, `.db.spec.ts` excluded). **No `testTimeout` is declared in this
  lane** — jest-config's default of 5000 ms governs every test unless the test itself passes a third
  argument to `it(...)`. The only `testTimeout` anywhere in the workspace is
  `apps/api/jest.db.config.js:10` (`30000`), which applies exclusively to the separate
  `*.db.spec.ts` lane and does not reach this file.
- **Lint / format rules that will fail the gate:** Prettier (semicolons, double quotes, printWidth
  100, trailing commas) via the repo's `formatCommand` below.
- **Existing patterns to copy rather than invent:** the four `spawnSync`-based `it` blocks already
  in this same spec file (`run(...)` at spec:57-59) — synchronous, block until child exit, no timer.
  Leave their shape untouched; only the async "defaults" test and its new sibling change.
- **Must NOT change:** `scripts/visibility-watchdog.mjs` (byte-for-byte); the four sibling tests'
  shape; `fakeEnv`/`readLog`/`newLogPath` signatures and semantics.
- **Do-not-introduce list (repo-wide):** Vitest, Biome — not relevant here but stays Jest throughout.
- **Landmines:**
  - `apps/api/package.json`'s jest reporter (`scripts/jest-campaign-reporter.cjs`) rewrites
    `.campaign/runs/api.json` on every run; a scoped run of just this spec clobbers that artifact —
    run the full `apps/api` suite once at close-out (see Verification commands, `final`).
  - A `NODE_OPTIONS=--require <path>` preload on Windows must use a forward-slash path
    (`path.resolve(...).replace(/\\/g, "/")`) — a POSIX-style Git-Bash path fails the child with
    `MODULE_NOT_FOUND`.
  - Converting a test from synchronous (`spawnSync`) to async (`spawn` + await/poll) moves it from
    "cannot time out" to "the 5 s default cap applies" — this is exactly why the per-test `35_000`
    timeout must be declared explicitly on both async tests.

---

## Test packages

### TP1 — Seam extraction + deterministic repro + pins

- **writes:** `apps/api/src/common/visibility-watchdog-script.spec.ts` (existing file, edited),
  `apps/api/src/common/testing/slow-boot.cjs` (**new file**)
- **tests:** T1, T3, T4 (T1 is REG-tagged and in the red gate; T3/T4 are un-tokened pins)
- **brief:**
  1. Create `apps/api/src/common/testing/slow-boot.cjs` with body exactly
     `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);` — a synchronous 1.5 s
     preload sleep used only via `NODE_OPTIONS=--require`.
  2. Extract the CURRENT fixed-500ms wait logic verbatim into a new helper
     `awaitStartLine({ argv = [SCRIPT], env, capMs = 30_000, intervalMs = 50 })` — behavior-preserving
     at this step (still just the old fixed delay, not yet a real poll). This is preparation for WP1,
     not the fix itself, so T1 is expected to fail here on the bug's own wrong value, not on an
     import/syntax error.
  3. Author T1: a new `it` whose title contains the words "boots slowly" (for the red-gate `-t`
     filter) and the token `REG-WATCHDOG-SLOWBOOT`, using `awaitStartLine` with
     `fakeEnv("success", logFile, { NODE_OPTIONS: "--require " + slowBootPath })`, where
     `slowBootPath` is `path.resolve(__dirname, "testing/slow-boot.cjs").replace(/\\/g, "/")`.
     Asserts the log contains `"minutes=45 repo=najathakram/routeflow"`.
  4. Author T3 (pin): `awaitStartLine({ argv: ["-e", "setInterval(() => {}, 1000)"], capMs: 300 })`
     must reject with the cap-exceeded message, and the child must be dead afterward
     (`child.exitCode !== null || child.signalCode !== null`).
  5. Author T4 (pin): add a non-empty-log guard to the existing "prints the same lines to stdout"
     test, before it compares lines.
- **must fail with:** T1 — `expected substring "minutes=45 repo=najathakram/routeflow", received ""`
  (the still-verbatim 500 ms wait reads the log before the 1.5 s-delayed start line lands).

**Red gate command** _(runs only T1; must fail on an assertion, not an error)_:

```bash
cd apps/api && npx jest src/common/visibility-watchdog-script.spec.ts -t "boots slowly" --runInBand
```

---

## Work packages

### WP1 — Poll/cap/kill helper + explicit timeouts

- **files:** `apps/api/src/common/visibility-watchdog-script.spec.ts` (same file TP1 wrote to — see
  note below; this is the intended seam-extraction pattern, not an oversight)
- **satisfies:** `watchdog-spec-host-speed`
- **provenBy:** T1, T2, T3
- **dependsOn:** none (test packages always run before the first implementation wave; TP1 → WP1
  ordering is guaranteed by phase order, never by `dependsOn` — a work package must never name a test
  package in `dependsOn`)
- **effort:** medium
- **brief:** Replace `awaitStartLine`'s body (extracted verbatim by TP1) with the real poll/cap/kill
  design: spawn the child, poll `readLog(logFile)` every `intervalMs` (default 50 ms) until it
  contains `" start "` — the exact tag `log()` writes at `scripts/visibility-watchdog.mjs:137-144` —
  resolve `{ child, log }`; on reaching `capMs` (default `30_000`), reject with
  `Error("start line not seen within <capMs> ms; log=<last 300 chars>")`; kill the child in a
  `finally` on every path (resolve, cap-reject, and the child's `"error"` event) and await its exit
  (up to 2 s) before returning. Add an explicit third-argument timeout of `35_000` to the "defaults"
  test (T2) and to T1, so the cap (`30_000` default, smaller for T3's `300`) always fires before
  Jest's own timer would. Add the non-empty-log guard from T4 if not already present verbatim from
  TP1's authoring (TP1 writes the test; WP1 must not weaken or remove it).
- **exact code:**

```ts
async function awaitStartLine({
  argv = [SCRIPT],
  env,
  capMs = 30_000,
  intervalMs = 50,
}: {
  argv?: string[];
  env: NodeJS.ProcessEnv;
  capMs?: number;
  intervalMs?: number;
}): Promise<{ child: ReturnType<typeof spawn>; log: string }> {
  const child = require("node:child_process").spawn(process.execPath, argv, { env });
  const start = Date.now();
  let settled = false;
  try {
    return await new Promise((resolve, reject) => {
      const poll = () => {
        if (settled) return;
        const log = readLog(logFile);
        if (log.includes(" start ")) {
          settled = true;
          resolve({ child, log });
          return;
        }
        if (Date.now() - start >= capMs) {
          settled = true;
          reject(
            new Error(
              `start line not seen within ${capMs} ms; log=${readLog(logFile).slice(-300)}`,
            ),
          );
          return;
        }
        setTimeout(poll, intervalMs);
      };
      child.on("error", (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
      poll();
    });
  } finally {
    child.kill();
    await new Promise<void>((resolveExit) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveExit();
        return;
      }
      const timer = setTimeout(resolveExit, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  }
}
```

(Signature and control flow only — the implementer wires `logFile` into the closure the same way
the existing test bodies already capture it per-test; this is the shape, not a drop-in file.)

### WP-DOCS — Code map, lessons, changelog

- **files:** `.claude/code-map/api.md`, `.claude/code-map/_meta.json`,
  `.claude/code-map/CHANGELOG.md`, `.claude/lessons/LESSONS.md`, `.claude/lessons/_meta.json`
- **satisfies:** documentation duty (project's own code-map/lessons routine — not a functional
  requirement; not counted against `watchdog-spec-host-speed`)
- **provenBy:** — (verified by `node scripts/validate-lessons.mjs`, not by a `T#`)
- **dependsOn:** WP1
- **effort:** low
- **brief:**
  - `code-map/api.md`: add/update the entry for
    `apps/api/src/common/visibility-watchdog-script.spec.ts` (purpose, the `awaitStartLine` helper's
    signature, cross-ref to `scripts/visibility-watchdog.mjs`) and the new
    `apps/api/src/common/testing/slow-boot.cjs` fixture.
  - `code-map/_meta.json`: bump `mappedSha` to this change's HEAD and `generatedAt` to now; replace
    (never accumulate) the notes field per the project's code-map-notes convention.
  - `code-map/CHANGELOG.md`: one dated bullet for this fix.
  - `LESSONS.md`: append, under `## testing`, EXACTLY this entry (≤ 650 bytes):

    ```
    ### L-061 · 2026-09-04 · testing · watchdog spec

    - **Symptom:** a spec green on CI failed on every loaded dev box, pushing people to skip the pre-push gate.
    - **Root cause:** a fixed 500 ms `setTimeout` stood in for "the spawned child has booted"; bare Node boot here is 0.6–6 s. A poll alone still fails: the api lane's undeclared Jest cap is 5 s.
    - **Lesson:** **A fixed delay is never a readiness signal. Wait on the observable (log line, exit, stream) with a capped poll, kill the child in `finally`, and give the async test its own timeout above the cap.**
    - **Guard:** `visibility-watchdog-script.spec.ts` slow-boot repro (`NODE_OPTIONS=--require slow-boot.cjs`, 1.5 s) stays green.
    ```

  - `.claude/lessons/_meta.json`: set `nextId: 62`, `activeCount` +1, `updatedAt` to now, and append
    to `note`: `" L-058..L-060 are reserved by #597's pending merge; L-061 taken 2026-09-04 by the
watchdog-spec fix."`
  - **State explicitly in this build plan** (do not leave it implicit): if
    `node scripts/validate-lessons.mjs` reports the byte cap exceeded at close-out, the L-061 entry is
    **held back** — `_meta.json.updatedAt` is bumped alone (no entry added), and the full entry text
    is kept in `RESUME.md` for the owner's caps ruling. This is not a failure of WP-DOCS; it is the
    documented fallback.

### Package map

| WP      | satisfies                  | provenBy                                | dependsOn | Wave |
| ------- | -------------------------- | --------------------------------------- | --------- | ---- |
| WP1     | `watchdog-spec-host-speed` | T1, T2, T3                              | —         | 1    |
| WP-DOCS | (documentation duty)       | — (validated by `validate-lessons.mjs`) | WP1       | 2    |

**Note on file overlap (deliberate, not an error):** TP1 and WP1 both touch
`apps/api/src/common/visibility-watchdog-script.spec.ts`. This is the seam-extraction pattern
required when the "production" code under test IS test-harness code: TP1 extracts the current
(buggy) wait behavior verbatim into a named helper so T1 can prove it fails on the bug's own wrong
value; WP1 then replaces only that helper's body with the real fix. Phase order (all test packages
before the first implementation wave) makes this safe without a `dependsOn` edge — and a work package
must never declare `dependsOn` naming a test package regardless.

Cross-check: the sole requirement `watchdog-spec-host-speed` is satisfied by WP1. T1, T2, T3 are
proven by WP1. T4 is a self-verifying pin authored and satisfied entirely within TP1 (it freezes
already-correct behavior — no implementation package changes what it guards), so it correctly appears
in no work package's `provenBy`.

---

## Acceptance criteria

1. `watchdog-spec-host-speed` — T1 (`REG-WATCHDOG-SLOWBOOT`) fails today
   (`expected substring "minutes=45 repo=najathakram/routeflow", received ""`) and passes after the
   fix regardless of host boot speed, within its declared `35_000` ms per-test timeout.
2. `watchdog-spec-host-speed` — T2 (the converted "defaults" test) and T3 (the cap-message pin) pass
   deterministically after the fix; T3's child is confirmed dead after the cap fires.
3. `watchdog-spec-host-speed` — T4: the stdout-mirror test can no longer pass on an empty log.
4. The four other `it` blocks in the spec are byte-for-byte unchanged in shape and continue to pass.
5. `scripts/visibility-watchdog.mjs` is byte-for-byte unchanged (diff shows zero changes to that
   file).
6. No `testTimeout` is added anywhere in `apps/api/package.json`'s jest config or as a lane-wide
   `jest.setTimeout` call; only T1 and T2 carry an explicit third-argument timeout.
7. **Negative case:** if the helper is manually reverted to a single read after a fixed 500 ms delay
   (the owner-visible manual check recorded in `RESUME.md`), T1 must go red again — proving T1
   actually exercises the fix, not merely the fixture.
8. **Deploy day:** this is a test/dev-tooling-only change — no runtime or production code path is
   touched, so existing users and existing data are unaffected; the next `npm run verify` or CI run
   on any host benefits immediately.

---

## Verification commands

Per round (cheap, runs after every implementation wave):

```bash
cd apps/api && npx jest src/common/visibility-watchdog-script.spec.ts --runInBand
cd apps/api && npx tsc -p tsconfig.build.json --noEmit
```

Final (runs once at the end):

```bash
cd apps/api && npx jest src/common/visibility-watchdog-script.spec.ts --runInBand
cd apps/api && npx tsc -p tsconfig.build.json --noEmit
cd apps/api && npx jest --runInBand
node scripts/validate-lessons.mjs
```

(The full, unscoped `apps/api` Jest run is required at close-out — not merely for coverage, but because
the campaign reporter rewrites `.campaign/runs/api.json` on every run, and a scoped-only run would
leave that artifact partial; see Harness notes in `bug-test-plan.md`.)

---

## UI verification

Not applicable — no UI surface is added or changed by this fix.

---

## Risks & rollback

| Risk                                                                                                                   | Likelihood                                                                                       | Blast radius                                               | Mitigation / what the reviewer should watch                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A heavier slow-boot or a CI load spike still exceeds the poll cap / per-test timeout                                   | low                                                                                              | test-only; blocks the pre-push gate and CI, no prod impact | `35_000` ms per-test timeout with a `30_000` ms default poll cap leaves headroom above the observed 0.8–2.9 s boot range (measurements A–C in `refutation.md`); RESUME.md records the BEFORE/AFTER numbers for future comparison                  |
| TP1's seam extraction and WP1's fix touch the same file, risking an incomplete "fix" that leaves the old wait in place | low                                                                                              | test-only                                                  | TP1's extraction must be behavior-preserving (T1 fails on the bug's exact wrong value, not on an import/syntax error) before WP1 runs; WP1's diff is reviewed against the `awaitStartLine` shape in this plan's exact code                        |
| Windows `NODE_OPTIONS` preload path uses backslashes and fails the child spawn                                         | medium (host-specific)                                                                           | test-only; breaks T1 locally on Windows                    | `slowBootPath` is resolved via `path.resolve(...).replace(/\\/g, "/")` per the cause-ruling's fix design                                                                                                                                          |
| Lessons register byte cap exceeded at close-out                                                                        | low (headroom existed at the pinned sha per `cause-brief.md` §f, but the branch has moved since) | none (docs only)                                           | WP-DOCS's documented fallback: bump `_meta.json.updatedAt` alone, keep the L-061 text in `RESUME.md` for the owner's caps ruling                                                                                                                  |
| The superseded candidate fix `b9c8e840` on `fix/e2e-freshness-guard-fail-open` collides with this change at merge time | medium                                                                                           | test-only; a merge conflict, not a behavior conflict       | Recorded here and in `RESUME.md`; whoever merges resolves in favor of this ruling's design (poll+cap+kill+explicit timeout), since `b9c8e840`'s 10 s budget is unreachable under the lane's undeclared 5 s default and is nominal, not functional |

- **Rollback:** revert the diff — every touched file is test-only or documentation-only; no runtime
  code, no migration, no feature flag.
- **Migration reversibility:** not applicable — no schema or migration change.
- **Feature flag / entitlement:** not applicable.
- **Deploy day:** not applicable — nothing here reaches the deployed API or web app; the benefit
  (a deterministic local gate) applies to the next `npm run verify`/CI run on any host.
- **Observability:** not applicable to production; in the test harness, a future regression would
  surface as `"Exceeded timeout of 35000ms"` or the helper's own cap-message error — both far more
  informative than today's silent `received ""`.

---

## Pipeline args

See `pipeline-args.json` in this directory for the exact object passed to the Workflow call — it is
kept as a separate file (not duplicated inline) so it can be passed verbatim without re-typing.
