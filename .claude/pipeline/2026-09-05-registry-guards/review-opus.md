# Opus review — Registry guards (R9 `sync --check`, R10 `move --tier`)

**Verdict: FIX-THEN-SHIP** — 2 major, 4 minor, 6 nits, 0 blockers.

Scope: `git diff d12203a3...HEAD -- scripts/campaign/bugs.mjs .claude/skills/bug-registry/SKILL.md
.claude/code-map/{INDEX.md,_meta.json,CHANGELOG.md}` at `c2de0712` (worktree `rf-registry`,
branch `feat/registry-guards`). Working tree clean. Method: refute-first; every finding below
survived an attempt to read it away in the surrounding code, and every empirical claim was
produced by a read-only probe (no file in the repo was modified by this review).

The core of the change is **right**. In particular the one deliberate deviation from the build
plan — comparing `renderFront(next)` instead of `JSON.stringify(next)` — is not a defect but a
**necessary correction to the plan**, and I proved it: see Q1. The two majors are a vacuity hole
in the real-tree guard and a documented flag that is silently dropped.

---

## Findings

### F1 · major · `scripts/campaign/bugs.mjs:6996-7014` (T13b) + `:1481-1501` (`--check`)

**Claim.** T13b — the pre-push guard, the whole point of R9 — passes **vacuously** when `bugs.mjs`
is invoked from anywhere other than the repo root, and nothing in the `--check` output would ever
reveal it.

`runCli` (`bugs.mjs:2823-2843`) passes **no `cwd`** to `execSync`, so the child inherits the
parent's cwd. `rootDir()` (`bugs.mjs:117`) is the cwd-relative literal `.claude/campaign`. When it
does not resolve, `readCatalogue()` (`bugs.mjs:151-157`) returns `[]`, the `--check` loop
(`bugs.mjs:1482-1494`) iterates nothing, `stale.length` is 0, and it prints
`sync --check: records mirror the ledger` and exits 0. The test plan explicitly specified
`cwd = the repo root (REPO_ROOT constant at the top of bugs.mjs)` (test-plan.md:10) —
`REPO_ROOT` (`bugs.mjs:111`) is referenced by neither the test nor `--check`.

**Refutation attempted, and why it failed.** I first tried to kill this as theoretical: the pre-push
hook (`.husky/pre-push`) and CI (`.github/workflows/ci.yml:255`, no `working-directory`) both run
`npm run verify` (`package.json:13`) from the repo root, where npm sets cwd to the package dir. That
holds today — so the guard is not _broken_. It does not refute _vacuity_, which I then reproduced:

```
$ cd apps/api && node ../../scripts/campaign/bugs.mjs sync --check
sync --check: records mirror the ledger
exit=0            # 213 real records never examined
```

**Failure scenario.** `verify` is ever moved under turbo or a workspace, or someone runs
`npm run bugs:self-test` from a package directory, or the self-test is lifted into a per-workspace
lane. From that moment the mirror guard is a permanent green no-op, the #612/#617/#618 drift class
ships again, and the gate reports success — the exact failure mode the run exists to prevent.

**Fix (one line each, do not implement).** Make `--check` print what it compared —
`sync --check: ${catalogue.length} record(s) mirror the ledger` — and have T13b assert the count is
≥ 1; or pass `cwd: REPO_ROOT` in `runCli` when `root` is `undefined`.

---

### F2 · major · `scripts/campaign/bugs.mjs:7160, 7167-7229` + `SKILL.md` (new `move --tier` block)

**Claim.** The triage path **silently discards `--why`** — the flag SKILL.md's own worked example
tells the operator to pass.

`const why = flag(args, "why")` is read at `bugs.mjs:7160`, and the triage branch
(`bugs.mjs:7167-7229`) never references it again. The History detail is the hard-coded
`` `assigned to ${to}` `` (`bugs.mjs:7217`) and the console line is
`` `move: ${id} -> ${to} (first ledger row, tier ${tier})` `` (`bugs.mjs:7226`). The new usage
string (`bugs.mjs:7161-7162`) advertises `[--why "<reason>"]` on both paths, and the SKILL.md block
added by this diff documents:

