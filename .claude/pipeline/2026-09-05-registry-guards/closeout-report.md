# Registry guards — close-out report (Sonnet executor, 2026-09-06)

Worktree `C:/ClaudeCode/routeflow/.claude/worktrees/rf-registry`, branch `feat/registry-guards`.
Executed the plan in `closeout-plan.md` steps 1–5, preceded by the Step 0 re-sync the assignment
added on top of it. Every command below was run in this worktree; nothing was pushed.

## Step 0 — re-sync after merging master a94f9428

```
$ node scripts/campaign/bugs.mjs sync
sync: recorded 0 new event(s).

$ node scripts/campaign/bugs.mjs sync --check
sync --check: 213 record(s) mirror the ledger   (exit 0)
```

`git status --porcelain` showed one changed file: `.claude/campaign/bugs/B185.md` — the merge
brought in PR #629's `420eef71` commit, and the git-scan half of `sync` appended a `commit` History
line for it (`- 2026-09-06 · **commit** · `420eef71` fix(mobile,api): map ios location sentinels to
null and accept accuracy (F25 B185) (#629)`). Committed as instructed:

- **`71dc61b0`** — `chore(campaign): sync records after merging master a94f9428`

```
$ node scripts/campaign/bugs.mjs self-test 2>&1 | tail -5
  ok   T14/R10: triage-move on an id outside the catalogue is refused as an unknown id
self-test: all checks passed
```

## Step 1 — F32 board issue + board.json

Guard: `gh issue list --search "F32 in:title" --state all --json number,title` → `[]` (empty, as
required). Created the issue with the plan's exact title/labels/body:

```
$ gh issue create --title "F32 · OCR add-on gate hotfix (observe-first registry, #616)" \
    --label kind:bug --label area:api --body-file <tmp>/f32-issue-body.md
https://github.com/najathakram/routeflow/issues/633
```

**Issue #633** — matches `closeout-prep.md`'s predicted next-free-number exactly. Added
`"F32": 633` to `.claude/campaign/board.json` after `"F29": 542`.

## Step 2 — B213 token + move + prove + discharge

- `apps/api/src/billing/addon.guard.spec.ts` line 125: `describe("REG-OCR-1 registry-driven
observe-first mode"` → `describe("REG-OCR-1 / REG-B213 registry-driven observe-first mode"`.
  Nothing else in the file touched.
- `move B213 --to F32 --tier T1 --why "..."` → `move: B213 -> F32 (first ledger row, tier T1) (owner
ruling 2026-09-05: hotfix shard for the OCR gate outage fixed by #616)`
- `prove B213 --pr 616 --proof "..."` → `B213: F32 row updated → proven (PR #616)`
- `discharge F32 --evidence "..."` → `F32: discharged 1 row(s) → done — B213`
- `show B213`: `state: done`, `batch: F32`, `tier: T1`. History:
  ```
  - 2026-09-05 · **filed** · filed directly via `bugs.mjs file`
  - 2026-09-06 · **batched** · assigned to F32 — owner ruling 2026-09-05: hotfix shard for the OCR gate outage fixed by #616
  - 2026-09-06 · **proven** · PR #616
  - 2026-09-06 · **done** · PR #616 merged 7281e4d7 2026-09-05T14:57Z (observe-first add-on gate registry, ocr dark); api + web deployed from it the same day; post-deploy-check green; the OCR run's close-out (2026-09-05) recorde
  ```
- `sync` (0 new events) then `sync --check` → `213 record(s) mirror the ledger` (clean) before
  committing.

Files touched: `.claude/campaign/board.json`, `.claude/campaign/bugs.jsonl`,
`.claude/campaign/bugs/B213.md`, `.claude/campaign/status/F32.jsonl` (new), and the spec file —
exactly the set the plan predicted.

- **`ccde58c2`** — `chore(campaign): open hotfix shard f32 and discharge b213 against #616`

## Step 3 — B92 (F13) and B185 (F25)

Pre-check: `status F13` → `done:4 proven-pending-deploy:1`; `list --batch F13` confirmed the one
non-`done` row is **B92** (B46/B48/B09/B106 all already `done`). `status F25` → `done:4 proven:1`;
`list --batch F25` confirmed the one non-`done` row is **B185**. Guard satisfied — proceeded with
the plan's discharge/prove commands verbatim.

