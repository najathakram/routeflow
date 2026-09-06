# Close-out prep — verified facts (read-only pass)

Worktree: `C:/ClaudeCode/routeflow/.claude/worktrees/rf-registry`, branch `feat/registry-guards`,
HEAD `c2de0712`, based on `master` `d12203a3`. `origin/master` now at `a94f9428` (4 commits ahead
of the branch's base; branch has 4 commits origin/master doesn't). All commands below were **run
read-only** (gh read commands, git read commands, grep/read on tracked files) — nothing was
written to the registry, no issue/PR was created, no `bugs.mjs` write command was executed.

---

## 1. Issue/PR numbering facts

**Issue #542** (`gh issue view 542 --json number,title,body,labels,milestone,state`) — state
`OPEN`, title:

> `F29 · Dead controls, copy and housekeeping`

Labels: `ready` (0e8a16, "Specified and safe for an agent to claim"), `kind:bug` (b60205),
`area:api` (bfd4f2). Milestone: `null`. Body, verbatim:

> Part of #512.
>
> Campaign batch **F29** — one dev-pipeline run, one PR, strictly serial merge.
> Brief: `.claude/pipeline/fix-cards/F29-*.md` · Ledger shard: `.claude/campaign/status/F29.jsonl` · Gate: `node scripts/campaign-check.mjs --batch F29`
>
> ## Done when
>
> - [ ] B03 (T1)
> - [ ] B05 (T3)
> - [ ] B06 (T2)
> - [ ] B07 (T3)
> - [ ] B22 (T3)
> - [ ] B36 (T2)
> - [ ] B38 (T3)
> - [ ] B39 (T3)
> - [ ] B173 (T3)
> - [ ] B174 (T2)
> - [ ] B178 (T2)
> - [ ] B179 (T2)
> - [ ] B184 (T1)
> - [ ] B187 (T2)
>
> ## Notes
>
> Plan: `read-the-bug-registry-scalable-gosling` (owner-approved). Register chips + user guide + code map ship inside this batch's PR window, per the owner mandate.

**F30/F31 issue search** (`gh issue list --search "F31 in:title" --state all --json number,title`
and the F30 equivalent) — both batches DO have board issues:

- `#549` — `F30 · Mobile scan-to-order loss hotfix (owner-reported, diagnosis in flight)`
- `#550` — `F31 · Mobile draft-invoice review before confirm + post-confirm item edit`

Naming convention confirmed across #542/#549/#550: `F## · <short description>` — no PR
cross-reference in the title text itself (the build-plan's proposed F32 title,
`F32 · HF-OCR · add-on gate observe-first (#616)`, adds a PR reference that #542/#549/#550 do not
carry — see §5 below for the naming-consistency call).

