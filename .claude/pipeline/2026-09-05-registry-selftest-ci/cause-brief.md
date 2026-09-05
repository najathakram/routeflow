# Cause brief — PR #597 CI run 33938718344, `bugs.mjs self-test` (dead holder / stolen lock)

> Written by the S1 evidence agent (Sonnet @ low, read-only). Facts with evidence only — every claim
> carries a file:line, a command output, or a quoted source. The suspected cause is recorded AS A
> CLAIM. No fix proposals.

## The bug as stated

- **Source**: PR #597, CI run `33938718344`, job **Verify**, step `node scripts/campaign/bugs.mjs
self-test`, exited 1. Five verbatim failures:
  - `dead holder: the NEXT waiter succeeds in one invocation — got 1 want 0`
  - `dead holder: breaking a dead owner's lock is reported, never silent — got false want true`
  - `dead holder: the write it was blocking actually landed — got "T1" want "T2"`
  - `stolen lock: the fixture starts with no lock held — got true want false`
  - `stolen lock: the stolen-from writer says so on stderr — got false want true`
- **Repro**: on `ubuntu-latest` / Node 20 in CI, these 5 self-test assertions fail every time (this
  run). Locally on Windows the same self-test passes (270/270); the owner reports "only wall-clock
  cases flake under load" locally, not these.
- **Suspected cause (claim, unverified)**: none stated yet by the owner beyond "flakes under load" —
  this brief treats that as unverified; the CI log shows a real, reproducible sequence of failures,
  not a flake (no retry/rerun evidence available; this is a single run).

## CI log evidence

Log fetched via `gh run view 33938718344 --log-failed` (readable — repo access worked; no
"unreadable while private" issue hit). Runner/env, from the same log:

```
env:
  NODE_VERSION: 20
```

`.github/workflows/ci.yml:163` and `:338` — both `Verify` and `E2E` jobs declare `runs-on:
ubuntu-latest`. Job-level API (`gh api .../jobs`) confirms `"name":"Verify"` ran on `"runner_group_name":
"GitHub Actions"` (hosted `ubuntu-latest`).

`ok` lines that printed **before** the first failure in this suite (i.e. passed), in order:

```
ok   lock fixture: the rows this suite races over share one shard
ok   concurrent prove: the orchestrator exited 0
ok   concurrent prove: BOTH child processes exited 0
ok   concurrent prove: BOTH rows landed — neither write erased the other
ok   concurrent prove: the lock directory is released, not left behind
ok   live holder: the orchestrator exited 0
ok   live holder: BOTH child processes exited 0
ok   live holder: a lock held past the OLD 5s threshold is NOT broken
ok   live holder: the waiter waited — BOTH rows landed, neither reverted
ok   dead holder: it really held the lock when it was killed
```

Then, verbatim (log lines, `ci-fail.log` around L10393–L10413):

```
ok   dead holder: it really held the lock when it was killed
FAIL dead holder: the NEXT waiter succeeds in one invocation
      got  1
      want 0
FAIL dead holder: breaking a dead owner's lock is reported, never silent
      got  false
      want true
FAIL dead holder: the write it was blocking actually landed
      got  "T1"
      want "T2"
FAIL stolen lock: the fixture starts with no lock held
      got  true
      want false
ok   stolen lock: the victim really held the lock when it was stolen
ok   stolen lock: the successor's lockdir SURVIVES the stolen-from writer's exit
FAIL stolen lock: the stolen-from writer says so on stderr
      got  false
      want true
ok   stolen lock (exit code): the stealer really observed the victim's own owner stamp first
ok   stolen lock (exit code): the successor's lockdir SURVIVES this writer's exit too
ok   stolen lock (exit code): the stolen-from writer's real process exit status is non-zero
```

followed downstream by more `ok` (SIGINT, abandoned lock, pid reuse cases all pass), then at the very
end: `##[error]Process completed with exit code 1.` (L10547). So exactly these 5 checks fail; every
other lock-suite check in the same run — including the _later_ stolen-lock-via-exit-code case (c2),
which uses `spawnSync` instead of the busy-poll pattern — passes.

## Code path

