# Code map changelog

Session-by-session history of code-map updates — **one dated bullet per session note,
newest first**. This file replaces the old habit of prepending each session's note into
`_meta.json` `"notes"` (which had grown to ~90K chars and made the file unreadable).

**Convention for new sessions:** add your note as a new bullet at the **top** of the list
below, and set `_meta.json` `"notes"` to that same note plus the pointer to this file —
never accumulate history in `"notes"`.

- **2026-09-26 — window H landed (docs-only bookkeeping; #2149/#2129/#2186 bookkept separately in #2224, window G).** `api/feature-modules-7.md` gains a "Landing batch 2026-09-26, window H" section: #2205 remaining local-db guards, #2139 inline return inside an order edit/merge (supersedes #2138), #2046 order-detail unit-label qty text (B653/B757-9). Lesson L-225 minted (a proven-on-one-screen fix must become a shared helper, or sibling screens reproduce the same bug). No source changed.
- **2026-09-26 — window G landed (docs-only bookkeeping).** `api/feature-modules-7.md` gains a "Landing batch 2026-09-26, window G" section: #2149 merge/consolidate banned-line warnings, #2129 recurring-invoice banned-line suspend + reactivation schedule (`recurring-schedule.ts`), #2186 add-on ledger writer (`addon-ledger.ts`, B863–B866), #2044 STANDARD return cap in pieces, #2061 partial Case billing (`unit-line-bill-guard.ts`). `api/returns-inline.md` + `api/feature-modules-3/returns.md`: `standardReturnPieces` is no longer an identity stub; `soldPiecesForProduct` → `soldQtyForProduct`. Lesson L-223 minted. No source changed.
- **2026-09-27 — merge train D landed (#2422 `fd810a7a` 7 PRs) + #2376 (`826b5ac2`), folded into the same follow-up PR.** New `api/landing-2026-09-27-train-d.md` (TOC row in `api.md`): #2387 NSF fee line survives order rebuild, #2398 driver changeStatus/resolve assignment check (discharges B874 as already-fixed), #2220 web unit-line count/lock, #2389 mobile offline fail-fast, #1358 B562 stock-ledger AST coverage gate, #2394 CHANGELOG cap regex fix (validate-code-map.mjs), #2396 scripts/work self-tests wired into verify, #2376 buyer edit never revives a seller-cancelled line. L-233 gained a recurrence note (train D's #2398 is the same role-check-not-ownership-check class at two more call sites). No new lesson ids minted this batch (several strong candidates recognized but not minted -- see lessons _meta.json note).
- **2026-09-27 — merge trains B and C landed (#2395 `097762e0` 16 PRs, #2383 `7e23c614` 14 PRs; docs-only bookkeeping, folded into the train-A follow-up PR per the lead).** New `api/landing-2026-09-27-train-b.md` and `api/landing-2026-09-27-train-c.md` (TOC rows in `api.md`), one bullet per PR (train C's own #2224 already covers its scope, not repeated). Lessons L-232..L-234 minted (calendar-day storage, role-vs-ownership authorization, whole-DB script scope-not-rerun); L-214/L-217/L-196 archived. No source changed.
- **2026-09-27 — merge train A landed (#2327, `5588ca1d`, 14 PRs; docs-only bookkeeping).** New `api/landing-2026-09-27-train-a.md` (TOC row in `api.md`) with one bullet per PR: #2296 payment rounding, #2323 resync-plan extraction, #2179 sales-facts + product insights, #2250 NSF `systemKind`, #2274 unit-line split guard, #2298 numbering first-mint seed, #2239 add-on row lookup, #2227 manual-row proration, #2234 commission savepoint, #2247 creditLimit bound, #2303 re-delivery cap wording, #2291 scale report, #2294 route realtime, #2117 invoice update/duplicate sell guard. Lessons L-226..L-228 minted, L-198 folded, L-204/L-207/L-210 archived. No source changed.
- **2026-09-26 — windows D/E landed (docs-only bookkeeping).** `api/feature-modules-7.md` gains a "Landing batch 2026-09-26" section: #2152 lock order + tx-retry, #2172 price-adjustment ledger, #2161 next-delivery pack snapshot, #2150 uncategorised-lines report, #2130 at-door ceiling, #2142 buyer tracking + rooms, #2162 local super-admin. Lessons L-219..L-222 minted. No source changed.
- **2026-09-25 — B861 numbering continuity landed (#2170, dd33057a; docs-only bookkeeping).** `api/feature-modules-6.md` B861 bullet refreshed to the merged shapes: year-0 `0*` scan, CAS on plain columns with `expectedNextNumber` required, `mintConfigured` `FOR UPDATE` on the year-0 row, DTO `next ≤ 999,999,999`, web `Extract<>` type, `seedFromSource` deleted. Lessons L-217/L-218 minted. No source changed.
- **2026-09-24 — Wholesaler onboarding playbook pointer (docs-only).** `INDEX.md` "Where to find" gains a row → `docs/runbooks/wholesaler-onboarding.md` (8 gated stages, demo → live); the parked in-app build spec is `docs/superpowers/plans/2026-09-24-wholesaler-onboarding-build.md`. No code changed; no area file touched.
- **2026-09-22 — B698 PO detail subtotal reads the stored total (web half) — surgical, in-session.** `web/catchup-2026-09-21.md`: `purchase-orders-shared.ts` gains `resolveStoredPOLineAmounts(item, unitsPerBox)` (stored `POItem` → `POLineResolved`; the stored exact `totalCost` wins, else `derivedCaseCost` + `buildPOLine`); `PurchaseOrdersTab.tsx`'s `PODetailRow` subtotal routes through it instead of `qtyOrdered x unitCost` (1,000 cases of 12 at $11.00 showed $11,000.40 for the $11,000.00 the server stored). Pricing math and the API untouched. **Mobile half, same branch (owner directed both land together):** `mobile/catchup-2026-09-21.md` gains `lib/po-line-subtotal.ts` (`poLineSubtotal`); `[id].tsx`'s `ItemRow` and header route through it, `lib/api/purchase-orders.ts`'s `POItem` gains `totalCost`/`packSize`, and the sibling `poDisplayTotal` (`lib/po-list-logic.ts`, the LIST row total) had the identical drift in its line fallback — folded into the same helper rather than a second derivation (cf. L-167), so list row, detail header and detail rows share ONE derivation.
- **2026-09-22 — B661 credit-note axis fix + B665 standard-return restock (MacBook lane) — surgical, in-session.** `api/feature-modules-5.md`: the W5c credit-note ledger-reversal entry gains the B661 axis fix — `reverseCreditNoteEntries` booked `unitBasisQty` on the LINE unit against SALE rows that are piece-denominated since B661, stranding 55 phantom pieces per credited 5-box pack-12 line on the regulated filing; the booked value now follows the SALE rows' own pieces-per-line-unit ratio, a closing credit books the exact remaining, and `reverseInvoiceEntries`'s skip guard tests `unitBasisQty` so a later void CLEARS a pre-fix residue rather than reading the line as already reversed. KNOWN LIMIT recorded there: a line whose SALE rows straddle the B661 deploy yields a blended ratio (that's B681). **Not yet mapped, pending merge:** B665's standard-return restock (#1217 `common/line-pack-factors.ts`, `returns/returns-restock-pieces.ts`, `returns-restock.util.ts`, `returns.service.ts`, `returns-pieces.util.ts`) and its operator resolution (#1218 `returns/parked-restock-resolution.service.ts`, `dto/resolve-parked-restock.dto.ts`, controller + module wiring) — both carry the docs-only follow-up under Bookkeeping Option B. **Dropped from Release 1:** B660 (#1187) and its parked-reversal resolution (#1190), superseded by B661/B671's mechanism; both left OPEN with hold notices rather than closed.
- **2026-09-21 — catch-up c19cb81→b8765689 (149 commits, #941-#1133; incl. 2287577d #1123, 7209edae #1126, 9f2c6c57 #1027, f9e5a6f9 #1090, 8ebc6113 #1128, b8765689 #1133).** ~260 code files mapped in new `api/catchup-2026-09-21-{src,scripts-schema}.md`, `web/catchup-2026-09-21.md`, `mobile/catchup-2026-09-21.md`, `packages.md` (new `scanning`); TOC rows + INDEX rows added; L-212/L-213 in lessons.
- **2026-09-21 — units_v1 spine + T6 prerequisite + money-guard repair (#1123 B606, #1126 B612, #1025/#1027 A3, #1090 4b-2b, #1128 T6-prereq, #1133 B620) — surgical, in-session.** `api/feature-modules-2.md`: `getCustomerPriceHistory` now filters `unitLabel: null` (B606 — a per-Case price was reaching BUYERS as the pack price via `effectiveBuyerPrice`, a 5x overcharge across catalog tile/detail/variant/favourites and every new standing-order line; one filter, all consumers); plus the units_v1 `create()` path (`orders/unit-line-build.ts`, `create-order.dto.ts`) and **B619**, a live defect where the staff create auto-merge folds by `productId` alone and drops `unitLabel`, writing a Case line as pack lines. `web/components-shared.md`: `LineItemRow.tsx` gains `data-testid="line-total"` (B620 — #946 changed the class from `w-16` to `sm:w-16` on 2026-09-19 and spec 13 selected `span.w-16`, so the boxed-proration money guard matched nothing and could not pass for two days). **Open, not yet mapped:** B621/B625 (the post-deploy E2E lane reports `success` on a skipped-all job and separately exceeds its 45-min timeout in 3/3 runs — a suite that passed 116 tests in 4.1 min on 2026-09-01), B623 (`inventory.service.ts:1103` nested `PurchaseOrderItem` create omits `tenantId`), B624 (compose derives its project name from the directory, so `local:up` in a worktree silently attaches empty volumes). Bookkeeping Option B: the merged shas above all carry `Bookkeeping-Follow-Up: pending`; the consolidated docs-only PR is still owed.

- **2026-09-19 — refresh 56c01d2b→a3c37bdb, 17 added / 13 updated / 0 removed.** B562 inventory fix+UI hiding, #933 `LineItemRow`, B536/B543 `getStats()`, B559/B535/B534/B533 mobile sweep, B343 credit-note event, B525 addon-toggle removal, B519 web warning, B549/A7 marketing CSS, #871 copy rewrite, A6 cache-control, B523 campaign-check, #940 filings. Plus **#936 schema spine** (mapped post-merge): `ProductUnit`/`SupplierProduct`, `ProductCategoryLabel`+`SellingRestriction`(+enums), `CustomerAddress.stateCode`, `VendorBill.purchaseOrderId`, 3 migrations, `resolveUnitPrice` — schema/types only, no API yet. `janitor.mjs` (Prettier-only) skipped.

- **2026-09-18 — Window-3 bookkeeping catch-up (B513/#881, B514/#883, B521/#891 C2 390px stragglers + B318/B406/#876 credit-note guards + B519 correction) — docs-only (Bookkeeping Option B)** — `web/routes-1.md`: `vendor-bills/[id]/page.tsx` (B513) + `orders/[id]/page.tsx` (B521), the two C2 390px items window-2 missed. `web/app-shell-lib.md`: `CropModal.tsx` Pointer Events (B514); corrected the `AVAILABLE_ADDONS` bullet — removing the legacy toggles did NOT close B519, `EnableAddonModal.tsx` has the identical unguarded gap. `api/feature-modules-2.md`: B318 (`create()` staff-gates `appliedCreditNotes`). `credit-notes.md`: B406 appended to its B315 bullet. B518/B522/planner-bottom-sheet already documented, verified not duplicated. Registry: closed B318/B320/B406/B521/B522 + 7 retroactive filings for never-centrally-allocated commit-referenced ids (B510-514/B508/B518 → B526-B532; id-collision story in lessons `_meta.json`). B443/B523 verified unlanded, left untouched. Lessons: L-199 (cross-workspace pinned-literal) + L-200 (UI-control removal ≠ dead-code removal). `mappedSha` → `56c01d2b`.
- **2026-09-18 — Window-2 mobile fixes (#874 B510, #877 B511, #878 B512, #881 B513, #883 B514) + B320 hard-delete guard (#885) + B508/B519 legacy addon-toggle removal (#866+#890) + B521 order line-item starvation (#891) + docs-truth dynamic assertion (#889) — docs-only bookkeeping (Bookkeeping Option B)** — `web/routes-1.md`/`routes-2.md`: `customers/[id]/page.tsx` (statement table + stat-strip responsive breakpoints, `touch-reveal` on 3 action buttons, scrollable tab strip), `orders/_components/SplitInvoiceModal.tsx` + `returns/[id]/page.tsx` (`overflow-x-auto` + `min-w` tables), `invoices/[id]/page.tsx` (`touch-reveal` on payment actions), `vendor-bills/[id]/page.tsx` (edit-mode line-item row wraps below `sm`), `products/[id]/CropModal.tsx` (full mouse→Pointer Events conversion, `touch-none`, capped `maxWidth`), `orders/[id]/page.tsx` (line-item row `flex-wrap` + `min-w` name column). `api/feature-modules-1.md`: `customers.service.ts deleteCustomer` now also blocks on a live `advancePayment` balance or an open (non-VOID, unconsumed) `creditNote`. `web/app-shell-lib.md`: `admin/tenants/[id]/page.tsx AVAILABLE_ADDONS` emptied — all eight legacy toggle cards removed, superseded by the Feature Console's per-feature grants. `api/bootstrap-cross-cutting/repo-truth-specs.md`: `docs-truth.spec.ts`'s lessons-cap assertion now reads `_meta.json.maxBytes` dynamically instead of a second hardcoded literal. `web/unit-tests.md`: `marketing-port.static.test.ts`'s MKT-PIN T7 `globals.css` hash re-pinned after #877's `touch-reveal` addition (a containment check, not a freeze — see the file's own comment). `mappedSha` → `359e31c3`.
- **2026-09-17 — Deliveries/new mobile bottom sheet (owner UX request)** — `web/routes-1.md`'s ad-hoc-trips entry gains a bullet: below `lg` (1024px), `deliveries/new/page.tsx` swaps its fixed, no-breakpoint two-column body (previously cut off the map/Compare-routes panel and scrolled sideways at phone widths) for a map-canvas + draggable bottom-sheet layout — new `_components/DeliveryMobileLayout.tsx` (map⇄sheet interplay: tap map to collapse to peek, tap a marker to highlight+recenter+lift-to-half+scroll-list-to-it, tap a list row to highlight+recenter) + `DeliveryBottomSheet.tsx` (hand-rolled non-modal sheet, three detents, pointer-drag/fling snapping on `transform` only) + `useReducedMotion.ts`. Chosen via a JS `isMobile` boolean (not a second CSS-hidden tree) specifically so only one real, billable `TemplateRouteMap`/Google-Maps instance ever mounts — the desktop map render gained a `!isMobile &&` guard that is a no-op at `lg`+. Three shared components gained small, additive/opt-in props with zero behavior change for existing callers: `TemplateRouteMap` (`onMapClick`, `panToSelectedStop`), `TripStopList` (`onSelectGroup`/`selectedCustomerId`/stable per-row id), `RouteVariantsPanel` (`scrollX`). `mappedSha` → `b31372f3`.
- **2026-09-17 — Mailbox connect (#824 Google, #830/#841 Microsoft) + N2 account/invite mail (#811) — docs-only bookkeeping (Bookkeeping Option B)** — `api/feature-modules-7.md`'s `email/` section gains two entries: N2's account/invite mail (`sendSetPasswordEmail`/`sendEmailChangedNotice`/`sendEmailChangeConfirmation`/`sendRoleChangedNotice`, and the bare platform-only `sendPlatform` cascade they ride on) and the new `email/mailbox/` subdirectory — `MailboxConnectionService` (Google `OAuth2Client` PKCE + Microsoft v2 identity-platform OAuth on the `common` authority, two-step confirm binding), `MailboxSendService.trySend` (Gmail API `messages.send` / Graph `sendMail`, never throws), `MailboxController` (unguarded callbacks, `TENANT_ADMIN`-gated everything else), and web `settings/_components/MailboxCard.tsx` (hidden behind the `email.connected_mailbox` add-on). `mappedSha` → `bd1a8457` (tip of the merged Outlook rebuild).
- **2026-09-17 — Feature grants v2 (#825 FG-A, #838 FG-B v2, #837 FG-C v2) — docs-only bookkeeping (Bookkeeping Option B)** — surgical entries across 7 part files for the shadow resolver + override `kind`/MRR-exclusion/review-job + config-modes/routes-dispatch batch: `api/feature-modules-4/billing.md` (main entry — the resolver, override kind, MRR exclusion, config modes), `api/feature-modules-1.md` (platform-admin shadow-resolver admin surface, `tenants/me/features`), `api/feature-modules-3/routes.md` (`route-dispatch-mode.ts`), `packages.md` (`api/features.ts`, `FeatureOverrideKind`/`FeatureSource` enums), `web/app-shell-lib.md` + `mobile/app-shell-lib.md` (`lib/tenant-features.ts`/`lib/feature-modes.ts`, both deliberately unwired into a page/screen yet), `web/e2e-tests.md` (`50-routes-dispatch-mode.spec.ts`). `mappedSha` → `18a1bfd0` (tip of the merged batch).

- **2026-09-17 — refresh the #789 email/ bullet for #802 (B452 follow-ups) — docs-only bookkeeping** — `api/feature-modules-7.md`: three clauses of the #789 bullet had gone stale after #802 — `getTenantFromAddress(smtpUser)` now falls back to the tenant's own SMTP login instead of the platform address, `sanitizeDisplayName()` now collapses CR/LF, and `getReplyTo()`'s admin fallback now filters ACTIVE with a deterministic order. Also: `docs/runbooks/deploy-visibility-flip.md` step 3 now requires proving each service's served commit via its health probe, never the GitHub deployments API's `statuses[0]`. `mappedSha` unchanged.

- **2026-09-16 — map #789 (B452 platform email sender) — docs-only bookkeeping follow-up** — `api/feature-modules-7.md` `email/`: new bullet for the platform Google Workspace SMTP transport (all-or-nothing `SMTP_*` selection over Resend), the `platformFrom` derivation, `getTenantFromAddress()`'s `<Business> via RouteFlow` fallback replacing the unowned `noreply@routeflow.app`, `sanitizeDisplayName()`'s scope, `getReplyTo()`'s fallback chain, and the read-only `apps/api/scripts/check-email-sender.mjs` diagnostic. Also corrected the module bullet's stale "global `EmailService`" — `EmailModule` is a plain `@Module`, so consumers import it (`CustomersModule` has since #778). `mappedSha` unchanged.

- **2026-09-16 — merge origin/master + map #778/#779 (worktree `rf-B420`, branch
  `docs/code-map-refresh-2026-09-16`)** — merged origin/master (bringing in #781's
  customer-lifecycle rescue, #778's auth rescue, and #779's tooling fixes) into this
  branch's earlier commit (the surgical refresh + feature-modules-4 split, entry
  below); two content conflicts (`_meta.json`'s rolling notes field,
  `feature-modules-3/{credit-notes,invoices}.md`'s empty-vs-populated bullets) plus
  one already-identical `api.md` TOC row, all auto-resolved via git rerere from an
  earlier rebase attempt of the same delta, verified marker-free. Added surgical
  entries for #778 (`auth.service.ts`/`buyer-auth.service.ts` status-after-bcrypt
  timing fix, `verifyEmailAndLogin` status refusal, `tenants.service.ts
resendVerification` logging + B448 cross-ref, `platform-admin.controller.ts` B216
  `CreateTenantAdminDto`, `customers.service.ts sendPortalInvite` actually sending
  email + SMS hard-reject, web `signup`/`check-email` `emailSent:false`/
  `resendFailed` danger states, `auth-shell.css`'s `.rf-auth-success--danger`) and
  #779 (`stop.gate5.spec.mjs`'s B411 fix — F4's per-dir `existsSync` check replacing
  an ambient tmpdir-count comparison that false-tripped on a concurrent sibling run
  — and the `bugs-self-test-script.spec.ts` repo-truth jest-lane wiring;
  `next-version.ts`/`bugs-self-test-script.spec.ts` themselves were already
  documented by #779's own map update, not duplicated) — both PRs had landed on
  master without their own code-map updates. Validator green throughout.

- **2026-09-16 — surgical refresh across ~175 stale files + `feature-modules-4.md` area-cap
  split (docs-only, worktree `rf-B420`, branch `docs/code-map-refresh-2026-09-16`)** —
  `_meta.json.mappedSha` (`bc24582d`) was left untouched by #784's split, ~175 files stale by
  `04b73dda` (this session's HEAD). Refreshed via 4 parallel subagents on disjoint target files:
  bootstrap-cross-cutting parts (`prisma-schema-and-seeds.md`, `schema-integrity-and-backfills.md`,
  `bootstrap-and-money-pricing.md`, `calendar-and-advisory-locks.md` — new plan-catalog-v12
  publisher, `bootstrap-house-tenant.mjs`, post-dated-check backfill, `check-transitions.ts`,
  enum-parity/schema-folder pinned counts); `feature-modules-1.md`,
  `feature-modules-3/{credit-notes,invoices,returns,routes}.md`, `feature-modules-5.md`,
  `feature-modules-6.md` (LITE invite-only plan `@RequirePlanFlag` gates WP5a-c across
  credit-notes/customers/messages/recurring-invoices/suppliers, B421 credit/advance
  payment-confirmation split in invoices, PR-1a returns `kind` STANDARD|INLINE, platform-admin
  `tenant-mirror.service.ts`); `web/{api-hooks,app-shell-lib,e2e-tests,routes-3}.md` and
  `mobile/{app-shell-lib,tests-2}.md` (plan-flags/PlanGates/AdminBadge MRR card, B421 field
  fixes, post-dated-check badge). `feature-modules-4.md` had grown to 99,637 B against the
  100,000 B cap — split verbatim (same pattern as #784) into `api/feature-modules-4/`:
  `inventory.md`, `billing.md` (58,842 B, gained the LITE-plan/plan-flag-policy refresh),
  `estimates.md`, `vendor-bills.md`; `feature-modules-4.md` is now a ~1.9 KB TOC, `api.md`'s
  module-index row updated to match. `mappedSha` bumped to `04b73dda` this time (all target
  files were actually touched, unlike the two prior "left as-is" splits above).

- **2026-09-15 — Rescue PR B: five stranded customer-lifecycle fixes (worktree
  `rf-rescue-lifecycle`, branch `feat/rescue-customer-lifecycle`)** — cherry-picked
  `b3ecec42`/`c255f042`/`f137fcae`/`168b172a` from the never-merged `fix/f09-f15-customer-lifecycle`
  branch after `local-assets/handoff/2026-09-16/stranded-fix-verification.md` confirmed all five
  bug ids (B13/B156/B157/B158/B159/B170) were still genuinely missing from master. All four
  cherry-picked cleanly onto `origin/master` (one trivial import-order conflict in
  `customers.service.ts`, resolved by keeping both imports) — B156/B158/B170 share one
  `buildListWhere()` behind `findAll`+`exportCustomers` plus `unassigned`/`removed`
  `ListCustomersDto` filters and a removed-customer edit/reactivate 409 guard; B157 factors
  `LIVE_CUSTOMER_STOP_WHERE`/`SCHEDULED_ROUTE_KIND_WHERE` into new
  `apps/api/src/routes/route-stop-filters.util.ts`, shared by `findOneRoute`/`getPackingList`/
  `getCustomerRouteAssignments`/`addStop`/`createRun`; B159 tombstones the linked `User`'s
  username/email/googleId on soft-delete and reverses it on restore (P2002 retry path); B13 wires
  the previously-uncalled `useApplyAdvanceToInvoice` hook into a new `ApplyAdvanceModal` on
  `invoices/[id]/page.tsx`. RED/GREEN-verified: all 17 new REG- test cases fail against the
  pre-fix service files and pass against the fix. `api/feature-modules-1.md` (customers),
  `api/feature-modules-3.md` (routes), `web/routes-1.md`/`web/routes-2.md` (customers/invoices
  UI), `web/api-hooks.md`, `mobile/tests-1.md` each got a short amendment for the newly-wired
  behaviour; no new area file. B13's Playwright proof (`apps/web/e2e/38-apply-advance.spec.ts`)
  is written but not run — deferred to a host grant per standing UI-proof policy.
- **2026-09-16 — `feature-modules-3.md` area-cap split (docs-only, no code change, worktree
  `rf-codemap-split`)** — it had grown to 99,998 B against the 100,000 B cap (PR #781 hit it
  adding a single line). Split verbatim (byte-diffed identical to the pre-split body, bullet-
  for-bullet reconstruction proof empty-diff) into seven parts under `api/feature-modules-3/`:
  `routes.md` (routes/route-optimization), `trips.md`, `invoices.md`, `credit-notes.md`,
  `returns.md`, `order-templates.md`, `drafts.md` — see that file's own TOC table for what each
  covers. `feature-modules-3.md` is now a 2.9 KB TOC. Repointed the three live INDEX.md
  cross-refs (ad-hoc trips, returns STANDARD flow, recurring routes) at the correct new part,
  `api.md`'s row description, `feature-modules-1.md`'s stale split-threshold note, and
  `returns-inline.md`'s STANDARD-flow pointer. `mappedSha` left as-is (same convention as the
  2026-09-15 `bootstrap-cross-cutting.md` split below).

- **2026-09-15 — Lite-L2 invite-only LITE plan + B445 checkout planKey fix (worktree
  `rf-lite-L2`, WP1-WP14, uncommitted)** — WP14 fixed a pre-existing prod defect:
  `billing.service.ts onCheckoutCompleted`'s upsert never wrote the `planKey` string column
  (create branch read the wrong metadata key), starving `emitPayingDelta`/billing-cron's MRR
  filter forever; fixed via a `resolvedPlanKey`/`resolvedBasePrice` resolve-then-write, present-
  only on the (common) update branch, no new idempotency mechanism (the existing
  `transitionAndEmit` CAS already covers it) — `billing.service.spec.ts` gained 5 cases.
  The Lite-L2 summary (LITE plan constants in `plan-catalog.constants.ts`, new
  `plan-flag-policy.ts`, invite-only gates on subscribe/upgrade/downgrade,
  `getSubscription()`'s `flags`/`paymentRequired`, the v12 catalog publisher, and
  `PlanFlagGuard` on 6 controllers) went into a **new area file, `api/lite-plan.md`**, with
  one pointer row in INDEX.md — `api/feature-modules-4.md` was already at 99,901B/99.9% of its
  100,000B cap with zero headroom, so nothing was added there (precedent: `api/returns-inline.md`
  / Returns PR-1a); the documented `feature-modules-4/<module>.md` split remains a real
  follow-up, unrelated to this lane. `web/api-hooks.md`, `web/app-shell-lib.md`,
  `mobile/app-shell-lib.md`, `packages.md` each gained real (uncompressed) Lite-L2 entries —
  `lib/plan-gated-nav.ts`, `lib/api/plan-flags.ts`, mobile `lib/plan-flags.ts`/
  `PlanLockedScreen.tsx`, and `packages/types/api/billing.ts` (`FLAG_KEYS`/`SubscriptionView`) —
  all within their caps. `pricing-plans.md` §Feature-flag keys gained the 5 new keys.
  **Fix-round follow-up (same day):** findings 1-7 from an Opus refute-first review landed
  (billing-cron re-pin/fail-loud, platform-admin shared catalog guard, frozen v11
  ENTERPRISE_FLAGS, checkout override preservation, checkout kill-switch check, web/mobile
  `flags` fail-open, 6 spec files' TS2352 casts) — `api/lite-plan.md`, `packages.md`,
  `web/app-shell-lib.md`, `web/api-hooks.md`, `mobile/app-shell-lib.md` each got a short
  amendment; no new area file.
- **2026-09-15 — check-payments PR-1 fix round (branch `feat/check-payments-pr1`, 4 findings
  from an independent Opus review)** — **BLOCKER 1** (API wouldn't boot): `invoices.service.ts`
  value-imported `CHECK_TRANSITIONS` from `@routeflow/types` (raw-TS package, no build step) —
  `nest build` emitted a literal `require(...)` into `dist/`, crashing `node dist/main.js` at
  boot; `no-runtime-workspace-imports.spec.ts` correctly caught it. Fixed with a new API-local
  mirror `apps/api/src/common/check-transitions.ts` (same convention as `trip-grouping.ts`/
  `shipping.ts`); `check-transitions-parity.spec.ts` rewritten to pin the mirror value-equal to
  `packages/types/api/checks.ts` by deep-equal instead of an import-path check. **BLOCKER 2**:
  `schema-folder.spec.ts`'s `EXPECTED_ENUM_COUNT` (84) wasn't bumped for the new
  `CheckReturnReason` enum — now 85, matching `enum-parity.spec.ts`'s already-bumped pin.
  **MAJOR 3**: `backfill-check-dates.mjs` gained the CLAUDE.md live-tenant policy guard —
  `--apply` against a live (non-test) tenant now requires `--live-tenant-override` +
  `--confirm-tenant-id=<id>` (same mechanism as `repair-receiving-units.mjs`); unscoped `--apply`
  always requires the override. **MINOR 4**: `enum-parity.spec.ts`'s mobile-stub-parity block
  (X2) now also deep-equals the Jest stub's hand-copied `CHECK_TRANSITIONS` against the canonical
  export (it can't ride the `*_VALUES`-suffix sweep). See `packages.md`/`api/feature-modules-1.md`
  /`mobile/tests-1.md` for per-file detail. `mappedSha` left as-is.

Older entries: [`CHANGELOG-ARCHIVE.md`](CHANGELOG-ARCHIVE.md).
