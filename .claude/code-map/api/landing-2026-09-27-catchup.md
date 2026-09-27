# Landing batch 2026-09-26/27 — catch-up of unmapped single-PR landings

Docs-only bookkeeping (Option B). A coverage pass (every first-parent master commit since the map's last
full mapping, `9c5e4b45`, checked for a code-map mention) found these 22 code PRs landed with no
entry; #2501, #2502 and #2485 landed after the afternoon batch. Each bullet below was grepped in the
merged tree unless marked "(per PR body)". Grouped by area.


## api — orders, invoices, returns

- **#2426 edit-return preflight priced against the post-revert set, `11346aeb`:** new
  `invoices/order-edit-revert-set.ts` `selectEditRevertedInvoices(db, orderId)` is the ONE
  selection `revertLinkedInvoicesForOrderEdit` makes (order's own non-batch SENT/VIEWED/OVERDUE
  invoices, minus an exempt deposit-mirror invoice); `returns/inline-returns.service.ts` now
  imports it and prices the inline-return preflight against the matching set as it will be AFTER
  the revert, not before. Spec `returns/inline-return-preflight-revert-set.spec.ts` +
  `inline-return-preflight-revert.db.spec.ts` (real Postgres, discriminates $20 pre-revert vs $8
  post-revert pricing on the same return). Closes #2178.
- **#2281 import payments and the Invoice row in one tx, `7d45e9e3`:** `import.service.ts`
  `importPayments`/`importInvoices` now run the payment write + status update in ONE
  `tenantTransaction` (lock Invoice, replace `zoho-import` placeholder, create payment, re-read,
  UPDATE Invoice). New `import-payment-status.ts` `importPaymentStatus(...)` /
  `importPaymentRefusal(status)` is the one status rule shared by the per-row tx and the
  end-of-run sweep. Specs `import-payments-tx.spec.ts`, `import-payment-status.spec.ts`,
  `import-payments-tx.db.spec.ts`. Lands after #2258; the two `ImportService` EXEMPT rows in
  `invoice-payment-writers.coverage.spec.ts` (baseline 2) are meant to drop to 0 once merged.
  Closes #2262.