All quotes from `scripts/campaign/bugs.mjs` at `origin/feat/bug-registry` (head `6fb6e7cac53704b2
1a9cc307a77cc87403daab52`), fetched via `git show origin/feat/bug-registry:scripts/campaign/bugs.mjs`.

### Lock design comment (L1630–1652)

```
1635: //     carries `owner.json` = {pid, token, at}; a waiter breaks the lock only
1636: //     when `process.kill(pid, 0)` reports ESRCH (which works on win32 too), or
1637: //     — a loud last resort, for a lock whose owner cannot be read at all —
1638: //     when it is older than LOCK_ABANDON_MS. Age is NOT liveness: breaking a
1639: //     live holder's lock put two writers inside the critical section, and the
1640: //     stolen-from writer then wrote its stale snapshot back over two proven,
1641: //     evidence-backed rows with every process exiting 0;
```

### Constants (L1654–1660)

```
1654: const LOCK_SPIN_MS = 10000;
1655: const LOCK_STEP_MS = 20;
1660: const LOCK_ABANDON_MS = 120000;
```

### Liveness check — `pidAlive` (L1692–1706)

```
1692: // true = alive, false = definitely gone (ESRCH) OR its owner pid predates
1693: // this boot (so it cannot possibly be the process that wrote the lock), null
1694: // = cannot tell. EPERM means the pid exists and belongs to someone else —
1695: // alive, not free, UNLESS the boot stamp already proved it can't be ours.
1696: const pidAlive = (pid, ownerBootAt) => {
1697:   if (!Number.isInteger(pid) || pid <= 0) return null;
1698:   if (typeof ownerBootAt === "number" && Math.abs(ownerBootAt - bootStamp()) > BOOT_STAMP_SLOP_MS)
1699:     return false;
1700:   try {
1701:     process.kill(pid, 0);
1702:     return true;
1703:   } catch (e) {
1704:     return e.code === "ESRCH" ? false : true;
1705:   }
1706: };
```

This is the **only** branch on process-exit signal semantics in the file; there is no separate
`process.platform === "win32"` branch for liveness itself (the comment at L1636 explicitly claims
`process.kill(pid, 0)` "works on win32 too"). `pidAlive` is used both by the SUT (`acquireLock`,
below) and, in a slightly different call (`pidAlive(child.pid) !== false`), by the self-test's own
`awaitExit` helper.

### `acquireLock` — mkdir, owner.json, break-dead-lock branch, stderr message (L1749–1840)

```
1749: function acquireLock(p, name, guarded) {
1750:   mkdirSync(dirname(p), { recursive: true });
1751:   const deadline = Date.now() + LOCK_SPIN_MS;
1752:   for (;;) {
1753:     try {
1754:       mkdirSync(p); // NOT recursive: recursive:true succeeds on an existing dir
1755:       installLockExitHook();
...
1768:       const token = randomUUID();
1769:       try {
...
1774:         writeFileSync(
1775:           ownerPath(p),
1776:           JSON.stringify({ pid: process.pid, token, at: Date.now(), bootAt: bootStamp() }),
1777:         );
1778:       } catch (writeErr) {
...
1791:       heldLocks.set(p, token);
1792:       return p;
1793:     } catch (e) {
1794:       if (e.code !== "EEXIST") throw e;
1795:     }
1796:     const owner = readLockOwner(p);
1797:     const alive = owner ? pidAlive(owner.pid, owner.bootAt) : null;
1798:     const bootMismatch =
1799:       alive === false &&
1800:       typeof owner?.bootAt === "number" &&
1801:       Math.abs(owner.bootAt - bootStamp()) > BOOT_STAMP_SLOP_MS;
1802:     let age = null;
1803:     try {
1804:       age = Date.now() - statSync(p).mtimeMs;
1805:     } catch {
1806:       age = null; // it vanished between the mkdir and the stat — just retry
1807:     }
1808:     let breakWhy = null;
1809:     if (bootMismatch)
1810:       breakWhy = `its owner (pid ${owner.pid}) predates this boot — it cannot possibly still be that process`;
1811:     else if (alive === false)
1812:       breakWhy = `its owner (pid ${owner.pid}) is gone — a writer was killed mid-write`;
1813:     else if (alive === null && age !== null && age > LOCK_ABANDON_MS)
1814:       breakWhy =
1815:         `LAST RESORT: it is ${Math.round(age / 1000)}s old and carries no readable owner.json, ` +
1816:         `so its holder cannot be verified either way`;
1817:     if (breakWhy) {
1818:       console.error(
1819:         `bugs: breaking the lock on ${name} — ${breakWhy}; ` +
1820:           `re-read the file if anything looks wrong`,
1821:       );
1822:       try {
1823:         rmSync(p, { recursive: true, force: true });
1824:       } catch {
1825:         /* another process won the race to break it — retry below */
1826:       }
1827:     }
1828:     if (Date.now() >= deadline)
1829:       fail(
1830:         `could not lock ${guarded} within ${LOCK_SPIN_MS}ms — ${name} is held by ` +
1831:           `${owner?.pid ? `pid ${owner.pid}, which still answers` : "another bugs.mjs process"}. ` +
...
1840:     sleepSync(LOCK_STEP_MS);
1841:   }
1842: }
```