**Highest issue/PR number in the repo right now:** `gh api
"repos/najathakram/routeflow/issues?state=all&per_page=1&sort=created&direction=desc"` and the
`/pulls` equivalent both return **#632** — `docs(handoff): improvements program complete — final
state, traps, follow-ons` (this is a PR, so it is the same number in both listings since GitHub
shares one counter for issues and PRs). **The next free number is #633.**

---

## 2. PR / CI run facts

`gh pr view 616 --json number,title,state,mergedAt,mergeCommit`:

- title: `fix(api,web): observe-first add-on gates — registry, ocr dark, scan toast fidelity`
- state: `MERGED`, mergedAt `2026-09-05T14:57:32Z`
- mergeCommit.oid: `7281e4d733b2dc54ad8adeb305b2a624323e241e` — **matches the expected `7281e4d7`.**

`gh pr view 629 --json number,title,state,mergedAt,mergeCommit`:

- title: `fix(mobile,api): map ios location sentinels to null and accept accuracy (F25 B185)`
- state: `MERGED`, mergedAt `2026-09-06T03:27:54Z`
- mergeCommit.oid: `420eef71b77be6bf90231bee0133e2a8f2662cd8` — **matches the expected `420eef71`.**

`gh run view 33993841827 --json headSha,conclusion,displayTitle,event,createdAt,workflowName`:

- headSha `d12203a367fd0feb977940462a1a97a9e32f5897` — **matches expected `d12203a3`.**
- conclusion `success`, event `deployment_status`, workflowName `CI`, createdAt
  `2026-09-05T21:43:02Z`.
- Jobs (`--json jobs`): `E2E (Playwright)` → success, `Verify` → skipped.

`gh run view 34009128893` (same fields):

- headSha `420eef71b77be6bf90231bee0133e2a8f2662cd8` — **matches expected `420eef71`.**
- conclusion `success`, event `deployment_status`, workflowName `CI`, createdAt
  `2026-09-06T03:29:45Z`.
- Jobs: same shape — `E2E (Playwright)` success, `Verify` skipped.

**Playwright counts for run 33993841827** (`gh run view --log`, searched with `grep -n` for the
exact tokens — not `grep -r | head`):

- Overall: **130 passed, 26 skipped, 0 failed (4.8m)**.
- `e2e/30-recurring-standing.spec.ts:217` → `✓ 153 … REG-B92 the recurring-template edit page
persists a schedule and notes change through the validated PATCH (R26, R27 / T32) (3.0s)` — PASSED.
- `e2e/30-recurring-standing.spec.ts:317` → `✓ 154 … REG-B106 web leg — after Run Now the
recurring-template card shows the recorded Succeeded outcome (R16 / T33) (3.4s)` — PASSED.

Both match the build-plan's expectation exactly: REG-B92 (:217) and REG-B106 web leg (:317) both
passed in this run.

---

## 3. `scripts/campaign/bugs.mjs` — usage header + `prove`/`discharge`/`file`

### Usage header (verbatim, from the file's leading comment block)

```
// USAGE — every implemented command (`cmds.*` below is the source of truth;
// keep this list in sync with it, not the other way round):
//   node scripts/campaign/bugs.mjs import                     # seed the catalogue from the register HTML (owner-machine only)
//   node scripts/campaign/bugs.mjs file "<title>" --location "<where>" --severity high|medium|low|critical [--symptom "..."] [--batch F## --tier T1|T2|T3] [--files "a.ts b.ts"]   (--tier is required whenever --batch is given)
//   node scripts/campaign/bugs.mjs next [--json] [--no-claims]  # the next batch an agent may take (the head of wave 1)
//   node scripts/campaign/bugs.mjs waves [--cap N] [--hub-threshold N] [--json] [--no-claims]  # the parallel schedule
//   node scripts/campaign/bugs.mjs list [--open] [--sensitive] [--batch F09]
//   node scripts/campaign/bugs.mjs stats
//   node scripts/campaign/bugs.mjs expand                      # create/refresh one record per catalogue row
//   node scripts/campaign/bugs.mjs sync [--quiet] [--rescan] [--check]    # derive History from the ledger + an ANCHORED git scan (idempotent; Gate 4 runs this every turn)
//     --check: read-only; exits 1 naming records whose front matter lags the ledger (the pre-push self-test runs it on the real tree)
//   node scripts/campaign/bugs.mjs show <B###>
//   node scripts/campaign/bugs.mjs note <B###> "<text>" [--section "Root cause"]
//   node scripts/campaign/bugs.mjs index                        # rebuild bugs.jsonl from the records (regenerate, never hand-edit)
//   node scripts/campaign/bugs.mjs brief <F##|B###>             # everything an agent needs to start a batch, in one output
//   node scripts/campaign/bugs.mjs prove <B###> --pr <n> --proof "REG-B### ..." [--pending-deploy] [--build-plan <path>]  (--build-plan is REQUIRED for a T3 row)
//   node scripts/campaign/bugs.mjs discharge <F##> --evidence "<post-deploy proof>" [--evidence-B### "<per-row proof>"]   # per-row evidence is REQUIRED for every T2 row
//   node scripts/campaign/bugs.mjs reopen <B###> --why "<failing REG-B### token or the run that showed the regression>"
//   node scripts/campaign/bugs.mjs claim <F##>                  # flip that batch's workable rows to in-flight (next/waves skip it)
//   node scripts/campaign/bugs.mjs release <F##>                # give them back
//   node scripts/campaign/bugs.mjs tier <B###> <T1|T2|T3> --why "<reason>"
//   node scripts/campaign/bugs.mjs status [F##]                 # per-batch done/analysed counts
//   node scripts/campaign/bugs.mjs triage                       # catalogue bugs with no ledger row at all
//   node scripts/campaign/bugs.mjs move <B###> --to <F##> [--tier T1|T2|T3] [--why "<reason>"]   (an uncampaigned id needs --tier to get its first row)
//   node scripts/campaign/bugs.mjs enrich                       # pull the register's detail blocks + files into every record (owner-machine only)
//   node scripts/campaign/bugs.mjs deps [--bug B###] [--hub-threshold N] [--all]
//   node scripts/campaign/bugs.mjs render [--open]              # regenerate the derived HTML view
//   node scripts/campaign/bugs.mjs self-test                    # also runs as a step of `npm run verify`
```

### `cmds.prove` (line 2278) — flags and behavior

- **Signature**: `prove <B###> --pr <n> --proof "REG-B### ..." [--pending-deploy] [--build-plan <path>]`.
- Validates `--pr` is a positive integer BEFORE writing (guards against `Number("not-a-number")`
  → `NaN` → silently serialized as `null`).
- `--proof` must contain the literal token `REG-<id>` via `new RegExp(\`REG-${id}(?![0-9])\`)`—
a prefix match (e.g.`REG-B12`satisfying`REG-B120`) is explicitly rejected.
- `findShardOf(id)` must be non-null (`fail("${id} is in no ledger shard — file it with a --batch
first")`) — **`prove` operates on a per-bug id that already has a ledger row**, unlike `discharge`
  (below), which takes a batch.
- State written: `pending ? "proven-pending-deploy" : "proven"`. `--pending-deploy` is refused
  outright unless the row's `tier === "T2"` (`fail("--pending-deploy is for T2 rows only …")`).
- **T3 rows require `--build-plan`** or the whole `prove` fails — `campaign-check` discharges a T3
  row only from a `REG-B###` table row inside that build-plan's own "## Manual verification"
  section (checked via `hasManualVerificationRow`), and `prove` persists the repo-relative path
  into the row's `buildPlan` field.
- Re-proving a row already `proven`/`proven-pending-deploy` with a different PR/proof prints a
  `WARNING — overwriting an existing proof` (the old proof is not otherwise kept).
- The whole read → validate → write is done inside `withShardLock(batch, () => { … })` — one
  critical section, so a concurrent `prove` of a sibling row in the same shard cannot be erased by
  this one's stale `{ ...row }` spread.
- On success it also updates the record's front matter/History via `appendEvent`, keyed on
  `state-${state}-${pr}` (not just `state-${state}`) specifically so a second `prove` after a
  `reopen` logs a new History line instead of silently deduping into the first proof forever.
- **No `--why` flag anywhere in `prove`.**

### `cmds.discharge` (line 2395) — flags and behavior

- **Signature**: `discharge <F##> --evidence "<post-deploy proof>" [--evidence-B### "<per-row
proof>" ...]`.
- **Takes a BATCH id (`F##`), not a bug id** — `const batch = normBatch(args[0]);`.
- `--evidence` (and every `--evidence-B###`) must be ≥ 40 chars (`thin()` helper) — refuses
  anything that can't plausibly "cite the deploy and the run that proved it."
