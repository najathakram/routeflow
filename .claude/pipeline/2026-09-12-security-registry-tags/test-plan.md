# Test plan: bugs.mjs --tag, Plane label mapping, F49 audit backfill

> **Stage S4 — "how we'll know".** Authored by Fable 5 on `2026-09-12`.
> Status: `IMPLEMENTED` (2026-09-12; T1-T8 all green as of the hand-verified re-run — see
> build-plan.md's Status line for the full account of what ran automatically vs. by hand).
> Requirement IDs `R#` come from the build plan's own Preamble (small scale — no
> separate spec.md). This file is the ONLY context the test-authoring, red-gate and
> review agents receive.

**Gate to pass before S5:** every `R#` maps to ≥1 `T#`; every `T#` names an `R#`; every
`T#` has an oracle; every `T#` has a stated reason it fails today.

---

## 1. Strategy for this change

This is a behavior-change to an existing CLI (`bugs.mjs`) and its Plane sync counterpart:
add a `tags` field end-to-end (file/tag/list/stats/show/sync) plus a new ledger state
(`already-fixed`), then map tags to Plane labels in the sync payload. All eight tests live
in the two scripts' own existing self-test blocks (`mkdtemp` + `BUGS_ROOT`, real `cmds.*`
calls) — no separate test files, no new test runner.

| Level | Used here? | Why / why not |
|---|---|---|
| unit | no | the self-test blocks below are integration-style already (real CLI dispatch over a real temp registry) |
| property | no | no money, quantities, dates or permissions are touched by this change |
| contract | no | single CLI, no second client |
| integration | yes | every T# drives the real `cmds.*`/`runCli()` over a `mkdtemp` `BUGS_ROOT`, exactly like the existing self-test blocks |
| e2e | no | no UI surface |
| manual | yes | R9 (data backfill) and R10 (docs) are verified by review of the resulting registry rows / doc diffs, not by an automated test |

**Rule applied:** prefer the lowest level that can fail for the right reason — here that
level is "drive the real CLI over a throwaway registry," matching every existing case in
the self-test block.

**Deliberately NOT tested, and why**:

- R9 (F49 backfill data) — a data-filing operation, not code; verified by re-reading the
  filed rows (`bugs.mjs show`/`list`) and the id map, per the P3 package brief.
- R10 (docs) — verified by manual diff review of the four doc files; no runnable oracle.

**Risk driving depth**: a wrong `--tag` validation lets an unsanitized string into the
catalogue/Plane payload; a wrong `already-fixed` transition could flip a bug's state
without evidence gating (`--why` shorter than 20 chars) or let it double-fire on an already
discharged row. Both are covered as negative tests in §4.

**Characterization tests needed first?** No — this is additive (new field, new
subcommand), not a refactor of existing behavior.

---

## 2. Test table

