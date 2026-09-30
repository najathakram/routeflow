# Opus re-check — fix round 1 (registry guards)

**Scope.** `git diff c2de0712..32df0fe4 -- scripts/campaign/bugs.mjs .claude/code-map/INDEX.md
.claude/skills/bug-registry/SKILL.md`, read against `git show 32df0fe4:scripts/campaign/bugs.mjs`
(never HEAD or the working tree — another agent is committing close-out material here).

**VERDICT: HOLDS.** All eight FIX rows match the ruling's design. No new defect. Two nits carry
forward to close-out (N1, N2) and one coverage gap is recorded (F4 has no test at all — the ruling
did not ask for one).

**Not verified (by instruction):** I did not run `self-test`, `sync --check`, or prettier. Every
"all checks ok / 213 record(s)" claim in `fix-round-1-report.md` is the fixer's, not mine. What I
did run: `node --check` on the committed blob (**SYNTAX OK**) and one Node env-semantics probe
(below). Everything else is static reading of the committed file.

---

## F1 · `sync --check` vacuity — **matches design: YES · new defect: none**

- Message: `bugs.mjs:1511` prints `sync --check: ${catalogue.length} record(s) mirror the ledger`
  — the ruling's exact string. T13's two "mirrors" fields are `/\d+ record\(s\) mirror the ledger/`
  (`:6933`, `:6996`); T13b's object is `{ code: 0, mirrors: true, examined: true, ranASync: false }`
  with `examined: Number((real.out.match(/(\d+) record\(s\) mirror/) || [])[1]) >= 1` (`:7042`).
  `Number(undefined) >= 1` → `NaN >= 1` → `false`, so a missing/renamed message fails closed.
- `runCli` cwd (`:2856`): `...(root === undefined ? { cwd: REPO_ROOT } : {})`. `REPO_ROOT` is
  `join(dirname(import.meta.url), "..", "..")` — `join` normalises the `..`, so it is the worktree
  root of the script itself, not the invoker's.

**Refutation attempted — "can `examined` be true while the check examined the wrong tree?"**
Three routes tried, all closed:

1. _`BUGS_ROOT` leaking from the parent into the child._ `env: { ...process.env, BUGS_ROOT: root, … }`
   with `root === undefined` sets the key to `undefined`. Node's `normalizeSpawnArguments` **skips
   env entries whose value is `undefined`**, so the spread's inherited `BUGS_ROOT` is dropped, not
   passed through. Probed empirically on this box (`node v24.14.0`): parent `LEAKY=parent-value`,
   child with `{...process.env, LEAKY: undefined}` reports `null`. So even a fixture value left in
   `process.env` — or one exported by the human invoker — cannot reach the T13b child.
2. _A fixture block leaving `process.env.BUGS_ROOT` set._ Every fixture block restores it in a
   `finally` (`prevRoot === undefined ? delete : restore`), and the `process.chdir(tmp)` block
   (`:4261`) restores cwd at `:4313` — both long before T13b at `:7029`. Belt and braces with (1).
3. _Another call site inheriting the new cwd._ `runCli(…, undefined)` occurs **once**, at `:7029`
   (a grep for a lone `undefined,` argument line returns nothing; 44 `runCli(` calls total). The
   fixture runs keep the inherited cwd, exactly as the ruling specified.

**Residual (N2, nit, matches the ruling as written).** The count is `catalogue.length`, but the
loop does `if (!rec) continue` (`:1495`, the F12-ACCEPT skip). So `examined >= 1` proves _"a
non-empty catalogue was found at the resolved root"_, not _"records were compared"_: with 213
catalogue rows and `.claude/campaign/bugs/` emptied, `--check` would print
`213 record(s) mirror the ledger`, exit 0, and T13b would stay green having compared nothing. The
cwd vacuity the ruling targeted **is** closed (a wrong root yields an empty catalogue → count 0 →
red). One-line fix if ever wanted: `let seen = 0;` incremented after the `continue`, and print
`seen` instead of `catalogue.length` (then the noun matches the number).

**Vacuity mutations.** T13b `examined`: `const catalogue = readCatalogue()` → `[]` (or printing a
literal `0`) → `examined` false → red. T13/T13b `mirrors`: change the success text (e.g. drop
`record(s)`) → red. `ranASync`: make `--check` fall through to the writing path → red.

## F2 · `--why` dropped on triage — **matches design: YES · new defect: none**

`:7284-7289` detail is ``assigned to ${to}${why ? ` — ${why}` : ""}``; `:7311` console is
``…(first ledger row, tier ${tier})${why ? ` (${why})` : ""}``. Byte-identical separators to the
re-home path (`:7385` detail ``${from} → ${to}${why ? ` — ${why}` : ""}``, `:7392` console
``${id}: ${from} → ${to}${why ? ` (${why})` : ""}``).