The break-and-report message the self-test regexes for (`/breaking the lock on F01\.jsonl — its
owner \(pid \d+\) is gone/`) is emitted **only** when `alive === false` at L1811–1812 — i.e. only when
`pidAlive` returns `false`. If `pidAlive` returns `true` (or the process never observes `false`
before the 10 s deadline), `breakWhy` stays `null`, the loop spins to `deadline` and calls `fail()`,
which exits non-zero without ever printing the break message and without ever removing `p` — leaving
the lockdir in place for every subsequent caller of the same lock path.

### `releaseLock` — identity check and the "stolen lock" stderr message (L1848–1871)

```
1848: function releaseLock(p, token = heldLocks.get(p)) {
1849:   heldLocks.delete(p);
1850:   if (!existsSync(p)) return; // already gone — nothing to undo
1851:   const owner = readLockOwner(p);
1852:   if (!owner || !token || owner.token !== token) {
1853:     console.error(
1854:       `bugs: our lock on ${shardOfLockPath(p)} was broken by another process; verify the shard`,
1855:     );
...
1859:     process.exitCode = 1;
1860:     return;
1861:   }
1862:   try {
1863:     rmSync(p, { recursive: true, force: true });
1864:   } catch {
1865:     /* already gone (someone broke it between the read and the rm) */
1866:   }
1867: }
```

This stderr message (`our lock on F01.jsonl was broken by another process; verify the shard`) is
what the fifth failing check regexes for. It is only reached on `releaseLock`'s normal path — i.e.
only if the stolen-from writer actually acquired the lock (wrote its own `owner.json`) in the first
place. No `process.platform`/`os.type()` branch appears anywhere in `acquireLock`/`releaseLock`/
`pidAlive`/`withLock`/`withShardLock`/`withCatalogueLock` — the only other `process.platform` uses in
the whole file are in unrelated fixtures (`symlinkSync(..., process.platform === "win32" ? "junction"
: "dir")` at L5007, and a POSIX-only real-SIGINT assertion gated by `if (process.platform !==
"win32")` at L5615, which is a _different_, later, passing case in this same run).

## Self-test cases — "dead holder" and "stolen lock" (L5445–5518)

Shared setup just above (L5445–5462):

```
5445: // Wait for a real child to be INSIDE its critical section. `owner.json`
5446: // is written immediately after the mkdir that wins the lock, so its
5447: // existence — not the lockdir's — is what proves the hold is established.
5448: const awaitHold = () => {
5449:   for (let i = 0; i < 400 && !existsSync(ownerPath(lockDir)); i++) sleepSync(25);
5450:   return existsSync(ownerPath(lockDir));
5451: };
5452: const awaitExit = (child, ms = 15000) => {
5453:   for (let i = 0; i * 25 < ms && pidAlive(child.pid) !== false; i++) sleepSync(25);
5454:   return pidAlive(child.pid) === false;
5455: };
5456: const holder = (id, stall, stdio) =>
5457:   spawn(process.execPath, [SCRIPT_PATH, ...proveArgs(id, 700 + Number(id.slice(1)))], {
5458:     env: { ...process.env, BUGS_ROOT: tmp, BUGS_SELF_TEST: "1", BUGS_TEST_STALL_MS: stall },
5459:     stdio,
5460:   });
```