- Required starting state: only rows whose `state === "proven"` or `state === "proven-pending-
deploy"` are eligible (`const ready = rows.filter(...)`). If NO row in the batch is in either
  state, the whole command fails: `"${batch} has no proven row to discharge (states: …)"`.
- **A row already `done` is simply excluded from `ready` and untouched** — passing
  `--evidence-B### <text>` for an id that is not in `ready` (e.g. already `done`) is a hard
  failure: `"${flag}: ${id} is not a proven row in ${batch} — nothing to discharge for it"`, and
  the whole discharge writes nothing (validated before any write).
- **Every T2 row in `ready` requires its own `--evidence-B###`** or the whole discharge is refused
  (`missing.length` check) — a single batch-wide `--evidence` string is explicitly disallowed for
  T2 (that field is what `campaign-check` accepts in place of a Playwright artifact, so one string
  discharging every T2 row would defeat the control). T1/T3 use the batch-wide `--evidence` into
  the plain `evidence` field.
- Byte-identical (normalized: trim/collapse-whitespace/lowercase) evidence strings across the
  **whole ledger** (every shard, not just this batch) are refused, except three hard-coded
  grandfathered ids (`B24`, `B130`, `B154`) predating the rule.
- Locking: `withCatalogueLock(() => withShardLock(batch, () => { … }))` — catalogue outermost,
  same one-way order as `file`/`move` — because the evidence-uniqueness scan reads every OTHER
  shard's `dischargeEvidence` while holding only this batch's shard lock.
- Snapshots the shard file before any write and restores it whole on any throw (records restored
  BEFORE the shard, since a record is the more visible artifact).
- **No `--why` flag** (that's `reopen`/`tier`/`move`'s flag, not `discharge`'s).

### `cmds.file` (line 315) — flags and behavior

- **Signature**: `file "<title>" --location "<where>" --severity critical|high|medium|low
[--symptom "..."] [--batch F## --tier T1|T2|T3] [--files "a.ts b.ts"]` (`--tier` required
  whenever `--batch` is given).
- Id allocation is `max+1` over the UNION of the catalogue's ids AND every ledger shard's ids —
  explicitly never inferred from a gap ("reserved is not abandoned"), and done inside
  `withCatalogueLock` so two concurrent `file` calls can't allocate the same id.
- Builds `{ id, title, location, severity, symptom, register: "open", batch, source: "filed",
filedAt }`, classifies it (`classify(bug)` → `sensitive`/`sensitiveFor`), and — if `--batch` was
  given — builds the ledger row `{ state: "queued", ... }` and writes it via
  `upsertLedgerRow(batch, row, { mustBeNew: true })` **before** the catalogue write (so a refused
  ledger write never leaves an orphan catalogue row).

### State vocabulary (grep sites)

- `"proven-pending-deploy"` / `"proven"` are assigned only in `cmds.prove` (line 2310, `pending ?
"proven-pending-deploy" : "proven"`) and read as the `ready` set in `cmds.discharge` (2426).
- `"done"` is assigned only in `cmds.discharge`'s per-row loop (2501–2503: `own ? { state: "done",
dischargeEvidence: own, evidence: own } : { state: "done", evidence }`) and in the matching
  record write (`{ ...rec.front, state: "done", closed: "yes" }`, line 2519).
- There is **no `"discharged"` state anywhere in the file** — `grep -n '"discharged"'` returns
  nothing; the terminal ledger state is `"done"`.
- `"queued"` is the state `file`/`move` mint a fresh row into; `WORKABLE = new Set(["queued",
"regressed"])` (line 476) is what `next`/`waves` offer.

---

## 4. Ledger last-lines and SKILL.md close-out text

**F13.jsonl, all ids' current (last) state** (computed by replaying every line per id, not just
`tail -1` naively, since a shard can carry multiple lines per id):

| id       | state                     | tier | pr  |
| -------- | ------------------------- | ---- | --- |
| B09      | done                      | T2   | 612 |
| B46      | done                      | T1   | 612 |
| B48      | done                      | T1   | 612 |
| **B92**  | **proven-pending-deploy** | T2   | 612 |
| **B106** | **done**                  | T1   | 612 |

**B92's last line (full JSON), `.claude/campaign/status/F13.jsonl`:**

```json
{
  "id": "B92",
  "batch": "F13",
  "tier": "T2",
  "state": "proven-pending-deploy",
  "pr": 612,
  "proof": "REG-B92 jest (T29, T31) — T2 leg: apps/web/e2e/30-recurring-standing.spec.ts",
  "evidence": "NOT discharged. merged #612 (master d7dcf393); api deployment 99bff5cc-b318-4dad-b980-59ca155b28ff SUCCESS 2026-09-05 06:24:29 -05:00, web deployment ec51533f-0af6-4dad-8c3e-5b0565e7bd67 SUCCESS 2026-09-05 06:24:29 -05:00 (both at commitHash 1f6483ec, the #617 merge whose history contains d7dcf393); post-deploy-check 9/9; full jest re-run on master after merge. But REG-B92 (30-recurring-standing.spec.ts:203, \"the recurring-template edit page persists a schedule and notes change through the validated PATCH\") FAILED all 3 attempts in E2E run 33963335473: 'strict mode violation: getByRole(\"heading\", {name:\"Edit Recurring Template\"}) resolved to 2 elements' at :253 — an <h1> and an <h2> on the edit page carry the same text. A failing proof is not a discharge (L-041).",
  "roundSha": "e5b0af8e",
  "buildPlan": ".claude/pipeline/2026-09-01-F13-recurring-standing/build-plan.md",
  "dischargeEvidence": null
}
```

**B106's last line (full JSON) — B106 is ALREADY `done`:**

```json
{
  "id": "B106",
  "batch": "F13",
  "tier": "T1",
  "state": "done",
  "pr": 612,
  "proof": "REG-B106 jest: apps/api/src/recurring-invoices/recurring-invoices.schedule-outcome.spec.ts (T17, T17b, T17c, T18, T19) + apps/mobile/__tests__/recurring-invoices-helpers.test.ts (T22a–T22c)",
  "evidence": "merged #612 (master d7dcf393); api deployment 99bff5cc-b318-4dad-b980-59ca155b28ff SUCCESS 2026-09-05 06:24:29 -05:00, web deployment ec51533f-0af6-4dad-8c3e-5b0565e7bd67 SUCCESS 2026-09-05 06:24:29 -05:00 (both at commitHash 1f6483ec, the #617 merge whose history contains d7dcf393); post-deploy-check 9/9; full jest re-run on master after merge",
  "roundSha": "0cd59277",
  "buildPlan": ".claude/pipeline/2026-09-01-F13-recurring-standing/build-plan.md",
  "dischargeEvidence": "E2E run 33963335473 (event deployment_status, headSha 1f6483ec), job 'E2E (Playwright)': step 8 'Wait for the deployed app to match this commit' = success, step 9 'Run Playwright tests' = failure; 155 total — 125 passed, 3 failed, 27 skipped (6.6m). T1 row — discharged by its passing REG-B106 jest proof (api + mobile) re-run on master. Caveat: the separate web leg (30-recurring-standing.spec.ts:287) failed in this run as a cascade of REG-B92's locator ambiguity (\"the REG-B92 test did not leave a shared template id\"), not a product regression — tracked on the B92 row, which stays proven-pending-deploy."
}
```

**B106's fields**: `state: "done"`, `evidence` (see above, the long merge/deploy narrative),
`proof: "REG-B106 jest: apps/api/src/recurring-invoices/recurring-invoices.schedule-outcome.spec.ts (T17, T17b, T17c, T18, T19) + apps/mobile/__tests__/recurring-invoices-helpers.test.ts (T22a–T22c)"`,
`pr: 612`. **B106 was already discharged in an earlier session — the build-plan's step 3 (`discharge
F13 --evidence-B92 … --evidence-B106 …`) is stale**: `cmds.discharge` only operates on rows whose
state is `proven`/`proven-pending-deploy`; B106 is `done`, so passing `--evidence-B106` for it will
hit `fail("--evidence-B106: B106 is not a proven row in F13 — nothing to discharge for it")` and the
whole command will abort before writing anything (see §3, `cmds.discharge`'s `ready` filter). See §7
of this report for the exact fixed command.

**B185's last line (full JSON), `.claude/campaign/status/F25.jsonl` — ON THE BRANCH, still `queued`:**

```json
{
  "id": "B185",
  "batch": "F25",
  "tier": "T1",
  "state": "queued",
  "pr": null,
  "proof": null,
  "evidence": null,
  "roundSha": "0b2c3a0a"
}
```

(This branch has never touched F25/B185 — see §6, origin/master has already advanced it.)

### SKILL.md — "Closing out" command examples (verbatim)

```bash
# after the PR merges, per bug
npm run bugs -- prove B129 --pr 601 --proof "REG-B129 jest: cancelling a run leaves its orders sweepable"