**`$`-safety / markdown injection — checked, no exposure.** `appendHistory` (`:1132-1159`)
interpolates the caller text through **template literals only**; its single `String.replace` is
`body.replace(/\s*$/, "")` whose replacement is a _constant_ `""` — there is no
replacement-string path for `$1` / `$&` / `` $` `` to expand caller text (that hazard is real only
in `replaceSection`, which is why that one uses a function replacement). The detail is additionally
`/\s+/g`-collapsed (so a multi-line `--why` cannot start a new line, let alone a heading) and has
`<!--` / `-->` stripped (so it cannot forge or corrupt a dedupe marker).

**Vacuity mutation.** Delete the `${why ? …}` suffix in the `appendEvent` detail → the new
`"…History records the triage's --why reason"` check (same-line `batched` + `triage reason`) → red.
**Gap (nit):** the console echo is asserted by _nothing_ — removing ``${why ? ` (${why})` : ""}`` at
`:7311` stays green. The ruling asked for one assertion and got it; naming this so it is a known
choice, not an oversight.

## F4 · rollback on a late triage failure — **matches design: YES · new defect: none**

- **Snapshot before the write:** yes — `const before = readCatalogue()` (`:7272`) precedes the
  `try`, and the `writeCatalogue(rows)` is inside it (`:7279`). `file` takes its snapshot before the
  write too but leaves the write just _outside_ the `try`; `move`'s placement is strictly safer (a
  throw _during_ `writeCatalogue` is also caught) and changes nothing else.
- **Inside the catalogue lock:** yes. The whole `try/catch` sits inside the `withCatalogueLock(…)`
  callback opened at `:7247` and closed at `:7313`. `dropLedgerRow` takes `withShardLock` (`:2072`),
  so the order is catalogue → shard, never the reverse. No lexical `withShardLock(` was added, so
  the static lock-order parse (`:6442-6473`, which only flags `withCatalogueLock(` nested inside a
  `withShardLock(s)(` argument span) is untouched.
- **`dropLedgerRow` on a brand-new shard:** `dropLedgerRowLocked` (`:2064`) writes
  `[].join(eol) + eol` → the shard file survives as a single newline. Tolerated everywhere I
  checked: `readShard` / `readState` (`.filter(Boolean)`), `findShardOf`, `batchIndex` (keyed off
  `state` rows, `:634+`), and `campaign-check.mjs:173` (`.filter(l => l.trim())`; it fails only when
  **no** `F##.jsonl` exists at all). Identical to `file`'s pre-existing rollback — not a new class.
- **`fail()` bypassing the catch:** correct and deliberately copied. `fail` is `console.error` +
  `process.exit(1)` (`:187`), which does not unwind, so the read-back `fail` (`:7295`) and
  `appendEvent`'s no-change `fail` (`:1181`) still exit **without** rollback — precisely `file`'s
  shape, which the ruling told the fixer to mirror. Net effect: the new catch covers genuine throws
  (IO / EISDIR / JSON), not the two `fail()` paths. Pre-fix there was no rollback at all, so nothing
  regressed.

**Vacuity: there is no test.** No new or changed self-test assertion exercises this catch — the one
place where "name the mutation that turns the new check red" has the answer _none_. The sibling
`file` rollback **is** covered (`:4010-4058`: pre-create `bugs/B1.md` as a **directory** → EISDIR →
assert the catalogue restored and `readShard("F01").rows` is `[]`). That seam transfers almost
verbatim if a later round wants coverage: `file B1` with no `--batch`, then `rm` `B1.md` and
`mkdir` it, then `move B1 --to F05 --tier T1` → `readRecord`'s `readFileSync` throws EISDIR →
assert exit != 0, `readShard("F05").rows` is `[]`, and the catalogue's `B1.batch` is back to `null`.
Recording as a RUN-LOG candidate, not a fix-again.

## F5 · code map — **matches design: YES · new defect: none**

`roundSha` is gone from the whole code map (`git grep -c roundSha 32df0fe4 -- .claude/code-map/`
→ no hits) and the attribution now reads "appends the record's `batched` event with `expand`'s own
key/text". CHANGELOG.md genuinely repeats neither phrase, so the fixer's "no CHANGELOG edit"
matches F5's own conditional.

**N1 (close-out, must-do).** The same INDEX.md paragraph still says "prints `sync --check: records
mirror the ledger` and exits 0" — stale as of F1 (verified against the committed blob). The fixer
declared this as a reported-not-applied deviation; it is F6 / close-out's to fix, and it is exactly
the class F5 was raised about (a map claim the code no longer satisfies).

## F7 · **matches design: YES (nothing expected in code)**

The ruling DROPPED the plan mutation; the test-plan.md sentence is outside my reviewed file set.
Confirmed only that the bugs.mjs diff contains no F7-attributable hunk. `mustBeNew` is unchanged.

## F8 · `list --batch` coverage — **matches design: YES · new defect: none**

Two `check()`s, exactly as ruled. `cmds.list:1029` filters the **catalogue** (`r.batch === batch`),
so these genuinely cover `cat.batch = to; writeCatalogue(rows)`. `\bB1\b` is whole-word (it cannot
be satisfied by `B10`), and the fixture cannot supply a spurious match: `list` prints
id / severity / batch / state / mark / title only, and the fixture's title is `"Triage fixture"`
(the location `apps/api/src/x.ts` is not printed).

**Vacuity mutations.** Delete `cat.batch = to; writeCatalogue(rows)` in the triage branch → the
`list --batch F05` check goes red. Delete the re-home path's equivalent (`:7373-7378`) → `f06HasB1`
red; leave the source batch in place → `f05HasB1` red.

## F9 · dead anchor snapshot/restore — **matches design: YES · new defect: none**

Block deleted; the `runCli(["sync","--check"], undefined)` call and its `check()` survive.

**Does the surviving path touch the real tree?** No. `--check` returns at `:1512`, before
`commitMentions` and before `writeSyncState`, and everything it calls is pure-read
(`readCatalogue`, `readState`, `readRecord`, `frontFor`, `renderFront` — all verified read-only).
The anchor path itself is `.campaign/bugs-sync-state.json` only when `BUGS_ROOT` is unset (`:1323`),
i.e. only on this one run — which never reaches a write.

**If a future regression makes `--check` unrecognised:** two sub-cases. (a) It falls out of `known`
too → F10's guard fails **before any read**, exit 1, T13b goes red having written nothing —
strictly better than before. (b) It stays in `known` but the `if (check)` branch stops firing → the
real-tree run performs a full writing sync: the gitignored, machine-local anchor is rewritten
(acceptable) **and** tracked `.claude/campaign/bugs/B###.md` records could be rewritten if any drift
existed. That tracked exposure is _not_ new — the deleted block only ever restored the anchor, never
the records — so F9 loses nothing but the anchor protection, whose only real edge (a concurrent
Gate-4 sync's anchor being `rmSync`'d by the `finally`) is now gone.

## F10 · unknown-flag rejection — **matches design: YES · new defect: none**

`:1467-1476` is the **first** statement of `cmds.sync`, before `readCatalogue()` / `readState()`;
message and `known` set are the ruling's verbatim.

- **Gate 4 still passes:** `.claude/hooks/stop.mjs:193` (read at 32df0fe4) spawns
  `["scripts/campaign/bugs.mjs","sync","--quiet"]` — `--quiet` only. `package.json` invokes only
  `self-test`. `.husky/` and `.github/` carry no `bugs.mjs` reference. SKILL.md documents `sync` and
  `sync --check` and nothing else.
- **Any flag-with-a-value `sync` accepted before?** No. `cmds.sync` reads flags by
  `args.includes(...)` only, and the sole other consumer of `args`, `commitMentions` (`:1351`),
  reads `args.includes("--rescan")` and nothing else — so `known` is complete and no legitimate
  _value_ token can be mistaken for a flag (there are no valued flags on this command).
- **Residual (nit, outside the ruling's design):** `sync --rescan --check` still silently ignores
  `--rescan` (F10's other half), and positional junk (`sync foo`) is still accepted silently.

**Vacuity mutation.** Delete the guard → `runCli(["sync","--chek"], tmp)` runs a plain sync on the
already-reconciled fixture, which prints `sync: recorded 0 new event(s).` and exits 0 → all three
fields (`code`, `ranASync`, `named`) go red. Triply non-vacuous.

---

## Hunk attribution (no behaviour change outside the eight findings)

Ten hunks in `bugs.mjs`, one line in `INDEX.md`; every one attributable, and **no prettier-only /
unattributed hunk**:

| Hunk                                             | Lines (new)    | Finding            |
| ------------------------------------------------ | -------------- | ------------------ |
| usage comment `--check` scoping                  | `:60`          | F3 (doc-only half) |
| unknown-flag guard                               | `:1467-1476`   | F10                |
| counted success message                          | `:1511`        | F1                 |
| `runCli` `cwd: REPO_ROOT`                        | `:2856`        | F1                 |
| T13 `mirrors` regex ×2                           | `:6933,:6996`  | F1                 |
| T13 typo check + re-brace, T13b lifted out       | `:7000-7047`   | F10 / F9 / F1      |
| `--why` on T14's triage call                     | `:7086-7089`   | F2                 |
| T14 `--why` History check + `list --batch F05`   | `:7123-7141`   | F2 / F8            |
| T14 `list --batch` after the re-home             | `:7179-7189`   | F8                 |
| `move` triage try/catch + `--why` detail/console | `:7268-7311`   | F4 / F2            |
| INDEX.md bugs.mjs sentence                       | `INDEX.md:106` | F5                 |

`node --check` on the committed blob passes, so the re-braced T13/T13b region is at least
syntactically balanced. Locks, `mustBeNew`, `upsertLedgerRow`, `dropLedgerRow`, the re-home path and
the static / runtime lock-order guards are byte-unchanged.

## Carried forward

- **N1 (close-out, F6's commit):** INDEX.md still quotes the pre-F1 `--check` success message.
- **N2 (RUN-LOG candidate):** `--check` counts catalogue rows, not comparisons — `examined >= 1`
  proves the root resolved, not that records were read.
- **N3 (RUN-LOG candidate):** `move`'s new rollback has no self-test; `file`'s EISDIR seam transfers.