```bash
npm run bugs -- move B213 --to F32 --tier T1 --why "triage id promoted into the hotfix shard"
```

**Refutation attempted, and why it failed.** I looked for the reason landing somewhere else — a
front-matter field, a second event, the console output. Nothing writes it. I then checked whether
`flag()` refuses an unconsumed flag: it does not (`bugs.mjs:192-204` only validates that the value
is present and not flag-shaped). So the text is accepted, ignored, and no diagnostic is printed.
The re-home path _does_ use it (`bugs.mjs:7297-7302, 7305`), which is what makes the asymmetry a
defect rather than a design.

**Failure scenario.** The run's own close-out (build-plan.md:37) triages B213 into F32. An operator
following SKILL.md records why, exit 0, and the record's History says only "assigned to F32" — the
provenance this registry exists to keep, gone silently. Worse for the next reader: the re-home
event _does_ carry its `--why`, so the History is inconsistent about whether reasons are recorded.

**Fix.** ``appendEvent(rec.body, `batch-${to}`, "batched", `assigned to ${to}${why ? ` — ${why}` : ""}`)``
and echo it on the console line, mirroring `bugs.mjs:7297-7302`.

---

### F3 · minor · `scripts/campaign/bugs.mjs:1493` vs `:1119-1122, 1556`

**Claim.** `--check` compares only the **front-matter half** of what `writeRecord` emits, so a
body-only write that a real `sync` would perform is invisible to the guard.

`writeRecord` writes `renderFront(front) + refreshHeaderLine(body, front)` (`bugs.mjs:1119-1122`).
The write path fires on `body !== before || JSON.stringify(nextFront) !== JSON.stringify(rec.front)`
(`bugs.mjs:1556`). `--check` evaluates only the second disjunct's rendered form.

**Refutation attempted, and why it partly failed.** Three refutations, two of which held:

1. _The state event._ REFUTED as a gap: the append at `bugs.mjs:1521-1533` is guarded by
   `st.state !== rec.front.state`, and `frontFor` (`bugs.mjs:1205-1225`) sets
   `state: st?.state ?? "uncampaigned"`, so a state event **always** coincides with a front-matter
   `state` change. `--check` catches every one. This is the case the run was built for.
2. _The commit scan._ Held as a real but **deliberate** gap: `appendHistory(body, `commit-<sha>`, …)`
   (`bugs.mjs:1535-1543`) changes the body with no front-matter consequence. Excluding it is
   specified (build-plan.md §WP-GUARDS 1) and justified — the anchor is machine-local and gitignored
   (`.gitignore:109`), so a `--check` that scanned would be non-deterministic across machines and
   would have to write the anchor.
3. _The header line._ Held as latent. Because `frontFor.sensitive` is a real boolean while every
   `rec.front` value is a parsed string, `JSON.stringify(nextFront) !== JSON.stringify(rec.front)`
   is **true for all 213 records** (measured — see Q1), so `sync` rewrites every record every run
   and thereby heals any stale `**Location** … **State** …` line. `--check` cannot see that. I
   measured the live exposure: **0 of 213** records currently carry a header line disagreeing with
   their own front matter, so this is latent, not live.

**Failure scenario.** A record committed with a hand-edited header line, or with commit-derived
History never synced, passes `--check`; the next worktree's Gate-4 `sync --quiet` dirties it —
the original symptom, one class narrower.

**Fix.** Compare the full rendered record —
`renderFront(next) + refreshHeaderLine(rec.body, next)` against the file's own bytes — and say in
the message that the commit scan is out of scope.

---

### F4 · minor · `scripts/campaign/bugs.mjs:7186-7227` vs `cmds.file` `:440-466`