| ID | proves | level | Given / When / Then | Oracle — why the expected value is KNOWN | File | Fails today because |
|---|---|---|---|---|---|---|
| T1 | R1 | integration | **G** empty `BUGS_ROOT` · **W** `bugs.mjs file --tag security --tag "audit-2026-06 security"` · **T** catalogue row `tags` equals `["audit-2026-06","security"]`; record front matter `tags` equals the same parsed list | dedup+sort of the two literal `--tag` values given on the command line — `["security","audit-2026-06","security"]` deduped and sorted is exactly `["audit-2026-06","security"]` | `scripts/campaign/bugs.mjs` (self-test block, existing) | `--tag` flag does not exist yet — `cmds.file` has no `tags` handling, so the row today carries no `tags` key at all |
| T2 | R1 | integration | **G** current catalogue length N · **W** `bugs.mjs file --tag "Bad_Tag" ...` · **T** exit code 1; catalogue length still N; stderr contains `Bad_Tag` | the tag regex `^[a-z0-9][a-z0-9-]*$` given in the ruling rejects any uppercase or underscore char — `Bad_Tag` fails on both | `scripts/campaign/bugs.mjs` (self-test block, existing) | validation does not exist yet — an invalid string is accepted and written today |
| T3 | R3 | integration | **G** two filed rows, one tagged `security`, one untagged · **W** `bugs.mjs list --tag security` · **T** output contains the tagged id, excludes the other; `list --tag security --open` on a `done` row returns empty | `--tag` is an AND-filter alongside `--open`/`--sensitive`/`--batch` per R3 — a `done` row is excluded by `--open` regardless of tag | `scripts/campaign/bugs.mjs` (self-test block, existing) | `list` has no `--tag` flag today, so filtering by tag is impossible |
| T4 | R4 | integration | **G** one row tagged `security` · **W** `bugs.mjs stats` · **T** parsed stats JSON/text contains `byTag` with `security: 1` | direct count of the one fixture row carrying that tag | `scripts/campaign/bugs.mjs` (self-test block, existing) | `cmds.stats` (L1041) only counts `bySeverity`/`byState`/`sensitive` today — no `byTag` key exists |
| T5 | R2, R5 | integration | **G** a filed row · **W** `bugs.mjs tag B### add security` twice, then `remove security`, then `tag B999 add x` · **T** after the first two adds, tags still `["security"]` (idempotent); after remove, the `tags` key is absent; `tag B999 ...` exits 1; `bugs.mjs show B###` output contains `tags` when present | idempotency and key-omission are stated directly in R1/R2; `B999` is not a filed id in the fixture, so `tag` must exit 1 | `scripts/campaign/bugs.mjs` (self-test block, existing) | the `tag` subcommand does not exist in the `cmds` table (L261) today — the CLI would report an unknown command, not this behavior |
| T6 | R6 | integration | **G** a row filed with `tags: ["security"]` · **W** `bugs.mjs sync` · **T** record front matter `tags` still equals `["security"]` after sync | `frontFor`'s merge at L1501 (`{...rec.front, ...frontFor(bug,st)}`) preserves any key not in `frontFor`'s output set, and `tags` is not one of those keys — this is an assertion on existing, unmodified merge behavior | `scripts/campaign/bugs.mjs` (self-test block, existing) | `tags` does not exist in any record today, so there is nothing yet to preserve — the assertion has no subject until R1 lands |
| T7 | R7 | integration | **G** a row in state `queued` · **W** `bugs.mjs already-fixed B### --pr 84 --why "fixed in PR #84 adopt-orphans guard"`, then the same call again, then a fresh row with `--why "short"` · **T** first call: ledger row `state:"already-fixed"`, `pr:84`, `evidence` equals the why string; second call on the same row: exit 1 (row is no longer `queued`/`in-flight`); short-why call: exit 1, state unchanged | R7's own transition rule (`already-fixed` only from `queued`/`in-flight`) and its `--why` length gate (≥ 20 chars; `"short"` is 5) are stated directly in the requirement | `scripts/campaign/bugs.mjs` (self-test block, existing) | the `already-fixed` subcommand does not exist in `bugs.mjs` today (per context-pack §1, its only occurrence anywhere is a `campaign-check.mjs` self-test fixture, not a real command) |
| T8 | R8 | integration | **G** a stub Plane label map `{security: "lbl-1"}` and a catalogue row tagged `["security","nolabel"]` · **W** `plane-sync.mjs` builds the create/patch payload for that row · **T** payload has `labels: ["lbl-1"]`; the run log contains `tag "nolabel" has no Plane label in BUGS — skipped`; the row's registry-hash differs from the hash of the same row with no tags | R8 states the exact log line and that unresolved tags are skipped, not fatal; the hash-input rule (`\|tags:<sorted joined>` appended only when tags exist) means adding a tag necessarily changes the hash | `scripts/campaign/plane-sync.self-test.mjs` (existing) | `plane-sync.mjs` never touches `label` today (context-pack §2: "zero `label` hits in file") — no payload carries `labels` and no such log line exists |

### 2.1 Expanded cases

No case needs expansion beyond the table — every oracle above is a literal value stated in
Fable's ruling (a regex, a count, a log string, a state-machine rule), not derived from
reading the implementation.

---

## 3. Coverage matrix

