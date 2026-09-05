# Fix ruling — B-none 2026-09-04-watchdog-spec-host-speed

> Fable @ high rules over the S1 brief + S2 refutation verbatim; it opens no file. One ruling per run.
> S2's verdict must be attached below this header, quoted in full.

## S2 verdict (quoted in full, from `refutation.md`)

> ## Verdict
>
> **CONFIRMED** — with one material refinement the naive reading misses.
>
> - Confirmed: the fixed 500 ms budget is the defect. It is not merely "racy" on this host, it is
>   **deterministically short**: 5/5 reproductions read an _absent_ log file at 500 ms, and bare
>   `node -e 0` startup alone (622–1142 ms) exceeds the entire budget.
> - Refinement (absent from the owner's statement, and it invalidates a poll-only fix): the api Jest
>   lane declares **no `testTimeout`**, so the effective per-test cap is Jest's default **5000 ms**.
>   The "defaults" case is the file's only _async_ test, so it is the only one the Jest timeout can
>   reach. Any poll budget larger than ~5 s is unreachable unless the test declares its own timeout —
>   and the already-written candidate fix `b9c8e840` polls with a **10 s** budget while declaring none.
>
> Alternative causes tested and **eliminated**:
>
> 1. _Log-path mismatch (test reads a different file than the script writes)._ Eliminated. `fakeEnv`
>    sets `VISIBILITY_WATCHDOG_LOG_FILE: logFile` (spec:69) and `logFile()` (script:107-109) reads that
>    exact variable with no other override path; `readLog` (spec:80-82) reads the same string produced
>    by `newLogPath` (spec:76-78). Empirically the file appears at that exact path with the expected
>    content, just later than 500 ms (measurement A). A path mismatch would leave the log empty
>    _forever_; it is not empty at 800–1600 ms.
> 2. _Child never starts / crashes before logging (empty log for a non-timing reason)._ Eliminated: the
>    same spawn writes a well-formed `start` line every time; `parseArgs([])` returns the defaults
>    without throwing; the four sibling tests spawn the same script successfully.
> 3. _Windows filesystem/AV visibility lag on `existsSync`+`readFileSync` (open unknown in the brief)._
>    Not supported: observed appearance times (777–1586 ms) track bare Node startup (622–1142 ms) plus
>    ~150–400 ms of module load, leaving no unexplained fs-visibility term.
> 4. _`child.kill()` racing/truncating the read._ Eliminated: the write is a completed synchronous
>    `appendFileSync` (script:141) before anything else runs; and in the failing case nothing has been
>    written at all — the file does not exist.

## 1. Cause verdict

- **Accepted cause: ACCEPTED as confirmed.** Diverging lines
  `apps/api/src/common/visibility-watchdog-script.spec.ts:148-157` — a fixed 500 ms `setTimeout` is
  the entire synchronisation between spawning `scripts/visibility-watchdog.mjs` and asserting its
  first log line; the script writes that line synchronously (script:158, nothing async before it), so
  the only latency is Node bootstrap, measured 0.6–1.1 s bare and 0.8–1.6 s to the line on this host
  (5/5 empty at 500 ms).
- **Refinement adopted from `refutation.md`**: the api jest lane declares no `testTimeout`, so the
  default 5 s aborts any async wait longer than that — a poll cap must be paired with a per-test
  timeout. Sibling tests are `spawnSync` with synchronous bodies and cannot time out (one runs 7.6 s
  green) — no change on that axis. The stdout-mirror test can pass vacuously on an empty log (no
  non-empty guard).
- **Superseded candidate fix**: the existing candidate fix on `fix/e2e-freshness-guard-fail-open`
  (`b9c8e840`: 10 s poll, no per-test timeout) is **superseded** by this ruling and will **collide at
  merge** — record it. Its 10 s budget is unreachable under the lane's undeclared 5 s Jest default, so
  it is nominal, not a working fix.
- **Registry**: no B-id exists (the in-repo registry lands with #597); the PR body says so and asks
  the owner to file it then.

## 2. Fix design (minimal diff)

In `apps/api/src/common/visibility-watchdog-script.spec.ts`:

(a) One shared helper `awaitStartLine({ argv = [SCRIPT], env, capMs = 30_000, intervalMs = 50 })`
that spawns the child, polls `readLog(logFile)` every `intervalMs` until it contains the
script's start tag (`" start "`, exactly as `log()` writes it — quoted from script:137-144),
resolves `{ child, log }`, and on cap rejects with
`Error("start line not seen within <capMs> ms; log=<last 300 chars>")`. The child is killed in a
`finally` on EVERY path (resolve, cap, `error` event), and the helper awaits the child's exit (up
to 2 s) before returning.

(b) The defaults test uses the helper and keeps its exact assertion
(`minutes=45 repo=najathakram/routeflow`) and gets an explicit per-test timeout of `35_000`
(third argument to `it`) so the cap fires first with its own message.

(c) NEW deterministic repro test (T1) uses the same helper with
`fakeEnv("success", logFile, { NODE_OPTIONS: "--require " + slowBootPath })`, where
`slowBootPath` is the committed fixture `apps/api/src/common/testing/slow-boot.cjs` (body exactly
`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);`), resolved with forward
slashes (`path.resolve(...).replace(/\\/g, "/")` — a POSIX-style path fails the child's preload on
Windows).

(d) The stdout-mirror test gains a non-empty guard on the log.

(e) Nothing in `scripts/visibility-watchdog.mjs` changes; no lane-wide `testTimeout` is added (sync
siblings must keep failing loudly if they ever hang elsewhere).

**Must NOT change**: the four sibling tests' shape, `fakeEnv`/`readLog` semantics, the script.

**Invariant preserved**: the assertion proves the defaults were applied, never that the host was
fast.

## 3. Regression tests

See `bug-test-plan.md` (S4) for the full red set — T1 (`REG-WATCHDOG-SLOWBOOT`, red today, must fail
on `expected substring "minutes=45 repo=najathakram/routeflow", received ""`) plus pins T2–T4
(un-tokened, freeze existing/adjacent behavior).

## 4. Blast radius (`radiusFiles`)

- `apps/api/src/common/visibility-watchdog-script.spec.ts` (the fix)
- `apps/api/src/common/testing/slow-boot.cjs` (new fixture)
- `scripts/visibility-watchdog.mjs` (read-only reference — must stay byte-for-byte unchanged)
- `apps/api/package.json` (read-only: jest config — confirms no `testTimeout` in this lane)
- `apps/api/jest.db.config.js` (read-only: the only `testTimeout` in the workspace, and it applies
  only to the `*.db.spec.ts` lane)

## 5. Sibling pattern (`siblingPatterns`)

- `setTimeout\([^)]*,\s*\d{2,4}\s*\)` in `apps/api/src/**/*.spec.ts` and `scripts/**/*.spec.*` — a
  literal-ms timer standing in for readiness (exclude `db-locks.db.spec.ts:22`, a reusable sleep
  helper, not a readiness race).
- `spawn\(` in `*.spec.ts` without a following `exit`/`close` listener or readiness poll.

## 6. Data repair

- None. This is a test-timing defect with no persisted data involved.

## 7. Probe plan

- Scale is small, so the engine runs no formal probe phase. In its place: the red gate on T1, plus a
  hand-specified mutation for close-out — change the helper to a single read after 500 ms (i.e.
  revert the poll/cap/kill design back to the old fixed-delay shape) — after which T1 must go red
  again. This is recorded as an **owner-visible manual check in `RESUME.md`**, not as an automated
  `mutationProbe` target.

| File                                                    | `revertFix` | REG test that must go red                    |
| ------------------------------------------------------- | ----------- | -------------------------------------------- |
| — (no automated probe at this scale; manual check only) | —           | T1 (`REG-WATCHDOG-SLOWBOOT`) — see RESUME.md |