`sleepSync` (L1699 area, actually defined near L1707) is:

```
const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
```

— a synchronous, event-loop-blocking wait (blocks the whole thread; no libuv/timer/SIGCHLD
processing can occur while it runs).

### "dead holder" case (L5463–5482)

```
5463: // (b) A holder killed OUTRIGHT leaves its lockdir behind, and the very
5464: // next waiter must break it within ONE invocation — on the owner pid
5465: // being gone, which `process.kill(pid, 0)` answers on win32 too. Before
5466: // the fix the waiter's 2s deadline expired long before the 5s age
5467: // threshold it was waiting for, so it exited 1 blaming "another bugs.mjs
5468: // process is writing F01.jsonl" when nothing was running at all.
5469: const victim = holder("B5", "20000", "ignore");
5470: const heldByVictim = awaitHold();
5471: victim.kill("SIGKILL");
5472: awaitExit(victim, 3000);
5473: const rescued = runCli(["tier", "B5", "T2", "--why", "dead-holder fixture"], tmp);
5474: check("dead holder: it really held the lock when it was killed", heldByVictim, true);
5475: check("dead holder: the NEXT waiter succeeds in one invocation", rescued.code, 0);
5476: check(
5477:   "dead holder: breaking a dead owner's lock is reported, never silent",
5478:   /breaking the lock on F01\.jsonl — its owner \(pid \d+\) is gone/.test(rescued.out),
5479:   true,
5480: );
5481: check(
5482:   "dead holder: the write it was blocking actually landed",
5483:   readShard("F01").rows.find((r) => r.id === "B5")?.tier,
5484:   "T2",
5485: );
```

Fixture: `holder("B5", "20000", "ignore")` **spawns a real child bugs.mjs process** (`spawn`, not a
fake pid) that acquires the F01 lock and stalls 20 s inside its critical section
(`BUGS_TEST_STALL_MS: "20000"`) — i.e. the "dead holder" is a genuinely spawned-and-then-killed child,
not a fabricated pid. `awaitHold()` busy-polls (via `sleepSync`/`Atomics.wait`) for the child's
`owner.json` to appear (confirming the child actually holds the lock), then the test sends
`SIGKILL`, then calls `awaitExit(victim, 3000)` which busy-polls `pidAlive(child.pid)` (i.e. re-checks
`process.kill(child.pid, 0)` from the SAME process, `bugs.mjs self-test`'s own Node process) for up to
3 s, then immediately runs a **third, separate** process (`runCli` → `execSync`, a brand-new
`node bugs.mjs tier B5 T2 ...` child) which is the one whose `acquireLock`/`pidAlive` call is actually
under test.

### "stolen lock" case (L5486–5518)

```
5486: // (c) The other half of the theft, from the RELEASE side: a process whose
5487: // lock was broken used to rm the lock PATH unconditionally on the way
5488: // out, deleting the lock its SUCCESSOR now held and admitting a third
5489: // writer. Hand-write a different owner token into the lockdir while a
5490: // real `prove` is inside its critical section: it must leave the
5491: // directory alone and say so.
5492: check("stolen lock: the fixture starts with no lock held", existsSync(lockDir), false);
5493: const errFile = join(tmp, "stolen.err");
5494: const errFd = openSync(errFile, "w");
5495: const stolen = holder("B6", "3000", ["ignore", "ignore", errFd]);
5496: const heldByStolen = awaitHold();
5497: writeFileSync(
5498:   ownerPath(lockDir),
5499:   JSON.stringify({ pid: process.pid, token: "a-successor-token", at: Date.now() }),
5500: );
5501: awaitExit(stolen);
5502: closeSync(errFd);
5503: const stolenErr = readFileSync(errFile, "utf8");
5504: check("stolen lock: the victim really held the lock when it was stolen", heldByStolen, true);
5505: check(
5506:   "stolen lock: the successor's lockdir SURVIVES the stolen-from writer's exit",
5507:   existsSync(lockDir),
5508:   true,
5509: );
5510: check(
5511:   "stolen lock: the stolen-from writer says so on stderr",
5512:   /our lock on F01\.jsonl was broken by another process; verify the shard/.test(stolenErr),
5513:   true,
5514: );
5515: rmSync(lockDir, { recursive: true, force: true });
```

`lockDir` (`= lockPath("F01")`) is the **same single lock path** shared by every case in this suite
(concurrent-prove, live-holder, dead-holder, stolen-lock, SIGINT, abandoned-lock, pid-reuse all race
over shard `F01`, per the earlier `check("lock fixture: the rows this suite races over share one
shard", ...)` at L5320-5323). "Stolen" here means: the fixture itself overwrites `owner.json` in a
lockdir a real second process (`holder("B6", ...)`) is legitimately holding, simulating the lock
being torn out from under a live writer — it is not a separate fabricated-pid mechanism, it is a
direct file write racing a real holder.

`runCli` (used by `rescued` above) is defined at L2768–2789 and spreads `{ ...process.env, BUGS_ROOT:
root, BUGS_SELF_TEST: "1" }` — this runs after `cmds["self-test"]` has already deleted every `GIT_*`
var from `process.env` at the top of the self-test (L2801–2827: `for (const k of ["GIT_DIR", ...])
delete process.env[k];`), so both `runCli` and `holder()`'s spawned children inherit that already-
scrubbed environment; neither `runCli` nor `holder()` does its own additional `GIT_*` stripping.
`holder()` (L5456–5460) uses `spawn` with `stdio: "ignore"` or a captured stderr fd (`["ignore",
"ignore", errFd]` in the stolen-lock case) — the stolen-lock case captures stderr to a real file
(`errFile`/`errFd`) and reads it back with `readFileSync` after `awaitExit`, which is how "reported,
never silent" is checked (regex against the captured file's contents, not against any in-memory
buffer).

