# Build plan: bugs.mjs --tag, Plane label mapping, F49 audit backfill

> **Stage S5 — "how".** Authored by Fable 5 on `2026-09-12`.
> Status: `IMPLEMENTED` (2026-09-12; the launching session ended after Fix round 2 and 2 fix
> rounds, so Verify/Mutation probe/Final pass never ran automatically — hand-verified in a
> fresh session instead: `bugs.mjs self-test`, `plane-sync.self-test.mjs`, `bugs.mjs stats`
> all green. R1-R9 confirmed (self-test T1-T8 + a manual `list --tag security` count of 39).
> R10 done for 3 of 4 docs; the conditional 4th (`CONTEXT.md`, "IF tracked in git") was
> correctly skipped against this worktree's base `0654d47d` snapshot, but `CONTEXT.md` IS
> tracked on current master — **still open, must be added before/at merge** (see the
> build-plan's own RAISED note). One finding deliberately left open, not re-litigated:
> `plane-sync.mjs:877` (Plane label scope on untagged rows) — see
> `.claude/pipeline/2026-09-12-security-registry-tags/result.json`'s `remainingFindings[0]`.
> Not yet committed, PR'd, or merged.
> Written AFTER [test-plan.md](./test-plan.md) — the tests decide the shape of the work.
> This file is the ONLY context the implementation and review agents receive.

**Gate to pass before S6:** every work package declares `satisfies:` (R#s) and
`provenBy:` (T#s).

**Ground rule — nothing named here may be invented.** Every path/command below is checked
against the repo by the Baseline phase before any agent writes a line.

---

## Preamble (small scale)

- **Problem:** Security findings are split across a gitignored audit, a status index, and
  six registry rows; the registry cannot filter "security" and cannot represent a finding
  fixed in an earlier PR without a fake proof.
- **Who hits it:** The owner, and every session that picks up security work.
- **Workaround today:** Reading three documents by hand; it fails because statuses drift —
  9 of 12 "UNREVIEWED" findings in the audit index were already fixed.
- **Success signal:** `node scripts/campaign/bugs.mjs list --tag security` lists every
  2026-06 audit finding (6 existing + 33 new) with a truthful ledger state. Baseline today:
  0 rows carry a tag.
- **Requirements** *(the `R#` that each package's `satisfies:` and each `T#` point at)*:
  - `R1` — `bugs.mjs file --tag <name>` (repeatable, and space-separated like `--files`):
    validated `^[a-z0-9][a-z0-9-]*$` (invalid → exit 1, no row written, message names the
    bad tag); deduped and sorted; written as `tags: [...]` on the catalogue row (key
    omitted when empty) and into the record front matter next to `files`.
  - `R2` — `bugs.mjs tag <B###> add|remove <name...>`: same validation; idempotent; updates
    catalogue row and record front matter; unknown id → exit 1.
  - `R3` — `bugs.mjs list --tag <name>`: AND-filter with existing `--open`/`--sensitive`/
    `--batch`; rows print their tags when present.
  - `R4` — `bugs.mjs stats`: adds `byTag` counts.
  - `R5` — `bugs.mjs show`: prints tags.
  - `R6` — `bugs.mjs sync`: leaves `tags` in front matter intact (the front-matter merge at
    L1501 already preserves unknown keys — this change asserts, not re-derives, that).
  - `R7` — `bugs.mjs already-fixed <B###> --pr <n> --why "<text ≥ 20 chars>"`: sets ledger
    row `state:"already-fixed"`, `pr:<n>`, `evidence:<why>` via the same locked upsert path
    `discharge` uses (L2408 pattern); allowed only from `queued`/`in-flight`; missing or
    short `--why`, or a missing row, → exit 1 with no write.
  - `R8` — `plane-sync.mjs`: once per run resolve BUGS project labels
    (`client.resolveLabels(projectId)`, `Map<lowercase name,id>`); send `labels: []` for a row
    with no tags (so dropping a row's last tag clears the labels the mirror set),
    `labels: [ids]` for the tags whose lowercase name resolves, and omit the key only when a
    row has tags but none of them resolve; unresolved
    tags logged once per run (`tag "<x>" has no Plane label in BUGS — skipped`);
    `--dry-run`/`--check` never write; tags participate in the registry-hash input so a tag
    change produces a patch.
  - `R9` — backfill data: tag B355..B360 `add security`; file 33 rows into batch F49; see
    P3 below for the exact filing plan (27 `already-fixed`, 2 stay queued with notes, 4
    UNREVIEWED verified in source first).
  - `R10` — docs: `security-findings-index.md` gets a `Registry` column + intro sentence;
    `security-testing-program.md` §8 gets a "Tracking rule" paragraph;
    `bug-registry/SKILL.md` gets a `## Security findings` section; `CONTEXT.md` gets one
    line IF tracked in git.
- **Non-goals (the scope fence):** no Plane label creation; no change to prove/discharge
  semantics; no CVSS field; no re-audit of fixed findings beyond the 4 UNREVIEWED; no
  backfill of Plane beyond the next `plane:sync` after merge; F2-MATRIX is not filed.

**Deploy-day:** docs/registry only; the Plane BUGS mirror applies labels on the next
`plane:sync` after merge; no backfill of Plane needed beyond that.

**Rollback:** revert the commit; rows are additive.

**RAISED:** `CONTEXT.md` is not tracked in this worktree's git index (`git ls-files
CONTEXT.md` returns nothing here) — R10's "IF the file is tracked in git" branch resolves
to **skip** for this worktree. P4 should re-check `git ls-files CONTEXT.md` against the
landing tree before merge, since the ruling only conditions on git tracking, not on this
worktree's snapshot.

---

## Constraints & conventions

- **Stack / framework:** pure Node scripts (`scripts/campaign/bugs.mjs`,
  `scripts/campaign/plane-sync.mjs`) — no framework, no build step.
- **Test runner and layout:** each script's own in-file self-test block, run directly with
  `node <script> self-test` / `node <script>.self-test.mjs`; no Jest/Playwright involved.
- **Lint / format rules that will fail the gate:** none runnable in this worktree — no
  `node_modules` here (context-pack §3); `npx prettier --write` is unavailable, so
  `formatCommand` is omitted.
- **Existing patterns to copy rather than invent:**
  - `fileSet(id)` (L7564, `raw.split(" ").filter(Boolean)`) — the space-split pattern for a
    single repeated/space-joined flag; there is no existing repeated-flag precedent, so
    `--tag` must collect **every** `--tag` occurrence (a new `flags(args,name)` helper
    returning an array, unlike `flag()` at L192 which returns one value) and then split each
    collected value on spaces, matching how `--files "a.ts b.ts"` is one space-joined flag
    today.
  - `cmds.discharge` (L2408) and its `withShardLock`/`withCatalogueLock` locking (L1952/1967)
    — the pattern `already-fixed` must mirror, including `upsertLedgerRow(batch, {...},
    {mustBeNew:...})`-style usage and `dropLedgerRow` (L2074) as the inverse where relevant.
  - `resolveLabelIds(ctx,names,index)` in `plane-apply.mjs` (L130, fails loudly on an
    unresolved name) — the pattern to copy for plane-sync.mjs's tag→label resolution,
    adapted to *log and skip* per row rather than fail the whole run (R8 says "skipped," not
    "abort").
- **Design system source:** not applicable — no UI.
- **Must NOT change:** `frontFor`'s fixed key set (L1205) itself; the `campaign-check.mjs`
  `EVIDENCE_ONLY_STATES`/`CLAIM_STATES` enums (already include `already-fixed` — no edit
  needed there); existing subcommands' current behavior for rows with no `tags`.
- **Do-not-introduce list:** no Vitest, no Biome, no new HTTP client, no root-level test
  runner (repo-wide `CLAUDE.md` "DO NOT introduce" list).
- **Landmines:**
  - `readCatalogue`/`writeCatalogue`/`readState` (L151/159/166) do zero schema validation —
    a malformed `tags` value would be written without complaint; validation must happen at
    the command layer (`cmds.file`, `cmds.tag`), not assumed from storage.
  - The worktree has 0 `node_modules` — do not add a verification command that needs one.
  - `already-fixed` today exists only as (a) an evidence-only **state name** in
    `campaign-check.mjs`'s `EVIDENCE_ONLY_STATES` (L125/L133) and (b) a self-test JSONL
    fixture string inside `bugs.mjs`'s `["self-test"]` block — it is not a `bugs.mjs`
    subcommand; do not assume any existing CLI wiring for it beyond those. (An earlier
    draft of this line cited `campaign-check.mjs` L6737; that file is 978 lines long, so
    the line number and the file were both wrong.)

---

## Test packages

### TP1 — tests-bugs
- **writes:** `scripts/campaign/bugs.mjs` (self-test block only — existing file, editing
  the `["self-test"]` section at L2881–7238; no new file)
- **tests:** T1, T2, T3, T4, T5, T6, T7
- **brief:** For each T#, add a self-contained block using the existing
  `mkdtempSync`+`BUGS_ROOT` + `check(name,got,want)` pattern (L2907, JSON-equality, exits 1
  on mismatch) and real `cmds.*`/`runCli()` calls (L2836). Use the exact Given/When/Then and
  oracle stated for that T# in test-plan.md §2 — do not invent a different expected value.
- **must fail with:** the `check()` assertion mismatches listed in test-plan.md §6 (e.g. for
  T1: `tags` missing/unsorted vs. `["audit-2026-06","security"]`; for T5/T7: an
  unknown-subcommand result vs. the wanted idempotent/locked-transition behavior).
- **effort:** medium

### TP2 — tests-plane
- **writes:** `scripts/campaign/plane-sync.self-test.mjs` (existing file)
- **tests:** T8
- **brief:** Add a case with a stub label map `{security: "lbl-1"}` and a catalogue row
  tagged `["security","nolabel"]`; assert the built payload's `labels` equals `["lbl-1"]`,
  the run log contains `tag "nolabel" has no Plane label in BUGS — skipped`, and the row's
  registry-hash differs from the hash of the same row with no tags. HARNESS FIX REQUIRED FIRST: today this self-test prints `plane-sync.self-test: 1 FAILURE(S)` yet exits 0 (hollow gate) and its F4 check counts every `plane-sync-self-test-*` dir in the OS temp dir, so stale dirs from earlier runs fail it. Make the harness set a non-zero exit code when any check fails, and make F4 compare the set of temp dirs after the run against a snapshot taken before it (only dirs created by this run count). Then add T8.
- **must fail with:** no `labels` key on the payload; no matching log line — per test-plan.md
  §6 T8.
- **effort:** medium

**Red gate command**:

```bash
node scripts/campaign/bugs.mjs self-test
node scripts/campaign/plane-sync.self-test.mjs
```

---

## Work packages

Rules: file lists across packages are disjoint. `P3` depends on `P1` (needs the new CLI
surface to file/discharge with). `P4` depends on `P3` (needs the id map for the docs'
`Registry` column).

### P1 — bugs-tags
- **files:** `scripts/campaign/bugs.mjs` (non-test code only — disjoint from TP1's
  self-test-block edits)
- **satisfies:** R1, R2, R3, R4, R5, R6, R7
- **provenBy:** T1, T2, T3, T4, T5, T6, T7
- **dependsOn:** none
- **effort:** medium
- **brief:** Implement R1–R7 exactly as specified in the Preamble above. Key transplants:
  - Add `flags(args,name)`: collects **every** occurrence of `--name` in `args` (unlike
    `flag()` at L192, which returns only the next single token after the first
    occurrence), returning an array of raw values.
  - Tag normalization: for every raw value returned by `flags(args,'tag')`, `.split(' ')`
    (mirroring `fileSet`'s `raw.split(" ").filter(Boolean)` at L7564), flatten, validate each
    against `/^[a-z0-9][a-z0-9-]*$/` (invalid → print the bad tag, exit 1, no write), then
    `[...new Set(x)].sort()`.
  - `cmds.file` (L315 region): add `tags` to the ledger/catalogue row pushed at the existing
    L406 push, and pass `tags` into the `writeRecord(id, {...rec.front, tags}, rec.body)`
    call alongside the existing `files` handling at L446 — same shape, omit the key when the
    resulting array is empty.
  - New `cmds.tag`: `tag <B###> add|remove <name...>` — validate each name with the same
    regex; `add` unions into the existing (deduped/sorted) tag set, `remove` filters it out;
    write the resulting set back to both the catalogue row and the record front matter (or
    omit the `tags` key entirely if it becomes empty); an id absent from the
    catalogue/ledger → exit 1.
  - `cmds.list` (L1022 region): accept `--tag <name>` and AND it with the existing
    `--open`/`--sensitive`/`--batch` filters; print a row's tags when present.
  - `cmds.stats` (L1041 region): add a `byTag` counter alongside the existing
    `bySeverity`/`byState`/`sensitive` counts.
  - `cmds.show` (L1586 region): print `tags` when present.
  - `cmds.sync` (L1466/1501 region): no code change needed for preservation itself (the
    existing `{...rec.front, ...frontFor(bug,st)}` merge already preserves `tags` since it
    is not one of `frontFor`'s output keys) — T6 exists to assert this stays true; do not
    add `tags` to `frontFor`'s fixed key set.
  - New `cmds['already-fixed']`: `already-fixed <B###> --pr <n> --why "<text>"` — mirror
    `cmds.discharge`'s locking (`withShardLock`/`withCatalogueLock`, L1952/1967) and its
    `upsertLedgerRow(batch, {...row, state:"already-fixed", pr, evidence:why})` call
    (discharge's L2408 pattern); allow the transition only when the row's current state is
    `queued` or `in-flight`; require `--why` to be a string of at least 20 characters and
    `--pr` to be present, else exit 1 with no write.
  - Register `tag` and `already-fixed` in the `cmds` dispatch table (L261) and in the
    unknown-command usage/help list.
- **exact code:** none of the tricky logic reduces to a short literal snippet worth
  transplanting verbatim beyond the regex and the `[...new Set(x)].sort()` idiom already
  named inline above — the implementer follows the described transplant points against the
  named line numbers.

### P2 — plane-labels
- **files:** `scripts/campaign/plane-sync.mjs`
- **satisfies:** R8
- **provenBy:** T8
- **dependsOn:** none
- **effort:** medium
- **brief:** Implement R8 exactly as specified. Key transplants:
  - Resolve labels lazily, once per run: `let labelMap = null; async function
    labelsFor(client, projectId) { if (!labelMap) labelMap = await
    client.resolveLabels(projectId); return labelMap; }` (per `resolveLabels` at
    `plane-client.mjs` L557, returning `Map<lowercase name,id>`).
  - In the payload builder (near the existing `client.patch`/`client.post` call sites at
    L747/808/780/850/860), for a catalogue row with `tags`, resolve each lowercase tag name
    against the label map; send `labels: []` when the row has no tags, `labels: [ids]` when any
    tag resolves, and omit the key only when the row's tags all fail to resolve (an omitted
    key leaves Plane's existing labels untouched; `[]` is what clears a stale label once a
    row's last tag is dropped); log
    `tag "<x>" has no Plane label in BUGS — skipped` exactly once per run per unresolved tag
    name (not once per row) — model the loud-fail shape of `resolveLabelIds` in
    `plane-apply.mjs` (L130) but replace its throw with a one-time log + skip, since R8 says
    "skipped," not "abort the run."
  - Hash input: append `|tags:<sorted joined>` to the existing registry-hash input string
    (feeding `buildDescriptionHtml`'s `registry-hash: <sha256>` line, L219–236) only when the
    row has tags — an untagged row's hash input, and therefore its hash, must be byte-for-
    byte identical to today's, so untagged rows do not spuriously re-sync.
  - `--dry-run`/`--check` (L666–700) must never write regardless of label resolution — no
    change to that gate's existing behavior.
- **exact code:** the lazy-resolution helper above (`labelsFor`) is given verbatim; the
  hash-input append follows the same "only when non-empty" shape already used for `tags` on
  the catalogue row in P1; the payload `labels` key does NOT — it follows the three-outcome
  rule above (`[]` / resolved ids / key omitted).

### P3 — backfill
- **files:** `.claude/campaign/**` (`bugs.jsonl`, `status/F49.jsonl`, `bugs/B*.md`) — data
  only, no script changes
- **satisfies:** R9
- **provenBy:** manual review (see test-plan.md §3 "Deliberately untested requirements")
- **dependsOn:** P1 (needs `--tag`, `tag`, and `already-fixed` to exist)
- **effort:** medium
- **brief:** Run the CLI from the worktree root with `BUGS_ROOT` set to this worktree's
  `.claude/campaign` path (per the cwd trap in the project's lessons register — always set
  `BUGS_ROOT` explicitly rather than relying on cwd). Steps, in order:
  1. Verify `max id + 1` over the current catalogue∪ledger. The ruling's expectation is
     B361–B393 in filing order; if the actual next id differs, **keep the same filing
     order** and report the discrepancy rather than renumbering by hand.
  2. `bugs.mjs tag B355 add security` through `B360` (the 6 existing rows).
  3. File the 33 new rows into batch F49 (`--batch F49 --tier T1`, tags `security
     audit-2026-06`, severity from the audit index, `--location "Security · <area from the
     finding's index section>"`, `--symptom` = the index's one-line description; PoC-free —
     no exploit detail in the filed row).
  4. For each of the 27 FIXED findings (F1-001, F1-002, F2-001, F2-003, F3-001, F3-002,
     F8-001, F4-001, F5-001, F5-002, F6-001, F9-001, F9-004, F11-001, F2-002, F3-004,
     F5-004, F12-002, F2-005, F2-006, F2-007, F4-002, F9-007, F9-008, F9-009, F10-003,
     F12-004), immediately run `already-fixed <id> --pr <first PR cited in the index>
     --why "..."` — for the "nc" (no PR number) rows, use `--pr 691` with
     `--why "re-verified in source 2026-09-11 at <file:line from the index>"`.
  5. The 2 PARTIAL findings (F12-001, F12-003) stay `queued`; add a
     `note --section "Summary"` citing the remainder for each, and for F12-003 also cite
     Plane ROAD-67.
  6. The 4 UNREVIEWED findings (F8-003, F10-002, F10-004, F10-005) are verified in current
     source **first**, by reading the relevant code: if the implementer's read shows the
     issue is fixed, file it and immediately `already-fixed --pr 691 --why "<file:line
     evidence>"`; if still present, leave it `queued` and write the four standard notes
     (Root cause / User impact / Fix approach and UX / Test plan) derived from that code
     read — F10-005 (invoice tax base for boxed products) is money math, so its Fix
     approach and Test plan notes are **plan-only**, no code change in this run.
  7. F2-MATRIX is NOT filed (informational, out of scope per the Non-goals above).
  8. Run `bugs.mjs sync` then `bugs.mjs stats`.
  9. Report the actual id map (audit-finding-id → B### assigned) in the package output —
     P4 needs this for the docs' `Registry` column.
- **exact code:** none — this package is CLI invocations against real data, not source
  code; the exact `--why`/`--location`/`--symptom` string content is drawn from the audit
  index at run time, not authored here.

### P4 — docs
- **files:** `docs/audit/security-findings-index.md`,
  `docs/security/security-testing-program.md`, `.claude/skills/bug-registry/SKILL.md`
- **satisfies:** R10
- **provenBy:** manual review (see test-plan.md §3)
- **dependsOn:** P3 (needs the id map to fill the `Registry` column)
- **effort:** medium
- **brief:**
  - `security-findings-index.md`: add a `Registry` column (the B### from P3's id map, or
    `ROAD-64` for the one row that is F2-MATRIX) to every existing table row (context-pack
    §7 notes the header shape `| ID | Title | Status |` repeats at L18/24/44/56/77 — add the
    column to each of those tables); add the intro sentence "The bug registry is the system
    of record for every security finding; this index maps audit ids to registry ids."
  - `security-testing-program.md`: under `## 8. Backlog catalogue (standing reference)`
    (context-pack §7, L215), add a short "Tracking rule" paragraph: every finding from a
    review, scanner, DAST, pentest or audit is filed with `--tag security`, PoC-free,
    severity by CVSS band (Critical ≥ 9.0 / High 7.0–8.9 / Medium 4.0–6.9 / Low < 4.0),
    fixed-elsewhere via `already-fixed`.
  - `bug-registry/SKILL.md`: add a `## Security findings` section with the same convention,
    plus `list --tag security` and `already-fixed` usage examples.
- **exact code:** none — prose edits only.

### Package map

| WP | satisfies | provenBy | dependsOn | Wave |
|---|---|---|---|---|
| P1 | R1, R2, R3, R4, R5, R6, R7 | T1, T2, T3, T4, T5, T6, T7 | — | 1 |
| P2 | R8 | T8 | — | 1 |
| P3 | R9 | manual | P1 | 2 |
| P4 | R10 | manual | P3 | 3 |

Cross-check: every `R#` (R1–R10) appears in some package's `satisfies:`; F2-MATRIX's
exclusion is stated as a non-goal, not silently dropped. Every `T#` (T1–T8) appears in
P1/P2's `provenBy:`.

---

## Acceptance criteria

1. `R1` — `bugs.mjs file --tag a --tag "b c"` writes a deduped, sorted `tags` array to both
   the catalogue row and the record front matter; an invalid tag name exits 1 with no write.
2. `R2` — `bugs.mjs tag <id> add|remove <name>` is idempotent and rejects an unknown id.
3. `R3`/`R4`/`R5` — `list --tag`, `stats`'s `byTag`, and `show`'s tag printing all reflect
   the tags written by R1/R2.
4. `R6` — running `sync` on a tagged row leaves its `tags` front matter untouched.
5. `R7` — `already-fixed` sets the ledger row's state/pr/evidence exactly once from
   `queued`/`in-flight`, and refuses a second call or a short `--why`.
6. `R8` — a catalogue row's Plane payload carries `labels: [ids]` for every tag that
   resolves, `labels: []` when the row has no tags, and omits the key only when the row's
   tags all fail to resolve; it logs a skip line for every tag that does not resolve, and its
   registry-hash changes when its tags change.
7. `R9` — `bugs.mjs list --tag security` lists 39 rows (6 existing + 33 new) after the
   backfill, each with a truthful state (`already-fixed` for the 27+N verified-fixed rows,
   `queued` for the 2 PARTIAL + any still-present UNREVIEWED rows).
8. `R10` — the four named docs carry the stated additions; `F2-MATRIX` is referenced only
   as `ROAD-64` in the index, never filed as a bug row.
9. Negative case: an unauthorized/invalid tag, a duplicate `already-fixed` call, and a
   short `--why` are all refused exactly as in test-plan.md §4 — none silently succeeds.
10. Deploy day: existing untagged rows are unaffected — their catalogue shape, front
    matter, and Plane payload/hash are byte-for-byte identical to before this change.

---

## Verification commands

Per round:

```bash
node scripts/campaign/bugs.mjs self-test
node scripts/campaign/plane-sync.self-test.mjs
```

Final (same two, run once at the end):

```bash
node scripts/campaign/bugs.mjs self-test
node scripts/campaign/plane-sync.self-test.mjs
node scripts/campaign/bugs.mjs stats
```

`campaign-check.mjs` cannot run in this worktree — `.campaign/runs/` is absent here
(context-pack §3); CI's own `verify` chain covers it on the landing tree. No
`formatCommand` — `npx prettier --write` is unavailable without `node_modules` in this
worktree.

---

## UI verification

Not applicable — no UI surface in this change.

---

## Risks & rollback

| Risk | Likelihood | Blast radius | Mitigation / what the reviewer should watch |
|---|---|---|---|
| an invalid or malformed tag reaches the catalogue/Plane payload | low | cosmetic (bad label in Plane) | T2's validation-rejection test; regex enforced at the command layer, not storage |
| `already-fixed` fires on the wrong row or double-fires | low | data integrity (a real bug marked fixed when it is not) | T7's locked-transition + idempotency-refusal tests; mirrors the already-reviewed `discharge` locking pattern |
| the 4 UNREVIEWED findings are misjudged during P3's source read | medium | a real, unfixed security finding gets marked `already-fixed` | P3's brief requires the code read to happen before filing, not after; F10-005 is explicitly carved out as plan-only |
| an untagged row's Plane hash changes unintentionally, causing a spurious re-sync of every existing row | low | wasted Plane API writes, no data corruption | P2's brief requires the hash-input append to be conditional on the row having tags at all |

- **Rollback:** revert the commit; all writes are additive (new `tags` field, new
  `already-fixed` state, new registry rows) — no destructive migration.
- **Migration reversibility:** not applicable — no schema migration, plain JSONL/markdown
  registry files.
- **Feature flag / entitlement:** not applicable — internal tooling, no user-facing gate.
- **Deploy day:** docs/registry only; the Plane BUGS mirror applies labels on the next
  `plane:sync` after merge; no backfill of Plane needed beyond that (per the ruling).
- **Observability:** `plane-sync.mjs`'s run log is the signal — a spike in
  `has no Plane label in BUGS — skipped` lines after a docs/label change would indicate a
  label naming drift between the tag vocabulary and Plane's BUGS project labels.

---

## Pipeline args

```js
{
  planPath: 'C:/ClaudeCode/routeflow/.claude/worktrees/rf-secfile/.claude/pipeline/2026-09-12-security-registry-tags/build-plan.md',
  testPlanPath: 'C:/ClaudeCode/routeflow/.claude/worktrees/rf-secfile/.claude/pipeline/2026-09-12-security-registry-tags/test-plan.md',
  lessonsPath: 'C:/ClaudeCode/routeflow/.claude/worktrees/rf-secfile/.claude/lessons/LESSONS.md',
  startedAt: 'SET_AT_LAUNCH',

  scale: 'small',
  workdir: 'C:/ClaudeCode/routeflow/.claude/worktrees/rf-secfile',
  context: 'Add --tag support to bugs.mjs (file/tag/list/stats/show/sync), an already-fixed ledger state, Plane label mapping in plane-sync.mjs, and backfill 33 security-audit findings into batch F49.',

  testPackages: [
    {
      id: 'TP1', title: 'tests-bugs',
      files: ['scripts/campaign/bugs.mjs'],
      brief: 'Add self-test cases for T1-T7 (tag validation/dedup/sort, list --tag, stats byTag, show, sync preservation, already-fixed transition) using the existing mkdtempSync+BUGS_ROOT+check() pattern.'
    },
    {
      id: 'TP2', title: 'tests-plane',
      files: ['scripts/campaign/plane-sync.self-test.mjs'],
      brief: 'Add a self-test case for T8: stub label map, tagged row, assert payload labels + skip-log line + hash change.'
    }
  ],
  redGate: {
    commands: [
      'node scripts/campaign/bugs.mjs self-test',
      'node scripts/campaign/plane-sync.self-test.mjs'
    ],
    expect: 'fail'
  },

  packages: [
    {
      id: 'P1', title: 'bugs-tags',
      files: ['scripts/campaign/bugs.mjs'],
      brief: 'Implement R1-R7: flags() collector, tag validation/dedup/sort, cmds.file/tag/list/stats/show updates, already-fixed subcommand mirroring cmds.discharge locking, dispatch table registration.',
      satisfies: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'],
      provenBy: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']
    },
    {
      id: 'P2', title: 'plane-labels',
      files: ['scripts/campaign/plane-sync.mjs'],
      brief: 'Implement R8: lazy once-per-run label resolution, labels: [] for a row with no tags, resolved ids when any tag resolves, key omitted only when a row's tags all fail to resolve, per-run skip logging for unresolved tags, conditional hash-input append.',
      satisfies: ['R8'],
      provenBy: ['T8']
    },
    {
      id: 'P3', title: 'backfill',
      files: ['.claude/campaign/**'],
      brief: 'File 33 F49 rows + tag B355-B360; discharge 27 FIXED + verified-fixed UNREVIEWED rows via already-fixed; note the 2 PARTIAL + still-present UNREVIEWED rows; report the id map.',
      dependsOn: ['P1'],
      satisfies: ['R9'],
      provenBy: []
    },
    {
      id: 'P4', title: 'docs',
      files: [
        'docs/audit/security-findings-index.md',
        'docs/security/security-testing-program.md',
        '.claude/skills/bug-registry/SKILL.md',
        'CONTEXT.md'
      ],
      brief: 'Add Registry column + intro sentence to the findings index; Tracking rule paragraph in the testing program §8; Security findings section in bug-registry/SKILL.md; one line in CONTEXT.md if tracked in git.',
      dependsOn: ['P3'],
      satisfies: ['R10'],
      provenBy: []
    }
  ],

  verifyCommands: {
    perRound: [
      'node scripts/campaign/bugs.mjs self-test',
      'node scripts/campaign/plane-sync.self-test.mjs'
    ],
    final: [
      'node scripts/campaign/bugs.mjs self-test',
      'node scripts/campaign/plane-sync.self-test.mjs',
      'node scripts/campaign/bugs.mjs stats'
    ]
  },

  runDir: 'C:/ClaudeCode/routeflow/.claude/worktrees/rf-secfile/.claude/pipeline/2026-09-12-security-registry-tags'
}
```
