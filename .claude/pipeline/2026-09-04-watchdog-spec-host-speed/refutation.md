# Cause refutation — 2026-09-04-watchdog-spec-host-speed

> S2 adversarial pass (read-only). Brief: `cause-brief.md`. Posture: assume the owner's diagnosis
> ("the fixed 500 ms budget is the bug") is WRONG and try to disprove it. All measurements were taken
> on the reporting Windows host, in worktree `.claude/worktrees/rf-watchdog` at the pinned sha
> `f60bd27c893bc0b1058d6dcdfff8180cdd92b42d` (worktree HEAD == pinned sha, tree clean apart from this
> pipeline dir). No repo files were modified; the measurement harnesses live in the session scratchpad.

## Trace — everything the spawned script does before the `minutes=… repo=…` line

Entry: `spawn(process.execPath, [SCRIPT])` with no argv (spec:144-146). SCRIPT =
`scripts/visibility-watchdog.mjs` (spec:20).

| Step                                                                     | Where                                   | Sync/async            | Can it delay the first log write?            |
| ------------------------------------------------------------------------ | --------------------------------------- | --------------------- | -------------------------------------------- |
| Node process bootstrap (exec, V8 init, ESM loader)                       | before any script line                  | —                     | **YES — dominant term** (measured below)     |
| `import spawnSync / fs / path / url`                                     | `scripts/visibility-watchdog.mjs:69-72` | sync module load      | Yes, small (~150–400 ms over bare node here) |
| `__dirname` / `REPO_ROOT` / `DEFAULT_LOG_FILE`                           | script:74-76                            | sync                  | negligible                                   |
| `main()` invoked                                                         | script:210                              | —                     | —                                            |
| `parseArgs(process.argv.slice(2))`                                       | script:83-105, called at 155            | pure sync, no I/O     | no                                           |
| `waitMs` / `deadline` math                                               | script:156-157                          | sync                  | no                                           |
| `log("start", …)` → `fs.mkdirSync` + `fs.appendFileSync` + `console.log` | script:137-144, called at 158           | **fully synchronous** | it IS the write                              |

**No asynchronous work precedes the write.** The first `await` is `sleep(waitMs)` at script:160 —
_after_ the start line. `runGh` (script:128-135) is never reached in this case: with defaults
`minutes=45` the script parks in `sleep(2_700_000)` at script:160 for the whole test, so no `gh`
subprocess, no network call, no filesystem wait and no in-script sleep stands between `spawn()` and
the line. The brief's finding (b) is confirmed independently: the only latency axis is Node's own
bootstrap plus this module's import cost.

Corollary: **the script exposes no knob that delays the first line.**
`VISIBILITY_WATCHDOG_VERIFY_INTERVAL_MS` (script:111-116) is read at script:179 and used at
script:195 — after the flip; `--minutes` only sizes the sleep at script:160 — after the log. Any
deterministic slow-boot injection must therefore come from outside the script (see Repro design).

## Verdict

**CONFIRMED** — with one material refinement the naive reading misses.

- Confirmed: the fixed 500 ms budget is the defect. It is not merely "racy" on this host, it is
  **deterministically short**: 5/5 reproductions read an _absent_ log file at 500 ms, and bare
  `node -e 0` startup alone (622–1142 ms) exceeds the entire budget.