## Suspected cause (claim, unverified) — for S2 to refute or confirm

All 5 failures are consistent with **one** upstream event: the dead-holder case's own `pidAlive`
check (either inside the SUT's `acquireLock`, called from the separately-spawned `rescued` process,
or inside the self-test's own `awaitExit` polling loop) never observes `process.kill(victim.pid, 0)`
throwing `ESRCH` for the SIGKILLed victim, within the 3 s `awaitExit` window or the SUT's 10 s
`LOCK_SPIN_MS` window. On POSIX/Linux, a process killed with `SIGKILL` becomes a **zombie** — its pid
stays allocated in the process table, and `kill(pid, 0)` keeps succeeding (no `ESRCH`) — until its
**parent** reaps it via `wait()`/`waitpid()`. The parent here is the `bugs.mjs self-test` Node
process itself (`victim = holder(...)` was created with `spawn`, whose parent is this process), and
that process spends the entire self-test body in tight, comment-documented `sleepSync`
(`Atomics.wait`, synchronous, blocks the whole thread — see L1707-area) busy-polls with no `await`
between statements, so libuv/SIGCHLD processing (which is what lets Node deliver the `'exit'` event
and, per the code's OWN comment at L5520-5527, is what "the busy-poll pattern above (`awaitExit`,
built on a raw `process.kill(pid,0)` liveness check) never yields for") may never get a turn to reap
`victim` before the `rescued` child's own `pidAlive(owner.pid, ...)` call runs. If `victim` is still
an unreaped zombie when `rescued`'s `acquireLock` checks it, `pidAlive` returns `true` (per L1701-1702:
`process.kill(pid, 0)` on an existing zombie pid does not throw), so `breakWhy` stays `null`
(L1808-1816), the loop spins the full `LOCK_SPIN_MS` (10 s) and calls `fail()` — explaining all three
"dead holder" failures in one shot (`code 1` not `0`; no break message printed; `tier` write never
applied so `B5.tier` stays `"T1"`). Because `fail()` never removes the lockdir in that path, `lockDir`
is left occupied — explaining `stolen lock: the fixture starts with no lock held` (`got true`): the
NEXT case (`holder("B6", ...)`, a fresh child) inherits the still-present, still-zombie-owned
lockdir. This differs from Windows, where `TerminateProcess`/handle semantics have no zombie/parent-
reap step — a killed process's pid check fails immediately — matching the owner's report that the
same suite passes locally on Windows. The fifth failure (`stolen lock: the stolen-from writer says so
on stderr`) is not yet independently explained by this brief and needs S2 to trace whether case (c)'s
`holder("B6", ...)` process ever legitimately acquired the F01 lock at all under a pre-occupied
`lockDir` inherited from the dead-holder case, or failed outright with no owner.json of its own to
overwrite.