# after a GREEN DEPLOY, per batch
npm run bugs -- discharge F11 --evidence "Railway deploy <id> SUCCESS; Actions run <id> E2E green against it" \
  --evidence-B129 "Actions run <id> job <id>: spec 28 REG-B129 passed against that deploy"
```

Two transitions, deliberately kept separate per the section's framing: "`proven` means merged with
a passing test, `done` means live after a green deploy." Both write the ledger replace-in-place and
update the record's front matter/History; never hand-edit `status/F##.jsonl`.

### SKILL.md — "Keeping the registry honest" section highlights

Locking model: `status/F##.jsonl` and `bugs.jsonl` are each locked with a `mkdir`-based lockdir
(atomic on NTFS and POSIX), held across the read AND the write. **Lock order is one-way and
load-bearing: catalogue lock OUTERMOST, shard lock(s) nested inside — never the reverse** — enforced
by a static self-test that parses `bugs.mjs`'s own source for a `withCatalogueLock(` nested inside a
`withShardLock(`. A lock is broken on the owner being **dead** (pid gone via `process.kill(pid,0)`,
or a `bootAt` mismatch proving a reused pid), never on age alone — age is a **last resort** (120s,
only when no `owner.json` exists at all).

---

## 5. Batch F32 freshness (confirmed stale/nonexistent) and F30/F31 naming

- **`board.json`**: `grep -n "F3" .claude/campaign/board.json` matches nothing under `"batches"` —
  the map stops at `"F29": 542`. **No F30, F31, or F32 entry exists in `board.json` at all**,
  even though #549 (F30) and #550 (F31) exist as GitHub issues — `board.json` is stale past F29.
- **`.claude/campaign/status/F32.jsonl`**: does not exist. `ls .claude/campaign/status/ | sort`
  shows shards F00–F30 only (30 files) — **no F31.jsonl and no F32.jsonl.**
- **`DECISIONS.md`**: `grep -n -i "F32\|B213\|OCR"` returns **zero matches**. The build-plan's
  close-out step 2 cites "owner decision via routeflow-3a, 2026-09-05" for F32/B213 — that decision
  is not recorded in this repo's `DECISIONS.md` (it lives only in the referenced external
  memory/session artifact, if anywhere).
