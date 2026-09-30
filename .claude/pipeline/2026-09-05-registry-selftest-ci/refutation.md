# S2 refutation — PR #597 CI run 33938718344, `bugs.mjs self-test` (5 lock failures)

> Adversarial pass over the S1 brief's hypothesis. Every claim below carries either a
> `file:line` at `origin/feat/bug-registry` (`6fb6e7cac53704b21a9cc307a77cc87403daab52`) or a
> command output captured in this session. Read-only on git and on every worktree; all
> execution happened in a scratch temp dir and in throwaway `node:20-alpine` containers.
> No fix is proposed — only facts a fix must satisfy.

## Verdict

**CONFIRMED** — in mechanism and in consequence — with two of the hypothesis's own worked
examples **REFUTED**.

| Hypothesis clause                                                                                 | Verdict                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The liveness check behaves differently on Linux than on Windows                                   | **CONFIRMED**, measured on both                                                                                                                                                                                                             |
| `process.kill(pid, 0)` does NOT throw `ESRCH` on Linux for the pid the fixture treats as dead     | **CONFIRMED** — it returns success for a _zombie_                                                                                                                                                                                           |
| … so the lock is never broken; the waiter times out                                               | **CONFIRMED** — exit 1 after 10,666 ms                                                                                                                                                                                                      |
| … the next case inherits the lock                                                                 | **CONFIRMED** — failures 4 and 5 are pure state leakage                                                                                                                                                                                     |
| "…a pid the fixture _chose_ as dead — a small or reused pid, or the CI runner's own process tree" | **REFUTED** — the fixture spawns a real child and SIGKILLs it; no pid is fabricated, and pid _magnitude_ is irrelevant (reproduced at pid 30)                                                                                               |
| "Linux `kill(pid,0)` returns `EPERM` — not `ESRCH` — for a live pid owned by another user"        | **REFUTED as the trigger** — true in general, irrelevant here (same user), and `pidAlive` already maps `EPERM → alive`, which is correct and must stay. The failing branch is the `try` succeeding at `:1701`, never the `catch` at `:1704` |
| "the token/mtime fallback would still break the lock" (brief's open question)                     | **REFUTED** — neither fallback can fire; see _Why no fallback saves it_                                                                                                                                                                     |

## The exact diverging line

`scripts/campaign/bugs.mjs:1701` inside `pidAlive` (`:1696–:1706`):

```js
1700:  try {
1701:    process.kill(pid, 0);      // <- DIVERGES: on Linux this SUCCEEDS for an exited-but-unreaped pid
1702:    return true;
1703:  } catch (e) {
1704:    return e.code === "ESRCH" ? false : true;
1705:  }
```

The false premise is written down twice, as a comment, and it is the _inverse_ of the real
problem: `:1636` — "`process.kill(pid, 0)` reports ESRCH (**which works on win32 too**)" — and
`:5464` — "the owner pid being gone, **which `process.kill(pid, 0)` answers on win32 too**".
Both are correct about win32 and both assume the win32 answer is the conservative one. It is the
opposite: **win32 is the platform that answers correctly here; Linux is the platform that lies.**

Two contributing lines, same root:

- `:5452–:5455` — `awaitExit` is built on the _same_ predicate, inside a synchronous
  `Atomics.wait` busy-poll (`sleepSync`, `:1710`), which structurally cannot reap.
- `:5471` — `awaitExit(victim, 3000)`'s return value is discarded. It returns `false` on Linux
  every time and nothing asserts it, so the fixture proceeds against a live-looking corpse.

The file already contains the missing half of the inference, at `:5518–:5527` (case c2): _"Node
only populates a spawned child's OWN `ChildProcess.exitCode` once this process's event loop gets
a tick to reap it — which the busy-poll pattern above … never yields for."_ The author knew the
child is never reaped; what was not drawn is the POSIX consequence — **unreaped means the pid is
still in the process table, and `kill(pid, 0)` succeeds for it.**

## Measured evidence

### E1 — the platform divergence, isolated (same script, two OSes)

Spawn a child, `SIGKILL` it, busy-wait with `Atomics.wait` (no event-loop tick anywhere), then
ask `process.kill(pid, 0)` — from the parent **and** from a completely separate process, which is
what `acquireLock` does.

Windows 11 / Node v24.14.0 (this host):

```
before kill       : alive(no throw)
parent, 1.5s after: ESRCH   child.exitCode = null      <- never reaped, still reports ESRCH
SEPARATE process  : ESRCH
```

Linux / Node v20.20.2 (`node:20-alpine`, the CI's Node major):

```
before kill       : alive(no throw) | /proc state: S
parent, 1.5s after: alive(no throw) | /proc state: Z | child.exitCode = null
SEPARATE process  : alive(no throw)   <-- this is what acquireLock/pidAlive sees
AFTER an event-loop tick (reaped): ESRCH | /proc state: no /proc entry
```

`child.exitCode` is `null` in **both** runs — non-reaping is identical across platforms. Only the
_answer to the liveness question_ differs. On Windows `uv_kill(pid, 0)` resolves through
`GetExitCodeProcess`, which reports the real status of a terminated process whether or not anyone
waited on it; on Linux the pid stays valid until the parent `waitpid()`s.

### E2 — the five CI failures reproduced verbatim on Linux, first try, deterministic

Ran the branch's real `self-test` in `node:20-alpine` against a sandbox tree assembled from
`git archive 6fb6e7ca .claude/campaign scripts/campaign scripts/team`:

```
  ok   dead holder: it really held the lock when it was killed
  FAIL dead holder: the NEXT waiter succeeds in one invocation             got 1      want 0
  FAIL dead holder: breaking a dead owner's lock is reported, never silent got false  want true
  FAIL dead holder: the write it was blocking actually landed              got "T1"   want "T2"
  FAIL stolen lock: the fixture starts with no lock held                   got true   want false
  ok   stolen lock: the victim really held the lock when it was stolen
  ok   stolen lock: the successor's lockdir SURVIVES the stolen-from writer's exit
  FAIL stolen lock: the stolen-from writer says so on stderr               got false  want true
  ok   stolen lock (exit code): …           (all three c2 checks pass)
  ok   signals / SIGINT / abandoned lock / pid reuse / owner-write failure / give-up / stall seam
```

This is **byte-identical** to the CI log's ok/FAIL sequence (brief, L50–72), including which
neighbours pass. (The same sandbox run also reports 15 unrelated failures — `gitignore`,
`campaign-check`, and a `chmod`-based `rollback` fixture that a root container cannot honour.
Those are artefacts of the sandbox, not of the branch; they are unchanged across every run below
and are excluded from every count.)

**This is not a flake and not contention.** It reproduced on the first attempt on an idle
machine. `LOCK_SPIN_MS` is 10 s (`:1654`) and a genuinely dead owner is detected on the _first_
loop iteration; no amount of wall clock changes an answer that is wrong by construction.

### E3 — the deciding variable, isolated against the real CLI

Same fixture twice, against the unmodified `bugs.mjs`; the **only** difference is whether the
parent lets its event loop turn once (`await once(victim, "exit")`) before the third process runs:

```
=== A · self-test pattern: child NEVER reaped (reap=false) ===
  victim pid 30  /proc state after SIGKILL : Z
  parent's own kill(pid,0) says alive?     : true
  rescued exit code                        : 1        (want 0)
  rescued wall time                        : 10666 ms
  printed "...its owner (pid N) is gone"?  : false    (want true)
  lockdir still present after the attempt? : true
  message: bugs: could not lock …/F01.jsonl within 10000ms — F01.jsonl is held by
           pid 30, which still answers. Retry; if nothing is running…

=== B · identical, but the parent awaits 'exit' (reap=true) ===
  victim pid 63  /proc state after SIGKILL : gone
  parent's own kill(pid,0) says alive?     : false
  rescued exit code                        : 0        (want 0)
  rescued wall time                        : 637 ms
  printed "...its owner (pid N) is gone"?  : true     (want true)
  lockdir still present after the attempt? : false
  message: bugs: breaking the lock on F01.jsonl — its owner (pid 63) is gone —
           a writer was killed mid-write; re-read the file if anything looks wrong
```

The give-up message says _"held by pid 30, which still answers"_ about a pid whose `/proc` state
is `Z`. That single line is the bug, printed by the product.

Note pid **30** — as low as pids get. The hypothesis's "small or reused pid" clause is refuted by
this run: the low pid in variant B behaves correctly the moment it is reaped.

### E4 — a one-predicate change turns all five green and nothing else red

Patched **only my scratch copy** so `pidAlive`'s success branch consults `/proc/<pid>/stat` state
`Z` before returning `true`. Full self-test on Linux: **20 failures → 15** — exactly the five lock
checks, no new ones, whole lock suite green:

```
ok  dead holder: the NEXT waiter succeeds in one invocation
ok  dead holder: breaking a dead owner's lock is reported, never silent
ok  dead holder: the write it was blocking actually landed
ok  stolen lock: the fixture starts with no lock held
ok  stolen lock: the stolen-from writer says so on stderr
ok  live holder: a lock held past the OLD 5s threshold is NOT broken   <- still not robbed
ok  pid reuse: … (all four)                                            <- boot stamp untouched
ok  SIGINT / abandoned lock / owner-write failure / give-up / stall seam
```

That is proof of the cause, not a fix proposal — it shows the predicate is load-bearing and that
correcting it does not disturb the live-holder, boot-stamp, or age-last-resort behaviours.

### E5 — predicate behaviour matrix, measured on Linux as an unprivileged user (uid 1000)

```
A. root-owned LIVE pid 1        : kill(1,0) = ok    | /proc/1/stat state = R
B. own live child               : kill = ok         | state = S
C. own SIGKILLed, unreaped      : kill = ok         | state = Z   <-- the false "alive"
D. pid that never existed       : kill = ESRCH      | state = unreadable(ENOENT)
```

`/proc/<pid>/stat` is world-readable for another user's process on a default Linux — the zombie
check needs no privilege. A never-existing pid is already `ESRCH`, so the `/proc` read never has
to decide that case.

## Per-case mechanism (all five, traced end to end)

Shared state: every case in this suite races over **one** lock path, `lockDir = lockPath("F01")`
(asserted at `:5320`). The victim child's `owner.json` carries `{pid, token, at, bootAt}`
(`:1774–1777`) with a `bootAt` from **this** boot, so the boot-stamp negative proof
(`:1697–1699`) cannot fire.

1. **`dead holder: the NEXT waiter succeeds in one invocation` — got 1, want 0.**
   `holder("B5","20000")` (`:5468`) is a _real_ `bugs.mjs prove` child that wins the lock and
   stalls 20 s inside the critical section. `victim.kill("SIGKILL")` (`:5470`) kills it; on Linux
   it becomes a zombie (`/proc` state `Z`, measured E3) because its parent — the self-test process
   — is the only thing that can reap it and spends the entire suite inside `Atomics.wait`
   (`sleepSync`, `:1710`). `runCli` (`:5472`) starts a **third** process; its `acquireLock` reads
   the victim's `owner.json`, calls `pidAlive(owner.pid, owner.bootAt)` (`:1795`), the `bootAt`
   matches this boot so no mismatch, `process.kill(pid,0)` **succeeds** on the zombie (`:1701`)
   → `alive === true` → `breakWhy` stays `null` (`:1806–1816`) → spins to the 10 s deadline →
   `fail()` at `:1826` → **exit 1**, measured 10,666 ms.

2. **`breaking a dead owner's lock is reported, never silent` — got false, want true.**
   The regexed message is emitted **only** on the `alive === false` branch at `:1809–1810`. With
   `alive === true` it is never printed; the process prints the give-up message from `:1828`
   instead — verbatim _"held by pid 30, which still answers"_ (E3). Directly implied by (1); no
   independent cause.

3. **`the write it was blocking actually landed` — got "T1", want "T2".**
   `fail()` calls `process.exit` before the critical section is ever entered, so `tier B5 T2`
   never runs. `B5.tier` stays at the value `file` seeded (`T1`). Directly implied by (1).

4. **`stolen lock: the fixture starts with no lock held` — got true, want false.**
   **State leakage, not an independent defect.** `fail()` (`:1826–1836`) exits _without_ removing
   the lockdir — deliberately, since it cannot prove the holder is dead. Case (c) at `:5492` is
   the only case in the suite with **no** `rmSync(lockDir, …)` in front of it (c2 has one at
   `:5515`, (d)/(e)/(f) at `:5580`/`:5652`/`:5761` — which is precisely why every one of those
   passes in the same red run). So (c) inherits the victim's lockdir, still carrying the zombie's
   `owner.json`.

5. **`stolen lock: the stolen-from writer says so on stderr` — got false, want true.**
   **Also state leakage, one further hop.** `holder("B6","3000")` (`:5495`) starts against the
   inherited lockdir. Its `pidAlive` sees the same zombie → `alive === true` → it spins 10 s and
   `fail()`s, so it **never writes its own `owner.json`** and never reaches `releaseLock`'s
   identity check (`:1848–:1861`). The message it is supposed to print — _"our lock on F01.jsonl
   was broken by another process"_ — is reachable only from that path, so stderr stays empty.
   The two neighbouring checks that **pass** pass for the wrong reason, which is the tell:
   - `the victim really held the lock when it was stolen` (`:5504`) — `awaitHold()` (`:5448`)
     returns instantly because the **dead** victim's stale `owner.json` is still on disk.
   - `the successor's lockdir SURVIVES the stolen-from writer's exit` (`:5505`) — the lockdir
     survives because nobody ever legitimately held or released it.

   Confirmed as consequence, not coincidence, by E4: fixing only the predicate turns both 4 and 5
   green with no change to case (c) itself.

**Why case (c2) passes and (c) does not** — the brief's open question. Two independent reasons,
both verified: `rmSync(lockDir, …)` at `:5515` clears the poisoned lockdir before c2 runs, and c2
uses `spawnSync` (which really does block until the child exits and reports its status) instead
of the `awaitExit` busy-poll. c2's own comment (`:5518–:5527`) is a written record that the author
had already noticed the busy-poll cannot reap.

## Why no fallback saves it (the brief's other open question)

- **`bootAt` mismatch** (`:1797–1801`, `:1808`) — cannot fire: the victim wrote `bootStamp()` on
  this boot; `|Δ|` is well inside `BOOT_STAMP_SLOP_MS` (5 s). This is also _why_ the `pid reuse`
  case passes on Linux while the dead-holder case fails: it forges an ancient `bootAt`, so it
  never reaches `process.kill` at all.
- **Age / `LOCK_ABANDON_MS`** (`:1811–1816`) — cannot fire: it is gated on `alive === null`, i.e.
  _no readable `owner.json`_. The victim's `owner.json` is perfectly readable. And 120 s is far
  past the 10 s spin anyway.
- **`token` / `mtime`** — there is no token or mtime fallback in the break path. `token` is used
  only by `releaseLock`'s identity check (`:1852`); `mtime` feeds only the `alive === null` age
  rule above.
- **A longer `LOCK_SPIN_MS`** — measured useless: the zombie persists for as long as the parent
  stays blocked, which is the whole suite. Raising the timeout only lengthens the red run.

## Fix-shape FACTS

**What the liveness predicate must be, for both platforms**

- **F1.** It must return `false` for a process that has exited but has not been reaped. On Linux
  the only in-process evidence of that is `/proc/<pid>/stat` field 3 (or `/proc/<pid>/status`
  `State:`) equal to `Z`; `kill(pid, 0)` cannot see it (E1, E5-C).
- **F2.** The zombie test may only ever turn a `true` into a `false`, never the reverse — the same
  structural rule the `bootAt` stamp already follows ("only ever proves a NEGATIVE", `:1685–1690`).
  An absent or unreadable `/proc` entry must be read as _"cannot tell — assume alive"_, never as
  dead. A pid that never existed is already covered by `ESRCH` (E5-D), so nothing is lost.
- **F3.** No privilege is required: `/proc/<pid>/stat` for a root-owned process is readable by an
  unprivileged uid on a default Linux (E5-A). A `hidepid`-restricted `/proc` must degrade to
  "alive", per F2.
- **F4.** `EPERM` must keep meaning **alive** (`:1704`'s `? false : true`). It is correct, it was
  never the trigger, and inverting it would break the live-holder guarantee.
- **F5.** win32 needs nothing added and nothing removed: `process.kill(pid, 0)` already answers
  `ESRCH` for a killed-but-unreaped child, from the parent and from an unrelated process (E1). Any
  `/proc` read there throws `ENOENT` and must be swallowed as "not a zombie" (F2).
- **F6. Untested gap, flag it:** macOS has no `/proc`. A POSIX zombie is visible there only via
  `ps -o state= -p <pid>` (state `Z`). Not verified in this pass; the project's matrix is
  ubuntu-latest CI + local Windows, so it is a correctness question, not a CI-green question.
- **F7.** The `bootAt` negative proof (`:1697–1699`, `:1797–1801`) must stay exactly as it is — it
  is the sole mechanism behind the four green `pid reuse` checks and is orthogonal to this defect
  (green before and after E4).

**What the fixture must do to create a guaranteed-dead holder on both platforms**

- **F8.** It must guarantee the killed holder is **reaped** — or is not this process's child —
  before the SUT's liveness check runs. Awaiting the victim's `'exit'` event (one event-loop turn)
  is sufficient and was measured to flip all three dead-holder assertions (E3-B: exit 0, break
  message printed, 637 ms). No synchronous call in this file can substitute: libuv reaps in
  `uv__chld` off the loop's signal pipe, and `execSync`/`spawnSync` run a _separate_ uv loop whose
  `uv__chld` only `waitpid()`s that loop's own process handles — so the main loop's children stay
  zombies through every `execSync` in the suite. Reparenting the holder to init (spawn a
  short-lived intermediate that spawns the holder and exits) is the alternative, but it depends on
  the environment's PID 1 actually reaping; not verified here.
- **F9.** `awaitExit`'s return value must be asserted, not discarded (`:5471`, `:5501`, `:5619`).
  On Linux it currently returns `false` in every case and nothing notices — that silence is what
  let the fixture proceed against a corpse and let three checks pass for the wrong reason.
- **F10.** Case (c) must not inherit the previous case's lockdir. It is the only case in the suite
  with no `rmSync(lockDir, …)` ahead of it (compare `:5515`, `:5580`, `:5652`, `:5761`), and
  `fail()` (`:1826`) deliberately leaves the lockdir behind, so a red predecessor always poisons
  it. Independently of the predicate fix, a _fixture-local_ precondition failure must not be able
  to cascade into two more failures in a different case.
- **F11.** Do not fix this by reaping alone. A fixture-only change makes the suite green while the
  product predicate stays wrong: in the field a real holder killed while its parent (a hook, an
  orchestrator) is blocked synchronously is a zombie on Linux, and the lock is unbreakable until
  something reaps it. The predicate and the fixture are two separate defects with one shared root.

**What must not change**

- Lock **order** — catalogue → shard, one-way, no cycle (`withCatalogueLock`, `:1880`-area
  comment). Nothing in this defect touches it.
- **Release only your own** — `releaseLock`'s token identity check (`:1848–:1861`) and its refusal
  to `rm` a successor's lockdir. Case c2 proves it and is green today; it must stay green.
- **Break on liveness, never on age** — `LOCK_ABANDON_MS` (`:1660`) stays a last resort for a
  lockdir with _no readable owner.json_ only. Both `live holder: a lock held past the OLD 5s
threshold is NOT broken` and `abandoned lock: … reported as a LAST RESORT` stayed green under
  E4's patched predicate; any fix must keep both.
- **`LOCK_SPIN_MS = 10000`** must not be raised as the remedy (measured useless — see above).
- The `BUGS_SELF_TEST` / `BUGS_TEST_STALL_MS` gating of the test seams (`:1766`-area) — unrelated
  and green (`stall seam` checks).

## Repro design that fails on Linux deterministically

Three tiers, sharpest last. All three are red on Linux today and green on Windows today; the fix
must make all three green on **both**. None depends on wall clock, load, or pid values.

**R1 — end-to-end (what CI runs).** Reproduced first try, 5/5 identical failures in identical
order:

```bash
git archive 6fb6e7ca .claude/campaign scripts/campaign scripts/team | tar -x -C sandbox/
docker run --rm -v "<abs>/sandbox:/repo:ro" -w /repo node:20-alpine sh -c '
  apk add --no-cache git &&
  git config --global user.email t@t.local && git config --global user.name t &&
  cp -r /repo /tmp/r && cd /tmp/r && git init -q && git add -A && git commit -qm seed &&
  node scripts/campaign/bugs.mjs self-test'
```

Diagnostic, not a gate: the sandbox lacks `.gitignore` and `scripts/campaign-check*`, so 15
unrelated checks are red in it regardless. The lock suite needs none of those.

**R2 — the predicate bar (the regression test the fix owes).** Platform-independent, no CLI, no
lock, ~1 s, zero flake surface:

> Spawn any child, `SIGKILL` it, **do not let the event loop turn**, then assert
> `pidAlive(child.pid) === false`.

Today: `true` on Linux (E1, E5-C), `false` on Windows (E1). The zombie persists for exactly as
long as the parent stays blocked, so this is deterministic by construction — there is no window to
widen and no timeout to tune. Pair it with a _negative_ control in the same check so F2 cannot be
satisfied by over-eagerness: a live child must still read `true`, and a live unrelated pid (ideally
one owned by another user) must still read `true`.

**R3 — the integration bar (product-level, third process, no reap allowed).** This is the sharpest
because it exercises the SUT exactly as CI does _and_ stands for the real-world case:

> `file` a bug into a throwaway `BUGS_ROOT`; spawn a real `bugs.mjs prove` holder with
> `BUGS_TEST_STALL_MS`; `awaitHold()`; `SIGKILL` it; **without reaping it**, run
> `bugs.mjs tier <id> T2` in a separate process and assert: exit code `0`, stderr matches
> `/breaking the lock on F01\.jsonl — its owner \(pid \d+\) is gone/`, the tier landed as `T2`,
> and the lockdir is gone.

Measured today (E3-A): exit 1 after 10,666 ms, no break message, tier `T1`, lockdir still present,
give-up text _"held by pid 30, which still answers"_ about a pid in state `Z`. The
**no-reap** clause is load-bearing: reaping is what a corrected _fixture_ would do, and a repro
that reaps would go green on a fixture-only change while the product predicate stayed wrong (F11).

**Bonus signal a fix should show.** The unpatched Linux run burns roughly 53 s of pure waiting in
this suite (3 s + 10 s + 15 s + 10 s + 15 s across `awaitExit`/spin), all of it on a predicate that
never changes its mind. The E4-patched full self-test completed in `1m23s` real.
