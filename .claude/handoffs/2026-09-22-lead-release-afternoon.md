# Fleet lead handoff — release afternoon (2026-09-22, written 14:35Z)

Supersedes `2026-09-22-lead-release-morning.md`. Board of record: GitHub issue **#938** — read the
last ~15 comments, they are more current than this. Owner brief:
`local-assets/handoff/2026-09-22/GO-NO-GO-BRIEF.md` (gitignored, PC only). Session cwd is
`C:/ClaudeCode/routeflow` on branch `ops/t6-a0-owner-batch` (owner's T6 work, uncommitted, do
not touch). Owner's Railway link is on that directory; new worktrees inherit `C:\ClaudeCode`'s
link to an UNRELATED project — run `railway` from `C:\ClaudeCode\routeflow` with absolute script
paths.

## Owner decision 15:40Z

**GO once the owner's production smoke run passes at 40e2477d** (chosen from the question box;
recommended). On a pass: post "Release 1 shipped" on #938 with the sha, tell the fleet, tear down
`C:/ClaudeCode/rf-rc-proof` (ports 5433/6380/3000/3001), and have the coordinator mark the release
in `.claude/roadmap/releases.jsonl` in tomorrow's docs PR. On a fail: the failing line decides —
nothing is reverted without the owner; stack stays up for the repro.

## 17:45Z landed: master 347f641d = #1236 05782852 → #1237 a5b91f44 → #1240 e6d03092 → #1239 7ea762c9 → #1243 347f641d

Open in window 5 (PUBLIC): #1241 (B698; CI green + U-units PASS; **captures blocked on F2's
user prompt**), #1242 (B716 docs), #1238 (B715 docs). Fleet-lead skill + learning loop written
(`.claude/skills/fleet-lead/`, `scripts/lead-closeout.mjs log|digest|check|promote`, 8 log
entries seeded, one rule promoted; user SessionStart hook prints the digest). Owner asked for
per-lane status + artifacts: brief re-sent 17:45Z; registry snapshot requested from U-units;
tracker republish after tomorrow's docs PR adds the roadmap entries.

## 17:55Z: three mini builder sessions RUNNING (owner opened them)

"RouteFlow Lane IR inline returns web" (pack sent directly by lead; brief file on the mini),
"RouteFlow Lane B707 mobile edit-items pack", "RouteFlow Lane web unit-line edit". Mac Lead
sequences verifies (one at a time; F2 first when its prompt clears; image builds between
verifies); mini disk 22 GB (~2.2 GB per worktree), 49 GB docker images untouched (ask lead first).
**B716 (vendor-bills poTotal)** = fix/vendor-bills-po-total-stored @ 7bd5228e on the MacBook,
stacked on #1241; ruling: finite check yes, drop ≥ 0; U-units PASS after rebase; F2 captures.
#1239 gated @ 925816f5 (U-units + SA), #1243 gated @ 699b98ef (S-order + S-scan + SA-074),
#1240 merged e6d03092, #1237 deployed 17:22Z → **pilot hold may lift (owner notifies)**.

## 17:40Z owner: "NOPE! I want them done now!" → "do everything on the mini right now"

Three PC builder subagents (inline-returns PR 1, B707, A3-2) were launched then STOPPED at the
owner's direction; nothing pushed. Owner is opening three Sonnet sessions on the mini from my
prompts: "RouteFlow Lane IR inline returns web" (brief file
`SPEC-inline-returns-capture-web-PR1.md` on the mini, SA-071/071a/071b), "RouteFlow Lane B707
mobile edit-items pack" (SA-063: lineUnitsPerBox + unitLabel on UPDATE; tier 1), "RouteFlow Lane
web unit-line edit" (A3-2: ItemUpdate.unitLabel, count+label payload, picker on edit row; tier 2).
Mac Lead sequences their verifies + F2 captures. **B709 = PR #1243 @ 699b98ef** (verify 24/24,
Opus delta PASS; S-order + S-scan + SA). Vendor-bills poTotal: owner's MacBook session
"Extract and fix vendor-bills poTotal drift" → coordinator mints its id (cite B698), branch
fix/vendor-bills-po-total-stored stacked on #1241 until it merges.

## 17:35Z window 5 (open per field; coordinator's time pending)

#1237 MERGED (deploy post pending → pilot hold lifts). #1239 final sha pushing (SA-073 test case +
empty trailer commit; U-units + SA re-pin). **#1240 B715** PASS S-order @ 17248086 (un-drafted by
R-ui; earlier 4 s "failure" = billing block). **#1241 B698** CI green + U-units PASS @ 83e375e6 →
only F2's captures gate it (F2 blocked on its user's :3001 prompt). B709 @ 699b98ef local, push
~17:55Z. Owner opened a session for the vendor-bills poTotal sibling → coordinator mints its id
(one id, cite B698). Lesson queued: draft PRs are doubly invisible (SKIPPED when draft,
unrunnable when private) — isDraft on the pre-window checklist.

## 17:20Z: window 4 CLOSED on watchdog (~17:13Z) with only #1236 landed (#1237 was DRAFT)

**Window 5** (coordinator opening): #1237 (un-draft; both PASSes @ ef06d4e1) → post "#1237
deployed" = pilot hold lifts → #1239 at re-pinned sha (U-units + SA) → **#1240 B715**
scan-price tap affordance (R-ui; S-order tier 2) → B709 (new sha; S-order + S-scan + SA) →
**#1241 B698** (U-units + F2 captures) → #1238 docs. Next checkpoint 17:45Z.

## 17:00Z state of window 4 (open since 16:28Z, master b70c53e0)

- **#1237 B700 pack-at-sale @ ef06d4e1** — PASSes Mac Lead + SA-072 (+ S-scan) → merging first.
- **#1236 B701 invoices update() @ 4025c490** — PASSes Mac Lead + SA-072 → merge on green; squash.
- **#1238** coordinator docs PR: scan-price affordance bug id → R-ui fixes (tier 2, S-order).
- **Predicate PR = #1239 @ c4ccf089** (Lane F, packages/pricing classifySaleAxis per SA-070a;
  repo-truth flake re-run alone, then clean push); gate U-units + SA; merges after #1237.
  Sizing runner fixed to `resolveDatabaseUrl` (Railway TCP proxy vars; `--service postgres`). **Routine** (Lane F, SA-069/069a/069b, apply gate = plan
  hash + guard-sha ancestry + DB fingerprint) follows; SA + Mac Lead.
- **B709 ruling 17:20Z:** SA-068 strict fail-closed broke 52 fixtures (orders.service.spec.ts at
  its ratchet ceiling 9536) → ship **B135's literal shape** `src = held.get(id) ?? li` tonight:
  held wins when present (money fix complete), snapshot fallback only when the held read lacks the
  row → vanished line fails loudly by P2025 rollback, clean 409 + fixture repair + items[].expectedQty
  = morning. SA veto window; S-order + S-scan re-briefed. Opus review fix 66146813 moved a fourth
  snapshot read (existingLineProductIds) to heldById.
- **B709** (MacBook, fix/b-order-edit-live-lines; commit 1 = 0f034920 extraction 5805→5751;
  SA-068c: red case (a) = qty-only UPDATE writing snapshot price; stock delta already live) —
  gate **S-order + S-scan** (Mac Lead off for load), SA diff read.
- **B698 = #1241 @ 83e375e6** (owner's session; web + mobile + list fold; map + L-204 fold inside
  the PR, so no empty follow-up) — gate: CI + U-units PASS + F2's Playwright captures as a PR
  comment (Proof recipe in the body). Sibling drift vendor-bills/page.tsx:1645 poTotal → id via
  coordinator, fast-follow. SA-068d accepted B709 option (2) with four conditions (both reads
  primed in the mirror test; B135-interim comment at `?? li`; body states fallback + P2025).
- **B681 guard = MORNING** (Mac Lead, on the dependency: predicate not on master, nothing to
  wire or to not-fire). **#1236 merged → 05782852** (B701 critical on master). Morning order:
  predicate PR (U-units + SA) → guard (Lane B; Mac Lead + SA) → routine (Lane F; SA + Mac Lead)
  → owner reads the dry run → live run (plan hash, guard-sha ancestry, fingerprint, backup).