```
$ node scripts/campaign/bugs.mjs discharge F13 --evidence "..." --evidence-B92 "..."
F13: discharged 1 row(s) → done — B92
  per-row evidence recorded for: B92

$ node scripts/campaign/bugs.mjs prove B185 --pr 629 --proof "..."
B185: WARNING — overwriting an existing proof (was PR #null · "apps/mobile/__tests__/location-payload.test.ts, apps/api/src/drivers/dto/post-location.dto.spec.ts") with PR #629. The old proof is not otherwise kept.
B185: F25 row updated → proven (PR #629)

$ node scripts/campaign/bugs.mjs discharge F25 --evidence "..."
F25: discharged 1 row(s) → done — B185
```

The WARNING on `prove B185` is exactly what `closeout-prep.md` predicted (master's row had
`pr: null`). `show B92` → `state: done`; `show B185` → `state: done`; both Histories carry the
expected proven/done lines dated 2026-09-06.

`sync` → 0 new events; `sync --check` → `213 record(s) mirror the ledger` (clean). Files touched:
`.claude/campaign/bugs/B185.md`, `.claude/campaign/bugs/B92.md`, `.claude/campaign/status/F13.jsonl`,
`.claude/campaign/status/F25.jsonl` — matches the plan's predicted set.

- **`2673103e`** — `chore(campaign): discharge b92 and b185 after their deploy-triggered e2e runs`

## Step 4 — lesson L-080 + code map

**Archive candidate.** Confirmed on the merged tree (`_meta.json` at `nextId: 80, activeCount: 40`
— cap, as `closeout-prep.md` predicted): read all 40 active `### L-` headings and their `Guard:`
lines. Every entry older than **L-044** (2026-09-02, security) has a Guard of `none`/judgment/a bare
runbook line (confirmed against `closeout-prep.md`'s exclusion list: L-004, L-010, and the whole
2026-09-01 batch L-025/026/027/034/035/038/041). L-044's Guard names two real specs (`REG-B132`,
`impersonation.guard.spec.ts`'s header case) — the oldest entry with a genuinely automated guard.
Master had already archived L-039/L-011 independently; neither changes this conclusion.

**Move.** LESSONS.md's `## security` heading held only L-044, so removing it removed the heading
too. Appended L-044 verbatim into ARCHIVE.md directly under its existing `## security` heading
(after L-023, before the first "## Archived ..." dated-compaction section), preceded by a one-line
dated note: `> archived 2026-09-06 for headroom — guard automated (registry-guards, making room for
L-080).` This reads the plan's "under its category heading" instruction literally — ARCHIVE.md
still carries the original per-category headings from before the dated-compaction convention
started (2026-09-04 onward), and `## security` is one of them.

**Add.** Appended `lesson-L-080.md`'s entry verbatim under `## process` at the top of the section
(newest-first, matching the file's existing convention — L-078/L-079 are likewise prepended to
their sections).

**`_meta.json`:** `nextId: 81`, `activeCount: 40`, `archivedCount: 36`, `updatedAt` bumped, one-
sentence `note` (branch, L-080 added, L-044 archived and why).

```
$ node scripts/validate-lessons.mjs
✔ .claude/lessons: register is self-consistent. 40/40 entries · 39.7/40.0 KB · archived 36 · nextId 81 (max L-080) · binding: size (~0 more entries at 0.99 KB each)
```

