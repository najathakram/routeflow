# Bug test plan — B-none watchdog-spec-host-speed

> Fable @ high writes this from the fix ruling (`cause-ruling.md`); Sonnet types the tests inside the
> engine. The red bar is BEHAVIORAL: each REG test must fail today on its own exact wrong value —
> reproduction is the point.

No B-id exists yet for this defect (the in-repo registry lands with #597). `REG-WATCHDOG-SLOWBOOT`
stands in as the token until a B-id is filed; the PR body asks the owner to file one.

## Red set (REG-tagged; in the red gate)

| T#  | Title (starts with REG-WATCHDOG-SLOWBOOT)                                                                                                                                             | Setup                                                                                                                                                                                                                                                                                                                                                                                | Asserts                                                | Fails TODAY with                                                                                                                                                                                                                                                                                                               | File                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| T1  | `REG-WATCHDOG-SLOWBOOT applies the defaults even when the child boots slowly (NODE_OPTIONS preload sleeps 1.5 s)` — title keeps the words "boots slowly" for the red-gate `-t` filter | `fakeEnv("success", logFile, { NODE_OPTIONS: "--require " + slowBootPath })` where `slowBootPath` is the forward-slash-resolved path to `apps/api/src/common/testing/slow-boot.cjs` (body: `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);`); driven through the seam-extracted `awaitStartLine` helper (still the verbatim fixed-500ms wait at authoring time) | log contains `"minutes=45 repo=najathakram/routeflow"` | `expected substring "minutes=45 repo=najathakram/routeflow", received ""` — the 500 ms wait reads the log before the 1.5 s-delayed start line has been written. AFTER the WP1 fix: the line is present at ~1.6–2.9 s and the assertion passes. Timeout: `35_000` (third arg to `it`). Level: integration (real child process). | `apps/api/src/common/visibility-watchdog-script.spec.ts` |

## Pins (no REG token; outside the red gate)

| T#  | Frozen behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                          | File                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| T2  | The existing "defaults --minutes to 45 and --repo to najathakram/routeflow when omitted" test, converted to use `awaitStartLine` with the same exact assertion and an explicit `35_000` per-test timeout. Green after the fix on any host; red-on-a-loaded-host BEFORE the fix (host-dependent — documented via the BEFORE measurements in `RESUME.md`, not a red-gate member because its red-ness depends on host speed rather than an injected, deterministic defect). | `apps/api/src/common/visibility-watchdog-script.spec.ts` |
| T3  | `awaitStartLine({ argv: ["-e", "setInterval(() => {}, 1000)"], capMs: 300 })` rejects with the cap message (`"start line not seen within 300 ms; log=..."`), and the child is dead afterwards (`child.exitCode !== null \|\| child.signalCode !== null`).                                                                                                                                                                                                                | `apps/api/src/common/visibility-watchdog-script.spec.ts` |
| T4  | The stdout-mirror test ("prints the same lines to stdout that it appends to the log") asserts the log is non-empty before comparing lines, so it can no longer pass vacuously on an empty log.                                                                                                                                                                                                                                                                           | `apps/api/src/common/visibility-watchdog-script.spec.ts` |

## Harness notes (verified by the engine's harness-integrity check)

- **Jest default cap**: `apps/api/package.json`'s `"jest"` block declares no `testTimeout` (confirmed
  at pinned sha `f60bd27c`), so the effective per-test cap for this lane is jest-config's default
  5000 ms. `apps/api/jest.db.config.js:10`'s `testTimeout: 30000` applies only to the `*.db.spec.ts`
  lane (excluded here by `testPathIgnorePatterns`) and does not cover this spec.
- **Seam extraction is a prerequisite, not the fix**: the test package (TP1) first moves the CURRENT
  fixed-500ms-delay wait verbatim into `awaitStartLine` (behavior-preserving — no poll/cap/kill logic
  yet). This is why T1 must fail on the wrong value (`received ""`), not on an import or syntax
  error — the seam exists but still behaves exactly like the old inline `setTimeout`. WP1 then
  replaces the helper's body with the real poll/cap/kill design.
- **NODE_OPTIONS path form**: `slowBootPath` must be resolved with forward slashes
  (`path.resolve(...).replace(/\\/g, "/")`). A Git-Bash POSIX-style path
  (`/c/Users/.../slow-boot.cjs`) fails the child's `--require` preload with `MODULE_NOT_FOUND` on
  Windows; the Windows form (`C:/Users/.../slow-boot.cjs`) works (verified in `refutation.md`'s Repro
  design section).
- **Campaign-reporter clobber**: `apps/api/package.json`'s jest reporter
  (`scripts/jest-campaign-reporter.cjs`) rewrites `.campaign/runs/api.json` on every run scoped to
  this lane. A scoped run (this spec only) clobbers that artifact with partial results — the
  close-out must run the FULL `apps/api` suite last (see `verifyCommands.final` in
  `pipeline-args.json`), or the pre-push campaign-check reads a partial artifact and reports falsely.
- No existing mock/fixture in this spec breaks from the fix's surface change — `fakeEnv`, `readLog`,
  and `newLogPath` keep their exact current signatures and semantics; only the "defaults" test's own
  waiting mechanism changes.

## Commands

- `redGate.commands`: `cd apps/api && npx jest src/common/visibility-watchdog-script.spec.ts -t "boots slowly" --runInBand` — expect fail (behavioral: `received ""`, not an import/setup error).
- `REG-WATCHDOG-SLOWBOOT` doubles as the registry proof line at close-out once a B-id is filed against
  it (post-#597); until then it stands alone as the reproduction token referenced from the PR body.