- **Inline returns**: spec `local-assets/handoff/2026-09-22/SPEC-inline-returns-capture-ui.md`
  (PC) + Mac Lead's brief file `SPEC-inline-returns-capture-web-PR1.md` (mini). SA-071/071a/071b.
  PR 1 office web capture (options 1+3), PR 2 list filters + held queue, PR 2b override pair,
  PR 3 driver mirror. **Owner asked to open "RouteFlow Lane IR inline returns web" on the mini**
  (no session-start tool in the fleet); else R-ui at first light. F2 also runs B467's two DB specs
  (observed) so the add-on can be granted.
- Owner actions pending: F2's :3001 permission prompt; Lane IR session; sizing via
  `--service @routeflow/api`; pilot pack-size hold notice.

## 16:50Z owner: two urgent product gaps (verified facts)

- **Inline returns:** API complete behind enforced `orders_inline_returns` (+ `flag.returns`),
  B467 OPEN (both DB specs exist), **NO web/mobile UI at all**. Owner: "let's do that now!"
  → lead writes the capture-screen spec (over-return → credit-note option) from S-scan's context
  pack (`scratchpad/inline-returns-pack.md`) + SA product rulings; **R-ui builds web first**,
  mobile mirror next; lands with Playwright proof, not in tonight's fix window.
- **Scan sheet unit type:** OrderLineUnitPicker self-hides without `flag.units_v1` (test only;
  never flip in prod; four open units_v1 findings incl. levy condition SA-066) → grant to the
  owner's tenant only after those fixes.
- **Scan sheet price:** scan V2 screen is behind `developer_mode` add-on (owner's tenant has it —
  screenshot shows it); price is tap-to-edit (LineItemRow.tsx:203-210) with NO touch affordance
  → small fix (icon + aria-label), R-ui after B700, tier 2 S-order; id via coordinator.