| R# | Requirement (short) | Priority | Covered by | Deepest level of cover |
|---|---|---|---|---|
| R1 | `file --tag`: validate, dedupe, sort, write to catalogue + record | must | T1, T2 | integration |
| R2 | `tag <id> add\|remove`: idempotent, validated | must | T5 | integration |
| R3 | `list --tag`: AND-filter | must | T3 | integration |
| R4 | `stats`: `byTag` counts | must | T4 | integration |
| R5 | `show`: prints tags | must | T5 | integration |
| R6 | `sync`: preserves `tags` in front matter | must | T6 | integration |
| R7 | `already-fixed <id> --pr --why`: locked state transition | must | T7 | integration |
| R8 | `plane-sync.mjs`: tag → label resolution in payload + hash | must | T8 | integration |
| R9 | F49 audit backfill (33 rows filed/discharged) | must | — (manual, see §1) | manual |
| R10 | docs updated (index, testing program, skill, CONTEXT.md) | should | — (manual, see §1) | manual |

**Reverse check — every T# names an R#:**

| T# | proves | Would it still pass with the feature removed? (must be "no") |
|---|---|---|
| T1 | R1 | no — with `--tag` unhandled, the row carries no `tags` key at all |
| T2 | R1 | no — with no validation, `Bad_Tag` would be accepted (exit 0) |
| T3 | R3 | no — with no `--tag` filter, `list --tag security` would list everything (or error on the unknown flag) |
| T4 | R4 | no — `stats` output would have no `byTag` key |
| T5 | R2, R5 | no — `tag` is an unknown subcommand; `show` prints no `tags` line |
| T6 | R6 | no — there is no `tags` field for `sync` to preserve or drop |
| T7 | R7 | no — `already-fixed` is an unknown subcommand |
| T8 | R8 | no — the payload has no `labels` key and the log line never fires |

**Deliberately untested requirements**:

- `R9` — data-filing, not code; compensating control is P3's own brief (verify next id
  first, verify the 4 UNREVIEWED findings in source before filing) plus a post-hoc
  `bugs.mjs list --batch F49` / `stats` review by the implementer, reported in the package
  output.
- `R10` — documentation; compensating control is manual diff review during P4, since
  prose has no automated oracle.

---

## 4. Negative tests — what must NOT happen

| ID | Must NOT happen | Level | Assertion | File |
|---|---|---|---|---|
| T2 | an invalid tag string (`Bad_Tag`) is written to the catalogue | integration | exit 1; catalogue row count unchanged; stderr names the bad tag | `scripts/campaign/bugs.mjs` |
| T5 | `tag` on an unknown bug id silently no-ops or creates a row | integration | `tag B999 add x` exits 1; no row for `B999` exists afterward | `scripts/campaign/bugs.mjs` |
| T7 | `already-fixed` fires twice on the same row, or fires from a state other than `queued`/`in-flight` | integration | second call exits 1; ledger row from the first call is unchanged by the second attempt | `scripts/campaign/bugs.mjs` |
| T7 | `already-fixed` is accepted with a missing or under-20-char `--why` | integration | exit 1; no ledger write occurs (state stays `queued`) | `scripts/campaign/bugs.mjs` |
| T8 | an unresolved tag is silently dropped with no trace | integration | the run log names the specific unresolved tag; the resolved sibling tag still resolves to its label | `scripts/campaign/plane-sync.self-test.mjs` |

---

## 5. Property-based invariants

Touched: `none touched` — this change adds tag metadata and one ledger state transition; it
does not touch money, quantities, dates, or permissions. (F10-005, the one money-math
finding in the R9 backfill, is filed queued with a notes-only entry — no code change, no
invariant to test here.)

**Library:** none — not applicable, no property-based tests in this plan.

---

## 6. Red gate

```bash
node scripts/campaign/bugs.mjs self-test
node scripts/campaign/plane-sync.self-test.mjs
```

| T# | Expected failure message (approximate) | Failure kind |
|---|---|---|
| T1 | `check("tag dedup+sort") — got: <tags missing or unsorted>, want: ["audit-2026-06","security"]` | assertion |
| T2 | `check("bad tag rejected") — got: exit 0 / catalogue grew, want: exit 1, catalogue unchanged` | assertion |
| T3 | `check("list --tag filter") — got: <untagged id present or unknown-flag error>, want: <only tagged id>` | assertion |
| T4 | `check("stats byTag") — got: <no byTag key>, want: {security:1}` | assertion |
| T5 | `check("tag add/remove/unknown-id") — got: <unknown subcommand error>, want: <idempotent tags, exit 1 on B999>` | assertion |
| T6 | `check("sync preserves tags") — got: <tags absent, nothing to preserve>, want: ["security"]` | assertion |
| T7 | `check("already-fixed transition") — got: <unknown subcommand error>, want: state already-fixed / pr 84 / evidence set` | assertion |
| T8 | `check("plane label payload") — got: <no labels key, no skip log line>, want: labels:["lbl-1"], skip-log for "nolabel"` | assertion |

