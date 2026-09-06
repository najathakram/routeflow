# Reader report — PR #634 CI run 34019219777 self-test failure (lock liveness)

Worktree: `C:/ClaudeCode/routeflow/.claude/worktrees/rf-registry`, branch
`fix/bugs-selftest-lock-liveness` @ `0b715128` (== current master). Tree clean throughout. All
commands below are read-only except the ONE local self-test run (item 8), which writes only to
its own OS temp dir.

---

## 1. CI run facts

`gh run view 34019219777 --json jobs`:

- Job **"Verify"** (`databaseId 101448572766`) — `conclusion: "failure"`, `runs-on: ubuntu-latest`
  (per `.github/workflows/ci.yml`, confirmed in §7). Started `2026-09-06T07:28:00Z`, completed
  `07:34:13Z`.
- Failing step: **"Verify (lockfile, bug-signature scan, types, lint, tests)"** (step 8), which
  runs `npm run verify`, i.e. `... && node scripts/campaign/bugs.mjs self-test && node
scripts/campaign-check.mjs`. That step's own conclusion is `"failure"`; step 9 ("Fail on critical
  production advisories") was `skipped` as a direct consequence.
- Job **"E2E (Playwright)"** was `skipped` entirely (never reached).

`gh run view 34019219777 --log-failed`, self-test section (`scripts/campaign/bugs.mjs
self-test`), timestamps UTC:

20 lines immediately before the first FAIL (everything here is `ok`):

```
07:33:30.7100700  ok  stolen lock (exit code): the stealer really observed the victim's own owner stamp first
07:33:30.7102080  ok  stolen lock (exit code): the successor's lockdir SURVIVES this writer's exit too
07:33:30.7103609  ok  stolen lock (exit code): the stolen-from writer's real process exit status is non-zero
07:33:30.7598547  ok  signals: a writer that took the lock installs SIGINT/SIGTERM/SIGHUP handlers
07:33:33.8348133  ok  SIGINT: it really held the lock when it was interrupted
07:33:33.8348983  ok  SIGINT: an interrupted writer leaves NO lock directory
07:33:33.9036074  ok  abandoned lock: the waiting writer still succeeds
07:33:33.9037165  ok  abandoned lock: breaking one is reported as a LAST RESORT, never silent
07:33:33.9037969  ok  abandoned lock: the write it was blocking actually landed
07:33:43.9659530  ok  pid reuse: the impostor pid genuinely answers to a liveness check with no boot stamp
```

Then the four failures, with got/want, immediately following (all logged within 1.4ms of each
other — see §5 for why):

```
07:33:43.9669131  FAIL pid reuse: the NEXT waiter succeeds in one invocation, not after LOCK_ABANDON_MS
                        got  1
                        want 0
07:33:43.9670251  FAIL pid reuse: breaking it names the boot mismatch, never the age-based last resort
                        got  false
                        want true
07:33:43.9671695  FAIL pid reuse: the write it was blocking actually landed
                        got  "T2"
                        want "T1"
07:33:43.9673181  FAIL owner-write failure: no lock exists before the fixture runs
                        got  true
                        want false
```

Immediately after, the REST of the owner-write-failure fixture passes clean:

```
07:33:44.0380345  ok  owner-write failure: the command fails loudly, never silently
07:33:44.0382032  ok  owner-write failure: the lockdir it just created is cleaned up, not left to wedge every later caller
07:33:44.0890003  ok  owner-write failure: a NEXT, unfixtured caller succeeds immediately — nothing was left behind to break
```

Final line: `07:34:04.5509912Z self-test: 4 FAILURE(S)`.

**Timing detail that drives §5's analysis**: the gap between the last "abandoned lock" `ok` line
(`33.9037969`) and the first "pid reuse" `ok` line (`43.9659530`) is **10.0622 seconds** — 62ms
over `LOCK_SPIN_MS` (10000, exact constant, see §3). Every check inside the pid-reuse block is
only a `console.log` of an already-computed value (see §2's fixture code — `pidReuseCheck` is
computed at the top of the block, but its `check()` call is written AFTER `runCli(...)` and
`impostor.kill()` in program order), so the entire 10.06s is consumed inside that one `runCli`
call, not fixture setup.

