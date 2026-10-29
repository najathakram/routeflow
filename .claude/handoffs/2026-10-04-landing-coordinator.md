# Landing coordinator handoff — 2026-10-04 (06:30Z)

Role: sole public-CI-window owner + merger + bug-id minter (next id **B1050**). Master at write time:
`b4643dcaf2727712b5dabea6c1d64e09903f0c5c` (#3140). Repo PRIVATE (read back). Live lead row: `Routeflow Lead [58d095]`
(PC session; the old `[c70b16]`/`[87c446]` rows are offline). Mac Lead = `RouteFlow Mac Lead coordination`.

## Standing rules (unchanged)
- Windows only on the lead's WINDOW/GREENLIT line; watchdog FIRST (`scripts/visibility-watchdog.mjs --minutes 45`, verify its
  start line), then public; private as a finally AFTER api/web/mobile deploys SUCCESS (poll `commits/<sha>/status`: wait for
  `@routeflow/api` to APPEAR and succeed); read visibility back; `npm run post-deploy-check` with
  `SMOKE_BASE_URL=https://routeflowapi-production.up.railway.app SMOKE_TENANT_SLUG=e2e-routeflow`.
- Land only at the lead's exact pin; carry rule = `git merge-tree --write-tree <master> <head>` clean; after the squash
  `master^{tree}` must equal it. Stacked children conflict after the parent squash (L-190): SIMULATE the whole order first
  (`merge-tree` then `git commit-tree <tree> -p <cur>` as the next base). When two PRs touch the same files, build a server-side
  probe branch (`gh api POST git/refs` + `POST merges` per head, CI on it, delete it) and require master's final tree == probe tree.
- Docs-only squash lands while private (no CI). Code PRs need a PUBLIC repo for Railway's deploy snapshot.
- Never force-push, never hand-resolve others' code, never SKIP_VERIFY without a reason (docs-only audited ok), never run prod
  migrations, never touch lane branches, no heavy local jobs (ask Mac Lead).
- Polling budget: my gh/tool calls have taken 10-20 min each at times; the watchdog beat me twice. Dispatch the long probe FIRST,
  merge ready PRs while it runs, never poll in tight loops, re-arm a SHORT watchdog (`--minutes 20`) only to cover a deploy wait
  inside a granted window.

## Helper scripts (scratchpad S = /private/tmp/claude-501/-Users-maznahamanullah-code-routeflow/ae34644f-595a-4180-9d88-b80aa314e91c/scratchpad)
- `S/mrg.sh N FULLHEAD` squash-merges a code PR (pin check, merge-tree, REST squash with `S/m-w25.txt` body, tree compare).
- `S/mrg-docs.sh N FULLHEAD` same with the docs body (`S/m-docs.txt`).
- `S/mk-issues.py go B###...` creates board issues from its table (always pass an ARRAY: `ids=(...); ... "${ids[@]}"`).
- zsh gotchas: unquoted `$var` does not split; `$k:r` is a modifier (use `${k}`); `declare -A` fails in Monitor (use bash scripts).

## Queue (all gated by the lead; none opened yet)
- 10:00 onboarding window: price-history API + popover, fleet-off clean UI, U-units' minimal fulfilment_model PR (pins from the
  lead), then #3017 @202fd7a6 (dispatch CI EARLY; land AFTER the onboarding three, only if green). #3052/#3031 re-merge later.
- Pixels-gated, later: #3116 (B1018) @5bc09106, #3135 (B1030) @55826302 (F2 DB lane + CI; B1031 stacked, land #3135 first),
  #3102 (B1009) rebased (PENDING_TOTAL 231) then #3069 (230), #3106 (B999).