Rules for the gate:

- A failure that is not an assertion means the test is broken, not the feature missing —
  fix the test, one remediation round, then re-run.
- Every new-subcommand test (T5, T7) is expected to fail via the self-test's own `check()`
  equality mismatch (an "unknown command" string compared against the wanted state), not
  via a thrown import/module error — `runCli()` already handles unknown subcommands as a
  normal (non-throwing) path per the existing `cmds` dispatch, so this stays an assertion
  failure, not a wiring error.
- Record the actual red output before P1/P2 implementation starts.

---

## 7. Test data and fixtures

| Need | How the test creates it | Scope / isolation | Cleanup |
|---|---|---|---|
| an isolated bug registry | `mkdtempSync` + `BUGS_ROOT` env var, exactly as every existing self-test block does (context-pack §1, L2881–7238 pattern) | one temp dir per test block | OS temp dir; not committed, not shared across test blocks |
| a filed row in a known state | `runCli(['file', ...])` / direct `cmds.file()` call against that temp `BUGS_ROOT` | disposable, created fresh in the block | discarded with the temp dir |
| a stub Plane label map | a literal `{security: "lbl-1"}` object passed directly to the payload-building function under test (per T8's Given) | in-process, no network call | none needed — no external state |

- Never assert against data anyone or anything else can change — every fixture above is a
  fresh `mkdtemp` registry or an in-process stub.
- Auth/session state: not applicable — these are CLI/file-based tests, no login flow.
- No real Plane credentials or network calls are used by T8 — the label map is stubbed in
  the self-test per R8/T8 as specified; this stays consistent with the project's fail-closed
  rule for external-system hooks (lesson L-111, cited in the context pack).

---

## 8. UI flows to drive (Playwright)

Not applicable — this change has no UI surface (CLI + Plane sync only). No
`uiVerify` block in the build plan.

---

## 9. Mutation probe targets

Not applicable at `scale: small` — per the dev-pipeline skill, small scale merges the base
review lenses into one reviewer with no refutation and no mutation probe. The red gate in
§6, driving the real `cmds.*`/`plane-sync` payload builder over real fixtures, is the
quality bar for this run.

---

## 10. Flake risks

| Risk | Where | How it is removed (removed, not retried) |
|---|---|---|
| shared/mutable fixture data across test blocks | `bugs.mjs` self-test, `plane-sync.self-test.mjs` | each T# uses its own fresh `mkdtemp` `BUGS_ROOT` (or in-process stub for T8) — the existing pattern already in the file, not something this plan introduces |
| ordering dependence between tests | same files | each block builds its own state from an empty registry; no test reads another test's temp dir |
| network or third-party call | T8 (Plane) | the label map is stubbed in-process per R8/T8 — no real `plane-client.mjs` HTTP call is made in the red gate |

---

## 11. Regression watch

- **Runs on every push:** both self-test commands in §6 — they are already part of the
  `verify` chain per context-pack §3 (`bugs.mjs self-test`, and all `plane-*.self-test.mjs`
  files including `plane-sync.self-test.mjs`), so T1–T8 ride that existing gate with no new
  CI wiring.
- **Runs nightly or on demand:** none beyond the above — this is a small-scope CLI change.
- **How this regresses unnoticed in six months, and the check that catches it:** a future
  edit to `frontFor` (L1205) that starts explicitly enumerating `tags` (instead of relying
  on the pass-through merge T6 protects) would silently start dropping tags on `sync` —
  caught only if T6 keeps running in `verify`, so T6 must never be removed from the
  self-test block even if its assertion looks "obviously true" later.
- A green replay from a build cache is not evidence a test ran — trust only the self-test
  script's own printed `check()` results (RAISED: this worktree has no CI config visible in
  the context pack beyond `verify`'s script chain; whether `verify` itself ever runs from a
  Turbo/Jest cache for these two pure-node scripts was not stated in the ruling — treat as
  TBD and confirm against `package.json`'s `verify` script before relying on cache-freshness
  guarantees here).