- **`bugs.jsonl`**: `grep -c '"batch":"F31"'` → 0 (F31 has an issue but no bugs ever assigned to it
  yet in the catalogue); no `"F32"` token anywhere either.
- **`bugs/B213.md`**: exists and DOES reference OCR and PR #616 (the same fix), but **contains no
  `F32` token anywhere** — B213 has never been assigned to any batch. Verbatim (tenant-free, no
  redaction needed — the file already uses no client identifiers):
  > `title: AI invoice scan returned 403 on every scan route and the web toast hid the server message (OCR add-on gate)`
  > "Fixed by PR #616 (fix(api,web): observe-first add-on gates — registry, ocr dark, scan toast
  > fidelity), merged to master at 7281e4d7: new apps/api/src/billing/addon-gate-registry.ts
  > registers ocr as dark (allow + would-deny warn, reviewBy 2026-10-15) … Regression coverage:
  > REG-OCR-1 (apps/api/src/billing/addon.guard.spec.ts, T1-T8) and REG-OCR-2
  > (apps/web/e2e/02-operator.spec.ts, OP-17g). Lesson L-071 … records the pattern: a new
  > entitlement gate on an existing route ships observe-first or it is an outage."

**Conclusion: F32 is entirely fresh** — no board entry, no shard, no catalogue batch tag, no
DECISIONS.md record, and B213 is still un-batched (`move B213 --to F32 --tier T1` in the close-out
plan is exactly the "uncampaigned id needs `--tier` to get its first row" path `cmds.move` added).