Re-run **34020125844** (head `cbbc10b4`, master `243325d2`) and every Windows run: green (per the
task's own framing; not independently re-fetched here since the ask was to analyze the failing
run and the code, not re-verify the passing run's log).

---

## 2. The four failing checks — fixture source, verbatim

All four live in `cmds["self-test"]` in `scripts/campaign/bugs.mjs`, inside the same lock-fixture
block that starts at the "(a) A LIVE holder…" comment near line 5486 and runs through line ~5900.
Exact fixture code, line numbers from `0b715128` (identical at `25335633`/`cde998d4` — see §7):

### (f) PID REUSE — lines 5756–5803

```javascript
5756	      // (f) PID REUSE. A lockdir whose owner pid has been reused by some
5757	      // UNRELATED live process must still be broken — before the boot stamp,
5758	      // `alive === true` (the pid genuinely answers) meant "never break it",
5759	      // permanently wedging every later caller on a lock nobody actually
5760	      // holds. A real, currently-running (but entirely unrelated) child
5761	      // process stands in for the impostor; its bootAt is stamped from a
5762	      // fabricated boot far in the past, which is the one thing that can
5763	      // prove "this cannot be the process that wrote this lock" even though
5764	      // `process.kill(pid, 0)` alone would say it is alive.
5765	      rmSync(lockDir, { recursive: true, force: true });
5766	      const impostor = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], {
5767	        stdio: "ignore",
5768	      });
5769	      mkdirSync(lockDir);
5770	      writeFileSync(
5771	        ownerPath(lockDir),
5772	        JSON.stringify({
5773	          pid: impostor.pid,
5774	          token: "pid-reuse-fixture-token",
5775	          at: Date.now() - LOCK_ABANDON_MS * 10,
5776	          bootAt: Date.now() - LOCK_ABANDON_MS * 10,
5777	        }),
5778	      );
5779	      const pidReuseCheck = pidAlive(impostor.pid);
5780	      const rescuedFromReuse = runCli(["tier", "B1", "T1", "--why", "pid-reuse fixture"], tmp);
5781	      impostor.kill();
5782	      check(
5783	        "pid reuse: the impostor pid genuinely answers to a liveness check with no boot stamp",
5784	        pidReuseCheck,
5785	        true,
5786	      );
5787	      check(
5788	        "pid reuse: the NEXT waiter succeeds in one invocation, not after LOCK_ABANDON_MS",
5789	        rescuedFromReuse.code,
5790	        0,
5791	      );
5792	      check(
5793	        "pid reuse: breaking it names the boot mismatch, never the age-based last resort",
5794	        /breaking the lock on F01\.jsonl — its owner \(pid \d+\) predates this boot/.test(
5795	          rescuedFromReuse.out,
5796	        ),
5797	        true,
5798	      );
5799	      check(
5800	        "pid reuse: the write it was blocking actually landed",
5801	        readShard("F01").rows.find((r) => r.id === "B1")?.tier,
5802	        "T1",
5803	      );
```

**How "pid reuse" is simulated**: a REAL, currently-running Node child (`spawn(process.execPath,
["-e", "setTimeout(() => {}, 15000)"])`) stands in for an unrelated live process that happens to
have been assigned the pid recorded in a stale `owner.json`. `owner.json` is hand-forged (not
written by `acquireLock`) with `pid: impostor.pid` and, critically, both `at` and `bootAt` set to
`Date.now() - LOCK_ABANDON_MS * 10` — i.e. **20 minutes** before the fixture's own `Date.now()`
(`LOCK_ABANDON_MS = 120000`; ×10 = 1,200,000ms). The impostor is only actually `.kill()`ed AFTER
`runCli` returns. `BUGS_ABANDON_MS`/`BUGS_TEST_STALL_MS`/`BUGS_SELF_TEST` are not used directly in
this fixture's forging step; `BUGS_SELF_TEST=1` is set unconditionally inside `runCli` (§3) so the
CHILD process (the CLI under test) gets the `stallMs` seam un-gated — irrelevant here since `tier`
doesn't call `upsertLedgerRowLocked` with a stall.

### (g) OWNER-WRITE FAILURE — lines 5805–5854

```javascript
5805	      // (g) OWNER-WRITE FAILURE. A crash between the mkdir that wins the lock
5806	      // and the owner.json write that follows it (disk full, a permission
5807	      // fault) used to leave the directory behind with no owner stamp at
5808	      // all — exactly the "no readable owner.json" case, which every OTHER
5809	      // waiter can only break as a LAST RESORT once it is a full
5810	      // LOCK_ABANDON_MS old, wedging every caller for two minutes over a
5811	      // fault that had nothing to do with contention. Driven through the
5812	      // real CLI via the same gated test-seam pattern as BUGS_TEST_STALL_MS
5813	      // — a real disk-full fault isn't reproducible on demand.
5814	      const ownerWriteFailure = () => {
5815	        try {
5816	          execSync(
5817	            `node ${[SCRIPT_PATH, "tier", "B1", "T2", "--why", "owner-write-fail fixture"].map((a) => JSON.stringify(a)).join(" ")}`,
5818	            {
5819	              encoding: "utf8",
5820	              stdio: ["ignore", "pipe", "pipe"],
5821	              env: {
5822	                ...process.env,
5823	                BUGS_ROOT: tmp,
5824	                BUGS_SELF_TEST: "1",
5825	                BUGS_TEST_FAIL_OWNER_WRITE: "1",
5826	              },
5827	            },
5828	          );
5829	          return { code: 0, out: "" };
5830	        } catch (e) {
5831	          return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
5832	        }
5833	      };
5834	      check(
5835	        "owner-write failure: no lock exists before the fixture runs",
5836	        existsSync(lockDir),
5837	        false,
5838	      );
5839	      const ownerWriteResult = ownerWriteFailure();
5840	      check(
5841	        "owner-write failure: the command fails loudly, never silently",
5842	        ownerWriteResult.code !== 0,
5843	        true,
5844	      );
5845	      check(
5846	        "owner-write failure: the lockdir it just created is cleaned up, not left to wedge every later caller",
5847	        existsSync(lockDir),
5848	        false,
5849	      );
5850	      check(
5851	        "owner-write failure: a NEXT, unfixtured caller succeeds immediately — nothing was left behind to break",
5852	        runCli(["tier", "B1", "T3", "--why", "owner-write-fail recovery check"], tmp).code,
5853	        0,
5854	      );
```

**How "owner-write failure" is set up**: no forged filesystem state at all — it drives the REAL
CLI (a fresh child process) with `BUGS_SELF_TEST=1` + `BUGS_TEST_FAIL_OWNER_WRITE=1`, which
(§3) makes `acquireLock`'s own `writeFileSync(ownerPath(p), …)` throw synthetically right after
the `mkdir` that wins the lock, exercising the real cleanup path (`rmSync` the dir it just
created, then rethrow). **There is no `rmSync(lockDir)` between the pid-reuse block (ending line 5803) and this block's first check (line 5834–5838)** — the precondition check assumes the
previous fixture left a clean slate; it does not enforce one.

**`LOCK_ABANDON_MS` / `BUGS_TEST_STALL_MS` / `BUGS_SELF_TEST` usage recap**: `LOCK_ABANDON_MS`
(=120000, defined line 1706) is used only to compute the pid-reuse fixture's forged 20-minute-old
timestamp and (earlier, in the "(e) abandoned lock" fixture, lines 5741–5754) to backdate a REAL
lockdir's mtime via `utimesSync` to `LOCK_ABANDON_MS * 2` ago. `BUGS_SELF_TEST=1` is set
unconditionally by `runCli` (line 2850) and gates two independent test seams:
`BUGS_TEST_STALL_MS` (the lost-update race widener, read in `upsertLedgerRowLocked`, lines
2022–2027) and `BUGS_TEST_FAIL_OWNER_WRITE` (the owner-write-throw seam, read in `acquireLock`,
line 1834).

---

## 3. Lock primitives the fixtures exercise (verbatim, `0b715128`)

**`LOCK_SPIN_MS` / `LOCK_STEP_MS` / `LOCK_ABANDON_MS`** (lines 1700–1706):

```javascript
const LOCK_SPIN_MS = 10000;
const LOCK_STEP_MS = 20;
...
const LOCK_ABANDON_MS = 120000;
```

**Boot stamp + platform branch** (lines 1722–1758):

```javascript
const bootStamp = () => Math.round(Date.now() - uptime() * 1000);
const BOOT_STAMP_SLOP_MS = 5000;
...
const zombieOnLinux = (pid) => {
  if (process.platform !== "linux") return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    return close !== -1 && stat.charAt(close + 2) === "Z";
  } catch {
    return false;
  }
};
```

`uptime()` is Node's `os.uptime()` (imported at the top of the file) — the runner's OS-level
uptime, not the process's. There is **no Windows-specific branch** for `bootStamp()` itself; the
platform fork is only in `zombieOnLinux` (checks `/proc/<pid>/stat`, Linux only; returns `false`
— i.e. "not a zombie" — on every other platform including win32, where `process.kill(pid,0)`
alone is trusted to answer ESRCH the moment the process truly ends).

**Liveness verdict** (lines 1760–1774):

```javascript
const pidAlive = (pid, ownerBootAt) => {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (typeof ownerBootAt === "number" && Math.abs(ownerBootAt - bootStamp()) > BOOT_STAMP_SLOP_MS)
    return false;
  try {
    process.kill(pid, 0);
    return zombieOnLinux(pid) ? false : true;
  } catch (e) {
    return e.code === "ESRCH" ? false : true;
  }
};
```

**The human-readable verdict/reason text** is produced inline inside `acquireLock`'s retry loop
(lines 1862–1893), which is also the function that decides break-worthiness — there is no
separate "verdict formatter" function:

```javascript
    const owner = readLockOwner(p);
    const alive = owner ? pidAlive(owner.pid, owner.bootAt) : null;
    const bootMismatch =
      alive === false &&
      typeof owner?.bootAt === "number" &&
      Math.abs(owner.bootAt - bootStamp()) > BOOT_STAMP_SLOP_MS;
    let age = null;
    try {
      age = Date.now() - statSync(p).mtimeMs;
    } catch {
      age = null;
    }
    let breakWhy = null;
    if (bootMismatch)
      breakWhy = `its owner (pid ${owner.pid}) predates this boot — it cannot possibly still be that process`;
    else if (alive === false)
      breakWhy = `its owner (pid ${owner.pid}) is gone — a writer was killed mid-write`;
    else if (alive === null && age !== null && age > LOCK_ABANDON_MS)
      breakWhy =
        `LAST RESORT: it is ${Math.round(age / 1000)}s old and carries no readable owner.json, ` +
        `so its holder cannot be verified either way`;
    if (breakWhy) {
      console.error(
        `bugs: breaking the lock on ${name} — ${breakWhy}; re-read the file if anything looks wrong`,
      );
      ...
```

And the give-up message on `LOCK_SPIN_MS` timeout (lines 1894–1907), which is what the fixtures'
"the NEXT waiter succeeds" checks are really probing for (a non-zero exit + no "breaking the
lock" line means THIS branch fired, not the boot-mismatch one):

```javascript
if (Date.now() >= deadline)
  fail(
    `could not lock ${guarded} within ${LOCK_SPIN_MS}ms — ${name} is held by ` +
      `${owner?.pid ? `pid ${owner.pid}, which still answers` : "another bugs.mjs process"}. ` +
      `Retry; if nothing is running, remove ${p}` +
      (!owner
        ? ` — it carries no owner stamp and will be broken automatically ` +
          `once it is ${LOCK_ABANDON_MS / 1000}s old`
        : ""),
  );
```

`fail()` (line 187) is `console.error("bugs: " + m); process.exit(1)`.

**`owner.json` writing** happens once, right after the `mkdir` that wins the lock (lines
1817–1856), and is exactly what `BUGS_TEST_FAIL_OWNER_WRITE` intercepts:

```javascript
const token = randomUUID();
try {
  if (process.env.BUGS_SELF_TEST === "1" && process.env.BUGS_TEST_FAIL_OWNER_WRITE === "1")
    throw Object.assign(new Error("BUGS_TEST_FAIL_OWNER_WRITE fixture"), {
      code: "EFIXTURE",
    });
  writeFileSync(
    ownerPath(p),
    JSON.stringify({ pid: process.pid, token, at: Date.now(), bootAt: bootStamp() }),
  );
} catch (writeErr) {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  throw writeErr;
}
```

**`withShardLock` / `withCatalogueLock`** (lines 1941–1969):

```javascript
function withLock(p, name, guarded, fn) {
  if (heldLocks.has(p)) return fn();
  acquireLock(p, name, guarded);
  try {
    return fn();
  } finally {
    releaseLock(p);
  }
}
function withShardLock(batch, fn) {
  return withLock(lockPath(batch), `${batch}.jsonl`, shardPath(batch), fn);
}
function withCatalogueLock(fn) {
  return withLock(`${CATALOGUE()}.lock`, "bugs.jsonl", CATALOGUE(), fn);
}
```

**The pre-existing "deterministic wait" template already in this file** — the pattern the lead's
ruling is asking to be extended to the pid-reuse/owner-write fixtures — is the dead-holder
fixture's `awaitExit` (lines 5528–5531), which polls `pidAlive` in a bounded loop BEFORE invoking
the waiter, rather than trusting a fixed sleep:

```javascript
const awaitExit = (child, ms = 15000) => {
  for (let i = 0; i * 25 < ms && pidAlive(child.pid) !== false; i++) sleepSync(25);
  return pidAlive(child.pid) === false;
};
...
const victimGone = awaitExit(victim, 3000);
const rescued = runCli(["tier", "B5", "T2", "--why", "dead-holder fixture"], tmp);
check("dead holder: the killed holder is observed gone before the waiter runs", victimGone, true);
check("dead holder: the NEXT waiter succeeds in one invocation", rescued.code, 0);
```

---

## 4. Lessons + self-test's own "both platforms" comments

`.claude/lessons/LESSONS.md`:

**L-068 · 2026-09-04 · tooling · #597**

> **Lesson:** Hold an exclusive lock across the READ as well as the write wherever two processes
> may touch one file — a read-back-assert can never see the write yours erased. Break a lock on
> LIVENESS (owner pid/token, ESRCH), never on age; release only the lock you own; fix break and
> release together; when two constants work in only one order, test the order. Order writes so any
> failure leaves the safest reachable state: additive write first, verify it landed, irreversible
> step last.
> **Guard:** `withShardLock`/`withCatalogueLock` (atomic `mkdir` lockdir, `owner.json` {pid,
> token}, released from an `exit` handler); `BUGS_TEST_STALL_MS` widens the race; planted failures
> (cross-shard duplicate, real `EISDIR`, corrupted record mid-loop) assert the PRE-failure state
> survives.

**L-070 · 2026-09-05 · tooling · #597**

> **Symptom:** the registry self-test's dead-holder lock cases failed on CI's Linux runner and
> passed on Windows; the waiter never broke a dead owner's lock and every later case inherited it.
> **Root cause:** `process.kill(pid, 0)` succeeds for a POSIX zombie — a killed child its parent
> never reaped — and a synchronous parent (`Atomics.wait`, `spawnSync`) never reaps.
> **Lesson:** Signal 0 proves a pid exists, not that it lives. A POSIX liveness check must also
> read `/proc/<pid>/stat` state `Z` (negative-only: unreadable means alive); a fixture that kills
> a child must assert it was observed gone before the code under test runs.
> **Guard:** self-test `liveness:` checks (a2) and the dead-holder `observed gone` assertion, run
> on both platforms; CI run 33938718344 is the red that proved it.

This is the exact precedent: a prior self-test fixture (dead-holder, a DIFFERENT case from
pid-reuse) was Linux-only-red for a related but distinct reason (zombie pids), fixed by adding a
deterministic "observed gone" poll before the waiter runs, per §3's `awaitExit`.

The self-test's own "both platforms" comments (verbatim, lines 5538–5546, 5568–5572, 5697–5701):

```
// (a2) The liveness predicate itself, platform-independent. A child that
// was SIGKILLed while its parent never turns the event loop is a POSIX
// ZOMBIE: its pid stays allocated and `process.kill(pid, 0)` keeps
// succeeding until the parent reaps it — which this synchronous suite
// never does. `pidAlive` must still answer "gone" (Linux: /proc state Z);
// win32 answers ESRCH outright. Before the fix this was red on CI's
// ubuntu runner and green on Windows, and every dead-holder assertion
// below cascaded from it. Paired with a live-child control so the check
// cannot be satisfied by a predicate that simply answers "gone" always.
...
// (b) A holder killed OUTRIGHT leaves its lockdir behind, and the very
// next waiter must break it within ONE invocation — on the owner pid
// being gone. `process.kill(pid, 0)` answers that on win32; on Linux the
// killed child is a zombie until reaped and `pidAlive` reads /proc for it
// (see (a2)). ...
...
// (d) Ctrl-C mid-write. Node's DEFAULT action for SIGINT/SIGTERM/SIGHUP
// terminates the process WITHOUT running `exit` listeners, so an
// interrupted writer left its lockdir behind. The handlers are asserted
// on both platforms by driving the REAL CLI in a child that reports its
// own listener counts; the real-signal assertion is POSIX-only, because
// on win32 `child.kill("SIGINT")` is a TerminateProcess — case (b), not a
// deliverable signal.
```

Notably: the pid-reuse fixture's own comment (§2, lines 5756–5764) makes NO mention of
"both platforms" or of any Linux-specific hazard — unlike the dead-holder fixture, its author did
not flag a known cross-platform risk here. That is itself informative: this failure mode was not
anticipated the way the L-070 zombie issue was.

---

## 5. Per-assertion analysis

### (1) `pid reuse: the NEXT waiter succeeds in one invocation, not after LOCK_ABANDON_MS`

**Measures:** `rescuedFromReuse.code === 0` — the REAL CLI child's process exit code from one
`runCli` invocation attempting `tier B1 T1` against a lockdir it does not own.
**Timing assumption:** that `acquireLock`'s retry loop, on ITS FIRST or an early iteration, will
compute `bootMismatch === true` (§3) from the forged `owner.bootAt` (20 minutes before the
fixture wrote it) versus the CHILD's own `bootStamp()` at read time, and break the lock well
within the 10-second `LOCK_SPIN_MS` budget — "not after LOCK_ABANDON_MS" is the check's own
name for "this must be the FAST boot-mismatch path, not the 120s LAST-RESORT age path."
**Linux-runner violation:** the exact 10.062s gap in §1 (matching `LOCK_SPIN_MS` almost to the
millisecond) shows the waiter spun its ENTIRE budget without ever computing `breakWhy` truthy,
then hit the `Date.now() >= deadline` branch and called `fail()` → exit 1. Per the code, the ONLY
way `bootMismatch` stays false for a full 10 seconds against a REAL, correctly-forged 20-minute
gap is if the CHILD's own `bootStamp()` (`Date.now() - os.uptime()*1000`) happened to land within
`BOOT_STAMP_SLOP_MS` (5000ms) of the forged value for the whole window — i.e. the runner's actual
OS uptime, at that exact moment, was itself close to 20 minutes (`LOCK_ABANDON_MS * 10`). GH
Actions `ubuntu-latest` runners are freshly provisioned per job, and this Verify step runs `npm
ci` + `prisma generate` + `check-types`/`lint`/`test`/`test:repo-truth` across all workspaces
before ever reaching this line (step 8 alone ran ~4m37s before the self-test's lock-fixture block
even started, on top of whatever uptime existed before job assignment) — so a genuine coincidence
between "the runner has been up around 20 minutes" and "we forged a boot 20 minutes before now"
is not far-fetched on a loaded/cold-cache run. This is a **pure Linux-and-CI-only failure mode**:
it depends on `os.uptime()` producing an unpredictable absolute value, which is exactly the kind
of number a fast, freshly-rebooted Windows dev box (large, stable uptime baseline, never anywhere
near 20 minutes freshly) or the FAST re-run (`cbbc10b4`, presumably faster to reach this line, or
simply a different real uptime at the moment it ran) would not hit. I cannot read the runner's
actual `os.uptime()` from the log — this is the most code-consistent explanation of the observed
10.06s spin-then-give-up, not a certainty.
**Windows vs Linux code path:** identical logic on both platforms — `pidAlive`'s bootAt-mismatch
branch has no platform fork at all (only `zombieOnLinux` forks, and it is irrelevant here since
the impostor was never killed until after `runCli` returned).

### (2) `pid reuse: breaking it names the boot mismatch, never the age-based last resort`

**Measures:** a regex match on `rescuedFromReuse.out` for the specific `console.error` string
emitted only when `bootMismatch` is the reason `breakWhy` was set (§3).
**Assumption:** that SOME "breaking the lock…" line was printed at all, and specifically the
boot-mismatch phrasing (not the age-based "LAST RESORT" phrasing, which requires 120s and cannot
fire inside a 10s spin anyway).
**Linux-runner violation:** got `false` — this is the direct, mechanical consequence of (1): if
`breakWhy` was never computed truthy in any loop iteration, NO "breaking the lock…" message of
any kind was ever printed; the only stderr line the child produced was the `fail()` give-up
message ("could not lock … within 10000ms …"), which does not match the regex regardless of
which reason it names. This assertion adds no new evidence beyond (1) — it fails for the exact
same root state.

### (3) `pid reuse: the write it was blocking actually landed`

**Measures:** `readShard("F01").rows.find(r => r.id === "B1")?.tier === "T1"` — i.e. that the
`tier` write from the pid-reuse `runCli` call actually committed.
**Assumption:** that the CLI child in (1) got far enough to acquire the lock and complete its
write.
**Linux-runner violation:** got `"T2"` — the value left behind by the PRECEDING "(e) abandoned
lock" fixture's own successful write (§1, `ok abandoned lock: the write it was blocking actually
landed` immediately before). Since the pid-reuse CLI child never acquired the lock at all (exit
1), it never wrote anything, so the shard simply still shows the last value another, unrelated,
successful fixture wrote. This is not evidence of a NEW defect — it is the passive residue of (1)
failing.

### (4) `owner-write failure: no lock exists before the fixture runs`

**Measures:** `existsSync(lockDir) === false`, checked as a PRECONDITION before invoking
`ownerWriteFailure()`.
**Assumption:** that the shared `lockDir` (`lockPath("F01")`) is clean when this block starts —
an assumption the code enforces nowhere; there is no `rmSync(lockDir)` between the end of the
pid-reuse block (line 5803) and this check (line 5834–5838) (confirmed by reading the source
verbatim in §2).
**Is this a cascade of (1)–(3)? Yes, unambiguously.** Because the pid-reuse `runCli` invocation in
(1) never SUCCEEDED, it never entered the critical section and never reached `releaseLock` (which
only runs from inside a successful `withLock`'s `finally`, or the `process.on("exit")` hook for a
process that HELD a lock — this child never held one at all, since `mkdirSync(p)` kept throwing
EEXIST against the fixture-created `lockDir` for the CLI child's entire run). The fixture-created
`lockDir` (with the stale, forged, impostor-pid `owner.json`) is therefore still sitting on disk
exactly as the pid-reuse block left it when the owner-write-failure block's precondition check
runs — `existsSync(lockDir)` reports `true` for a directory nothing in (1)–(3) ever cleaned up.
The REST of the owner-write-failure fixture then passes (§1) because, by the time
`ownerWriteFailure()`'s CLI child actually starts, real wall-clock time has passed and
`impostor.kill()` (line 5781, called back in the pid-reuse block) has genuinely terminated that
child — Node's child_process module reaps its own spawned children on `exit`, so there is no
zombie window analogous to L-070 here — so `pidAlive(impostor.pid, owner.bootAt)` now returns
`false` via a real ESRCH (or the same bootAt mismatch, either one now works), the lock breaks
inside the retry loop well within budget, and the rest of the owner-write-failure assertions
(which test the REAL `BUGS_TEST_FAIL_OWNER_WRITE` throw/cleanup path, unrelated to pid-reuse)
proceed normally. **Failure (4) requires no independent defect theory — it is fully explained as
downstream fallout of (1).**

**Windows vs Linux code path for all four:** no platform-specific branch exists anywhere in
`acquireLock`, `pidAlive`'s bootAt check, or the pid-reuse/owner-write fixture code itself (the
only platform fork in this whole lock-fixture block, `if (process.platform !== "win32")` at line
5728, guards the UNRELATED real-SIGINT-delivery assertion several fixtures earlier). The
divergence between Linux-red and Windows/Linux-green-on-rerun is not a different code path — it
is the same code evaluated against a different, unpredictable `os.uptime()` reading.

---

## 6. Proposed rewrites (NOT implemented — read-only reader)

General principle for all four: assert on the **verdict text `acquireLock` actually produced**
(the `breakWhy` reason it printed, or the specific give-up message) and on the **end state** (did
the write land; is the lock released), not on an exit code alone or on which "invocation" it took.

### (1)+(2) combined — replace the pass/fail-by-exit-code pair with a verdict-string assertion

Minimal rewrite: instead of asserting `rescuedFromReuse.code === 0` and separately regex-matching
`.out` for the boot-mismatch phrase, capture ONE verdict and assert it names the reason:

```javascript
const wasRescued =
  rescuedFromReuse.code === 0 &&
  /breaking the lock on F01\.jsonl — its owner \(pid \d+\) predates this boot/.test(
    rescuedFromReuse.out,
  );
check(
  "pid reuse: broken via the boot-mismatch verdict, and the waiter then succeeded",
  wasRescued,
  true,
);
```

This does not change WHAT is measured much (still exit code + regex) but collapses two
assertions that are causally the same event into one, removing the illusion that (1) and (2) are
independent evidence — today a partial fix that makes (1) pass without (2) (or vice versa) is
incoherent but the harness would still report it as "half fixed." A mutation that would still
turn this red: swap `bootMismatch` and the age-based `LAST RESORT` branch order in `acquireLock`
so a stale-but-old-enough lock is broken by AGE instead of by boot-mismatch even when boot-mismatch
is also true — the regex would stop matching (the LAST RESORT text would show up instead), while
a pure `code === 0` check alone would still pass. That is exactly the kind of code-behavior
regression an exit-code-only check cannot catch, which is the reason to keep the reason-string
condition folded in.

### (3) — assert end state, not "which write landed", with a resilient precondition

Minimal rewrite: read the row's tier BEFORE the pid-reuse `runCli` call and assert the AFTER value
DIFFERS from the BEFORE value in the expected direction, rather than hard-coding the specific
prior fixture's leftover value ("T2") as an implicit expected-failure baseline:

```javascript
const beforeTier = readShard("F01").rows.find((r) => r.id === "B1")?.tier;
const rescuedFromReuse = runCli(["tier", "B1", "T1", "--why", "pid-reuse fixture"], tmp);
...
check(
  "pid reuse: the write it was blocking actually landed",
  readShard("F01").rows.find((r) => r.id === "B1")?.tier,
  rescuedFromReuse.code === 0 ? "T1" : beforeTier, // only require T1 if the CLI itself reported success
);
```

This is a lesser rewrite — arguably the RIGHT fix is to make this check `code === 0 ? … "T1" :
FAIL-early / skip`, since asserting "T1" landed is meaningless once (1) has already proven the
CLI never ran the write path at all. A mutation that would still turn this red: make
`upsertLedgerRowLocked` silently drop a write when `--why` contains the substring "fixture" (a
deliberately silly but concrete mutation) — the tier would stay at whatever it was before, still
failing this check even after gating on `rescuedFromReuse.code === 0`.

### (4) — make the precondition self-sufficient instead of load-bearing on (1)-(3)

Minimal rewrite: force the precondition true rather than merely asserting it, OR (better, to keep
the check meaningful) explicitly assert on the state the code claims responsibility for — that
`acquireLock`'s SELF cleanup (the `rmSync` on a `writeFileSync` throw, and `releaseLock`) is
sufficient, by removing today's assumption of a globally-clean start:

```javascript
rmSync(lockDir, { recursive: true, force: true }); // OWN the precondition; do not inherit it
check("owner-write failure: no lock exists before the fixture runs", existsSync(lockDir), false);
```

This one-line addition (`rmSync` before the check) is the actual minimal fix for THIS check
specifically — it stops it from being a cascade detector for fixture (f) and makes it test only
what its name claims. It remains non-vacuous: a mutation that would still turn it red is
`acquireLock`'s cleanup-on-EFIXTURE-throw block (lines 1850–1855) being deleted or changed to NOT
`rmSync(p)` before rethrowing — then the very NEXT owner-write-failure invocation's own OWN prior
run would leave the lock behind even after this line's defensive `rmSync`, since the throw would
now be re-entered by a lockdir this exact fixture just created and failed to clean up itself. (A
more surgical mutation: have `acquireLock`'s `catch (writeErr)` cleanup silently swallow errors
without calling `rmSync` at all — same effect.)

### Making the pid-reuse fixture itself deterministic (not just re-asserted)

The task's suggested "wait for ESRCH via bounded poll before the waiter starts" pattern (the
`awaitExit` template in §3) does not directly apply here — the impostor process is DELIBERATELY
kept alive throughout (that's the whole point of "pid reuse": a live, unrelated process). The
actual deterministic fix is **not to rely on a coincidental 20-minute forged gap at all**: choose
an offset for the forged `bootAt`/`at` that cannot plausibly collide with any real machine's
`os.uptime()` within `BOOT_STAMP_SLOP_MS`, e.g.

```javascript
at: Date.now() - 1000 * 60 * 60 * 24 * 365 * 5, // 5 years — no runner has that uptime
bootAt: Date.now() - 1000 * 60 * 60 * 24 * 365 * 5,
```

(`LOCK_ABANDON_MS * 10` = 20 minutes was almost certainly chosen only because it is "far larger
than LOCK_ABANDON_MS," not because it needed to be plausible-uptime-proof — a 5-year offset
satisfies "definitely predates any real boot" with zero coincidental-collision risk on any
runner, cold or warm, cached or not.) This single-constant change is the one fix in this whole
report that plausibly eliminates the root cause outright rather than just re-shaping what the
checks assert; it should be evaluated ALONGSIDE the verdict-string rewrites above, not instead of
them, since the rewrites above still improve the harness's honesty even if the timing coincidence
is also fixed.

**Does a `BUGS_TEST_STALL_MS`-style knob already exist for this?** Not for boot-stamp forging.
`BUGS_TEST_STALL_MS` and `BUGS_TEST_FAIL_OWNER_WRITE` are the two existing gated seams (§3), both
scoped to `upsertLedgerRowLocked`'s race window and `acquireLock`'s owner-write throw
respectively — neither touches `bootStamp()`/`pidAlive`'s mismatch arithmetic. A THIRD seam (e.g.
`BUGS_TEST_BOOT_STAMP_OVERRIDE`) is not present in the current file; if a future implementer
wants the CHILD process's own `bootStamp()` value pinned instead of widening the forged
constant, that would be new code, not a knob that already exists.

---

## 7. What changed between the failing run and current HEAD; CI env

`git log --oneline -8 -- scripts/campaign/bugs.mjs`:

```
243325d2 feat(registry): sync --check guard, move --tier, f32 hotfix shard (#635)
10ddc3fa feat(campaign): in-repo bug registry — records, automatic history, lifecycle CLI, dependency graph (#597)
```

Only two commits have ever touched this file (consistent with L-068/L-070 citing #597 as the
introducing PR).

`git diff 25335633 0b715128 -- scripts/campaign/bugs.mjs | grep -n "pid reuse\|owner-write\|bootAt\|LOCK_ABANDON"` produced **zero matches** — none of the quoted lines (fixtures, `LOCK_ABANDON_MS`, `bootAt` handling) differ AT ALL between the failing run's commit (`25335633`, base of PR #634's head `cde998d4`) and current HEAD `0b715128`. (The file DID change overall — `243325d2`/#635 added 472 lines, `sync --check` + `move --tier` + an F32 shard entry — but none of it touches the lock-liveness code or these four fixtures.) This is strong corroborating evidence for "unchanged code, runner-dependent outcome" rather than a regression introduced by #634 or #635.

`.github/workflows/ci.yml`, the `verify` job (lines 159–283): `runs-on: ubuntu-latest`,
`timeout-minutes: 20`, `env.NODE_VERSION: "20"`. The failing step itself
("Verify (lockfile, bug-signature scan, types, lint, tests)", line 282) carries **no explicit
`env:` block** — it inherits whatever Actions sets by default (no `NODE_ENV` override visible in
this job). The job's own header comment explicitly notes **"No turbo cache here, deliberately —
… every task genuinely executes on a fresh runner"** and cites three prior false-green incidents
from cached replays — i.e. this Verify job is intentionally cold/uncached on every run, which is
consistent with (and could plausibly extend) the runner being under load/variable uptime by the
time it reaches `bugs.mjs self-test`, five-plus minutes into the step.

---

## 8. Local self-test run (Windows)

```
node scripts/campaign/bugs.mjs self-test
```

Tail:

```
  ok   T14/R10: an existing ledger row can still be re-homed without --tier
  ok   T14/R10: F05's shard survives the re-home and no longer holds B1
  ok   T14/R10: F06's shard holds B1 after the re-home
  ok   T14/R10: list --batch reflects the re-home's catalogue update too
  ok   T14/R10: triage-move on an id outside the catalogue is refused as an unknown id

self-test: all checks passed
```

Wall time: **86 seconds**.

---

## Summary of the chain of evidence

1. `bugs.mjs`'s lock-liveness code (`acquireLock`, `pidAlive`, `bootStamp`, `LOCK_ABANDON_MS`) is
   byte-identical between the failing run's commit and current HEAD.
2. The 10.062-second gap between the last "abandoned lock" `ok` and the first "pid reuse" `ok`
   matches `LOCK_SPIN_MS` (10000ms) almost exactly — the pid-reuse `runCli` child spun its ENTIRE
   give-up budget without the boot-mismatch branch ever firing, then exited 1 via `fail()`.
3. Checks (1) and (2) are two views of that ONE event (exit code, and absence of the
   boot-mismatch message). Check (3) is passive residue (the write never ran, so the shard still
   shows the PRIOR fixture's value). Check (4) is a pure cascade: nothing in the pid-reuse block
   ever cleans up `lockDir` on a failed `runCli`, so the very next fixture's "no lock exists"
   precondition inherits the mess.
4. The most code-consistent explanation (not provable from the log alone, since it needs the
   runner's live `os.uptime()`, which isn't logged) is that the fixture forges its "impossible"
   boot offset as exactly `LOCK_ABANDON_MS * 10` = 20 minutes — a value plausible for a real,
   cold, multi-step CI runner's actual uptime by the time this deep a Verify step runs — rather
   than an astronomically safe offset (years). That single design choice is orthogonal to, and
   arguably more fixable than, the invocation-count-vs-verdict assertion style the lead flagged.