- Refinement (absent from the owner's statement, and it invalidates a poll-only fix): the api Jest
  lane declares **no `testTimeout`**, so the effective per-test cap is Jest's default **5000 ms**.
  The "defaults" case is the file's only _async_ test, so it is the only one the Jest timeout can
  reach. Any poll budget larger than ~5 s is unreachable unless the test declares its own timeout —
  and the already-written candidate fix `b9c8e840` polls with a **10 s** budget while declaring none.

Alternative causes tested and **eliminated**:

1. _Log-path mismatch (test reads a different file than the script writes)._ Eliminated. `fakeEnv`
   sets `VISIBILITY_WATCHDOG_LOG_FILE: logFile` (spec:69) and `logFile()` (script:107-109) reads that
   exact variable with no other override path; `readLog` (spec:80-82) reads the same string produced
   by `newLogPath` (spec:76-78). Empirically the file appears at that exact path with the expected
   content, just later than 500 ms (measurement A). A path mismatch would leave the log empty
   _forever_; it is not empty at 800–1600 ms.
2. _Child never starts / crashes before logging (empty log for a non-timing reason)._ Eliminated: the
   same spawn writes a well-formed `start` line every time; `parseArgs([])` returns the defaults
   without throwing; the four sibling tests spawn the same script successfully.
3. _Windows filesystem/AV visibility lag on `existsSync`+`readFileSync` (open unknown in the brief)._
   Not supported: observed appearance times (777–1586 ms) track bare Node startup (622–1142 ms) plus
   ~150–400 ms of module load, leaving no unexplained fs-visibility term.
4. _`child.kill()` racing/truncating the read._ Eliminated: the write is a completed synchronous
   `appendFileSync` (script:141) before anything else runs; and in the failing case nothing has been
   written at all — the file does not exist.

## Diverging line

`apps/api/src/common/visibility-watchdog-script.spec.ts:148-157` at sha `f60bd27c` — the
`setTimeout(...)` gate opened at line 148, with the literal budget at **line 157** (`}, 500);`).
That timer is the sole gate before the assertion at spec:152; there is no `child.on("exit")` and no
readiness check of any kind (spec:158 registers only `"error"`).

## Evidence

Measurement A — spawn → `"minutes=45 repo=…"` visible at the fakeEnv log path, same spawn shape as
spec:144-146, 5 runs on the reporting host (Node v24.14.0):

```
run 0: 1255 ms   run 1: 777 ms   run 2: 1005 ms   run 3: 1586 ms   run 4: 1414 ms
```

Measurement B — the old test's exact shape (read the log 500 ms after `spawn`, then kill), 5 runs:

```
run 0: elapsed=577ms exists=false log=""
run 1: elapsed=579ms exists=false log=""
run 2: elapsed=543ms exists=false log=""
run 3: elapsed=548ms exists=false log=""
run 4: elapsed=544ms exists=false log=""
```

→ `readLog` returns `""` (file not yet created) in 5/5 runs, producing exactly the reported failure
`Expected substring "minutes=45 repo=najathakram/routeflow", Received ""`. **The defect reproduces on
this host with no injection at all.**

Measurement C — bare `node -e 0` startup, 5 runs: `[1083, 1142, 622, 890, 799]` ms. The 500 ms budget
is below the floor of starting an empty Node process here; the script's import cost (~150–400 ms over
bare) is a secondary term.

Measurement D — sibling wall-clock (same argv/env as the `run(...)` tests, standalone `spawnSync`):

```
success:        wall=3741 ms  status=0  logLines=3
public-forever: wall=7646 ms  status=1  logLines=3
edit-fail:      wall=3193 ms  status=1  logLines=2
```

Jest facts (this install):

- `jest-config@30.2.0` default `testTimeout: 5000`
  (`node_modules/jest/node_modules/jest-config/build/index.js:515,622`).
- The api lane config is the `"jest"` block in `apps/api/package.json` (lines 119-159): **no
  `testTimeout`**, no `setupFiles`/`setupFilesAfterEach`. `testRegex: ".*\\.spec\\.ts$"` with
  `.db.spec.ts` ignored — so this spec runs in the default lane. The only `testTimeout` in the
  workspace is `apps/api/jest.db.config.js:10` (`30000`), which applies **only** to the `*.db.spec.ts`
  lane and therefore not to this file. Grepping the spec for `setTimeout|testTimeout|setupFiles`
  yields the single hit at spec:148 — **no `jest.setTimeout` anywhere in the file**.
- Sync vs async test bodies, from `jest-circus@30`
  (`node_modules/jest/node_modules/jest-circus/build/index.js`): the timeout timer is armed at
  **:1163**; a returned promise keeps it live (**:1228-1229**); a synchronous body falls through to
  the comment _"Otherwise this test is synchronous…"_ and `resolve()` at **:1242+**, which runs
  synchronously inside the promise executor — the timer callback can never have fired, because the
  body blocked the event loop. **A synchronous `spawnSync` test cannot trip the 5 s timeout however
  slow the host; the async "defaults" test can.** Measurement D corroborates: `public-forever` burns
  7.6 s of wall clock and is still reported green, while only the async test is red.