## History

Not gathered in this pass — the task scoped evidence to the CI log, the self-test source at
`origin/feat/bug-registry` (`6fb6e7ca`), and the branch's pipeline artifacts; `git log`/`git blame` of
`scripts/campaign/bugs.mjs`'s lock section were out of scope for this brief and are left for S2 if
needed.

## Existing tests around this behavior

The only coverage of this lock path is the self-test block itself
(`scripts/campaign/bugs.mjs`, `cmds["self-test"]`, lock-suite section starting around L5290, sharing
shard `F01` across: concurrent-prove, live-holder, dead-holder, stolen-lock (busy-poll), stolen-lock
(exit-code via `spawnSync`, case c2, L5518–5578 — which **passes** in this run), SIGINT (L5580+),
abandoned-lock, and pid-reuse cases). No `*.spec.ts` Jest coverage exists for this file (it is a CLI
script under `scripts/campaign/`, not part of the Jest-covered `apps/*` tree).

## Production evidence (if any)

None — this is a CI self-test failure, not a production incident. No client-tenant data is involved.

## RESUME / build-plan artifacts on the branch

Searched every `.claude/pipeline/*` directory tracked at `origin/feat/bug-registry` (`6fb6e7ca`) —
`build-plan.md`, `discovery.md`, `spec.md`, `test-plan.md`, `RESUME.md` files across
`2026-08-30-campaign-schema-foundation`, `2026-08-30-destructive-endpoint-guards`,
`2026-08-31-f02b-destructive-family`, `2026-08-31-f03-payment-truth`, `2026-08-31-f04-pricing-mirrors`,
`2026-08-31-f05-driver-at-door-money`, `2026-08-31-f06-update-order-items`,
`2026-08-31-f17-import-robustness`, `2026-08-31-f30-scan-loss`,
`2026-09-01-F10-reopen-stop-state-guards`, `2026-09-01-f07-order-lifecycle`,
`2026-09-02-F11-run-cancel-skip`, `2026-09-02-F14-authz-matrix`, `2026-09-02-wave-a-completion`, and
`2026-09-03-registry-views` — via `git grep -liE "ESRCH|EPERM|liveness|process\.platform|kill\(pid"`
against `origin/feat/bug-registry` scoped to `.claude/pipeline`. **No matches.** None of the
tracked pipeline artifacts on this branch discuss lock liveness semantics or platform assumptions;
the only place that reasoning lives is the inline comments in `scripts/campaign/bugs.mjs` itself
(quoted above).

## Open unknowns

- Whether `pidAlive`'s zombie-vs-reaped theory is actually what happened on this runner, or whether
  something else (CPU contention on `ubuntu-latest` making the 3 s `awaitExit` / 10 s `LOCK_SPIN_MS`
  windows too tight, independent of zombie semantics) is the real trigger — S2 should try to
  reproduce under artificial load on Linux and check whether `victim`'s `'exit'` event / `child.
exitCode` ever populates during the self-test's synchronous run, and whether increasing
  `LOCK_SPIN_MS`/`awaitExit`'s budget or adding an explicit reap (e.g. `child.on('exit', ...)` /
  awaiting a promise instead of the raw `pidAlive` busy-poll) changes the outcome.
- Why `stolen lock: the stolen-from writer says so on stderr` fails specifically — whether it is a
  direct consequence of the leftover lockdir from the dead-holder case (case c's `holder("B6", ...)`
  child fails to ever acquire F01 at all, so it never legitimately holds the lock to have "stolen"),
  or an independent timing issue in the same busy-poll family.
- Whether this is genuinely CI-only (no zombie issue on Windows) or could also intermittently hit a
  Linux dev machine under load, given the owner's report of "wall-clock cases" flaking locally too.
- No retry data for run `33938718344` — unclear whether a rerun would reproduce identically or is
  itself flaky in a way that would argue against the zombie theory (a hard 100%-reproducible failure
  would argue for something more deterministic than zombie-reap timing, e.g. a hard-coded
  Linux-only kill-signal semantic difference not yet identified).
