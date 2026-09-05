# F13 close-out — bug-pipeline RESUME card

Written at launch. The resume key is `{scriptPath, resumeFromRunId, args}` and **args are NOT
stored by the tool** — that is why `pipeline-args.json` sits beside this file.

## Context

The batch was built by a dead session's dev-pipeline run and snapshotted as commit `9e5ce526` on
`fix/F13-recurring-standing-v2` (rows B09, B46, B48, B92, B106; B46/B48 Critical). Refutation
(2026-09-04, `refutation.md`) confirmed all five causes and four of five fixes; B106's fix is
**PARTIAL**. This run adds the remaining fixes and the close-out.

The run executes on the **COMMITTED snapshot** (this worktree's HEAD after a master merge lands —
the merge was in progress, mid-conflict, at the time this card was written; it has since landed
cleanly as `428046772195178cd694109e37d437f9097a8b14` / `42804677`, master `f60bd27c` merged into
`fix/F13-recurring-standing-v2`). The lenses read the
full radius (`radiusFiles` in `pipeline-args.json`); `refutation.md` stands as the deep review of
the v1 diff and is not re-litigated. Probes are `revertFix: false` mutations (HEAD already
contains the v1 fixes; revert-to-PRE is not expressible from a state that never had the bug).

**Every file:line anchor in `cause-ruling.md` / `bug-test-plan.md` / `build-plan.md` was originally
stated at `9e5ce526`; it has now been re-anchored against the merged tree (`42804677`), confirmed
2026-09-04** by reading each cited range directly (`sed -n`/`git show HEAD:<path>`). All anchors
checked held unchanged from their `9e5ce526` values except: the two `OrdersService` test doubles in
`order-templates.service.spec.ts` (`~:186`→`:238`, `~:400`→`:452`), the web retry-hint block in
`recurring/page.tsx` (`:176-193`→`:184-193`), and `invoices.ts`'s `isRetryableRunFailure`/
`RUN_UNFINALIZED_PREFIX` (`:783-785`→`:782`/`:785`) — the corrected citations now live in
`cause-ruling.md`, `bug-test-plan.md`, `build-plan.md`, and `pipeline-args.json` themselves. A
resuming agent should still spot-check before trusting a number blindly, per standing practice, but
these four artifacts no longer carry an open re-anchor debt. The api scoped baseline (`cd apps/api
&& npx jest src/order-templates src/recurring-invoices --runInBand`) is confirmed green at
**72/72** on this merged tree (master added three tests since the `9e5ce526` snapshot); the web
workspace has a working Jest runner covering **19** `*.test.ts`/`*.test.tsx` files.

## Resume key

|              |                                                                                     |
| ------------ | ----------------------------------------------------------------------------------- |
| `runId`      | _(fill in at launch — not yet launched)_                                            |
| `scriptPath` | `C:\ClaudeCode\routeflow\.claude\worktrees\rf-F13\local-assets\tooling\pipeline.js` |
| `args`       | `pipeline-args.json` in this directory — pass its parsed contents verbatim          |
| transcript   | _(fill in at launch)_                                                               |

```
Workflow({ scriptPath: "C:\\ClaudeCode\\routeflow\\.claude\\worktrees\\rf-F13\\local-assets\\tooling\\pipeline.js",
           args: <contents of pipeline-args.json> })
```

`local-assets/` is gitignored; `pipeline.js` there must be a fresh copy of
`~/.claude/skills/dev-pipeline/pipeline.js` (the Workflow tool only accepts paths inside the
working directory) — copy it into **this worktree's** `local-assets/tooling/`, not the main
checkout's, since `workdir` in `pipeline-args.json` points at `rf-F13`.

## Sequencing rule (owner-mandated cap; do not violate)

**Launch only after F25 Run A's close-out.** F25 (`.claude/pipeline/2026-09-03-F25-calendar-dates/`,
worktree `rf-F25`) is a dev-pipeline major-scale run already in flight on this machine at the time
this card was written (no `RESUME.md`/`result.json` had landed in the main checkout's F25 pipeline
directory yet). **Never run this F13 close-out concurrently with another engine run on this
machine** — the house cap is one dev-pipeline/bug-pipeline engine run at a time (each is ~90
agents), separate from the unrelated 4-concurrent-background-agent cap. Check
`.claude/pipeline/2026-09-03-F25-calendar-dates/result.json` (or `RESUME.md`) for existence before
launching this run; if absent, F25 is still running — wait.

## Setup to do in this worktree before launch — do NOT assume any of it is already done

- [DONE 2026-09-04] The concurrent master merge into `rf-F13` (branch
  `fix/F13-recurring-standing-v2`) has **completed and been committed** as `42804677` (`git log -1`
  shows a clean merge commit, `git status` clean apart from this pipeline directory). Do not launch
  while a merge is in progress or has unresolved conflicts.
- [DONE 2026-09-04] Re-anchored every file:line reference in `cause-ruling.md`, `bug-test-plan.md`,
  `build-plan.md`, and `pipeline-args.json` against the post-merge tree (`42804677`) — see the
  Context section above for the citations that actually shifted. F13 and other Wave A batches
  landing around it are known to shift line numbers (F14's `addItemForUser` shifted
  `order-templates.service.ts` by +8 lines in a prior instance of this exact hazard — see
  `.claude/pipeline/2026-09-02-wave-a-completion/SEQUENCE.md`).