**F30/F31 identity** (for F32's issue-title consistency): F30 = `F30 · Mobile scan-to-order loss
hotfix (owner-reported, diagnosis in flight)` (#549) — its shard `F30.jsonl` shows 5 rows (B190–
B194 seen), all `state: "done"`, `pr: 555`, so F30 is fully closed out already. F31 = `F31 · Mobile
draft-invoice review before confirm + post-confirm item edit` (#550) — has an issue but **no
`F31.jsonl` shard and no `bugs.jsonl` batch entries** — it hasn't started implementation, ledger-
wise. Naming pattern confirmed across #542/#549/#550: `F## · <short plain-English description>`,
no PR reference in the title. **F32's issue title should follow this same bare pattern** — the
build-plan's proposed `F32 · HF-OCR · add-on gate observe-first (#616)` adds a PR-number
parenthetical and an "HF-OCR" tag that none of F29/F30/F31 use; a title closer to the established
convention would be `F32 · OCR add-on gate hotfix` (no PR reference, matching #542/#549/#550).

---

## 6. Master drift (`origin/master` = `a94f9428`, branch base = `d12203a3`)

`git diff --name-only d12203a3 origin/master` → 50 files changed on master since the branch's
base; `git diff --name-only d12203a3 HEAD` → 15 files changed on the branch. **Intersection (files
touched by BOTH sides — these will conflict on a straight merge/rebase):**

| file                            | `git check-attr merge` |
| ------------------------------- | ---------------------- |
| `.claude/campaign/bugs/B185.md` | `unspecified`          |
| `.claude/campaign/bugs/B59.md`  | `unspecified`          |
| `.claude/campaign/bugs/B91.md`  | `unspecified`          |
| `.claude/code-map/CHANGELOG.md` | **`union`**            |
| `.claude/code-map/_meta.json`   | `unspecified`          |

Only `CHANGELOG.md` is declared `merge=union` in `.gitattributes` (along with
`.claude/pipeline/cost-ledger.jsonl`, not in this overlap set) — it will auto-merge cleanly. The
other four are **not** union-merged and are real conflict risk on a merge/rebase. Notably, `.gitattributes`
carries an explicit comment for `_meta.json`: _"`_meta.json` is deliberately NOT unioned — union on
JSON breaks it. Rebase rule: take master's `_meta.json`, then re-set only its `notes` field to your
session's bullet."_ — this is the documented resolution rule for that specific conflict (applies
to the code-map `_meta.json`; the lessons `_meta.json` isn't in this overlap set at all — see §7).

Neither `.claude/campaign/status/F13.jsonl` nor `.claude/campaign/status/F25.jsonl` nor
`.claude/campaign/bugs.jsonl` nor `board.json` are in the overlap (the branch's own diff never
touches those files, so master's changes to them are pure fast-forward-style additions from this
branch's point of view, not conflicts) — and none of these ledger shards are declared
`merge=union` either (`git check-attr merge` on all three returns `unspecified`), so if a future
branch commit ever does touch them, expect a real conflict, not an auto-union.

**Has origin/master already discharged or changed B92/B106/B185?**

- **F13.jsonl (B92, B106): UNCHANGED on master** — `git diff --stat d12203a3 origin/master --
.claude/campaign/status/F13.jsonl` and the `bugs/B92.md`/`bugs/B106.md` record diffs are all
  **empty**. Master's copy of B92/B106 is byte-identical to the branch's — confirmed by dumping
  master's F13.jsonl last-per-id state: `B92 proven-pending-deploy T2 612`, `B106 done T1 612`,
  matching §4 exactly. **No drift on F13 — the close-out's B92/B106 step is safe to run first.**
- **F25.jsonl (B185): CHANGED on master.** `git show origin/master:.claude/lessons/…` — sorry,
  `.claude/campaign/status/F25.jsonl` — carries an additional B185 line master's branch lineage
  wrote that this branch has never seen:
  ```json
  {
    "id": "B185",
    "batch": "F25",
    "tier": "T1",
    "state": "proven",
    "pr": null,
    "proof": "apps/mobile/__tests__/location-payload.test.ts, apps/api/src/drivers/dto/post-location.dto.spec.ts",
    "evidence": "WP-MOB-LOC + WP-API-LOC landed on fix/F25-location-b185 (roundSha 5aa011e3): apps/mobile/lib/location-payload.ts buildLocationPayload maps iOS -1 heading/speed sentinel to null (was forwarded raw, 400'd on API @Min(0)); apps/api/src/drivers/dto/post-location.dto.ts gained optional accuracy (@Min(0), no @Max), persisted by drivers.service.ts recordLocation(). T1-T5 (REG-B185 mobile seam tests + DTO accuracy/whitelist/bound tests) jest-provable end to end, no deploy-only tier — spec: location-payload.test.ts, post-location.dto.spec.ts. Not yet run in this package per plan (no test suites in WP-DOCS-LOC); a later gate stage runs the jest confirmation.",
    "roundSha": "5aa011e3"
  }
  ```
  This is via PR #629 (`fix(mobile,api): map ios location sentinels to null and accept accuracy
(F25 B185)`, merged `420eef71`, per §2). **State is `proven`, not `done` — B185 has NOT yet been
  discharged on master either**, and `pr` is still `null` on the row (the `prove` for it apparently
  hasn't been re-run with `--pr 629` post-merge, or was run before merge). `bugs/B185.md` also
  differs (4 insertions / 3 deletions vs. the merge-base) confirming `sync` ran on master to
  reflect this. **This branch's own F25.jsonl (queued) is now stale relative to master and must be
  taken from master, not merged, before any F25/B185 work continues from this worktree.**
- **`bugs.jsonl` and `board.json`: byte-identical between the branch and origin/master** (empty
  diffstat both ways) — no drift there.

---

## 7. Lessons register — `_meta.json`, heading drift, and the archive candidate

**Branch `.claude/lessons/_meta.json` (verbatim):**

```json
{
  "nextId": 77,
  "activeCount": 39,
  "archivedCount": 33,
  "maxEntries": 40,
  "maxBytes": 40960,
  "updatedAt": "2026-09-05T21:15:00.000Z",
  "schemaVersion": 1,
  "note": "fix/e2e-recurring-toast-locator, rebased onto origin/master 1ebd4f54 (#623 PR-2b `imp-02b-cron-leader-lock`, which itself rebased onto b1e3bed0 #622 and archived L-013 + L-040 for headroom — see the archived cap-discipline note above). REG-B92's spec-30 toast assertion (bare page.getByText(\"Recurring template updated\")) hit a strict-mode violation against Radix's aria-live announcer mirror; scoped both spec-30 toast assertions (REG-B09's \"Standing order updated\", REG-B92's \"Recurring template updated\") through getByRole(\"region\", {name:/notifications/i}).getByRole(\"listitem\"), the convention 21-destructive-guards.spec.ts already documents — no shared toast helper exists yet. Minted as L-075 (testing) on the branch when the register was at 40/40 (nextId 75) inherited from b1e3bed0; renumbered to L-076 here because #623 claimed L-075 upstream first — ids are immutable once merged and a reserved gap is never reused ([[L-039]]). Archived L-037 (domain, #TBD, REG-B55 (T21) reversal-completeness lesson) to restore headroom before adding L-076 under the older b1e3bed0-based cap — L-037 was the oldest active entry with a genuinely automated (non-\"none\"/judgment) guard, per the same rule the prior L-071-driven archival of L-030 used. Combined with master's own L-013/L-040 archival the register now sits comfortably under the cap. Final state: 39 active, 33 archived, nextId 77 (max id 76 across both files, +1)."
}
```

**`origin/master` `.claude/lessons/_meta.json` (verbatim):**

```json
{
  "nextId": 80,
  "activeCount": 40,
  "archivedCount": 35,
  "maxEntries": 40,
  "maxBytes": 40960,
  "updatedAt": "2026-09-06T05:30:00.000Z",
  "schemaVersion": 1,
  "note": "Bookkeeping follow-up for #627 (0ee2672e): added L-079 (tooling — per-workspace Jest testTimeout fixes the cold-worker flake class) and archived L-011 (tooling, guard now enforced in code) to hold the 40-entry cap; see ARCHIVE.md's 2026-09-06 section."
}
```

**Master's `nextId` is 80** (branch's is 77) — master has minted at least 3 more ids since the
branch's base (`L-077`, `L-078`, `L-079` confirmed present, see below).

**`### L-0xx` headings present on `origin/master` but NOT on the branch** (`comm -13` on the sorted
id sets extracted from both files' `### L-` headings):

- `L-077` (`2026-09-05 · deploy · close-out re-check`)
- `L-078` (`2026-09-05 · process · close-out re-check`)
- `L-079` (`2026-09-06 · tooling · #627 \`chore/ci-private-minutes\``)

(For completeness, the reverse — present on the branch but archived on master — is `L-011` and
`L-039`; master's own `_meta.json` note above explains the `L-011` archival directly. `L-039`'s
archival on master is not explained in that note, so it happened in an earlier master-side commit
between `d12203a3` and `a94f9428` not captured by the note text.)

### LESSONS.md header (first ~9 lines, verbatim — the file's actual first non-blank content

through the cap-discipline note; the file has no literal blank line 1):

```
# Lessons Learned — RouteFlow

> Generalizable rules this project has paid for. **Read this at the start of every major task,
> implementation, or bug fix** (alongside the code map) and cite entry ids when one changes your
> approach. **After every bug fix, append an entry** — Symptom / Root cause / **Lesson** / Guard —
> and bump [`_meta.json`](_meta.json); Gate 3 of [`../hooks/stop.mjs`](../hooks/stop.mjs) blocks
> fix-shaped turns that don't (a lesson-free fix bumps `_meta.json.updatedAt` to acknowledge).
> Caps: ≤ 40 active entries / ~25 KB — compact to [`ARCHIVE.md`](ARCHIVE.md). Maintained by the
> `lessons-learned` skill. Blameless; **never client names/slugs/document numbers** — the repo
> goes public briefly for CI.
```

### Active entries whose Guard names an automated guard (spec / hook / script / CI check — not

"judgment", "none", or a runbook line), oldest date first

Read all 39 active entries' `**Guard:**` lines on the branch. 26 of the 39 name a real automated
artifact; the other 13 are `none — judgment`, a bare `none`, "no hook", or a manual command/
procedure (`gh run view …`, "force execution … then assert the mtime") rather than something that
enforces itself. Qualifying entries, oldest first:

| id        | date       | category | Guard (verbatim)                                                                                                                                                                                                                                                                                              |
| --------- | ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L-039** | 2026-09-01 | tooling  | `validate-lessons` prints `binding:` and the remaining headroom every run — treat `~0 more` as unlanded work. Second-order cost: the run died at the gate, so everything its success path owned went undone and the repo was left **public** — a private flip that lives after a green CI is not a `finally`. |
| L-044     | 2026-09-02 | security | `REG-B132` (the inverted test) and `REG-B165` (`impersonation.guard.spec.ts` header case with `req.user` undefined); mutation probes in the F14 PR body.                                                                                                                                                      |
| L-045     | 2026-09-02 | domain   | `REG-B129 (T5 path: cancel → un-cancel → re-dispatch)`, `REG-B211 (T12 path: complete-with-skipped → reopen refused)`; mutation probes in the F11 PR body.                                                                                                                                                    |
| L-054     | 2026-09-03 | domain   | `db-locks.spec.ts` (T1), `db-locks.db.spec.ts` (T4, `npm run local:test:db`), `orders.merge-lock.spec.ts` (T3), and `orders.scan-hardening.spec.ts`'s concurrent-merge case.                                                                                                                                  |
| L-060     | 2026-09-03 | testing  | the RED BAR block now asserts `code: "P2025"` (Prisma's own not-found shape), so a regression that returns the row — or throws something else — fails the DB lane.                                                                                                                                            |
| L-065     | 2026-09-03 | tooling  | `no-runtime-workspace-imports.spec.ts` (PR-1's engine already seeded the idea; this PR makes it assert every `@routeflow/*` the API imports has a built `main`).                                                                                                                                              |
| L-072     | 2026-09-03 | domain   | `apps/api/src/common/enum-parity.spec.ts` — a generic table (40 enums) against `packages/types/api/enums.ts`, plus a regression layer pinning the drifted files and the mobile jest stub that can't `require` the shared package directly.                                                                    |
| L-046     | 2026-09-04 | domain   | REG-B48 T9–T16 through the real resolver; REG-B46 T1–T7b; REG-B106 T17/T17b/T17c/T18/T19.                                                                                                                                                                                                                     |
| L-047     | 2026-09-04 | domain   | REG-B59 e2e under `timezoneId`; REG-B118 tenant-tz jest with a DST fixture; REG-B90/B91 mobile helper tests + the mirror-identity pin; REG-B185 DTO spec.                                                                                                                                                     |
| L-056     | 2026-09-04 | tooling  | `scripts/ci-audit-critical.mjs` (…); contract spec `apps/api/src/common/ci-audit-script.spec.ts`.                                                                                                                                                                                                             |
| L-057     | 2026-09-04 | deploy   | `scripts/visibility-watchdog.mjs`, mandatory in `docs/runbooks/deploy-visibility-flip.md` and the `rebuild` skill.                                                                                                                                                                                            |
| L-058     | 2026-09-04 | testing  | `ci-freshness-guard-script.spec.ts` T1 executes the workflow's own step under a fake `gh`.                                                                                                                                                                                                                    |
| L-061     | 2026-09-04 | testing  | `prisma-isolation.spec.ts` drives the real `_tenantExtension`; `local:test:db` runs on `apps/api/src/prisma/**` PRs (`db-migrations.yml` paths).                                                                                                                                                              |
| L-062     | 2026-09-04 | tooling  | `turbo.json` `test:repo-truth`; `apps/api/src/common/turbo-inputs.spec.ts`.                                                                                                                                                                                                                                   |
| L-063     | 2026-09-04 | testing  | `apps/api/package.json` `jest.reporters` (campaign reporter) + `scripts/campaign-check.mjs`; the pre-push hook runs the suite unsplit.                                                                                                                                                                        |
| L-064     | 2026-09-04 | deploy   | `apps/web/csp.mjs` (`apiConnectSources`) + `apps/web/lib/csp.test.ts` (prod-identity case pins the exact production CSP string).                                                                                                                                                                              |
| L-066     | 2026-09-04 | testing  | `visibility-watchdog-script.spec.ts` slow-boot repro stays green.                                                                                                                                                                                                                                             |
| L-067     | 2026-09-04 | tooling  | `bugs self-test` (step 6 of `npm run verify`): `$`-safety, one `## History` per record, ledger id-uniqueness, real `cmds.render` on a fixture, sync done→queued→done, reopen leaves the proof clear.                                                                                                          |
| L-068     | 2026-09-04 | tooling  | `withShardLock`/`withCatalogueLock` (…); `BUGS_TEST_STALL_MS` widens the race; planted failures (…) assert the PRE-failure state survives.                                                                                                                                                                    |
| L-069     | 2026-09-04 | process  | busy batches pre-coloured into wave 1, `CONFLICTING` includes `in-flight`; `readClaims` is pure and asserted against the three comment sets that broke it.                                                                                                                                                    |
| L-071     | 2026-09-04 | domain   | `ADDON_GATE_REGISTRY` pins P1a–P1h and REG-OCR-1 T1–T8; e2e OP-17g.                                                                                                                                                                                                                                           |
| L-073     | 2026-09-04 | tooling  | `split-prisma-schema.mjs --check` proves block-identity + `MODEL_DOMAIN` placement; `npm run local:drift` is the output-side oracle.                                                                                                                                                                          |
| L-075     | 2026-09-04 | deploy   | `db-locks.spec.ts` (p) pins `keepAlive: true` / `keepAliveInitialDelayMillis: 30_000` on both lock pools, and their per-family `max`.                                                                                                                                                                         |
| L-070     | 2026-09-05 | tooling  | self-test `liveness:` checks (a2) and the dead-holder `observed gone` assertion, run on both platforms; CI run 33938718344 is the red that proved it.                                                                                                                                                         |
| L-074     | 2026-09-05 | tooling  | `resolveDatabaseUrl` + its spec; the seed logs its target host.                                                                                                                                                                                                                                               |
| L-076     | 2026-09-05 | testing  | the `getByRole("region"…).getByRole("listitem")` scoping convention (documented in `21-destructive-guards.spec.ts`) applied at `apps/web/e2e/30-recurring-standing.spec.ts` (REG-B09, REG-B92).                                                                                                               |

**The oldest fully-guarded active entry is `L-039`** (2026-09-01, tooling) — its Guard names the
actual `validate-lessons` script (the same enforcement `CLAUDE.md`'s cap-discipline section
references), not a manual judgment call. **This is the archive candidate**, matching the pattern
the branch's own `_meta.json` note already used for `L-037`'s prior archival ("the oldest active
entry with a genuinely automated … guard"). Note that `origin/master` has _already_ archived
`L-039` independently (§ above) — so if this branch's own registry work ever needs headroom, the
id to archive there is already gone on master's side; taking master's `LESSONS.md`/`ARCHIVE.md` as
the merge base (per the `_meta.json` gitattributes rule) will already reflect that.

Excluded (Guard = `none`/`judgment`/"no hook"/a bare manual procedure), for reference: L-004,
L-011, L-010, L-025, L-026, L-027, L-034, L-035, L-038, L-041, L-050, L-051, L-055 (a doc-comment
pin, not an executable check).

---

## Proposed close-out command list (NOT executed — for the owner/next session to run)

1. Pre-flight (already confirmed clean above, but re-run live before touching anything):
   ```bash
   node scripts/campaign/bugs.mjs self-test
   node scripts/campaign/bugs.mjs sync --check
   npx prettier --check "scripts/campaign/*.mjs"
   ```
2. **Rebase/merge onto `origin/master` FIRST** — F25.jsonl/B185.md are stale on this branch (§6);
   merging without picking up master's B185-proven row risks the close-out re-deriving `queued`
   over `proven`. Resolve the five overlap files per §6 (`_meta.json` per the `.gitattributes`
   rule: take master's, re-apply only this session's own note fields).
3. **F32 + B213** (per the build-plan's owner-approved decision, naming adjusted per §5 to match
   the #542/#549/#550 convention — drop the PR parenthetical/HF-OCR tag unless the owner insists
   on it):
   ```bash
   gh issue create --title "F32 · OCR add-on gate hotfix" --body "<F542-style body, batch F32, Done-when: B213>"
   # then add "F32": <n> to .claude/campaign/board.json by hand
   node scripts/campaign/bugs.mjs move B213 --to F32 --tier T1
   node scripts/campaign/bugs.mjs prove B213 --pr 616 --proof "REG-OCR-1 (apps/api/src/billing/addon.guard.spec.ts, T1-T8) and REG-OCR-2 (apps/web/e2e/02-operator.spec.ts, OP-17g) pin the observe-first gate and the toast surfacing the server message"
   node scripts/campaign/bugs.mjs discharge F32 --evidence "PR #616 merged 7281e4d7 2026-09-05; deployed; post-deploy-check green; live probe returns 400 not 403"
   node scripts/campaign/bugs.mjs sync
   git commit -m "chore(campaign): open hotfix shard f32 and discharge b213 against #616"
   ```
4. **B92 (F13) — CORRECTED from the build-plan**: B106 is already `done` (§4); passing
   `--evidence-B106` will abort the whole discharge (§3). Only B92 is still `proven-pending-
deploy`, so the discharge call must drop the B106 evidence flag entirely:
   ```bash
   node scripts/campaign/bugs.mjs discharge F13 \
     --evidence "deploy-triggered E2E run 33993841827 on master d12203a3 (130 passed, 26 skipped, 0 failed); 30-recurring-standing.spec.ts REG-B92 (:217) PASSED, REG-B106 web leg (:317) PASSED" \
     --evidence-B92 "E2E run 33993841827, headSha d12203a3: 30-recurring-standing.spec.ts:217 REG-B92 PASSED post-deploy — the toast-locator fix holds"
   node scripts/campaign/bugs.mjs sync
   git commit -m "chore(campaign): discharge b92 after the toast-locator fix (b106 was already done)"
   ```
5. Lesson (nextId 77 on the branch, but confirm against whatever `nextId` lands after the master
   merge in step 2 — master is already at nextId 80): append the `process` entry the build-plan
   describes (`sync --check` guard), bump `_meta.json` accordingly.
6. `node scripts/campaign/bugs.mjs sync --check` once more; result.json + ledger row + RUN-LOG
   entry; push with the full hook; open the PR.