- ~17:30/18:00 big sitting (owner plan): profiles + back-office picker, buyer portal for shipping, shipping dashboard cards,
  COUNTER SALE (API PC builder D, web MacBook), shipped emails, self-serve add-on billing (#3098/#3129 ONLY on the lead's word after
  the owner's Stripe test-mode check), plus #3102->#3069, #3106, #3116, #3135->B1031, #3052/#3031. Possibly two back-to-back windows.

## Migration checklist for the 17:30 sitting (owner-run only; I never run prod migrations)
1. Ask the lead for the migration PR numbers + folder names early. For each: Squawk clean (`npm run lint:migrations`), migration
   replay green (db-migrations.yml), no `ALTER TYPE ... ADD VALUE` sharing a transaction with its first use (split the counter-sale
   enum and its column across migrations or order them so replay passes).
2. Order: emails migration FIRST, then counter-sale enum + column. One migration set at a time.
3. Fresh prod backup immediately before each apply (owner).
4. Owner runs `railway run --service postgres node apps/api/scripts/prod-migrate.mjs` from a checkout AT THE EXACT MERGE SHA.
5. THEN the public window + squash (code that expects the schema deploys).
6. After deploy: `railway run --service postgres node apps/api/scripts/schema-drift.mjs` = exit 0, post-deploy-check green.
   A migration PR is NOT landed until drift is 0 (L-184).
7. Simulate the squash order locally (read-only merge-tree/commit-tree); probe the combined tree in CI when migrations + code overlap.

## Local record chain (unpushed; waits for a PASS) — worktree ../rf-wt-bk-m, branch docs/bugs-b1045
- B1045-B1047 (#3158-#3160), B1048 (#3162), B1049 (#3163; updated per SA-652: allowed with C1-C4, tier-1, after B1048, not this
  release; commit 24c56b28c). sync --check = 961 mirror. Next record PR: rebuild on the then-current master by cherry-pick.
- Minting recipe: `node scripts/campaign/bugs.mjs file "<title>" --location "<where>" --severity ... --symptom "..." --id B###`,
  then `sync --check`. After `move` + `already-fixed` ALWAYS run `bugs.mjs sync`, `sync --check` and `self-test` BEFORE the commit
  (L-193). `sync` appends commit-event lines to unrelated records: revert those (`git checkout -- <paths>`).
- Commit subjects start lowercase and <=100 chars (commitlint). A no-install worktree needs a node_modules symlink to a FULL install
  (the PC main checkout's is broken; any worktree's works) for the commit (prettier) AND the push (size-ratchet gate runs even
  under SKIP_VERIFY); remove the link right after.

## Owed bookkeeping
- Code-map bullets for landings since #3070 (last mappedSha stamped 01b7eaa52): #3099, #3104, #3105, #3110-#3115, #3071, #3097,
  #3111, #3113 and later. Use Sonnet subagents (explicit model) to draft, verify every file/symbol against HEAD, then
  `node scripts/validate-code-map.mjs`.
- Lessons register 63.5/64.0 KB, 52/52: the NEXT lesson needs one whole entry archived first.
- Registry fixed-marking still owed: B1009 (#3102), B999 (#3106), B1018 (#3116), B1030/B1031, and whatever lands next.
- Lane labels: invoice-family issues now `lane:invoices` (#3120/#3121/#3137/#3158-#3160/#3162/#3163); no "Mac docs" lane label exists.
- A message to the Mac Lead was dropped at its inbox (relay-loop cut): fold B1048/B1049 + the B1049 ruling + the label fix into
  ONE later message.

## Landed since the 2026-09-30 handoff (see git log origin/master for shas)
Windows: K 5619016f, L 782b4f4f, M 01b7eaa5, N 97eb53ab, O/P a480faf2, Q 13fc2dcb, R 6c7688ad, S 70b3bcc7, then #3136 b5ace48e and
#3140 b4643dca (docs, landed private).

## UPDATE 2026-10-04 (after lead seat switch at 98% weekly usage)
- Master `ab3828fa192cb760f05a3a7b61132689fd409c6a` (#3185 records B1045-B1058 landed private). Repo PRIVATE; HOLD private.
- NO new public window until the NEXT lead PASSes the final heads. Next window order when it opens: #3190 + #3191 (security), then
  #3188, then #3135 (B1030; B1031 stacked behind it). Live queue: `.claude/handoffs/2026-10-04-lead-release.md` (lead's file).
- Still queued behind those: #3017 @202fd7a6 (CI early, land last, only if green), #3116, #3102->#3069, #3106, #3052/#3031, the 17:30 big
  sitting (migration checklist above), self-serve add-on billing only on the lead's word after the owner's Stripe check.
- Local, unpushed: B1059 (#3189) commit 0a4974580 on branch `docs/bugs-b1059` in `../rf-wt-bk-m` (on master ab3828fa; sync --check 971).
  Next records PR: cherry-pick onto the then-current master.
- Ids: next free = **B1060**. Security records B1055-B1057 are GENERIC on purpose (public during windows): never add exploit detail.
- Lessons register 63.5/64.0 KB 52/52: archive one whole entry before the next lesson.
- Mac Lead messages: one earlier message was dropped (relay-loop cut); content was re-sent in one consolidated message.
- FINAL 2026-10-04T14:25:04Z: repo PRIVATE (read back), no watchdog running, no tmp probe branches on origin, master ab3828fa192cb760f05a3a7b61132689fd409c6a. STOPPED per the lead (account 99%); no window opened.
- LOCAL RECORD BRANCHES (committed, unpushed): docs/bugs-b1059 @ 0a49745805d0e45ba0e67d0d58a3ad4b1dd58462 (B1059, #3189) in worktree ../rf-wt-bk-m, based on master ab3828fa. Nothing else unpushed. Nothing lands without the new lead's PASS on the final heads.