- Still owed before launch: this worktree's own `npm ci` (a worktree cannot see the main checkout's
  nested deps) and `npx prisma generate` if the merge touched `schema.prisma` or any
  generated-client consumer.
- Still owed before launch: confirm `apps/api` and `apps/web` typecheck cleanly in this worktree
  post-merge, before trusting any red-gate result as meaningful.
- [CONFIRMED 2026-09-04] The api scoped suite (`cd apps/api && npx jest src/order-templates
src/recurring-invoices --runInBand`) is green at **72/72** on this merged tree (master added
  three tests since the `9e5ce526` snapshot) — a useful baseline for judging this run's own
  red-gate and final verify results. The web workspace has a working Jest runner covering **19**
  `*.test.ts`/`*.test.tsx` files.

## Owed after the run, regardless of verdict

- Persist `result.json` beside this plan; append the ledger row via
  `~/.claude/skills/model-routing/scripts/pipeline-ledger.mjs append` (with `--subagent-tokens`
  from the Workflow usage line when available).
- Append ONE entry (≤ 10 lines) to `~/.claude/skills/dev-pipeline/references/RUN-LOG.md`: run slug
  · mode `bugfix` · scale `major` · est. cost · active wall-clock · what caught the real defects ·
  what was wasted · one candidate knob change with evidence · any deviation this run forced (the
  `revertFix: false` mutation-only probe plan is itself a deviation worth logging, along with
  the post-merge re-anchoring findings — three citations shifted (the `OrdersService` test
  doubles, the web retry-hint block, and `invoices.ts`'s `isRetryableRunFailure`/
  `RUN_UNFINALIZED_PREFIX` lines); every other cited anchor held unchanged).
- `.claude/campaign/status/F13.jsonl`: B46/B48/B106 → `proven`; B09/B92 stay
  `proven-pending-deploy` (T2, spec 30 e2e; unchanged tier, no new e2e work in this run). `pr: null`
  until merged.
- Lesson **L-046** (pre-allocated to F13; text and placement given verbatim in `build-plan.md`'s
  WP-DOCS section). `nextId` stays untouched — it is 58 on master as of 2026-09-04; this run does
  NOT bump it (a batch never spends `nextId` on its own pre-allocated id, only on a second,
  unallocated one, which this run does not need).
- **Do not use** the stray `l046-draft.md` already present in this pipeline directory (dated
  2026-09-03, category `testing`, unrelated mutation-probe/baseline-disturbance content) as this
  run's L-046 — it is a leftover from a different, unrelated draft and does not match the
  domain/F13 content this ruling specifies.
- Deferred findings and the owner-owed follow-ups listed at the end of `cause-ruling.md` go to the
  owner verbatim — none of them are built in this run.
- Update the code-map entries for every touched file (surgical, not a regen) per `build-plan.md`'s
  WP-DOCS package.

## Oracles to check individually on resume (a skipped phase is neutral; an UNVERIFIED one is not)

- `redGate.behaviorallyRed` — both commands in `pipeline-args.json.redGate.commands` must fail on
  the exact wrong value named in `bug-test-plan.md`, not merely fail to compile or fail to find a
  matching test title (an empty test-title filter fails exactly like a real red — confirm the
  selector matches at least one test before trusting a "fail" as reproduction, per the project's
  own testing-lesson pattern for negative results).
- `mutationProbe.allCaught` / `.restoredVerified` — 6 targets declared, all `revertFix: false`
  (mutation, not revert-fix) since HEAD already carries the v1 fixes. `.restoredVerified` still
  matters: confirm the probe's post-mutation file content matches its pre-mutation content via a
  same-agent-owned before/after read, not a baseline another process could have moved (this
  worktree has a concurrent merge writer active until setup is confirmed done above).
- `harnessCheck.issues` — should name the two `OrdersService` doubles this run repairs; if it comes
  back empty, the harness-hygiene package likely did not run or did not touch the right files.
- `radiusPack.{built,truncated,files}` — expect `files` to reflect the 40-entry `radiusFiles` list
  (or a superset the pack agent found via call-site tracing); a dead/empty pack here means the
  lenses read the whole diff instead of the radius, which is more tokens, not less coverage — not
  itself a failure.
- `siblingSweep.hits` / `.findings` — expect at least the known `invoices.controller.ts:156`
  `Partial<>` hit on pattern (b); a `defect` verdict on it should be filed to the owner as a
  registry candidate, not fixed in this run (see `cause-ruling.md` §5's explicit "do NOT fix here").
- `finalPass.ran` / `.completed` — this run's diff touches money/schedule code
  (`recurring-invoices.service.ts`), so Baseline should classify it HIGH risk and run the final
  pass; if it reports `ran: false`, check whether Baseline under-classified the risk before
  accepting the result.
- `uiVerify` — configured (copy/CTA-styling only); a UI-verify skip here is a real gap, not neutral,
  since the retry-hint fix is precisely a rendering behavior.
- No e2e spec is added or changed in behavior by this run (spec 30's edit is comment-only) — no
  post-deploy T2 discharge is owed by this run for B106; B09/B92 continue to discharge only on a
  green post-deploy run of spec 30, unaffected by anything built here.