- Ledger sync fix landed: **master b70c53e0** (#1235); window 4 open (watchdog 16:28Z+45).
  MacBook saturated by B698's hook chain (8 GB box); B709 serialised behind it. Mini healthy;
  **:3001 still F2's stale expo export — restore blocked on F2's user (owner) approval.**
  Mini janitor report-only approved. Railway: `--service postgres` exposes no DATABASE_URL;
  owner runs sizing via `--service @routeflow/api`.

## 16:40Z BLOCKER: master 40e2477d fails `bugs.mjs sync --check` (B689, B690)

The #1231 batch carried the .md refutations but the ledger mirror was never synced → the pre-push
gate rejects EVERY push fleet-wide (R-ui reproduced on a pinned detached worktree; Mac Lead had
wrongly cleared it from two trees that were not master). Coordinator lands a docs-only `sync`
commit as the FIRST PR of window 4; then every lane merges origin/master and pushes; nobody else
runs sync. Lessons queued: "a claim about a specific sha must be tested at that sha — a tree based
on master is not master"; "`sync --check` runs on the assembled docs branch before merge".

## Owner 16:10Z: "can we fix B681 now?" → B681 STARTED TONIGHT (three pieces)

(1) Owner runs SA-058 via `railway run --service postgres node
local-assets/handoff/2026-09-22/run-b681-sizing.mjs` (READ ONLY tx, refuses non-SELECT).
(2) **Lane B** (after B701) builds SA-067 guard + SA-061 gate + **SA-070** (a) ONE predicate
`isLegacyBoxAxisSale(saleRow, lineShape, correctionsOfRow)` in `packages/pricing/src/legacy-box-axis.ts`
(pure), (b) reverseReturnEntries/reverseCreditNoteEntries never iterate a correctsEntryId row as a
sale row; tier 1 Mac Lead + SA; **morning is an acceptable answer** (touches today's fixed
writer). **R-ui** builds B700 pack-at-sale instead (SA-062, bounded; tier 1 Mac Lead + S-scan).
**Hard order (SA-070c):** sizing → guard lands AND deploys → routine dry run any time → live run.
**Predicate lands FIRST as its own tiny PR** (Lane F, `fix/b681-legacy-box-axis-predicate`,
tier 1 **U-units + SA**; Mac Lead off it for load). Contract = **SA-070a**: three-state
`classifySaleAxis(row, line, corrections, productPackNow?)` → legacy | piece-axis | unknown, first
hit wins: non-SALE → unknown; line null → unknown; split → piece; unitLabel → piece; boxed by
snapshot else live gate (both absent → unknown; not boxed → piece); eff = row + Σcorrections:
effQty ≤ 0 → unknown, ≈ → legacy, > → piece, < → unknown. Guard parks legacy+unknown; routine
corrects legacy, lists unknown; SA-061 gate counts legacy+unknown. Guard PR review: Mac Lead + SA
after B700/B701 clear (Mac Lead's fatigue flag accepted). — no cherry-picks (squash-merge ancestry trap, Mac Lead's catch); guard and
routine rebase on master and import by name. Pack rule (SA-069b): unitsPerBox>1, else
legacyLinePieces basis "source-boxes" → pieces/qty integer ≥2, else factor 1; unknown → UNKNOWN.
Apply gate adds SA-069a: guard-sha must be an ancestor of the served commit on master; plan file
carries a DB fingerprint (current_database, tenant ids, ledger max createdAt).
(3) **Lane F** (PC, worktree `.claude/worktrees/rf-b681-correction`, branch
`fix/b681-correct-ledger`, never remove) builds the correction routine per
**SA-069** (`apps/api/scripts/b681-correct-ledger.mjs`: one formula targetUnitBasis = qty × pack,
pack from line snapshot ?? legacyLinePieces, never live; money only for A+piece reversal via
replay after completeness assert; same entryType, signed deltas, correctsEntryId, originalSoldAt,
period = corrected row's; idempotent delta = target − (booked + prior corrections); live run
consumes the dry-run PLAN FILE id-pinned with hash, aborts on drift; refuses GENERATED periods,
unknown pack, incomplete lines; dry-run report per tenant/category/period with BEFORE/AFTER on
four axes). Apply gate (lead ruling): flags only, `--apply --plan <file> --confirm-plan <hash>
--guard-sha <sha> --i-have-a-fresh-backup`; hash = type-back token; served commit ≥ guard sha;
live-override guard with scope = plan's tenant list; dry run prints the exact apply command.
Tier 1: SA + Mac Lead. Owner's live run: fresh backup, warn-then-approve, after reading the dry
run. Lane B takes over in the morning if unlanded.

## Owner instruction 16:00Z (typed) — declaration AFTER these land

"fix the one or two critical bugs ... and the PO detail subtotal ... before the release."
**Build list (single, confirmed to SA + Mac Lead verbatim after SA's stop-the-line):**
(1) B701 invoices update() via packFromOwnSplit — CRITICAL — Lane B, SA spec ≤13 net lines, no
extraction; (2) B700 pack-at-sale snapshot-first (SA-062) — Lane B; (3) B709 updateOrderItems
race — CRITICAL — MacBook on `fix/b-order-edit-live-lines`, **SA-068**: commit 1 extracts
appendOrderRevision (4948–5005) → orders/order-revisions.ts + lower ratchet baseline; commit 2
widens post-lock heldById select, resolves every diff-branch li from it, CONCURRENT_UPDATE on
missing id; required outcome = stock delta from LIVE qty; lost update on qty NOT closed tonight
(body says so; morning: items[].expectedQty); Arm B morning; (4) B698 PO subtotal web+mobile —
owner's session on claude/wizardly-thompson-a7362f. NOT tonight: inline-return park guard
(**SA-067** = morning spec: SA-058 content rule for detection, false-positive guards, unreverse
deletes that return's parked rows). Reviewers: (1)(2) Mac Lead + S-scan; (3) S-order + Mac Lead

- SA diff read; (4) U-units tier 2. Coordinator opens window 4 on the first fully gated PR;
  watchdog never extended; window 5 if needed. Owner's smoke run at the FINAL sha, then declare.

## Owner decision 15:55Z (superseded by the above)

Mac Lead relayed an owner directive "fix critical/high before the release"; SA-066 triaged: NO
revert; inline-return legacy item is critical-class but MITIGATED by SA-061 (filing gate; SA-049
amended so B681 correction rows may carry money); invoice re-save RAISED to CRITICAL; PO detail
re-derivation LOWERED to MEDIUM; the shared trigger for both silent-corruption items is a product
pack-size edit; substitution levy = condition on any units_v1 grant beyond `test`. Owner chose
(question box): **GO on smoke pass + pilot hold (no pack-size edits until the fix deploys, owner
sends it) + SA's two surgical patches tonight** — (1) pack-at-sale snapshot-first (SA-062), (2)
invoices update() via packFromOwnSplit (SA confirming it fits the 24-line ratchet headroom, else
morning). Lane B builds, Mac Lead + S-scan PASS at exact sha, coordinator opens window 4 on PR
(1)'s PASSes. B671 guard WITHDRAWN. Owner's new PO-subtotal session (B698, web half done on
claude/wizardly-thompson-a7362f) lands tomorrow, tier 2.

## Release state

- **Deadline extended to 16:00Z.** Migration `20260921180000_ledger_correction_and_parked_reversals`
  applied ~14:05Z, `schema-drift` NO DRIFT ×2, backup verified 27.5 MB. Worktree
  `C:/ClaudeCode/rf-prod-migration` @ 2e75d19e was used; has node_modules.
- **Merged today:** 15+ PRs. Both live money defects fixed and confirmed green in production
  (#1221 returns, #1219 credit notes). #1184 merged 14:13Z → b754c33f.
- **In flight:** #1217 (445543f1) hit a real conflict with #1184 in
  `apps/api/src/testing/prisma-mock.ts` — keep-both resolution, MacBook merging master and pushing;
  S-order verifies the delta; #1218 follows. Coordinator holds the window; closes on watchdog.
- **tx-report fix** `fix/tx-report-cases-basis` @ a40660e7 (Lane B, Mac) — SA-051: read `row.qty`
  (line's unit in every era) not `unitBasisQty`. Mac Lead = PASS 1, **S-scan = PASS 2**. Tier 1.
- **Then:** deploys to SUCCESS, `post-deploy-check` (SMOKE_BASE_URL=prod), go/no-go.

## Gate (binds the lead too)

Tier 1 (pricing/regulated/invoice/order money/migrations): **two independent PASSes posted to #938
at the exact merging sha**, coordinator resolves sha against origin (`merge-base --is-ancestor`).
Tree-identity exception only when tree hashes match. Billing-blocked red = zero steps, ~2s, no
logs ≠ real failure ≠ pass. Docs PRs: queue-or-edit, never both; freeze = delete local branch.

## Reachability

Mac mini was **Remote Control off** all day (not accounts — I misdiagnosed). Now on. Names do
not resolve; reply to bridge addresses: **Mac Lead** `bridge:session_01Xht68WkQXbamRhejZwWN9k`,
**SA** `bridge:session_018aNnTMY8UVzQ4tdnzCZXFd`, **MacBook** `bridge:session_01Y7DS6eapNvycyUDpKKfgsH`
(MacBook also resolves by name). PC lanes resolve by name. Every SA ruling before 14:20Z reached
me only via Mac Lead relay to #938.

## SA rulings today (full text in `.claude/sa/` on Mac, PR #1229 pending `code-map:stamp`)

SA-053 B660/#1190 drop confirmed, 3 conditions (B681 brief names the inline-PIECES case; #1184
parked tables documented reserved; **#1180/B662 NOT dropped**, to SA after rebase). SA-054
tx-report deferral reversed. SA-055/057 **#1185: minimal fix first** — keep round-3 sync for
matched lines, never zero an unmatched one; `everInvoiced` column + writer-enumerating guard +
backfill as follow-up; "settle fate at zero time" refused. SA-056 spec typecheck (filed B688,
#1231). B648 unowned until wk of 09-28 (R-028).

## Owner decisions

B681 → **size first** (chosen). SA writing the per-LINE-KEY query (per-row overstates); goes in
brief verbatim when it arrives. Spec-typecheck ratchet red budget → owner, after go/no-go.

## Bug hunt (owner-requested, MacBook)

Layer 1 done, exit 0; both leads refuted → **B688-scanner** (write-pass regex `\b` cannot anchor
after `forTenant()`, 22 models latent false leads, fixture encodes the limitation) — filed via
coordinator. Wave 1 running: A1/A2/A4 Fable, A5 Opus. Paused for #1217. Findings come to lead
for filing, never appended directly.

## 14:45Z addendum

- Window 1 closed on watchdog ~14:36Z, nothing merged. **Window 2 opening ~14:45Z** for #1217
  (PASS at e459acb1, S-order delta-verified) → #1232 tx-report (PASSes ×2 at a40660e7, needs real
  green Verify) → #1218 (if MacBook pushes its rebase onto e459acb1 and S-order PASSes) → #1233.
- **#1210 live defects (F2):** B689 (PO RECEIVED boxed-line cost edit under "Keep stock as is"
  not persisted; severity high PROVISIONAL, mechanism UNCONFIRMED on master — server write is
  unconditional, unknown id throws; SA-059a: silent no-op close when payload empty; F2 asked for
  PATCH response/wire, API build provenance, raw SQL read-back, pack equality) and B690 (untouched
  boxed line round-trips live product pack instead of stored packSize — confirmed by code read,
  `buildUpdateItems` sends `packSize: upb`). Both FAST-FOLLOW, tomorrow's first fix, U-units owns
  the three web files. SA-059 ruling: edit modal derives from the LINE's stored packSize; live pack
  for new lines only. B691 = scanner regex (#1233).
- SA-058 B681 sizing query inserted verbatim in the brief + `local-assets/handoff/2026-09-22/b681-sizing.sql`.
- B687 specs PR (Lane B) held unpushed until after go/no-go. Checkpoint timers armed 15:20Z, 15:48Z.
- **15:00Z:** window 2 open 14:41:48Z; #1217 merged → 2289e679. Hunt A1 claim (box-unaware sale
  line decrements qty, #1217 restocks qty×pack) confirmed by lead code read (orders.service.ts
  :1977-1999, order-stock.ts:132-134). **SA-060: currentStock is PIECES by definition; #1217 right
  side, NO revert; fast-follow on the SALE side** (qty × live pack at write time + snapshot
  unitsPerBox, via the one shape-to-pieces fn; repair only by post-count adjustment, SA-029).
  #1218 hold lifted → merges after #1232. Coordinator checking whether B644 already covers the
  sale under-decrement, else mints an id.
- **B689 repro provenance INVALID**: Mac proof stack API image built 2026-09-21T23:26:35Z (11 h
  before #1210). F2 re-running on a rebuilt image; all Mac proofs from today are void as evidence
  until Mac Lead lists which exercised changed API behaviour. Lesson to file: print API image
  build sha/time and assert ≥ merge sha before any proof (L-176 family, third instance today).
- **15:15Z:** #1232 merged → 4937ed48; #1217 + #1232 deployments SUCCESS. Lane F running
  post-deploy-check @ 4937ed48 (prod, test tenant). #1218 CONFLICTING (squash ancestry trap:
  master has #1217's squash, branch has #1217's commits + bookRestockMovement refactor) → MacBook
  merging master, taking branch side verbatim, proving `git diff c7e05400 HEAD -- <15 files>`
  empty; S-order pre-briefed for tree-identity re-verify; coordinator merges on post + green.
- **B689 + B690 REFUTED** on an image rebuilt at master (14:47:53Z); kept as cleared, anchor for
  the stale-proof-stack lesson. B690's mechanism (live pack vs stored packSize in
  buildUpdateItems) folded into the notes-only-save rewrite id.
- **SA-061** filing gate is on the DATA: no filing for any period with a non-clean SA-058 line
  until B681 corrections applied; Units column rightly sums unitBasisQty; #1232 covers TX report
  only; code gate (prepareFiling 409) fast-follow. **SA-062** pack-at-sale: snapshot first, live
  only when null, warn on differ, two red-first specs; closes most of SA-047 residual (a).
- **A2 verifier batch (MacBook, Fable):** 6 ids to mint — B56-deepen (manual DELIVERED writes no
  deliveredQty → cancel credits full stock), unvoid on CANCELLED order, void CN strands REFUNDED
  return (all high); reopenOrder no CAS, completeStop duplicate payment (medium); run
  COMPLETED→CANCELLED (low). #1190 critical is branch-only → PR comment. Deferral: proof fixtures
  seed tenant SystemConfig (two classifier blocks today). #1089 proof will be partial.
- **15:15Z:** #1218 merge commit 7283c479 local (conflict resolved by c7e05400 blob; own-file diff
  empty; master diff = 6 own files, 9 #1217 files blob-identical) — pushes on verify + Opus green;
  if past ~15:22Z → window 3 (#1218, #1233 if missed, B687 spec PR with SA red-proof line).
  Watchdog ~15:26:40Z. Owner asked to run post-deploy-check with own SMOKE_* env @ 4937ed48.
- **SA-063** class rule (owner to mint R-029): stored line's pack = its own snapshot; live pack
  only for NEW line at write (snapshotted) or warned fallback; enforced by packOfStoredLine() in
  @routeflow/pricing + count-pinned shrink-only callsite specs (api, web, mobile SA-064a); five
  instances (pack-at-sale, PO edit modal, invoices update(), mobile edit-items, B657/B674) land as
  one PR family. **SA-064** standard-return refund = subtotal + tax + category tax shares by the
  ledger's frac, one pricer (inline reference), CN cap → billed total, components on CN lines,
  historic under-refunds → read-only report, owner decides.
- **A1/A4/A5/B5 batches routed to coordinator:** sale-side under-decrement (new high, no B644
  row exists), refund-tax (SA-064), cancel-after-void residue, unvoid-with-reversed-ledger, mobile
  edit-items live pack, Piece-unit park (MacBook fast-follow, units_v1), **CRITICAL
  updateOrderItems stale snapshot (B135 sibling)**, vendor scan double-post, expireTrials vs
  subscribe, scheduled cancellations vs resume, scheduled downgrades, mobile invoices customerId
  dropped; enrich B681/D-23 (REVERSAL rows), B332 (cron census 19 vs 13). Hygiene: B285/B286
  stale-open?, B04/B56 Open in existing-bugs.txt. Hunt to stop after A3/B5-web/B7/B4 report.
- **15:10Z:** window 2 closed 15:04Z (private). Master = 4937ed48 (#1217, #1232). **#1233 merged
  into its stacked base `docs/coord-file-b688`, NOT master** (daa2694e parent c24b8740); #1231
  (base master, OPEN, CLEAN, 32 campaign files) is now the register vehicle for B688–B714.
  Lesson queued: read baseRefName before every merge. #1218 pushed 79eed453 (tree e76f18e7,
  message-only amend of 7283c479; five proofs; verify 27/27; Opus PASS) → S-order verifying →
  **window 3** = #1218 → #1231 → B687 (75015bd9, tier 2). Tracker unchanged (registers same
  since 4937ed48), no republish. Lane F done. Hunt stops after A3/B5-web/B7 verifier batch.
- **15:13Z hunt CLOSED** (#938 issuecomment-5779020780): totals 1 crit master (updateOrderItems
  snapshot), 1 crit branch-only (#1190), 11 high, 13 medium, 4 low, 5 deepenings, ~30 cleared.
  Final batch QUEUED for tomorrow's docs PR (not #1231, frozen): A3-2 web Case-line edit 409
  (units_v1), A3-3 = B677 deepen reconciled with PO-display id, A3-4 PO receive live pack (6th
  SA-063 instance), B5-web-6 add-on charge before preview, B5-web-2 tag catalog, B5-web-1 urgent
  toggle, B7-1 tenant-proxy select gap (low). B7-2 refuted (platform convention).
- **Window 3 OPEN 15:10:31Z**: #1218 (79eed453, S-order PASS) → #1231 → B687 (Lane B pushing).
  MacBook holds its branch until master ref moves. Owner still to run post-deploy-check.
- **15:25Z: #1218 merged → 545a4b23 (base + ref checks clean). RELEASE 1 CODE COMPLETE.**
  Deploys building; then #1231 (registers) → #1234 (B687 @ 75015bd9, Mac Lead PASS) → private.
  MacBook branch hold released. Owner to run post-deploy-check @ 545a4b23 after SUCCESS, then
  go/no-go.
- **15:30Z LANDING COMPLETE.** Master 40e2477d (#1218 545a4b23 → #1231 c4d470fe → #1234
  21e90e8d → #1228 40e2477d), PRIVATE, all deploys SUCCESS (#1234's spec triggered one). Open PRs:
  19 (coordinator's count; my "six" was a `--limit 6` read) — today's: #1229 (stamp tomorrow),
  #1230 (needs review), #1190 rework; older fast-follow/deferred: #1059 #1060 #1120 #1121 #1134
  #1137 #1154 #1163 #1180 #1181 #1183 #1185 #1187 #1189 #1194 #1197. MacBook code-map catch-up
  committed at fd69298f (docs/code-map-web-mobile-catchup, on origin) → fold into tomorrow's docs PR.
  Owner running post-deploy-check for go/no-go. Fleet stood down with tomorrow's order:
  docs branch first (final hunt batch, 3 lessons, deferral, hygiene, bookkeeping trailers for
  #1217/#1232/#1218); then code: SA-063 family → updateOrderItems race → sale-side
  under-decrement (SA-060) → SA-064 refund pricer → SA-061 prepareFiling gate — **amended by
  SA-065:** orders.service.ts is AT its size ceiling (5805/5805) and invoices.service.ts at
  6390/6414, so the FIRST PR into each carries a behaviour-neutral funding extraction as commit 1
  (SA-022/025 shape) and later PRs into that file serialize behind it; live money outranks the
  guard (SA-026): the updateOrderItems race lands FIRST if it does not need packOfStoredLine,
  else right after the helper; SA-060 runs in parallel on a lane not holding orders.service.ts;
  #1185 minimal fix ranks ahead of SA-064 when capacity frees; pack-at-sale first of the five
  pack instances; MacBook A4-F3 +
  #1190 rework; Mac #1229 stamp+land, F2 #1045/#1089-guard; SA-058 run by owner after go/no-go.
- Mac hunt: PO detail views re-derive qty×unitCost (web PurchaseOrdersTab.tsx:112, mobile
  purchase-orders/[id].tsx:208) — id pending; notes-only PO save rewrites billed line total (same
  root cause as B690) — id pending; invoice re-save reinterprets split at today's pack — PLAUSIBLE,
  verifier running, no id yet.

## Filed today

B682 strict guard no callers · B683 stale comments · B684 PriceEditor guard · B685 DB-lane CI
gap (narrower: fires on spec add, not on service change) · B686 scripts/ unlinted · B687 no
return+credit composition test · B688 spec typecheck (#1231) · scanner regex (pending id).
D-24..D-33 deferrals. #1228 registers, #1229 SA registers+code-map, #1230 sweep-repro-red.

## Held / dropped

#1121 HOLD (live-product denominator) · #1185 HOLD (deadlock, SA minimal fix next wk) ·
#1187/#1190 open-as-record, dropped · #1194/#1189 fast-follow · B663 cut.

## Tracking

Tracker artifact v2 https://claude.ai/artifact/WRxxrqUTN8eTCcua4Men1f (from #1228 registers).
Plane in sync (0/0). Code-map 42 behind = D-25, each lane maps its own post-release.

## Day's lesson (six instances, all one property)

**A fact restated in a second place; the second copy is the one that goes wrong.** Stale comment,
stale verdict, typed placeholder, relayed claim, shell substitution, correct-then-stale caveat.
None from carelessness. Remedy is structural, never "be careful": provenance on claims,
sha-resolution, freeze-by-deletion, `date -u` not estimates, guards paired with default-lane pins.

## 18:15Z addendum (post-compaction)

- Window 5 closed ~18:08Z (PRIVATE at 18:12Z); master **1001cf07**. #1238/#1242/#1244 docs merged.
- **#1245 B707 @ fb434fbd** fully gated: S-scan PASS 1 + **SA-075** PASS 2 on #938, Verify green 17:56Z → coordinator opens window 6, squash.
- **#1241 B698 @ 83e375e6**: CLEAN, U-units PASS, captures still owed. Owner chose (question box 18:0xZ): answer F2's block. Mac Lead: F2's block is an **AskUserQuestion** inside "RouteFlow Mac F2 prover" (pending since 14:54:53Z), almost certainly about the classifier-refused SystemConfig write for the #1089 credit-limit proof, NOT a permission card. MacBook has no container runtime (B716 session verified). Capture scope: web PO detail row (per-piece + boxed), mobile operator PO detail row/header + PO list row; not vendor-bills, not the edit form.
- **Merge order: #1241 before B716.** ce526294 (branch `fix/vendor-bills-po-total-stored`, unpushed, worktree exciting-haslett on the MacBook, owned by "Extract and fix vendor-bills poTotal drift") imports `resolveStoredPOLineAmounts`, defined only on #1241. Never cherry-pick it. Rebase belongs to that session once master contains #1241; the B716 session reports the merge sha.
- **Load cap was fiction:** no jest config reads JEST_MAX_WORKERS; verify-turbo.mjs pins --concurrency=2 → 2 × (cores−1) workers. Instruction fleet-wide: check-types + lint alone; tests per workspace with `-- --maxWorkers=2`; one full verify per machine with nothing else running. Tooling follow-up: verify-turbo.mjs passes --maxWorkers from an env var. Logged (lead log, rule candidate load-cap-provenance).
- SA-075 sibling sweep (4 mobile callsites reading live pack) → coordinator to file / attach to SA-063 callsite spec.
- Mini: Lane IR verify aborted for load; Lane web unit-line committed locally 76933fc7, holding.

## 18:32Z addendum

- **#1245 B707 MERGED → master f10bf3b5** (coordinator verified both PASSes at fb434fbd, real green 7m10s).
- **#1246 B681 correction routine** OPEN, not draft, base master @ d10e74e5, five files (api script + query lib, pricing module + 15-case spec, index export). Reviewers: SA (money-replay scope, deriveLinePack duplication vs SA-069b, apply-gate ordering, migration ownership) + MacBook read-only (gate logic, dry-run/apply selection divergence, classifier single-source). Lands AFTER Lane B's guard = morning.
- **#1241 captures corrected: AFTER only at 83e375e6, ONE image build, no BEFORE.** The running `routeflow_web` on the mini is a 2026-09-21 build (api 09-22 09:47; master committed 12:47), so a BEFORE off it proves nothing and an honest one costs a second build on the owner's machine. Red-first run already evidences 11,000.40.
- **Owner ruling 18:40Z: work must not be delayed by Photoshop.** Blanket hold replaced by a bounded-run rule on the mini: one run at a time, `--concurrency=1`, `--maxWorkers=2`, Playwright `--workers=1`, pressure read before and mid-run, stop at 3. Queue: F2 captures → Lane IR verify+push → Lane web unit-line. Owner also ruled: keep Docker up (dashboard stays), leave ~/Library/Caches alone.
- **Mini after standdown:** pressure 1, free 6.07 GB, load 9.96 → 4.48, disk 20 GB. Reclaims were negligible (816 KB of stale watchers); the win was lanes standing down. `:3001` is the compose web container (ssh listener = Colima port forward, not external).
- **B467 closed on an observed green run** posted by Mac Lead on behalf of F2 (#938 comment 5781773639), rf-proof-web at 1001cf07, 2 suites / 3 tests / 1.987 s.
- **Two ids to mint (coordinator, docs PR tomorrow):** janitor proposes removing a live worktree (no liveness signal + enumerates only one checkout's worktrees; `--target` widens eligibility); B465 sibling found by the web lane while held (unit switch via picker set ladder price without moving the reason-required baseline → false reason demand for special-tier customers), fixed in `1d70034b`, same PR.
- **Lead log now 12 entries:** added load-cap-provenance, cleanup-plan-read-before-apply, idle-lane-self-review.

## 19:10Z addendum

- **#1241 B698 MERGED → master 3d86b9ab.** Verified: `resolveStoredPOLineAmounts` now resolves on master, so B716's import is real. B716 session rebases onto 3d86b9ab, no cherry-pick, cites B716+B698 (id already filed by #1244). Repo PRIVATE.
- **Two lead rulings recorded on #1241:** (1) AFTER-only captures approved, the pre-fix value is already observed by the red-first run and an honest BEFORE needed a second image build on the owner's machine; (2) captures delivered as DOM-extracted values + file paths + environment satisfy the gate, because the heavy-files policy keeps images out of git and `gh` cannot attach one. Pictures in a PR need a human via the web UI.
- **VM shrink DONE.** colima 10 GiB → 6 GiB, CPUs preserved at 6 (all three flags passed explicitly). Reads: `colima list` 6GiB/6, `docker info` MemTotal 5.77 GB / NCPU 6, `free -m` total 5909. `:3001` HTTP 200 by curl, ~25 s downtime, five containers healthy. Host: swap used 10.7 → 5.3 GB, free 45% → 53%. The reservation had been FORCING the paging; the win exceeded the 3.7 GB arithmetic.
- **#1246 B681 routine: HOLD at d10e74e5.** SA-076 (FIX 1 return-true-pieces + park, FIX 2 parked-reversal rows when money declined, FIX 3a refuse on exit 1, FIX 3b plan-scoped FOR UPDATE) + SA-076a (dist stamp via shared `scripts/lib/assert-pricing-dist-fresh.mjs` + stamp in plan; per-row evidence hash with fixed contents) + gate review's 2 high / 2 medium / 2 low. Lane F rebuilding; both reviewers re-read at the new sha.
- **B681 guard in flight**, units lane, PC, `fix/b681-park-guard` off f10bf3b5. Seam contract: routine writes a parked-reversal row per declined money correction; the guard's SA-061 gate must keep holding on those until the resolver clears them. Spec it from the guard side.
- **Owner asks taken on (outside the release):** multi-line per-item notes → `feat/multiline-item-notes` (PC, Order UI lane) off f10bf3b5, full brief sent, no migration needed (column is already `text`); at-location order mode → `local-assets/handoff/2026-09-22/SPEC-at-location-order.md`, owner ruled regulated POD REQUIRED, payment deferred to v2, post-Release-1.
- **Five ids from the notes trace + two from the at-location trace** are with the coordinator (unbounded update DTO, missing StripHtml on item notes, dead `itemNote`, note never reaches packing list / manifest / driver checklist / invoice email, stale 5-value `OrderStatus` mirror in `packages/types/index.ts`, bare status PATCH to DELIVERED enforces no regulated POD).
- **Lead log at 18 entries.** New tonight: load-cap-provenance, cleanup-plan-read-before-apply, idle-lane-self-review, correction-opens-with-a-stop, brief-cites-merged-signature, resolve-by-construction, prove-the-gauge, assign-ui-only-to-a-host-that-can-prove-it, unexplained-red-is-a-load-suspect.

## 19:35Z addendum — the verify-cap blocker

- **Unbounded pre-push verify is the fleet's blocker.** `scripts/verify-turbo.mjs:17` pins `--concurrency=2` and reads NO env var; every workspace test script is a bare `jest`. Authorised ONE watched unbounded verify on the mini (best machine state of the day, 57% free, swap 5.9 GB, load 2.6, zero workers). It hit **pressure 4 in ~2 minutes**: **21–22 workers** (not the predicted 18), free 21%, swap 11.6 GB, load 17. Lane IR's push did NOT land; nothing lost, jest is read-only, 4 commits intact on `feat/inline-returns-capture-web` (c2e592cc / 36b5a200 / 59126f48 / 2feac558, 14 files, tree clean, branch absent from origin). **No second attempt.**
- **The authorisation was mine.** The 18 was derived, never counted; I accepted a recommendation resting on a number without asking whether it had been measured. Logged as `authorise-on-a-count-not-an-estimate`.
- **Killing jest does NOT stop a runaway verify.** `--continue=dependencies-successful` makes turbo skip to the next task and re-spawn within seconds; a half-kill looks successful because pressure drops first. Kill the whole tree incl. the turbo/npm parent, scoped by worktree path. Logged as `kill-the-tree-not-the-task`; also given to the coordinator for the runbook.
- **Critical path is now `fix/verify-worker-cap`** (S-scan, PC, off 3d86b9ab): env pass-through for a worker cap, default byte-identical so CI is unchanged, self-test proving both the unchanged default and that the var reaches jest, plus the re-spawn assertion or a documented full-tree kill. **Proof is a COUNTED worker number during a real run; the number to beat is 21.** Reviewer pre-assigned: Mac Lead (diagnosed it, measured it, otherwise idle), reading in parallel with the flip.
- **Window correction to the coordinator:** CI cannot be green before the flip (checks do not run while private under the billing block). The ONLY precondition for flipping is PR exists + `isDraft == false`; everything else happens inside the window. Coordinator accepted. Order: verify-cap → #1246 if cleared → B716 once rebased.
- **Mini watcher now has three signals:** pressure ≥ 3, swap ≥ 14.5 GB, **workers ≥ 12** (the ramp arrives before either memory signal; 12 is clear of a bounded run's 3 and well under the measured 21).
- **Owner asks recorded:** at-location spec amended with the **recipient bypass** (owner ruling) — a driver/operator/admin may skip capturing who personally received regulated goods, the known billed customer is recorded instead; bypass is logged not silent, tenant-configurable default OFF, safe-drop still forbidden on regulated, age verification untouched, and compliance is stated as the owner's call. Roadmap registrations sent to the coordinator for at-location, multi-line notes, and the verify cap.
- **Lead log at 20 entries.**

## 21:30Z addendum — the B717 critical and the verify-cap unblock

- **#1249 verify worker cap MERGED → master 949eb154** (21:23:49Z). `JEST_MAX_WORKERS` and `VERIFY_CONCURRENCY` are now real; **effective ceiling = VERIFY_CONCURRENCY × JEST_MAX_WORKERS** (cap 2 + concurrency 2 ≈ 4 workers, not 2). Proof was a counted 8 workers at cap 4 with two jest parents concurrent, against 21–22 uncapped. `.husky/pre-push:94` still says "No environment variable narrows the run" — deferred to the coordinator's bookkeeping follow-up **by my ruling** (a second 7-min CI run vs two lanes idle 2.5 h); the PR body carries interim guidance so the deferral is safe. **Any shell still exporting JEST_MAX_WORKERS=4 from this morning now silently gets a cap** — every lane told to echo and unset first.
- **B717 = the night's critical, found by the MacBook hunt on freshly merged code.** #1236 left `unitsPerBox` undefined on ANY underivable split → box price charged per PIECE (12× on a 12-pack) AND the snapshot nulled → wrong figure into the regulated ledger. **Live 16:52:30Z–now. Production exposure CONFIRMED ZERO** (46 lines edited in window, 9 on boxed products, 0 with the signature; query keyed on the null snapshot so it covered all three paths). No credit notes owed.
- **Three null paths, not one** (`packFromOwnSplit`: no boxes / non-integer quotient / quotient exactly 1). Fix must key off `pack == null`, never `boxes === 0`. My approval of the lane's narrowing was **reversed by SA-077a** — narrower was not safer, it left the wrong price reachable on a different shape.
- **SA-077c withdrew the qty normalisation entirely.** The lane traced that `recomputeOrderFromInvoices` (:2255 → :2311 → :2347) writes the normalised qty onto `OrderItem.qty` AND `invoicedQty` — qty 10 → 38 on a notes-only save. Final shape: **store qty AS SENT; price from the split at the resolved pack (payload → unanimous stored → live); snapshot the resolved pack; warn.** Residual = ledger under-file on a contradictory split: bounded, findable (warn + consistency query), NOT covered by the B681 guard, closed by the follow-up 4xx.
- **SA-077(2) guards a LIVE shape:** the DTO validates qty/boxes/pieces independently with no cross-field invariant, so `{10,3,2}` passes from mobile, import, script or curl. The 4xx follow-up is the next piece of work, not a queued one.
- **`buildPriorPackMap` loses unanimous information:** exactly-one-line-per-product means two lines at the same pack lose BOTH snapshots. Fix = carry on unanimous agreement, refuse only on disagreement.
- **Pilot hold REINSTATED** (SA-078) until the reconcile fix deploys; owner is sending the notice. **SA-078(b)** (carry the prior InvoiceItem's pack for the same orderItemId) is built by Lane F at `fix/sa078b-reconcile-pack-snapshot` @ 56433d4cf, unrun.
- **Check-run rule (adopted fleet-wide):** gate on a completed run of plausible duration **by run id**, never the aggregate. A `Verify` finishing in ~2 s is the billing-block artifact. Tonight's worked example: 106939394543 = 6m59s real green; 106938493898 = 2 s artifact.
- **PC queue:** B681 guard verifying → Lane F SA-078(b) (lifts the pilot hold) → multi-line notes. **Mini:** Lane IR pushing now, web unit-line behind it, one at a time.
- **Lead log at 38 entries.**

## 21:45Z addendum — B717 landed; both urgent features are PR'd

- **#1253 B717 MERGED → master 3e707af8.** Tonight's live billing defect is fixed on master and deploying. Both PASSes at 219d0935 (SA-077d + Mac Lead comment 5784618671), squash. Final shape: qty stored AS SENT; money from the split at the resolved pack (payload → **unanimous** stored → live with a warn); snapshot never cleared on an underivable save; keyed off `pack == null`, closing all three `packFromOwnSplit` null paths. **Seven observed reds in the body**, all run not predicted: 110/34.83, 550/24.75, 77/56.83, unanimous-pair 6/12, 55/4.58, 143/11.92, null-snapshot/12.
- **Known limitation documented, both reviewers found it independently:** disagreeing stored packs for one product carry nothing and re-snapshot at the live pack with a warn. Cannot be fixed without line ids on the replace payload, which would be the positional guess the unanimity rule refuses. Body, not code.
- **#1249 worker cap merged earlier → 949eb154.** Effective ceiling = VERIFY_CONCURRENCY × JEST_MAX_WORKERS. Confirmed on two machines at two cap values by three observers: 21–22 uncapped vs 8 at cap 4 (PC) and 7 at cap 2 (mini).
- **Owner's two urgent gaps are PR'd, blocked only on captures:** #1250 inline-returns capture @ **6cec01e9** (S-scan PASS posted, tree identity proven), #1252 order-edit unit line @ **8b34fea2** (U-units reviewing). Captures running on the mini, 3002 then 3013.
- **B681 guard @ 5183e1d5: SA-080 PASS with ONE test-only condition** — add the "row with no readable line parks" spec case, push, SA re-reads the spec diff. **Its merge sha is what the routine's apply gate keys on (SA-070c).**
- **SA-077(2) owned by the B717 lane**, starting off 3e707af8: refuse only when a split is present and no pack exists anywhere; ships the read-only consistency query (split where qty ≠ boxes × pack + pieces).
- **Trailer trap, three shapes, all present identically:** HEAD moved onto a merge commit; HEAD moved onto the lane's own later commit; trailer silently dropped by a blank line in the message (git parses the contiguous last paragraph). Remedy is an empty commit and it is FREE — the hook prints "tree already passed npm run verify locally — skipping (clean tree, unchanged content)". **Grep for the specific trailer, never for non-empty output.**
- **Check-run rule:** gate on a completed run of plausible duration **by run id**; a Verify finishing in ~2 s is the billing-block artifact.
- Coordinator's exit sequence: both deploys to SUCCESS → flip private as a `finally` and read visibility back → post-deploy check (positive evidence the deployed code prices a partial-box line correctly) → window summary. Bookkeeping PR carries four runbook items.
- **Lead log at 42 entries.**

## 22:00Z — end-of-night state (read this first tomorrow)

**Master 3e707af8. Repo PRIVATE (read back, not assumed). Deploy SUCCESS 21:48:40Z; post-deploy-check green, health commit = 3e707af8. A live probe of the exact defect shape on a test tenant was authorised and is the last thing running.**

### Merged + deployed tonight

- **#1249** verify worker/concurrency caps → 949eb154. Ceiling = VERIFY_CONCURRENCY × JEST_MAX_WORKERS.
- **#1253 B717** the live billing defect → 3e707af8. Deployed and confirmed.

### Ready in the morning window, in this order

1. **#1250 inline-returns capture @ 6cec01e9** — GATE FULLY SATISFIED: Verify success 21:35:06→21:42:42Z (7m36s), S-scan PASS at that sha with tree identity proven, 15 captures (5 states × 1440/768/390) on the **mini**, paths in the PR comment. Outstanding: SA contract read + R-ui cold read, **additions not gate items**.
2. **#1252 order-edit unit line @ 8b34fea2** — Verify success 21:37:47→21:44:56Z (7m09s). Needs U-units' PASS (not started) + captures on 3013.
3. **B681 park guard** — SA-080 PASS with its one condition now met (the "no readable line parks" case added); lane pushing + opening the PR. **Its merge sha is what the routine's apply gate keys on (SA-070c).**
4. **#1248 vendor bills @ 66e8ee66** — owes captures.
5. **SA-078(b) reconcile fix** (Lane F, `fix/sa078b-reconcile-pack-snapshot`) — **this is what lifts the pilot hold**, which is keyed on it, NOT on B717. Still verifying on the PC.
6. **SA-077(2)** (B717 lane, `fix/sa077-2-refuse-unpackable-split`) — `splitWithoutPack` exported from pricing, called FIRST in `lineAmbiguity`, 4xx at create AND update, consistency query as a stated mirror. Follow-up filed as **B729** (#1254): extend to the buyer order endpoints, the surface SA-036's generic message was written for.
7. **feat/multiline-item-notes** (notes lane) — cites **B724**; third in the PC queue.

### Corrections I issued tonight that must not be re-litigated

- **No second overcharge in invoice create.** A measured 660 was the CORRECT price: on a product with no pack a unit price is per piece. The incoherence was in the request. No id, exposure stays closed. The truthy `product?.unitsPerBox` at pack 1 is **B664**, already filed medium.
- **Exposure for B717 = confirmed ZERO** across all three null paths (46 lines edited in window, 9 boxed, 0 with the signature).
- `computeLineSubtotalStrict` **is** called — three sites in `build-line.ts`.

### Standing rules earned tonight

Gate on a **run id** of plausible duration, never the aggregate; a ~2 s Verify is the billing artifact. Grep for the **specific** trailer, never non-empty output. A merge moves HEAD off the trailer; the empty-commit remedy is **free** (hook prints "clean tree, unchanged content"). Headroom is available memory read now, never installed total. End-of-run comes from **exit status**, never a process count. An observed value with an assumed meaning is still an assumption.

**Lead log: 43 entries.**

## 22:05Z — B717 confirmed fixed IN PRODUCTION by live probe

Coordinator ran the exact defect shape against production on `e2e-routeflow` (approved test tenant):
product "B717 PROBE box-of-12", pricePerUnit 11, unitsPerBox 12 → DRAFT invoice with a full-box line
(11.00, correct) → **PATCH through the real update() path to boxes:0, pieces:5, unitPrice:11**.

```
observed subtotal   4.58      (5/12 × 11 = 4.5833 → 4.58)   CORRECT
pre-fix would be   55.00      (box price per piece)
stored unitsPerBox    12      not null — the snapshot half is fixed too
```

Draft `ca9f44ad-65db-4ef3-b8c4-af436bfca042` left in place on the test tenant, no cleanup.

**This is the end-to-end claim rather than the adjacent one.** Deployment success, health commit and a green
smoke pass each prove the code is present; only this proves the deployed system prices the shape correctly.
Both halves of the defect — the overcharge and the snapshot destruction — are confirmed closed in production.

## 22:10Z — B681 guard PR is open

**PR #1255 @ `e2aba544e`**, not a draft, base master, cleanly mergeable, exactly 4 files, master merged twice
(#1241, #1253) with no conflicts. Trailer confirmed on HEAD by grep for the literal string.

- **SA-080's condition is met.** The "row with no readable line parks" case is in, and the lane tested the
  REACHABLE form: `reverseReturnEntries`'s pre-existing `productByItem` gate means a row only becomes a
  candidate once its `invoiceItemId` already resolves a product, so "both ids null from the start" is
  unreachable. It modelled the id resolving while `loadSaleLineShapes`'s fuller re-read comes back empty,
  and documented why in the test.
- **Reviewers already hold it, nobody new to name:** the architect re-reads the spec diff at this sha;
  the Mac Lead's PASS on the code at 5183e1d5 re-pins here.
- Body carries the count-pin reasoning with the "present count + retiring change, never a predicted number"
  rule named, the snapshot-trust paragraph on #1236/B700, and the seam contract with the correction routine
  stated from the guard's own side as a generic filing gate rather than an assumed shape.

**Reminder for the morning: this PR's MERGE sha is what the routine's apply gate keys on (SA-070c).**
It is the anchor for the rest of the B681 chain, not one PR among several.

## 22:15Z — guard has its first PASS

**SA-080 final: #1255 PASS @ `e2aba544`** (architect's, one of two; Mac Lead re-pins from 5183e1d5).
Condition met in the REACHABLE shape, and the architect stated why it matters: case (a2) makes the row a
live candidate because `productByItem` resolves its `invoiceItemId`, then the guard's OWN fuller re-read of
that id finds nothing and the OrderItem fallback finds nothing → parked, "no line to read a shape from",
no REVERSAL, warn. **The guard's own read is the one that can come back empty when a reconcile deletes or
rotates the invoice item between the two reads**; the naive both-ids-fail shape is unreachable and would
have proved nothing.

Only other change since fb5dcc9c is #1253's baseline 3 arriving via the master merge; the guard's own pin
stays at 1. Four files, merge-tree clean against 3e707af8. **Squash in the morning window — one PASS still
outstanding.**

## 22:20Z — mini idle, everything staged for morning

- **#1252 captures verified on disk** (1440/768/390). Both the visual and behavioural proofs come from the
  SAME edit (`ORD-90015`), so a reviewer traces one transaction end to end rather than matching a payload to
  a screenshot of some other state. Worth making the house standard.
- **CAPTURE RULE, learned on the last item of the night:** the interactive browser tool's screenshots are
  **inline-only** — they live in the session transcript, cannot be attached to a PR, cannot be verified by
  anyone else, and vanish with the session. The lane's first pass produced **nothing on disk**. UI proof is
  written to a file by a script; confirm the PNGs exist and name host + path in the PR.
- **#1255 re-pinned to `e2aba544` by the Mac Lead**, who checked my premise rather than my conclusion: I said
  "spec-only push", it was two master merges plus one spec case. They proved the guard service byte-unchanged
  (`git diff 5183e1d5 e2aba544 -- regulated-ledger.service.ts` empty) so the code review stands. **Both PASSes
  are now green at e2aba544.**
- **#1256 SA-077(2)** open at `537772d3`, complete: `splitWithoutPack` first in `lineAmbiguity`, 4xx at both
  invoice paths, consistency query as a stated mirror, B729 cited, buyer-variant omission explained. SA holds
  one PASS; **second reviewer to name in the morning.**
- Mini idle, compose healthy, `:3001` serving, repo `private=true` by API read. Mac Lead's own handoff is
  `.claude/handoffs/2026-09-22-mac-lead.md`.
- **Live evidence for #1246's dist-vs-src HIGH:** `tsc` failed against a stale `packages/pricing/dist` while
  jest passed against src, reproduced by accident on an unrelated change. Sent to the architect.

## 22:20Z FINAL — everything staged, nothing merges before morning

**Master 3e707af8 · repo PRIVATE (read back) · B717 fixed AND confirmed in production by live probe.**

### Morning window, in this order

| PR                                 | sha        | state                                                                                            |
| ---------------------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| **#1257** SA-078(b) reconcile pack | `45f306c6` | SA-078e PASS (1 of 2), body conditions met. **LIFTS THE PILOT HOLD — on DEPLOY, not on merge.**  |
| **#1255** B681 park guard          | `e2aba544` | **BOTH PASSes green.** Its MERGE sha is the routine's apply anchor (SA-070c).                    |
| **#1250** inline-returns capture   | `6cec01e9` | Gate fully satisfied + 15 captures verified. Owed: SA contract read, R-ui cold read (additions). |
| **#1252** order-edit unit line     | `8b34fea2` | Green + 3 captures verified. Owed: U-units PASS (not started).                                   |
| **#1256** SA-077(2) refusal        | `537772d3` | SA-077g PASS (1 of 2). **Name the 2nd reviewer.**                                                |
| **#1248** vendor bills             | `66e8ee66` | owes captures                                                                                    |
| notes lane                         | local      | third in PC queue, cites B724                                                                    |

### Facts that must not be re-litigated

- **No second overcharge in invoice create.** The measured 660 was CORRECT: no pack ⇒ price is per piece. Incoherence was in the request. No id; exposure stays closed. Truthy `product?.unitsPerBox` at pack 1 = **B664**, already medium.
- **B717 exposure = confirmed ZERO** (46 edited, 9 boxed, 0 with the signature) and confirmed fixed in prod by probe: 4.58 not 55.00, snapshot 12 not null.
- **#1257 stops the corruption, it does NOT repair it.** A prior item already rewritten at the live pack by a pre-fix reconcile is carried forward as-is — that is B681's "reconciled after a repack" bucket (SA-078d), the routine's job.
- `computeLineSubtotalStrict` IS called — three sites in `build-line.ts`.
- **`invoices.service.ts` is at 6414/6414, zero headroom.** Next change into it extracts first (SA-065).

### Rules earned tonight (all in the lead log, 46 entries)

Gate on a **run id** of plausible duration, never the aggregate; ~2 s Verify = billing artifact. Grep the **specific** trailer, never non-empty output. A merge moves HEAD off the trailer; the empty-commit remedy is **free** (hook prints "clean tree, unchanged content"). Headroom = available memory now, never installed total. End-of-run = **exit status**, never a process count. **An observed value with an assumed meaning is still an assumption.** Pin where a guard does **not** fire. **A transcript is not an artifact** — UI proof is written to a file by a script. Suspect the capture as well as the product. Review what a change **gives up**, not only what it does.

## 22:25Z — merge ORDER ruling, and #1257's conditions closed

**RULING (mine, on the architect's observation): #1257 merges FIRST tomorrow, ahead of #1255.**
By mechanism #1257 has NO dependency on the B681 guard or routine — it touches the invoice rebuild and the
pack-at-sale helper, the guard touches the ledger service, no file overlap. Holding it behind B681 would only
delay lifting the owner's pilot hold, which is keyed on **#1257's DEPLOYMENT** (not its merge).

**#1257's body conditions are all closed**, confirmed by the lane: the expanded red-first numbers
(24/24/120 → 12/12/60, plus the new-line case at 24 proving the fix does not over-reach); the cap-exact
6414/6414 stated as a fact for the next lane with the identifier-shortening left flagged for reviewer
judgement; and a dedicated section stating that this fix **stops future corruption and does not repair it** —
pre-fix-corrupted rows are carried forward deliberately rather than re-derived, and belong to B681's
SA-078(d) bucket handled by the routine (#1246). The test-plan footer now says the hold lifts on deploy.

The architect accepts the identifier shortening **once, because it was disclosed** — "the ratchet's letter
without its spirit". Next change into that file extracts first.

**Final morning order:** #1257 → #1255 → #1250 → #1252 → #1256 → #1248 → notes lane.

## 23:30Z — BOTH of the owner's urgent gaps are on master

| merged | sha          | what                                                                        |
| ------ | ------------ | --------------------------------------------------------------------------- |
| #1250  | 4d4a7bfe     | inline-returns capture (web): over-return → real credit note                |
| #1255  | **3ff8b142** | B681 park guard — **this sha is the routine's apply-gate anchor (SA-070c)** |
| #1252  | 34668f7d     | order-edit unit line: unit type + price, with the B465 intra-branch fix     |

Earlier tonight: #1249 worker cap (949eb154), #1253 B717 billing fix (3e707af8, deployed + probed).

### Still open

- **#1257** reconcile pack — HELD on a confirmed gap: `rebuildIssuedDepositMirrorOnDelivery` is a 4th caller of the `rebuildSiblingDrafts` core and never selects `items`, so the carried pack is always empty and the headline defect survives for prepaid deposit-mirror orders. SA withdrew its PASS (posted, comment 5785883386). Fix = same select + a test driving that caller + fresh PASSes from both at the new sha. **This is what lifts the pilot hold, on DEPLOY.**
- **#1256** unpackable-split refusal — PASS at `bdcc8194` conditional on rewriting `pricing.ts:217`'s over-broad comment; extraction bought the service back to 6401 under the 6414 cap.
- **Extraction → `packages/returns`** — HALTED at classification: web's copy is 249 lines/35 tests, mobile's is **253 lines/25 tests**. Already drifted. Lane must classify every difference as platform-necessary / accidental / real behaviour change and send the three buckets before moving anything. Web is source of truth.
- **Mobile unit picker** — NOT on origin yet. `feat/u-unit-picker-5a` @ 02e168ab is OLD WEB work (unwired picker component), not this. I misread a truncated ref and sent a reviewer to the wrong diff.
- **Mobile inline-returns mirror** — `feat/inline-returns-mobile-mirror` @ dc76dfa3, logic layer done, operator screen next, driver dormant pending the `developer_mode` answer.
- **multiline notes** — running on the PC.

### Owner questions logged

`local-assets/handoff/2026-09-22/OWNER-QUESTIONS-PENDING.md` — five, each with a recommended answer.

## 23:40Z — B681 apply gate is ANCHORED

**#1255 merged 23:24:44Z → squash `3ff8b142`, production deploy SUCCESS 23:27:42Z.** The architect verified
the four files identical to the reviewed tree at e2aba544 post-merge.

**SA-070(c) step (2) is satisfied.** The correction routine's apply gate keys on the guard sha:
the served commit must be at or after **`3ff8b142`** on master. So the routine's `--guard-sha` value is
**`3ff8b142`**, and the live run is unblocked on the guard side.

**What still blocks the B681 live run**, in order:

1. **#1246 routine revision** — HOLD on its own SA-076/076a fixes (live-sha gate that cannot refuse; dist/src
   stamp; per-row evidence hash; replay refusal; statement timeout). Lane F owns it, AFTER #1257.
2. **Owner runs the sizing query** — never run. `railway run --service postgres node
local-assets/handoff/2026-09-22/run-b681-sizing.mjs`. Nothing downstream can be planned without the count.
3. Owner reads the dry run, then authorises the live run with a fresh backup.

#1252 landed after the guard at `34668f7d`.

## 23:45Z — four of five merged; #1257 is the last of the set

| merged tonight                                     | sha                               |
| -------------------------------------------------- | --------------------------------- |
| #1249 verify worker/concurrency cap                | 949eb154                          |
| #1253 B717 billing fix (deployed + probed in prod) | 3e707af8                          |
| #1250 inline-returns capture, web                  | 4d4a7bfe                          |
| #1255 B681 park guard — **apply-gate anchor**      | **3ff8b142** (deployed 23:27:42Z) |
| #1252 order-edit unit line                         | 34668f7d                          |
| #1256 unpackable-split refusal                     | c222f972                          |

**#1257 is the only one left from the set.** Its fourth-caller fix is committed (1700ebdeb + trailer 3bac4448c),
push in flight. The old test asserted on the MOCK'S RETURN VALUE, so it stayed green when the query stopped
selecting the field; the new test asserts the findMany call args and was proven to discriminate by reverting
the select. Both reviewers read fresh at the new sha, nothing carries from 45f306c6.

**#1256's extraction freed the ceiling**: `invoices.service.ts` went to 6401, so the merge-order collision is
gone and Lane F can restore the doc paragraph it trimmed to fit, after merging master (c222f972).

### Not yet on origin

- **Mobile unit picker** — nothing pushed. `feat/u-unit-picker-5a` is OLD WEB work, not this. Chasing.
- **`feat/extract-returns-logic-package`** — committed (fb92eaa7 pure move + 873842c5 seam doc/test union,
  36 tests counted), waiting on a build slot. The seam note lives in `packages/returns/src/index.ts` so the
  moved file stays permanently zero-diff against web's original.
- **`test/B467-inline-returns-db-specs`** — on origin with NO PR. Needs one or needs deleting.

### Newly filed

B730 mobile unit-picker gap · B731 inline-returns has no client · B732 janitor merged-detection (both
directions + the target-gated no-op) · B733 size-ratchet headroom exhausted · B734 move key minting out of
`packages/returns`.

## 00:00Z — state

**Master `c222f972`.** Merged tonight: #1249 worker cap, #1253 B717 billing fix (deployed + probed),
#1250 inline-returns capture, #1255 B681 park guard (**apply anchor 3ff8b142**, deployed), #1252 unit line,
#1256 unpackable-split refusal.

**In flight**

| item                                           | where           | state                                                                                                                                                                            |
| ---------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1257 reconcile pack                           | PC, Lane F      | head 3bac4448c; merging master + restoring the trimmed doc paragraph before reviewers start. Both read fresh, nothing carries from 45f306c6. **Lifts the pilot hold on DEPLOY.** |
| #1261 multiline notes                          | PC              | PASS posted at 16c56405a; captures running.                                                                                                                                      |
| #1262 returns extraction                       | mini            | open @ 9dc3cb66, 12 files. Move proof re-verified 3× incl. **post-commit-prettier**. U-units reviewing.                                                                          |
| mobile unit picker                             | mini            | 5 commits, captures done, pushing. Reviewer = U-units after #1262.                                                                                                               |
| mobile inline-returns mirror                   | mini            | logic layer done; drops its duplicate once #1262 lands.                                                                                                                          |
| #1246 routine revision                         | PC, Lane F      | after #1257. `--guard-sha 3ff8b142`.                                                                                                                                             |
| docs stack #1247→#1251→#1254→#1258→#1259→#1260 | PC, coordinator | landing bottom-up; verify each retarget, gate each, yield to #1257.                                                                                                              |

**B735 bounded by sweep:** ONE live surface (capture screen shows unconditional success on a silent park),
ONE latent (the driver-cap `approve` endpoint — no client calls it today; whoever builds that screen must
apply the same fix), THREE structurally impossible (standard return receive web+mobile pass LINE_UNIT and
the park branch is gated on PIECES; credit-note and invoice-void reversals have no classification call).

**Captures earned their cost concretely:** the picker lane's pixel read caught an order-total footer showing
$24.00 beside a line at $220.00, with 2038 tests green — the suite covered the extracted helper while the
footer re-derived price independently. Display-only, fixed.

**Lead log: 59 entries.**