**Claim.** The triage path has **no rollback** on a late failure, unlike `cmds.file`, which the
build plan told it to mirror ("build the row exactly as `cmds.file` does").

`file` wraps everything after the catalogue write in `try/catch`, restores the pre-write catalogue,
and calls `dropLedgerRow(bug.batch, bug.id)` (`bugs.mjs:440-466`). The triage path writes the ledger
row, then the catalogue (`:7208-7212`), then the record (`:7214-7220`), then asserts a final
`readShard` (`:7223-7225`) — any `fail()` past the ledger write exits 1 with the ledger row and the
catalogue already changed. Reachable via `appendEvent`'s no-change refusal (`bugs.mjs:1178-1185`,
which fires if the record already carries a markerless `**batched** · assigned to F05` line), a
`writeRecord` IO error, or the final read-back.

**Refutation attempted, and why it only partly failed.** The primary L-067 read-back is `landed`
(`bugs.mjs:7199-7203`), which comes from disk **inside the shard lock** (`upsertLedgerRow` →
`upsertLedgerRowLocked`'s re-read, `bugs.mjs:1999-2001, 2049-2050`) — so the ledger row genuinely is
verified before the catalogue is touched, and the ordering is sound. And a half-applied triage
self-heals: the record's front matter would then lag the ledger, which the new `--check` flags and a
plain `sync` repairs. That is why this is minor, not major.

**Fix.** Wrap the catalogue + record writes in the same `try/catch` + `dropLedgerRow(to, id)`
restore that `file` already uses.

---

### F5 · minor · `.claude/code-map/INDEX.md` (new bugs.mjs sentence)

**Claim.** The code map states a field that **does not exist anywhere in the repo**: "builds the row
exactly as `file --batch` does (same fields/`roundSha` derivation)".

`grep -n roundSha scripts/campaign/bugs.mjs` → no matches (none repo-wide). The phrase originates in
build-plan.md:11, which asserted it about master; the implementation correctly ignored it, and the
docs package copied it verbatim into the map.

**Refutation attempted, and why it failed.** I checked whether `upsertLedgerRow` injects it — it
does not: `upsertLedgerRowLocked` (`bugs.mjs:2003-2052`) pushes/merges the caller's object verbatim
and re-reads it. Both row literals are field-identical (see Q3). So the field is fictional.

**Failure scenario.** The project rule is to trust the map instead of re-reading (`CLAUDE.md`,
"Code map routine"). A future session adds or expects `roundSha` on ledger rows;
`scripts/campaign-check.mjs:171-206` validates only `id`/`batch`/`tier`/`state`, so the invention
ships unchallenged.

**Fix.** Delete "/`roundSha` derivation" from the INDEX row. (Same sentence also says the `batched`
event uses "`file`'s own key/text" — it is `expand`'s; the code comment at `bugs.mjs:7215-7216` has
this right.)

---

### F6 · minor · `.claude/code-map/_meta.json`

**Claim.** `"mappedSha": "2da6228c"` is the commit **before** the code it claims to map
(`c2de0712` is HEAD; `2da6228c` is its parent, the plan-only commit). The sha exists on the branch,
so nothing dangles — but the drift check the project uses (`mappedSha` vs `git rev-parse HEAD`) will
report the map current while it describes a tree that does not contain the mapped behaviour.

**Refutation attempted, and why it failed.** WP-DOCS necessarily runs before the commit that
contains it, so "HEAD short sha" is inherently one behind — that would excuse it, except the
CHANGELOG bullet restates ``mappedSha` → `2da6228c`` as the mapped state, making it an assertion
rather than an artefact of ordering.

**Fix.** Re-set `mappedSha` to the final branch head during close-out (the close-out list already
has a `_meta.json` bump step).

---

### F7 · nit · `scripts/campaign/bugs.mjs:7198` / test-plan.md:11

T14 does not cover one of the **test plan's own three named anti-vacuity mutations**. The plan says
"Creating the row without `mustBeNew`" must turn T14 red. `upsertLedgerRowLocked` consults
`opts.mustBeNew` only when `i !== -1` (`bugs.mjs:2013-2019`); T14's fixture never has a pre-existing
B1 row in F05, so deleting `{ mustBeNew: true }` leaves every T14 check green. Refutation attempted:
I checked whether the F06 re-home or the `move B9` case could create a collision — B9 is refused at
`unknown id` before any write, and the re-home goes through `allowExistingIn`, not `mustBeNew`.
Fix: one extra case (hand-write a duplicate row, assert the refusal) or drop the mutation from the plan.

### F8 · nit · `scripts/campaign/bugs.mjs:7208-7212`

The catalogue write is untested. Deleting `cat.batch = to; writeCatalogue(rows)` leaves every T14
check green: `show` renders the record, whose `batch` comes from `frontFor(bug, landed)` → the
ledger row, and `batchIndex()` (`bugs.mjs:634-660`) keys off the shards, not the catalogue. The one
reader that would break is `list --batch F05` (`bugs.mjs:1029`). The implementation is **correct**
and matches the re-home path (`bugs.mjs:7292-7296`); only the coverage is absent.

### F9 · nit · `scripts/campaign/bugs.mjs:6996-7013`

T13b's anchor snapshot/restore is now dead weight that still writes to the real tree. With `--check`
implemented no anchor write can occur (the branch returns at `bugs.mjs:1501` before
`commitMentions`), yet the `finally` unconditionally rewrites `.campaign/bugs-sync-state.json` when
it existed (it does here — 96 bytes) or `rmSync`s it when it did not. Harmless in the common case.
The one real edge: a concurrent Gate-4 `sync` in the same worktree creating the anchor **during**
the self-test, which the `finally` then deletes — costing that worktree its unscanned commit range.
Fix: delete it now that the red-gate window is closed.

### F10 · nit · `scripts/campaign/bugs.mjs:1469-1470`

`sync --rescan --check` silently ignores `--rescan`, and a typo'd flag (`--chek`) falls through to a
**writing** `sync` that exits 0. This is the file's existing flag idiom, but `--check` is now a gate,
where "unrecognised → write, exit 0" is the wrong default. Fix: reject unknown `--` flags in `cmds.sync`.

### F11 · nit · `scripts/campaign/bugs.mjs:1481-1500`

`--check` takes no lock, so a concurrent writer can make it report a spurious stale id and refuse a
push. Refutation: `cmds.sync` has never taken a lock either (documented at `bugs.mjs:1466`), so this
is consistent — the only change is that the read is now load-bearing for a gate.

### F12 · nit · `scripts/campaign/bugs.mjs:1484`

`--check` skips catalogue rows with no record file (`if (!rec) continue`) — **identical** to the
write path (`bugs.mjs:1516-1517`), so it is not a divergence. It does mean a missing record (an
`expand` obligation) is invisible to the guard. 0/213 today.

---

## The 13 questions

**1. Is `sync --check`'s derivation identical to the write path's? Can `renderFront` vs
`JSON.stringify` cause a false clean or a false dirty? Any write `sync` performs that `--check`
cannot see? — REFUTED (the deviation is required), with one documented residual (F3).**

The derivation is identical where it matters: both build `nextFront = { ...rec.front, ...frontFor(bug, st) }`
from the same `readCatalogue()`/`readState()` pair (`--check` `bugs.mjs:1482-1493`; write path
`bugs.mjs:1515-1546`), and both skip records that do not exist with the same `if (!rec) continue`
(`:1484` vs `:1516-1517`).

The comparison operator differs, and it **had to**. I measured it on the real tree with a read-only
re-implementation of `frontFor`/`renderFront`/`parseRecord` over `.claude/campaign`:

| metric                                               | result        |
| ---------------------------------------------------- | ------------- |
| catalogue rows with a record                         | 213 / 213     |
| `JSON.stringify(next) !== JSON.stringify(rec.front)` | **213 / 213** |
| `renderFront(next) !== renderFront(rec.front)`       | **0 / 213**   |
| records with a stale `**Location**` header line      | 0 / 213       |
| records checked out CRLF                             | 0 / 213       |

The cause is `frontFor.sensitive` (`bugs.mjs:1219`), a real boolean, versus `rec.front.sensitive`,
a string from `parseRecord` (`bugs.mjs:1095-1099`, every value is a string or null). So:

- **Had `--check` used `JSON.stringify` as the plan specified, it would have reported all 213
  records stale and refused every push, forever.** The implementation's inline comment
  (`bugs.mjs:1487-1492`) states exactly this and is correct. This is a plan defect the build caught.
- **False clean from `renderFront`?** No: `renderFront(next) !== renderFront(rec.front)` implies the
  bytes `writeRecord` emits differ, and key order is preserved on both sides because `nextFront`
  spreads `rec.front` first. **False dirty?** No: the write path's condition is effectively always
  true (see above), so `sync` always writes; `--check` dirty ⟹ the file's bytes really change.
- **A write `--check` cannot see:** yes, one class — `body !== before` (`bugs.mjs:1556`). The state
  event is _not_ it (it always moves `front.state`, so it is caught). The **commit-scan appends**
  are (`bugs.mjs:1535-1543`), and so is header-line healing (F3). The commit-scan exclusion is
  specified and defensible; the header-line one is latent (0/213 today).

**2. Does `--check` truly write nothing? — REFUTED (it writes nothing).** Traced every call in the
branch: `readCatalogue` (`existsSync`+`readFileSync`, `:151-157`), `readState`
(`existsSync`+`readdirSync`+`readFileSync`, `:166-184`), `readRecord`
(`existsSync`+`readFileSync`, `:1109-1110`), `frontFor`/`renderFront` (pure). No `mkdirSync`, no
`writeSyncState` (the branch returns at `:1501` before `commitMentions`, so the first-run/re-anchor
branch at `:1372` that persists the anchor itself is never reached), no lock (`installLockExitHook`
is called only from `acquireLock`, `bugs.mjs:1810`), no lazily created directories, and no
module-level writes (dispatch is `bugs.mjs:7783-7796`). It does not even need git. Confirmed live:
`node scripts/campaign/bugs.mjs sync --check` → `sync --check: records mirror the ledger`, exit 0,
tree still clean.

**3. Is `move --tier`'s row field-identical to `cmds.file`'s? — REFUTED (identical); the plan's
`roundSha` is fictional (F5).**

| field                       | `cmds.file` `:386-394`                  | triage `:7187-7195`      |
| --------------------------- | --------------------------------------- | ------------------------ |
| `id` / `batch` / `tier`     | `bug.id` / `bug.batch` / `tier`         | `id` / `to` / `tier`     |
| `state`                     | `"queued"`                              | `"queued"`               |
| `pr` / `proof` / `evidence` | `null` / `null` / `null`                | `null` / `null` / `null` |
| `roundSha`                  | **absent — does not exist in the repo** | absent                   |

`upsertLedgerRow` adds nothing (`bugs.mjs:2003-2052` writes the caller's object verbatim). Downstream
readers are satisfied: `frontFor` needs `batch`/`tier`/`state`/`proof`; `campaign-check.mjs:186-193`
validates `batch`/`tier`/`state`; `batchIndex` needs `batch`/`state`; `dischargeEvidence` is added
by `discharge`, never at creation. **N-A** for `roundSha` — the build plan asserted a field that
master never had.

**4. Lock order and the static self-test. — REFUTED as a defect; partial coverage.** `upsertLedgerRow`
does take the shard lock internally (`bugs.mjs:1999-2001`: `withShardLock(batch, () =>
upsertLedgerRowLocked(...))`), and the triage path calls it inside `withCatalogueLock`
(`bugs.mjs:7186`) — catalogue outermost, matching `file` (`bugs.mjs:334`) and the one-way rule at
`bugs.mjs:1954-1958`. The static self-test (`bugs.mjs:6423-6454`) scans for `withCatalogueLock(`
lexically nested inside a `withShardLock(`/`withShardLocks(` argument span. The new site contains no
`withShardLock(` opener at all, so the test **would pass regardless of whether the new code were
correct in the `upsertLedgerRow`-nesting sense** — but it _would_ have caught the specific mistake
of writing it inverted. Coverage is real but narrow; the implementation is correct.

**5. Catalogue write consistency. — REFUTED (consistent).** `cmds.file` puts the batch in the
catalogue row at creation (`bugs.mjs:357`) and the existing re-home path updates it
(`bugs.mjs:7292-7296` — `cat.batch = to; writeCatalogue(rows)`), byte-for-byte the same shape the
triage path uses (`:7208-7212`). Source of truth for `batch` is the **ledger shard**: `frontFor`
prefers `st?.batch` over `bug.batch` (`:1210`), `batchIndex` iterates `state` not the catalogue
(`:641`), and `campaign-check.mjs` reads only shards. The catalogue's `batch` is a denormalised copy
whose only reader is `list --batch` (`:1029`). All three writers keep it in sync. No inconsistency.

**6. `frontFor(bug, landed)` with a pre-update `bug`. — REFUTED.** `frontFor` reads
`batch: st?.batch ?? bug.batch ?? null` (`bugs.mjs:1210`) and `landed.batch === to`, so the ledger
row wins and the stale `bug.batch === null` is never consulted. `tier`/`state`/`proof` likewise come
from `st`. The fields taken from `bug` (`id`/`title`/`location`/`severity`/`sensitive`/`sensitiveFor`)
are untouched by the catalogue update. On-disk front matter therefore reads `batch: F05`, not empty.
`cmds.show` (`bugs.mjs:1573-1580`) simply `process.stdout.write`s the record file — so `show`'s
`batch:` comes from the record, not from a second derivation, and the two cannot disagree here.

**7. History event key/text. — REFUTED (identical to `expand`; the plan's "`file`" is loose).**
`expand`: ``appendHistory(body, `batch-${st.batch}`, "batched", `assigned to ${st.batch}`)``
(`bugs.mjs:1279`). Triage: ``appendEvent(rec.body, `batch-${to}`, "batched", `assigned to ${to}`)``
(`bugs.mjs:7217`) — same base key, same event, same detail. `cmds.file` does not append this event
itself; it calls `cmds.expand()` (`bugs.mjs:441`), so "the key `file` uses" _is_ `expand`'s. The code
comment says `expand`; the code-map INDEX says `file` (F5). No duplicate is possible on a later
`sync`: `sync` never appends a `batched` event (`bugs.mjs:1515-1554`), and `expand` appends it only
on the `!existing` branch (`bugs.mjs:1255-1287`). `appendEvent` → `uniqueHistoryKey`
(`bugs.mjs:1166-1175`) would suffix `#2` if it ever recurred.

**8. `--tier` and `--to` validation. — REFUTED (correctly ordered).** `normBatch(flag(args, "to"))`
runs at `bugs.mjs:7164`, **before** `findShardOf` and before any shard file could be created;
`--to garbage` dies at `batch must look like F## (got "garbage")` (`bugs.mjs:209-220`) and a missing
`--to` at "a batch is required". `--tier` is validated in two steps (`:7178-7181`): presence, then
`/^T[123]$/` after `.toUpperCase()`, mirroring `file` (`bugs.mjs:374-381`). `unknown id` is checked
_before_ `--tier` (`:7176-7178`), which is right — the comment says so and it prevents the tier
message masking a bad id, exactly as T14 asserts.

**9. Is the read-back a real disk read? — REFUTED (it is).** `readShard(to)` (`bugs.mjs:1963-1983`)
`existsSync`+`readFileSync`s the shard path every call; there is no cache anywhere in the module.
Note the _primary_ read-back is stronger than the one flagged: `landed` comes from
`upsertLedgerRowLocked`'s post-write re-read **inside the shard lock** (`bugs.mjs:2049-2050`), and
the assertion at `:7199-7203` uses it. The extra `readShard(to)` at `:7223` runs after the shard lock
has been released (only the catalogue lock is still held), so in principle it can race a concurrent
writer — belt-and-braces, and the meaningful assertion already happened under the lock.

**10. Tests vs the test plan. — every oracle met or stronger; two deviations, both justified; one
env/cwd hole (F1).**

- **T13** matches test-plan.md:9 point for point and is _stronger_ in two places: every clean/dirty
  assertion also pins `ranASync: /recorded \d+ new event/.test(out) === false`, which is what makes
  the check discriminating (an unrecognised `--check` falls through to a plain `sync` that also
  exits 0); and the anchor oracle plants a `selfTestSentinel` key rather than comparing bytes, so a
  same-millisecond rewrite cannot hide (`writeSyncState` rewrites `{lastSha, at}` wholesale,
  `bugs.mjs:1342-1348`). `SYNC_STATE()` with `BUGS_ROOT` set resolves to `<tmp>/sync-state.json`
  (`bugs.mjs:1323-1325`), matching the plan's path.
- **T13b** — `runCli(argv, undefined)` **does** remove `BUGS_ROOT` from the child env: the env object
  is `{ ...process.env, BUGS_ROOT: root, BUGS_SELF_TEST: "1" }` (`bugs.mjs:2837`), and Node's spawn
  normaliser skips keys whose value is `undefined`, so an inherited parent `BUGS_ROOT` is overridden
  to absent rather than passed through. No env leak reaches it either: every earlier block restores
  `BUGS_ROOT`/`BUGS_REGISTER`/`BUGS_PIPELINE_DIR`/`BUGS_SYNC_STATE` in a `finally`, and the one
  `process.chdir` (`bugs.mjs:4242`) is restored at `:4294`. **The `process.cwd()` assumption is the
  hole** — see F1. It holds under `npm run verify` (root cwd) and CI (`ci.yml:255`, no
  `working-directory`), and breaks silently otherwise.
- **T13b's anchor snapshot/restore** is now a **trap, mildly** — see F9.
- **T14** meets every oracle in test-plan.md:11 and is stronger in three places (the `--tier` refusal
  and the `unknown id` refusal both assert the _old_ `no ledger shard` message is **absent**, so a
  pre-existing dead-end cannot masquerade as the new guard; the re-home check asserts F05's shard
  still **exists** alongside not holding B1). One documented deviation: the plan's
  `show B1 → state: uncampaigned` is a thrown fixture precondition rather than a scored check,
  because it is already true before the implementation and the red-gate contract (test-plan.md:19)
  bars asserting that. Correct call.
- No assertion in any of the three would have passed before the implementation (see the table below).

**11. Anti-vacuity — see the table below.** Every test has at least one single-line kill mutation;
two of the plan's own named mutations are uncovered (F7, and implicitly F8).

**12. Blast radius of T13b on a correct tree. — one real risk (F1), the rest refuted.**

- _Fresh clone, no `.campaign/bugs-sync-state.json`:_ safe. `--check` returns before
  `commitMentions` (`:1501`), so the anchor is never read or written and git is never invoked. The
  `finally`'s `rmSync(..., {force:true})` on a non-existent path is a no-op.
- _CI / the public window:_ safe. `.claude/campaign` is tracked (249 files, 213 records); CI runs
  `npm run verify` from the repo root; no network, no git, no anchor.
- _A worktree whose ledger changed under a rebase:_ exit 1 — correct, that is the guard.
- _Windows / CRLF:_ refuted as a risk. `.gitattributes:3` is `* text=auto eol=lf`, so records check
  out LF; and independently `parseRecord` splits on `/\r?\n/` (`bugs.mjs:1081-1099`) while
  `renderFront` always emits `\n` (`:1102-1107`), so both sides of the comparison are `\r`-free
  regardless. Measured: 0/213 records contain CRLF. A CRLF checkout would still not produce a false
  dirty.
- _Concurrency:_ a Gate-4 `sync` running in the same worktree during the self-test can produce a
  spurious stale id (F11) or lose its anchor to the `finally` (F9).

**13. Docs. — accurate except F2, F5, F6.** SKILL.md's `--check` block is right on the flag name, the
read-only claim, the commit-scan exclusion and "exits 1 naming records whose front matter lags the
ledger" (matches `bugs.mjs:1495-1500`); the sync-before-commit rule is a genuine and useful addition.
SKILL.md's `move --tier` block is right that `--tier` is required only the first time — but its
worked example passes `--why`, which is dropped (**F2**). The header usage block
(`bugs.mjs:56-57, 73`) matches the implementation. The CHANGELOG bullet is accurate.
`_meta.json.mappedSha = 2da6228c` **does** exist on this branch (it is `HEAD~1`), but it predates the
code it describes (**F6**). The INDEX entry invents `roundSha` (**F5**).

_(Close-out, out of diff scope but outstanding: `.claude/lessons/_meta.json` still reads
`nextId: 77`, `activeCount: 39` — build-plan.md:39's L-077 entry has not been filed, and Gate 3 will
want it before the push.)_

---

## Anti-vacuity table

| Test                  | Single-line mutation of `bugs.mjs` that turns it red                               | Which check fires                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **T13**               | `:1493` → `if (false) stale.push(bug.id);`                                         | "exits 1 when a shard state has drifted" → got 0, want 1                                                        |
| **T13** (2nd)         | delete the `return;` at `:1501` so `--check` falls through to the write path       | "does NOT write the record it found out of date" + `ranASync: true`                                             |
| **T13b**              | `:1470` → `const check = false;` (or change the `:1500` message text)              | `mirrors: false, ranASync: true`                                                                                |
| **T14**               | `:7177` → `if (false) fail(\`${id} has no ledger row yet — --tier is required…\`)` | "refused because --tier is required" → `tier: false`                                                            |
| **T14** (2nd)         | delete the `appendEvent` at `:7217`                                                | "History carries a line naming the triage as batched into F05" → false                                          |
| **T14** (3rd)         | `:7176` → `if (false) fail(\`${id}: unknown id\`)`                                 | "refused as an unknown id" → `unknown: false, oldMsg: true`                                                     |
| **T14 — NOT covered** | delete `{ mustBeNew: true }` at `:7198`                                            | _nothing_ — `mustBeNew` is consulted only when a row already exists (`:2013`), which T14 never sets up (**F7**) |
| **T14 — NOT covered** | delete `cat.batch = to; writeCatalogue(rows)` at `:7208-7212`                      | _nothing_ — `show` renders the record (batch from the ledger row) and `batchIndex` keys off shards (**F8**)     |
| **T13b — vacuity**    | none needed: run the self-test from any non-root cwd                               | _nothing_ — empty catalogue prints the mirror line, exit 0 (**F1**)                                             |

---

## Recommended order

1. **F2** (one line, `--why` in the triage event) — the docs already promise it.
2. **F1** (count in the `--check` message + assert it in T13b) — restores the guard's own integrity.
3. **F5**, **F6** (docs truth: drop `roundSha`, re-set `mappedSha` at close-out).
4. **F3**, **F4**, **F7**–**F12** are safe to defer, but F9 (delete the dead anchor restore) is free.