## Actual cause

The owner's stated cause stands: `setTimeout(…, 500)` at spec:157 is a fixed wall-clock stand-in for
"the child has booted and written its first line", and on this host that boot costs 0.8–1.6 s (bare
Node startup alone 0.6–1.1 s). CI's ubuntu runner clears 500 ms; this host cannot.

Stated precisely, and distinguishing it from "a flaky test": the test has **no readiness signal at
all** — no exit listener, no stdout listener, no log poll. The 500 ms literal is the entire
synchronization protocol between a real OS process launch and the assertion. Two independent budgets
bound this test and only one of them is written down:

1. the readiness budget (500 ms, spec:157), which must exceed real child-boot latency; and
2. the Jest per-test budget (5000 ms, default, undeclared anywhere in this lane), which caps whatever
   readiness budget the test chooses, because this is the file's only async test.

## Sibling verdicts

All five `it` blocks in `apps/api/src/common/visibility-watchdog-script.spec.ts`:

| Test (lines)                                             | Waits on                                                                 | Same shape as the defect?                     | Detail                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `success: edit succeeds…` (85-101)                       | child **exit** — `run(...)` → `spawnSync` (spec:57-59); body synchronous | **No**                                        | `--minutes 0.01` (spec:87) → `waitMs = 600` (script:156) is a real sleep _inside the child_ at script:160, but `spawnSync` blocks until the child exits, so a slow host stretches the run without desynchronizing it. 3741 ms measured (D). Sync body ⇒ Jest's 5 s timer cannot fire (circus:1242+). |
| `never verifies: view keeps reporting PUBLIC…` (103-116) | child exit (`spawnSync`); body synchronous                               | **No**                                        | spec:105-108. Worst wall-clock in the file: 7646 ms measured (D) — 1 script spawn + 1 fake-gh `edit` + 5 fake-gh `view` spawns (script:180-195) + the 600 ms in-script sleep + 4×5 ms verify sleeps. Exceeds 5000 ms yet cannot time out, because the body is synchronous.                           |
| `edit itself fails…` (118-128)                           | child exit (`spawnSync`); body synchronous                               | **No**                                        | spec:120. 3193 ms measured (D).                                                                                                                                                                                                                                                                      |
| `prints the same lines to stdout…` (130-138)             | child exit (`spawnSync`); body synchronous                               | **No** on timing — **but a harness weakness** | spec:132-137. If the log were ever empty, `log.trim().split("\n")` yields `[""]` and `expect(res.stdout).toContain("")` passes vacuously: the test has no non-empty guard on the log, so it cannot detect the very failure mode under investigation.                                                 |
| `defaults --minutes to 45 …` (140-163)                   | **nothing** — a fixed 500 ms `setTimeout` (spec:148,157)                 | **YES — the defect**                          | The only test using async `spawn` (spec:144) and the only one returning a Promise (spec:147); only `child.on("error")` is registered (spec:158), never `"exit"`. A fixed delay stands in for "the child has started". Also the only test the Jest 5 s cap can reach.                                 |

So `--minutes 0.01` does become a fixed 600 ms sleep **inside the child** (script:156,160) that a slow
host stretches — but every test using it awaits the child's exit through `spawnSync`, so the stretch
is absorbed, not raced. The defect's shape is unique to the "defaults" test.

## Repro design facts

Facts only; each measured or sourced.

- **The defect already reproduces on this host with zero injection**: measurement B, 5/5 empty reads
  at 500 ms. On a fast host (CI ubuntu) it does not.
- **Deterministic slow-boot without touching `scripts/visibility-watchdog.mjs`**: preload a CJS module
  that sleeps synchronously, via `NODE_OPTIONS=--require <absolute Windows path>/slow-boot.cjs`, whose
  body is `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)`.
  - Verified working against the **ESM** entry: with the preload set, the start line appeared after
    **2844 ms** versus the 777–1586 ms baseline (measurement A) — a ~1.5 s delta matching the sleep.
  - **Path form matters on this host**: a Git-Bash POSIX path (`/c/Users/…/slow-boot.cjs`) fails the
    child with `MODULE_NOT_FOUND … requireStack: ['internal/preload']`; the Windows form
    (`C:/Users/…/slow-boot.cjs`) works.
