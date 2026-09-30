# Opus refute-first RE-CHECK — pid-reuse self-test lock-liveness fix (`1245bb07` on `0b715128`)

Read-only. Evidence from `git diff 0b715128..1245bb07 -- scripts/campaign/bugs.mjs` and
`git show 1245bb07:scripts/campaign/bugs.mjs` (7,908 lines, extracted to a scratchpad temp file;
all `bugs.mjs` line numbers below are **as committed at `1245bb07`**). No command was run against
the working tree; the self-test was not executed.

## VERDICT: **HOLDS** — push is not blocked.

The ruling's cause survives every refutation I could construct from the code. R1 is a genuine
root-cause elimination (not a re-assertion), R2's fold is non-vacuous against a real single-line
lock-code mutation, and R3/R4 close the cascade. Four findings, all LOW/INFO, none blocking; three
are one-liners a later diff can absorb.

---

## Q1 — Cause: is the value collision the ONLY code-consistent explanation? **CONFIRMED (with one named, non-code residual)**

The observed CI state is a conjunction, not one symptom: exit **1**, **no** `breaking the lock…`
line anywhere in the child's output, and a `runCli` wall time of **10.062 s** ≈ `LOCK_SPIN_MS`
(`bugs.mjs:1700`). For that, `breakWhy` (`bugs.mjs:1874–1882`) must have stayed falsy on **every**
iteration of a ~500-iteration, 20 ms-step loop (`bugs.mjs:1908`) — a _stable_ condition, not a
transient one. Enumerating every code path that keeps `breakWhy` falsy:

| Path                                                                                                                                                                                                                                                                         | Reachable?                                       | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(A) `alive === true`** — `pidAlive` (`bugs.mjs:1764–1775`) skips its boot short-circuit because the forged/real gap is ≤ 5000 ms, then `process.kill(pid,0)` succeeds on the live impostor                                                                                 | yes                                              | **the ruling's collision.** `bootStamp() = Date.now() − uptime()*1000` (`:1732`) is near-constant within a 10 s window (both terms advance together; `os.uptime()` resolution ≤ 1 s), so once inside the slop it _stays_ inside — the only enumerated path that is stable for a full spin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **(A′) EPERM from `process.kill(pid,0)`** → `catch` returns `true` (`:1772–1774`)                                                                                                                                                                                            | only _after_ the boot short-circuit is skipped   | **not an independent explanation.** It is strictly downstream of the same collision — the `ownerBootAt` test at `:1766` returns `false` _before_ `process.kill` is ever called. It is also impossible in fact: the impostor is a same-user child. **R1 neutralises it** for free — with a 1-year gap `pidAlive` returns `false` without reaching `process.kill`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **(A″) POSIX zombie** → `zombieOnLinux` (`:1747–1758`) makes `alive === false`                                                                                                                                                                                               | only after the collision skips the short-circuit | **REFUTED by the log.** `alive === false` with the gap _inside_ the slop ⇒ `bootMismatch` false (`:1864–1867`) ⇒ the `else if (alive === false)` branch (`:1877`) fires ⇒ the lock **is** broken, exit **0**. CI observed exit 1. Also unreachable post-R1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **(B) `owner === null`** — `readLockOwner` (`:1713–1720`) fails ⇒ `alive === null` ⇒ the age branch (`:1879`) needs `age > 120000`, but `age` is `now − statSync(lockDir).mtimeMs` on a dir the fixture created seconds earlier ⇒ no break ⇒ spin out, exit 1, no break line | mechanically yes                                 | **the one surviving alternative, and R1 does NOT neutralise it.** But it is _not code-consistent_: `owner.json` is written synchronously by the parent before `runCli`, is never rewritten (the CLI child never wins the `mkdir`), and nothing deletes it — a read failure would have to be permanent (a filesystem/AV fault), not a race, to hold across 500 reads. It is also excluded on the evidence: check (1) `pidAlive(impostor.pid) === true` **passed**, proving the JSON was well-formed with a positive-integer pid. Finally, (B) would print a _different_ give-up tail (`…another bugs.mjs process… carries no owner stamp and will be broken automatically once it is 120s old`, `:1896–1906`) — which the CI log could not show because the child's stderr was never printed. **R3's new `console.error(out.slice(-1200))` is exactly the instrument that discriminates (A) from (B) if it ever recurs** — a real, unclaimed benefit of the fix. |
| **(C) `owner.pid` not a positive integer** ⇒ `pidAlive → null` ⇒ same as (B)                                                                                                                                                                                                 | yes                                              | **REFUTED**: check (1) returned `true`, which requires `Number.isInteger(pid) && pid > 0` (`:1765`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **(D) `age === null` (statSync threw)**                                                                                                                                                                                                                                      | yes                                              | irrelevant — the age branch also requires `alive === null`; subsumed by (B)/(C).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **(E) `mkdirSync` throwing non-EEXIST** (`:1857`)                                                                                                                                                                                                                            | yes                                              | **REFUTED by timing**: it rethrows immediately; the child would exit in milliseconds, not 10.062 s.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

**Conclusion:** the value collision is the only _code-consistent_ explanation, and the only one
stable enough to hold for a full `LOCK_SPIN_MS`. (B) is the sole residual and is a hardware/OS
fault story, not a code story; R1 does not eliminate it, but R3 now diagnoses it from one line of
CI log. The `at` field plays no part (see Q2).

---

## Q2 — R1: can the forged `bootAt` ever fall inside the slop? Can the age path now fire first? **CONFIRMED / REFUTED (the concern does not materialise)**

`bugs.mjs:5780` — `const forgedBoot = bootStamp() - 365 * 24 * 3600_000;`

1. **Never inside the slop, for any uptime.** The old value was _absolute_ (`Date.now() − 20 min`),
   so its distance from `bootStamp()` was `|20 min − uptime|` — a function of the machine. The new
   value is _relative to the same reference the checker uses_: the child computes the distance
   between `forgedBoot` and its own `bootStamp()` (`:1766`, `:1867`), and the two boot stamps agree
   to within clock/`os.uptime()`-resolution jitter (≤ ~1 s), so the distance is
   **31,536,000,000 ms ± ~1 s** on every machine at every uptime. Always `> 5000`. `uptime` cancels.
2. **Still the intended branch.** `pidAlive(pid, forgedBoot)` short-circuits `false` at `:1766–1767`
   _without_ calling `process.kill`; in `acquireLock`, `alive === false` **and** `typeof bootAt ===
"number"` **and** gap > slop ⇒ `bootMismatch === true` (`:1864–1867`) ⇒ the **first** branch
   (`:1875–1876`, `"predates this boot"`). Not `"is gone"` (that needs `bootMismatch` false), not
   the age branch. The pid-reuse _premise_ is still proved by check (1) — `pidAlive(impostor.pid)`
   with **no** bootAt returns `true`, i.e. signal-0 alone would refuse to break the lock.
3. **The `at` field cannot pre-empt it — three independent reasons.** (i) `owner.at` is **never
   read**: a grep over the whole committed file finds no reader; `acquireLock` writes it (`:1840`)
   and nothing consumes it. (ii) `age` is derived from `statSync(p).mtimeMs` (`:1870`) — the
   lockdir's own mtime, seconds old — not from `at`. (iii) Even a 1-year-old `age` could not fire
   first: the age branch is **third** in the `if/else if` chain (`:1879`) _and_ is gated on
   `alive === null`, which a readable owner.json makes impossible. The fixer keeping
   `at: Date.now() - LOCK_ABANDON_MS * 10` unchanged (`:5786`, per the ruling) is therefore inert —
   correct, though it now reads as vestigial.

---

## Q3 — R2: do the regexes match the exact `breakWhy` strings? **CONFIRMED**

The three `breakWhy` strings, verbatim (`bugs.mjs:1876`, `:1878`, `:1881–1882`), printed as
`bugs: breaking the lock on ${name} — ${breakWhy}; re-read the file if anything looks wrong`
(`:1884–1887`):

1. `its owner (pid ${owner.pid}) predates this boot — it cannot possibly still be that process`
2. `its owner (pid ${owner.pid}) is gone — a writer was killed mid-write`
3. `LAST RESORT: it is ${Math.round(age / 1000)}s old and carries no readable owner.json, so its holder cannot be verified either way`

- `verdict: /predates this boot/` (`:5814`) — matches (1) exactly, and only (1). Confirmed.
- `ageBased: /age|abandon|last resort/i` (`:5815`) — **cannot be false when the age path was taken**:
  string (3) opens with the literal `LAST RESORT`, matched case-insensitively. The wording never
  uses "age" or "abandon", but `last resort` alone is sufficient and is not template-interpolated,
  so it cannot drift out from under the regex without the string itself changing. Confirmed.
- **False-positive direction** (checked, currently clean): `runCli` merges stderr via `2>&1`
  (`:2846`), so `out` on the success path is the break line plus `cmds.tier`'s
  `${id}: ${batch} row updated → tier ${tier} (was ${row.tier})` (`:2764`). Neither contains
  `age`, `abandon` or `last resort`. See **F-1** for the residual fragility of the bare `age`
  alternative.

**Single-line lock-code mutation that turns this check red** (the non-vacuity proof R2 owes):
change `bugs.mjs:1875` from `if (bootMismatch)` to `if (false)`. `breakWhy` then falls to
`else if (alive === false)` (`:1877`) → the lock is _still_ broken, the write still lands, the CLI
**still exits 0** — so the pre-fix `code === 0` check and check (3) both stay green — but the printed
reason becomes `"is gone"`, so `verdict: false` and the folded check goes **red**. A second
one-liner with the same property: delete the boot short-circuit at `:1766–1767`, and the waiter
spins out (`code: 1, verdict: false`). Both confirm the fold is not a tautology, and that it
catches a reason-swap regression an exit-code-only assertion provably cannot.

---

## Q4 — R3/R4: `finally` cleanup and cross-fixture coupling. **CONFIRMED**

`bugs.mjs:5769–5803` (pid-reuse) and `:5860–5866` (owner-write precondition).

- **Impostor killed and awaited on every path, including a throw.** `mkdirSync`, `writeFileSync`,
  `pidAlive` and `runCli` are all inside the `try` (`:5770–5791`); the `finally` (`:5792–5803`)
  runs whatever happens. `spawn` is deliberately _outside_ the try — correct, since a `spawn` throw
  leaves nothing to clean.
- **Ordering is right**: `process.kill` → `awaitExit(impostor)` → `rmSync(lockDir)` (`:5796–5802`).
  `rmSync` after the kill, per R4. (Materially the impostor never holds a handle on `lockDir` — it
  is `node -e setTimeout`, `stdio:"ignore"`, cwd inherited from the repo root, not `tmp` — so no
  Windows EBUSY-from-the-impostor path exists.)
- **No leaked process.** `awaitExit` (`:5528–5531`) is in scope at `:5801` — verified: there is
  **no** block-closing brace at indent ≤ 5 anywhere between `5531` and `5790`, so both live in the
  same fixture block. On Linux the killed impostor is a zombie the synchronous suite never reaps,
  and `awaitExit`'s `pidAlive` returns `false` via `zombieOnLinux` (`:1747–1758`) — i.e. R4
  correctly reuses the L-070 guard rather than re-inventing it. On Windows libuv's `uv_kill` checks
  the exit status, so signal-0 answers ESRCH once terminated. Bounded at 15 s either way; the
  return value is discarded, so a worst case is a delay, never a failure.
- **Nothing left in `lockDir` for fixture (g).** Double-guarded: the `finally`'s `rmSync` (`:5802`)
  _and_ (g)'s own `rmSync` (`:5862`).
- **(g)'s `rmSync` is BEFORE its precondition check.** `:5862` `rmSync(lockDir, …)`, then `:5863–5867`
  `check("owner-write failure: no lock exists before the fixture runs", existsSync(lockDir), false)`.
  It sits after the `ownerWriteFailure` closure declaration, which is inert. The check remains
  non-vacuous: deleting `acquireLock`'s `catch (writeErr)` cleanup (`:1841–1854`) still turns
  `"the lockdir it just created is cleaned up"` (`:5873–5877`) red.
- **New cross-fixture coupling: none.** The only scope change is `const` → `let pidReuseCheck,
rescuedFromReuse` hoisted to the block (`:5769`); grep confirms both names appear **only** at
  `:5769, 5790, 5791, 5807, 5813–5815, 5822` — no shadowing, no later reuse. `forgedBoot` is
  block-`const` inside the `try`. No env var and no shared mutable state added. Coupling was
  **removed** (the shared-`lockDir` residue), not added.
- **Throw-safety of the `check` calls.** `runCli` cannot throw for a non-zero exit — `execSync`
  failure is caught and returned as `{code, out}` (`:2861–2863`). If it threw for some other reason,
  the exception propagates _past_ the `finally` and aborts the suite loudly before any `check` reads
  `rescuedFromReuse` — so the `let`-undefined window can never produce a misleading `got undefined`.

---

## Q5 — the unexplained "3 FAILURE(S)" first run: a real race? **REFUTED as a race introduced by this diff — does NOT block**

`fix-report.md:275–290` reports one 3-failure run whose per-check output was not captured, followed
by **8** clean runs. From the code:

- **Leftover state from a previous aborted run is impossible.** The lock-fixture block gets a fresh
  `mkdtempSync(join(tmpdir(), "bugs-self-test-"))` root at `bugs.mjs:5370`, so no prior run's
  `lockDir`, shard or impostor can be inherited. Refuted.
- **A pid-reuse failure for the CI reason is impossible.** Post-R1 the boot gap is a fixed 1 year
  (Q2), so the collision cannot recur on any platform or uptime. One arithmetic coincidence is
  worth stating explicitly: the pid-reuse group is now **exactly 3 checks** (`:5805–5827`), and R4
  removed its cascade into (g) — so "3 failures" _is_ the post-fix signature of a pid-reuse
  give-up. It is nevertheless unreachable, and the fixer reports those three lines as `ok` in all
  8 captured runs.
- **The load-sensitive candidates are all pre-existing and untouched by this diff**: the "live
  holder" fixture races a 6,000 ms deliberate stall against the waiter's 10,000 ms `LOCK_SPIN_MS`
  budget plus two `node` cold starts (`:5493–5518`); `awaitHold` polls a 10 s budget (`:5525–5526`);
  the `race()` fixtures use fixed `delay`s. On a Windows box under load (the fixer was running
  prettier, git and a merge chain in the same window) any of these can slip. None is in the diff.
- **`awaitExit` timing is not a new failure source** — its return value is discarded at `:5801`.
- **The one genuinely NEW Windows exposure is `rmSync` faulting, not a check failing.** The diff adds
  two `rmSync(lockDir, {recursive:true, force:true})` calls (`:5802`, `:5862`) with `maxRetries`
  defaulted to 0. On Windows a transient AV/indexer handle on the freshly-written `owner.json`
  makes `rmSync` **throw** EPERM/EBUSY. That would abort the suite with a stack trace and, from the
  `finally`, would _mask_ the original exception — it would not print `3 FAILURE(S)`. So it does not
  explain the observed run, and the identical pre-existing `rmSync` at `:5765` has been green for
  the file's life. See **F-2** for the one-line hardening.

**Conclusion:** the 3-failure run is unattributed because the output was not captured, but no
mechanism introduced by this diff can produce it, and the mechanism the diff _removes_ is provably
gone. It indicates a pre-existing load-sensitivity in the earlier lock fixtures plus a harness that
cannot name its own failing checks from a `tail`. Not a blocker; see **F-3**.

---

## Q6 — Unrelated hunks. **CONFIRMED — none**

`git diff 0b715128..1245bb07 -- scripts/campaign/bugs.mjs` is **two hunks**, both inside
`cmds["self-test"]`: `@@ -5766,36 +5766,60 @@` (R1 + R2 + R3 + R4's `finally`) and
`@@ -5831,6 +5855,9 @@` (R4's owner-write `rmSync`). **Zero** lines touched in `acquireLock`
(`:1817–1911`), `pidAlive` (`:1764–1775`), `bootStamp`/`BOOT_STAMP_SLOP_MS` (`:1732–1736`),
`LOCK_SPIN_MS`/`LOCK_STEP_MS`/`LOCK_ABANDON_MS` (`:1700–1706`), `readLockOwner`, `releaseLock`, or
`withLock`. Every line in both hunks maps to R1–R4; **no unattributable hunk**.

The commit's other 10 files are R5/R6 bookkeeping and this pipeline directory, and they match the
ruling: `LESSONS.md` +L-082 / −L-045 (40 active, 40,493 B < the 40,960 cap), `ARCHIVE.md` +L-045
with a dated note, `lessons/_meta.json` `nextId 81→83`, `archivedCount 36→37`, `activeCount 40`;
`code-map/_meta.json` `mappedSha 2673103e→0b715128` + `generatedAt` + replaced `notes`, one
`INDEX.md` clause, one `CHANGELOG.md` bullet. See **F-4** on `nextId`.

---

## Q7 — L-082 text. **CONFIRMED**

- **Lesson line is generalizable.** Two transferable rules, neither an incident diary: _never forge
  a timestamp relative to "now" by a plausible machine uptime — forge it relative to the real boot
  stamp, far outside any slop_, and _give every fixture its own setup and cleanup so a give-up
  cannot cascade into unrelated checks_. The first generalises past locks to any fixture forging a
  value that a slop window compares against a machine-derived reference; the second is a plain
  fixture-isolation rule. Both are stated as rules, not as what happened.
- **Guard line is true of the code as committed**, clause by clause: `bootAt = bootStamp() − 1 year`
  → `bugs.mjs:5780`; _asserts the "predates this boot" verdict_ → `:5814`; _the owner-write fixture
  clears the lock dir before its own precondition_ → `:5862` immediately preceding `:5863`;
  _step 6 of `npm run verify`_ → `package.json:13`, whose chain is validate-lock-edges (1),
  validate-lessons (2), scan-signatures --self-test (3), scan-signatures (4), turbo (5),
  **`bugs.mjs self-test` (6)**, campaign-check (7). No client identifier anywhere in the entry.

---

## Findings

**F-1 · LOW · `ageBased`'s bare `age` alternative is a substring match with no word boundary.**
`bugs.mjs:5815` — `/age|abandon|last resort/i` matches inside `message`, `usage`, `manage`,
`package`, `storage`, `stage`. Today's output is clean (Q3), but `cmds.tier`'s own usage line
(`:2723`) contains **`usage:`**, so any future argument-shape change to `tier` would flip
`ageBased: true` and mis-describe the failure as age-based when it is an arg error.
_Refutation attempted:_ the only strings on the success path are the break line and
`"B1: F01 row updated → tier T1 (was T2)"` — verified neither matches; and the failure direction is
a **false RED with a misleading label**, never a false green, so it cannot hide a regression.
_Failure scenario:_ someone renames a `tier` flag; the self-test goes red reporting an age-based
break that never happened, and the next reader chases `acquireLock` instead of the arg parser.
_One-line fix:_ `ageBased: /last resort|abandon/i.test(rescuedFromReuse.out)` — drop the bare `age`;
`LAST RESORT` alone already covers every wording the age branch can print (Q3).

**F-2 · LOW · the two new `rmSync(lockDir, …)` calls have no Windows retry, and the `finally` one can mask a real error.**
`bugs.mjs:5802` (inside `finally`) and `:5862`. `fs.rmSync` defaults `maxRetries: 0`, so a transient
Windows EPERM/EBUSY (AV/indexer on the just-written `owner.json`) throws; from a `finally` it
_replaces_ the exception the `try` was propagating.
_Refutation attempted:_ the impostor holds no handle on `lockDir`, the CLI child has exited, and the
identical pre-existing `rmSync` at `:5765` has never been observed to fault — so this is hardening,
not a regression the diff introduces.
_Failure scenario:_ a loaded Windows host aborts the whole self-test with a cleanup EPERM whose
stack points at the `finally`, hiding the fixture error that actually mattered.
_One-line fix:_ `rmSync(lockDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })`
at both sites (and, optionally, wrap the `finally`'s call in `try {} catch {}` as `acquireLock:1848`
already does).

**F-3 · LOW · the self-test's failure output is not durably captured, which is why the "3 FAILURE(S)" run is unattributable.**
`check` (`bugs.mjs:2908–2914`) prints `FAIL` lines interleaved with hundreds of later `ok` lines and
a bare count at the end, so a `tail -N` after a mid-suite failure shows nothing useful — exactly what
happened at `fix-report.md:277–279`.
_Refutation attempted:_ not a correctness defect; the CI log does show every line, and R3 already
adds the one diagnostic the CI failure specifically lacked.
_Failure scenario:_ the next local red is again unattributable and gets dismissed as a hiccup.
_One-line fix (process, not code):_ run the gate as
`node scripts/campaign/bugs.mjs self-test 2>&1 | tee <scratchpad>/self-test.log` and grep `^  FAIL`.
Follow-up candidate: have the suite re-print the collected FAIL names above the summary count.

**F-4 · INFO · `nextId` jumps 81 → 83 with no L-081 anywhere.**
`.claude/lessons/_meta.json`; `L-081` is present in neither `LESSONS.md` nor `ARCHIVE.md`. This
matches the ruling's R5 verbatim ("nextId 83"), so it reads as a deliberate reservation for the
concurrent `rf-F09` engine, not an error — flagged only so the landing coordinator expects a
`_meta.json` conflict if `rf-F09` lands its own L-081 and re-bumps `nextId`. `validate-lessons.mjs`
passed (`fix-report.md`, gate 4), so the gap is tolerated by the validator. Headroom is thin:
40,493 of 40,960 bytes and 40 of 40 entries — the next lesson must archive one.

**Not a finding, recorded:** `:5797` uses `process.kill(impostor.pid)` where the pre-fix code used
`impostor.kill()`. Node's `ChildProcess.kill()` signals through the retained process handle and is a
no-op once the child is gone, whereas `process.kill(pid)` signals whatever holds that pid _now_ —
mildly ironic in a fixture about pid reuse. The window is closed in practice (the impostor's own
`setTimeout` is 15,000 ms; the `finally` runs at most ~11 s after `spawn`, bounded by
`LOCK_SPIN_MS` + spawn overhead), and the fixer followed the ruling's literal text. If the block is
ever touched again, prefer `impostor.kill()`.