- **#2414 (B871) a SKIPPED stop refuses a replayed completion, `bdc2e019`:** new
  `routes/delivery-lines.util.ts` `assertStopNotSkipped(status)` throws 409 `STOP_SKIPPED`; both
  `completeStop`/`completeWithPayment` call it right after the existing `COMPLETED` 400 guard, and
  the atomic claim's `COMPLETABLE_STOP_STATUSES = ["PENDING", "IN_PROGRESS"]` (was `{not:
  COMPLETED}`) throws the same error when the claim loses to a SKIPPED row. A 409 dead-letters on
  the driver device instead of silently applying. Specs `routes.skipped-stop-completion.spec.ts`,
  `skipped-stop-completion.db.spec.ts`. Fixes **B871**. Closes #2409.
- **#2278 net a unit line's order edit in pieces at its held factor, `dbe52033`:**
  `selling-restrictions/order-edit-lines.ts` `existingLineEdit` now nets an id-matched units_v1
  line's incoming COUNT × the held row's snapshot `unitsPerBox` against its stored pieces (was
  count vs pieces directly, e.g. 3→4 Cases read as −32 instead of +12 and slipped the selling-ban
  choke point). `products/line-units.ts` and `EditItem`/`ExistingLine` gain `unitLabel`. Specs
  `order-edit-lines.spec.ts` (+6, 5 red on master), `order-edit-lines.purity.spec.ts`,
  `unit-line-restriction-netting.db.spec.ts`. SA-408 on #938, tier 1. Closes #2275.
- **#2107 (B680) duplicate() writes the copy's regulated ledger rows, `02c05863`:**
  `invoices.service.ts` `duplicate()` calls the new private `writeCreatedInvoiceLedger(tx,
  created)` (extracted from `create()`'s inline ledger block, one path for both) inside the copy's
  own transaction when a copied line is regulated — previously the copy had no
  `RegulatedSalesLedger` SALE rows at all. Line-copy mapping also moved to a new
  `invoice-duplicate-lines.ts` `copyInvoiceLine` (copier C2). Specs
  `invoices.duplicate.spec.ts` (3 cases), `invoice-duplicate-ledger.db.spec.ts`. Fixes **B680**
  (`invoices.service.ts duplicate() ... writes no regulated ledger SALE rows`) (B680 already-fixed in this batch).
  Closes #1466.

## api — billing, credit notes, gateways

- **#2411 tenant admins can Remove credit on an invoice, `c90c213f`:**
  `credit-notes.controller.ts`'s `:id/void` and `:id/unapply` now say `@Roles(UserRole.OPERATOR,
  UserRole.TENANT_ADMIN)` (behaviour unchanged, since `RolesGuard`'s `ROLE_SATISFIES` already let
  TENANT_ADMIN satisfy OPERATOR). Web `invoices/[id]/RemoveCreditButton.tsx` replaces the
  OPERATOR-only `isOperator` check with the dashboard's staff convention (`role !== CUSTOMER &&
  role !== DRIVER`); it hides on a voided invoice. Specs `credit-notes.staff-roles.spec.ts`,
  updated `credit-notes.plan-gate.spec.ts`, `RemoveCreditButton.test.tsx`. Part of epic #2400
  (SA-436 PR-3). Closes #2403.
- **#2260 driver stop screen calls every hook before its early returns, `c0269c5d`:** mobile-web
  `(driver)/route/stop/[stopId]/index.tsx`'s `useMemo(() => itemsFromStop(stop))` moved above the
  loading/stop-not-found early returns (was after them, causing React #310 "Rendered more hooks
  than during the previous render"). `eslint.config.mjs` raises `react-hooks/rules-of-hooks` from
  warning to error for mobile. Pin `__tests__/driver-stop-hooks-order.test.ts` (AST check, red
  before the fix). Part 2 (the `developer_mode` gate) is explicitly unchanged per owner ruling
  "Keep the gate" (2026-09-26). Closes #2257 (part 1 only).

## packages, web and mobile — units_v1 / edit-items

- **#2380 keep a price-only edit on a units_v1 order line, `a759fc4d`:** web
  `OrderLineUnitPicker.tsx`'s tier-refresh effect now remembers the last ladder price it saw and
  refreshes only when the ladder price itself moves (first sight of the held unit, or a
  tier/unit change) — previously it refreshed on every `line.unitPrice` change, silently
  reverting a hand-typed price on Save (no PATCH sent). Pin `OrderLineUnitPicker.test.tsx` ("keeps
  a price-only edit on a unit line", red on master: 0 calls expected, 2 received) plus a guard that
  a hand-priced STANDARD line still re-prices on a real tier change. Closes #2305.
- **#2316 buyer edit-items shows a unit line's count, read-only, `2d87c560`:** new mobile
  `lib/buyer-edit-items.ts`: `hydrateBuyerDraft` derives a unit line's COUNT via `unitLineCount`
  (imported from `./edit-items-draft`, which itself re-exports `@routeflow/pricing`'s
  `unitLineCount` since #2430 — since changed by #2430); `isBuyerUnitLine` mirrors the server's
  `isUnitAwareLine`; `buyerSavePlan` refuses locally with no request when a live unit line is
  present. `(customer)/orders/[id]/edit-items.tsx` becomes read-only on such an order (notice, no
  steppers/Add/Save). Specs `buyer-edit-items.test.ts`, `edit-items-unit-line-count.test.ts`,
  `buyer-edit-items-unit-noun-wiring.test.ts`. Closes #2270.
- **#2269 derive a stored unit line's count by SA-388's rule, `1b5d5fbf`:** mobile
  `lib/edit-items-draft.ts` (operator edit-items) originally defined its own `unitLineCount`
  rule (boxes when a positive integer, else `qty ÷ unitsPerBox` when a whole multiple, else
  LOCKED/`needsRepair`) and used it in `hydrateFromOrder`/`orderOriginals`/`promoBaseUnits` — a
  stored `boxes: 0` line previously hydrated qty 0 and silently dropped edits. A LOCKED line now
  blocks the whole Save with a named "needs repair" refusal if touched. **Since changed by #2430**:
  the file's own `unitLineCount` is now a re-export of `@routeflow/pricing`'s shared
  implementation, kept for `buyer-edit-items.ts` and specs to import from the same place. Spec
  `edit-items-unit-line-count.test.ts` (19 tests, 16 red on master). Closes #2231.
- **#2252 buyer edit-items price suffix names the line's own unit, `55eb52a8`:** mobile
  `(customer)/orders/[id]/edit-items.tsx`'s `DraftItem` gains `unitLabel` (hydrated from
  `li.unitLabel`); the price suffix now reads `invoiceLineUnitNoun(item)` when `unitLabel` is set,
  else falls back to `item.unit` — was always the live `product.unit`, showing "/ box" or "/ ea"
  on a units_v1 Case line. Save payload unchanged (`{productId, qty}`). Pin
  `buyer-edit-items-unit-noun-wiring.test.ts` (3/3 red on master). SA-168a follow-up. Closes #2222.

## packages, web and mobile — other

- **#2384 one Ledger token source for web and native, `49c2fa4c`:** new
  `packages/ui/src/tokens/ledger.ts` (exported `@routeflow/ui/ledger`) holds the Ledger design
  values as plain data — scales, ink, surfaces, status pairs, per-surface accents, radius,
  shadows, fonts, `ledgerCssVars(surface)` — for both platforms; `packages/config/tailwind.config.ts`
  builds its theme from it (no hand-typed hex left). Parity specs
  `apps/web/lib/ledger-css-parity.test.ts` (bidirectional `:root`/`.surface-buyer` vs
  `ledgerCssVars()`) and `tailwind-preset-ledger.test.ts` pin the values; compiled web CSS proven
  byte-identical (149,636 bytes) before/after. T0.1 of the native-parity rebuild (epic #2328).
  Closes #2329.
- **#2399 (B879) self-host every web font, `e2a2b475`:** `apps/web/app/fonts.ts` moved all four
  Google families (Spline Sans, Spline Sans Mono, Inter, Instrument Serif) from
  `next/font/google` to `next/font/local`, same variables/weights, backed by new woff2 files under
  `apps/web/fonts/` (Latin subset only, byte-identical to what Google served; +173,528 bytes; total
  fonts+brand+marketing 712 KB). No `next/font/google` import remains in `apps/web`. Pin
  `fonts-self-hosted.static.test.ts`; production Docker build proven green with Google's font
  hosts unreachable (`--add-host fonts.googleapis.com:0.0.0.0` etc.), master red under the same
  gate. Fixes **B879**. Closes #2397.
- **#2378 native-parity proof harness and test-seed buyer fixtures, `5acdf7f1`:** new
  `apps/api/prisma/seed-parity-buyer.ts` seeds `PARITY_BUYER` (loaded, linked to an existing
  customer with orders) and `PARITY_BUYER_EMPTY` (empty customer) into the `test` tenant only,
  `assertTestTenant`-guarded; `scripts/native-parity/fixtures.cjs`/`screens.json` are the shared
  fixture/manifest; `apps/web/playwright.native-parity.config.ts` + `e2e/native-parity/` (not a
  `playwright.config.ts` project, so CI/post-deploy never runs it against prod);
  `scripts/native-parity/capture-native.mjs` drives iPhone/iPad simulators via `simctl`, never
  logging in or tapping. Output is gitignored `local-assets/proofs/.../native-parity/`. T0's plan
  §2.2 items 1-3, epic #2328. Refs #2338 (no issue closed by this PR itself).
- **#2393 dev-only parity sign-in for the proof harness, `b61d2a8d`:** new mobile
  `lib/dev-parity-login.ts` `maybeDevParityLogin`/`parseParityLogin`/`isSimulatorApiUrl`, wired
  into `app/_layout.tsx`; runs only inside `if (__DEV__)`, needs `EXPO_PUBLIC_PARITY_LOGIN` (set
  only by `scripts/native-parity/parity-env.mjs` from the `test` seed fixtures — no credential in
  app code), and refuses any API base that isn't exactly `localhost`/`127.0.0.1`/`::1`/`10.0.2.2`.
  `Dockerfile` greps the production mobile-web export for the marker and fails the build if
  present. Pin `__tests__/dev-parity-login.test.ts` (33/33; 18 red before an Opus-fold security
  pass, SA-431/431a). Security tier 1. Refs #2338 (no issue number closed).
- **#2318 mobile store build config + iOS bundle fix, `590cde10`:** `babel.config.js` adds this
  workspace's own `node_modules` (via `__dirname`) to Node's resolution paths before
  `babel-preset-expo` loads, replacing four hard-coded Linux `NODE_PATH` entries in `eas.json` that
  pointed nowhere on the macOS iOS EAS workers (root cause of the "Bundle JavaScript" build
  failure: `babel-preset-expo`'s `require.resolve` probe for `expo-router` missed the nested
  workspace `node_modules`). `eas.json` gains Android `serviceAccountKeyPath`/`track: internal`;
  `app.config.js` refuses an Android production EAS build with no
  `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY`. Pin `__tests__/babel-node-path.test.ts` (real Node child
  process resolving expo-router), `__tests__/app-config-store-build.test.ts`. Closes #2312.

## api — routes, mobile driver

- **#2060 second-visit Case stepper bound = count − deliveredSoFar, `bea54630`:** mobile
  `lib/short-pick.ts` `shortPickLinesFromOrder`/`fallbackShortPickLines` take a per-line
  `deliveredSoFar` (server's per-stop projection, B785/SA-116 half) and derive the visit's
  REMAINING qty/boxes/subtotal from it; `short-pick.tsx`/`payment.tsx` wire
  `deliveredSoFarByLine(stop?.orders)` through so the Case stepper bound and "N of M" label read
  the per-visit view, not the full order. Was: a driver's second visit could over-collect/double-
  count against the full ordered qty. Pin `short-pick-second-visit.test.ts` (12/13 red against
  master's un-parameterized `shortPickLinesFromOrder`). Stacked on #1353's server half. Closes
  #2028.
- **#2251 open the invoice and ask to send it after delivery, `4e83f6d5`:** new
  `packages/types/post-delivery-invoice-prompt.ts` — one pure decision (skip / issue-and-send /
  send / offline-later; offline checked first). Web `handleDeliver`, mobile operator
  `openSendForOrder` (gated on `isOnline`) and mobile **driver** `payment.tsx` (previously had no
  prompt at all — the original gap) all route through it and open `SendInvoiceSheet`/
  `SendInvoiceModal`. Known gap: the driver payload carries no customer email, so Email is hidden
  on that surface only. Specs: 11 decision cases
  (`common/post-delivery-invoice-prompt.spec.ts`), 2 RTL (web), 10 mobile wiring pins. Closes
  #2089.

## tooling, tests-only, scripts

- **#2315 move send credit-note specs out of the oversized spec, `5bce7a82`:** test-only.
  Moved the `send() — credit-note interactions (WP2)` describe (104 lines) verbatim from
  `invoices.service.spec.ts` (9385 lines, over its 9351+25 ratchet row) into new
  `invoices.send-credit-notes.spec.ts`; no source or assertion changes; unblocked master, which
  was red on the size ratchet at `896fdd96`. 353 passed before and after (351 + 2).
- **#2258 retry Serializable send/void txs on conflict, `896fdd96`:** api `invoices.service.ts`
  wraps `send()`/`sendEmail()`/`voidInvoice()` and the order-cancel void tx in the shared
  `retryOnTxConflict` (SA-269); new shared `markSent(id, orderId, emailSent)` re-locks/re-reads
  under `lockInvoiceRow` with `sendRefusal`/`nextSentStatus` (`invoice-send-guard.ts`); order
  cancel gets `lockOrderForCancel` (`order-cancel-impact.ts`, Order→Invoice lock order, SA-214).
  `recordStandalonePayment` now writes an unconditional `tx.invoice.update` for every payment
  status, not just PAID, an invariant `invoice-payment-writers.coverage.spec.ts` enforces by AST
  walk (2 Zoho-import writers EXEMPT, count-pinned, fixed later by #2281). Pin
  `invoices.tx-retry.spec.ts` (red first). SA-404/404a/404b/404d. Closes #2255.
- **#2217 roadmap from-git.mjs trailer report and bounded --apply, `3d678032`:** new
  `scripts/roadmap/from-git.mjs` exports `parseTrailers`, `gitRootOf`, `defaultSince`,
  `readCommits`, `buildReport`, `applyPrs({dir, proposals})` — a read-only report of merged
  commits' `Feature:`/`Bug:`/`Defers:` trailers against the roadmap registers, plus one bounded
  `--apply` that only merges proposed PR numbers into `features.jsonl`'s `"prs":[…]` in the
  working tree (refuses on a dirty reg dir; never stages/commits/pushes/touches the network).
  Self-test `from-git.self-test.mjs` (T11–T17, T36) proves zero writes without `--apply` via a
  full working-tree/index/HEAD snapshot diff, plus a mutation probe. F-22 WP2. Tier 2. Closes
  #2214.
- **#2237 local-super-admin spec expects the win32 mode skip, `b3e7cf51`:** test-only, 1 file.
  `local-super-admin.spec.ts` now expects `scripts/local-super-admin.mjs --self-test`'s
  win32-specific "skip mode assertions" line instead of demanding the POSIX-only `mode 0600`
  string (Node reports 666 on win32 regardless of chmod) — every Windows pre-push of master was
  failing this spec. Non-win32 platforms (incl. Linux CI) still assert the real `mode 0600`.
  Closes #2221.

## Landed after `96c17054` (evening, through `e2fead9f`)

- **#2501 payment receipt images move out of invoices.service, `4e1ad1b4`:** behaviour-neutral size-ratchet extraction (SA-065): `uploadPaymentImage`, `getPaymentImageUrl`, `deletePaymentImage` (+ the private `findPaymentOrThrow`) move verbatim into `invoices/payment-image.ts`, which takes an explicit `PaymentImageDeps` (`prisma`, `storage`); the service keeps one-line delegates and its `size-ratchet.spec.ts` row is lowered. Closes #2498.
- **#2502 master's api specs pass on win32, `4e53280c`:** test-only. ESM imports of a bare `C:\` path go through `pathToFileURL(x).href` (the report-script specs, `db-lane-serial`, `local-db-specs`, `script-spec-lane`), pinned by the new `common/no-bare-path-esm-import.spec.ts`; the tsconfig-scope specs normalise path separators; symlink cases skip on EPERM/EACCES; spawn budgets raised. Every Windows pre-push was red on master while Linux CI stayed green.
- **#2485 an invoice due date keeps the literal calendar day, `e2fead9f`:** `common/calendar-date.ts` `calendarFieldStamp(raw, field)` stores a `YYYY-MM-DD` prefix as UTC midnight and 400s naming the field when it names no real day (`issueDateStamp` delegates to it); `invoices/invoice-due-dates.ts` `dueStamp`/`dueDateStamps` (moved out for the size ratchet) stamp `dueDate`/`depositDueDate` in `create()`/`update()`/`updateTerms()`/`createInvoiceFromOrder*`/`createPartialFromOrder`, validated before any read or write. Spec `invoices.service.b2256-due-date.spec.ts`. Second instance of L-232. Closes #2256.