Exit 0. Note the register is now binding on **size**, not count (39.7/40.0 KB) — essentially no
headroom left for the next entry without a further archive; flagging for the owner/next session,
not fixed here (out of this plan's scope).

**Code map.** Added one dated bullet at the top of `CHANGELOG.md` for `2026-09-06` summarizing: the
master merge, the Opus review round (`32df0fe4`) over the 2026-09-05 `sync --check`/`move --tier`
work (F1/F2/F4/F8/F9/F10 fixes, F5's `roundSha` correction — confirmed by grep that
`.claude/code-map/INDEX.md` no longer contains the fictional `roundSha` field or the
`file`-vs-`expand` misattribution: current text reads `same fields)` and `` `expand`'s own
key/text ``), and this close-out commit's own campaign/lesson work. `_meta.json`: `mappedSha` set
to `2673103e` (HEAD at the moment all mapped source code was final, i.e. after commits A/B and
before this docs-only commit C), `generatedAt` now, `notes` replaced with the same bullet.

- **`effe9db2`** — `docs(lessons,code-map): l-080 derived-file check guard; map the registry guards`
  (commit subject uses lowercase `l-080` — commitlint's `subject-case` rule rejected the plan's
  literal `L-080` capitalization as start-case; every other commit in this run that names an id in
  its subject, including the plan's own `ccde58c2`/`2673103e`, already lowercases it, so this
  matches house convention.)

## Step 5 — final gate (reported, not committed)

```
$ node scripts/campaign/bugs.mjs self-test 2>&1 | tail -3
self-test: all checks passed

$ npx prettier --check "scripts/campaign/*.mjs"
Checking formatting...
All matched files use Prettier code style!

$ node scripts/campaign/bugs.mjs sync --check
sync --check: 213 record(s) mirror the ledger

$ node scripts/campaign-check.mjs --batch F32
campaign-check: 1 ledger row(s) across 1 shard(s), 1 making an affirmative claim.
✖ 1 undischarged claim(s):
   - B213: no test titled with REG-B213 found in the jest report

$ node scripts/campaign-check.mjs --batch F13
T2 discharge acknowledgment: B09 accepted on recorded evidence (...)
T2 discharge acknowledgment: B92 accepted on recorded evidence (...)
campaign-check: 5 ledger row(s) across 1 shard(s), 5 making an affirmative claim.
✖ 3 undischarged claim(s):
   - B46: no test titled with REG-B46 found in the jest report
   - B48: no test titled with REG-B48 found in the jest report
   - B106: no test titled with REG-B106 found in the jest report

$ node scripts/campaign-check.mjs --batch F25
T2 discharge acknowledgment: B59 accepted on recorded evidence (...)
T2 discharge acknowledgment: B91 accepted on recorded evidence (...)
campaign-check: 5 ledger row(s) across 1 shard(s), 5 making an affirmative claim.
✖ 3 undischarged claim(s):
   - B90: no test titled with REG-B90 found in the jest report
   - B118: no test titled with REG-B118 found in the jest report
   - B185: no test titled with REG-B185 found in the jest report
```

These "undischarged claim" hits are **expected**, exactly as the plan flagged: `campaign-check`
looks for a `.campaign/runs` Jest/Playwright report on THIS tree, and no api/mobile/e2e suite has
been re-run here since the merge — B213's REG-B213 Jest title, B185's mobile/API DTO specs, and the
older T1 rows (B46/B48/B106/B90/B118) all need that local run to show green, not another ledger
edit. The ledger-side transitions (`show`/`status`) already confirm `done` for every row this
close-out touched.

```
$ git status --porcelain
?? .claude/pipeline/2026-09-05-registry-guards/recheck-opus.md
```

**Deviation from the plan's expectation** (`git status --porcelain` empty): one untracked file,
`recheck-opus.md`, appeared in this worktree during the session — it was NOT present when this
session started (confirmed: the very first `git status --porcelain` at session start was empty).
Its own header states it is a concurrent Opus re-check of the fix-round-1 commit, deliberately
reading only the committed blob `32df0fe4` (never HEAD or the working tree) "because another agent
is committing close-out material here" — i.e. it is aware of and designed not to collide with this
close-out. Left untouched: it is not part of this plan's file list, not something this session wrote,
and not something this session's steps 1–4 needed. Reported here rather than deleted, moved, or
committed.

```
$ git log --oneline origin/master..HEAD
effe9db2 docs(lessons,code-map): l-080 derived-file check guard; map the registry guards
2673103e chore(campaign): discharge b92 and b185 after their deploy-triggered e2e runs
ccde58c2 chore(campaign): open hotfix shard f32 and discharge b213 against #616
71dc61b0 chore(campaign): sync records after merging master a94f9428
3b8302da Merge remote-tracking branch 'origin/master' into feat/registry-guards
32df0fe4 feat(registry): counted sync --check, --why on triage move, rollback
c2de0712 chore(registry-guards): checkpoint before account switch
2da6228c docs(pipeline): plan the registry guards run (sync --check, move --tier)
664fbef1 chore(campaign): sync records after rebasing onto d12203a3
eb869c0b chore(campaign): file the ocr add-on gate incident closed by #616
```

## Final batch/bug state

```
F13     5/5 done ·  0 analysed · #526  done:5
F25     5/5 done ·  0 analysed · #538  done:5
F32     1/1 done ·  0 analysed · #633  done:1
```

B213, B92, B185 are all `done`. No F30/F31 board entries were added to `board.json` (out of scope,
per the plan) even though #549/#550 exist as GitHub issues for them — `board.json`'s map now reads
`..., "F29": 542, "F32": 633`.

## Commit shas (this session)

| Commit     | Subject                                                                           |
| ---------- | --------------------------------------------------------------------------------- |
| `71dc61b0` | `chore(campaign): sync records after merging master a94f9428`                     |
| `ccde58c2` | `chore(campaign): open hotfix shard f32 and discharge b213 against #616`          |
| `2673103e` | `chore(campaign): discharge b92 and b185 after their deploy-triggered e2e runs`   |
| `effe9db2` | `docs(lessons,code-map): l-080 derived-file check guard; map the registry guards` |

Nothing was pushed. Ready for Fable to write `result.json`, the cost-ledger row and the RUN-LOG
entry.