- **Does it reach the child?** `fakeEnv` (spec:66-73) spreads `...process.env` first, so any
  `NODE_OPTIONS` present in the Jest worker's environment is inherited by the spawned child with no
  edit to the spec. `fakeEnv`'s `extra` parameter (spec:64, applied at spec:72) is the per-test seam
  if a narrower injection is wanted. Caveat: this assumes the Jest worker's `process.env` carries the
  variable through from the invoking shell.
- **Does the injection disturb the fake `gh`?** `runGh` spawns with `env: process.env` (script:133),
  so a fake-gh child inherits the preload too. Harmless in both directions: (a) in the "defaults" case
  no `gh` call ever happens (the script parks at script:160 for 45 minutes), and (b) in the sibling
  cases it only adds wall clock, which per circus:1242+ cannot trip the timeout for their synchronous
  bodies.
- **No in-script knob can serve as the injection** — see Trace: everything the script exposes
  (`--minutes`, `VISIBILITY_WATCHDOG_VERIFY_INTERVAL_MS`) acts strictly _after_ the start line.
- **What the OLD test sees under the injection**: `readLog` at 500 ms returns `""` (the file does not
  exist yet) → `expect("").toContain("minutes=45 repo=najathakram/routeflow")` fails with the reported
  message. True on a fast CI host too, since 1.5 s ≫ 500 ms. **Behavioral red on the bug's own wrong
  value.**
- **What a poll-based test sees under the injection**: the start line lands at ~1.6 s (fast host) to
  ~2.8 s (this host, measured) → green, provided the poll budget _and_ the governing Jest timeout both
  exceed that. Under the lane's undeclared 5000 ms default, a 2.8 s appearance leaves ~2.2 s of
  headroom, which a heavier injection or a slower host consumes.

## Fix-shape facts

Constraints the evidence imposes; not proposals.

- The lane's per-test cap is **5000 ms** and is undeclared anywhere in `apps/api` for `*.spec.ts`
  (`apps/api/package.json:119-159`; `jest.db.config.js:10`'s 30000 covers the db lane only). Any
  readiness budget above that is unreachable **unless** the test passes an explicit third-argument
  timeout to `it(...)` or calls `jest.setTimeout`. Neither exists in this file today.
- The already-written candidate fix `b9c8e840` ("test(ci): watchdog spec waits for the start line
  instead of racing the log", on branch `fix/e2e-freshness-guard-fail-open`, not an ancestor of the
  pinned sha) converts the test to `async`, polls `readLog` for `" start "` every 100 ms against a
  **10 s** deadline, and kills the child in a `finally` (with a further up-to-2 s wait for `exit`).
  It declares **no** per-test timeout. Facts that follow: on a host where the start line needs more
  than ~5 s (the owner's reported 3.0–6.4 s bare-startup band reaches that), Jest aborts at 5000 ms
  with _"Exceeded timeout of 5 s for a test"_ before the 10 s budget is spent, and the `finally`'s
  exit wait is inside the same 5 s. Its 10 s budget is therefore nominal under the current config.
- Converting the test from sync to async (which any poll- or event-based wait requires) moves it from
  the "cannot time out" class into the "5 s cap applies" class — circus:1163 / :1228-1229 / :1242+.
  The four sibling tests stay in the sync class and need no change on this axis (measurement D shows
  one of them already runs 7.6 s).
- The child is left running unless killed; the script's own sleep is 45 real minutes (script:156,160),
  so any exit path that skips the kill leaks a process past the test. The current test kills only
  inside the timer callback (spec:149) — an assertion throw happens after that kill, but a rejection
  via the `"error"` path (spec:158-161) leaves no kill at all.
- Readiness signals available without touching the script, ranked by directness: the log file content
  at `VISIBILITY_WATCHDOG_LOG_FILE` (written synchronously at script:141 before anything else), and
  the child's `stdout` (the same line is mirrored there at script:142). The current test consumes
  neither — it registers only `"error"` (spec:158).
