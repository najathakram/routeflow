# web — API hooks

> Split from `.claude/code-map/web.md` (verbatim, lines 1326-1553) on 2026-09-13. See [`../INDEX.md`](../INDEX.md).

## API hooks (`lib/api/`)

Each module exports TanStack Query hooks + TS types mirroring API DTOs. **2026-09-03 (wave E /
imp-10b):** the 95 identical/near-identical DTOs the dup sweep found now live in
`packages/types/api/*.ts` and every Prisma-enum mirror in `packages/types/api/enums.ts` — these
modules `import type { ... } from "@routeflow/types"` instead of redeclaring; the divergent shapes
(39 names) stay local. See [`packages`](packages.md) → `@routeflow/types` for the domain-file
layout and the enum-parity guard. Key entries:

| Module | Key hooks |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orders.ts` | `useOrders`, `useOrder`, `useCreateOrder`, `useUpdateOrderStatus`, `useToggleUrgent`, `useReopenOrder`, `useBulkDeleteOrders`, `useResolveChangeRequest` (P5-11) |
| `invoices.ts` | `useInvoices`, `useInvoice`, `useCreateInvoice`, `useUpdateInvoice`, `useSendInvoice`, `useVoidInvoice`, `useApplyCreditNote`, `useApplyAdvanceToInvoice`, `useDownloadInvoicePdf`, `useRecordInvoicePayment`, `useRecurringInvoices` |
| `routes.ts` | `useRoutes`, `useRoute`, `useCreateRoute`, `useAddStopToRoute`, `useUpdateRoute`, `useRouteRuns`, `useCreateRouteRun`, `useOptimizeRoute`, `useAnalyzeRoute`, `useUpdateRouteRunStatus` (**F11:** `onSuccess` also invalidates `["orders"]`, `["trips-eligible-orders"]` (trips.ts picker list) + `["trip-eligibility"]` — a CANCELLED/COMPLETED write releases the run's undelivered orders, freeing the pointer both trip-builder queries read) |
| `customers.ts` | `useCustomers`, `useCustomer`, `useCreateCustomer`, `useUpdateCustomer`, `useDeleteCustomer` (hard), `useSoftDeleteCustomer` (force → restorable) + `useRestoreCustomer` (8s-undo pair). **F09/B13 (2026-09-06):** `useApplyAdvancePayment` deleted — zero component callers ever existed (`git log -S` shows it added once, never wired to any JSX); `invoices.ts`'s `useApplyAdvanceToInvoice` is the one advance-apply hook, itself still uncalled from any page (B13 refuted as a bug — a real "Apply advance" web affordance is a FEATURE, deferred to dev-pipeline). |
| `products.ts` | `useProducts`, `useProduct`, `useProductByBarcode`, `useCreateProduct`, `useUpdateProduct`, `useBulkAssignParent` (one POST `/products/bulk-assign-parent` → `BulkAssignParentResult{succeeded,failed}`; consumed by GroupAsVariantsModal) |
| `drivers.ts` | `useDrivers`, `useDriver`, `useCreateDriver`, `useUpdateDriver`, `useChangeDriverStatus`, `useDriverHistory`, `useDriverMetrics`, `UpdateDriverInput` (= `Partial<Driver>` + the four `home*` write fields — the home base READS back as one composed `Driver.homeAddress` but WRITES as line1/city/state/zip; `drivers/_components/EditDriverModal.tsx`'s "Home Base" section is the only web writer, and the only way the `trips.service.ts` DRIVER trip origin becomes usable) |
| `suppliers.ts` | `useSuppliers` (key `["suppliers", params]`), `useSupplier`, `useCreateSupplier`, `useUpdateSupplier`, `useDeactivateSupplier`, `useDeleteSupplier`, `useImportExpenseSuppliers` + **`invalidateSupplierLists(qc)`** — supplier lists live under TWO key families (`["suppliers"]` here, `["inventory","suppliers"]` in `inventory.ts`); every supplier mutation in BOTH files invalidates both via this helper (2026-08-23 fix: "+ New" supplier in the purchase/scan-invoice/vendor-bill modals never appeared in the other family's dropdowns) |
| `returns.ts` | `useReturns`, `useReturn`, `useCreateReturn`, `useApproveReturn`, `useRejectReturn`, `useMarkReturnInTransit`, `useMarkReturnReceived` (**WP10:** `{id, restock?}`, sends body), `useProcessRefund` (**WP10:** `{id, method?: "CREDIT_NOTE"\|"EXTERNAL_REFUND"}`, drops dead `restock`, also invalidates `["credit-notes"]`). `Return` gained `creditNoteId`/`creditNote{id,creditNoteNumber,amount,status}`/`refundAmount`/`refundMethod`/`refundedAt`/`refundEstimate` (server-computed, always present). |
| `estimates.ts` | `useEstimates`, `useEstimate`, `useCreateEstimate` (payload carries `issueDate`, F27/B79), `useUpdateEstimate`, `useSendEstimate`, `useConvertEstimateToInvoice` (renamed from `useConvertEstimate`; **F27/B15-NAV (registry B411):** result typed `{ id: string }` — the created Invoice's id, not `invoiceId`) |
| `credit-notes.ts` | `useCreditNotes`, `useCreditNote`, `useCreateCreditNote`, `useApplyCreditNote`, `useVoidCreditNote`. **F09/B18 (2026-09-06):** `useIssueCreditNote` deleted (the `/issue` route never worked — the enum had no DRAFT). `CreditNoteStatus` now `export type { CreditNoteStatus }` re-exported from `@routeflow/types` (was a hand-typed `"DRAFT" \| "ISSUED" \| "APPLIED" \| "VOID"` union incl. the phantom DRAFT — [[L-072]]). `CreditNote.invoice?: { id; invoiceNumber }` added (F09/B19). |
| `vendor-bills.ts` | `useVendorBills` (+`needsMapping`, meta.needsMappingCount), `useVendorBill`, `useCreateVendorBill`, `useReceiveVendorBill` (`{id, acknowledgeUnlinked?}`), `getUnlinkedItemsError` |
| `finance.ts` | `useFinanceDashboard`, `useArAgingInvoices`, `useSalesByCustomer`, `useSalesByItem`, `useProfitAndLoss`, `useCashFlow`, `useExpenses`, `useCreateExpense`, `useUploadExpenseReceipt` |
| `bookkeeping.ts` | `useBookkeepingSummary`, `useTransactions`, `useTransaction`, `useRecordPayment`, `useDownloadInvoice`; types `Transaction`/`Payment` — `Payment.method` is `AnyPaymentMethod` (display type; the picker writes any of the 6 selectable methods) |
| `inventory.ts` | `useStockOverview`, `useStockMovements`, `useRecordPurchase`, `useRecordAdjustment`, `usePurchaseOrders`, `useForecasting`, `useInventoryValuation`, `useSetCostBasis`, `useBulkSetCostBasis`, `useRecomputeCosts` + a DUPLICATE supplier hook set (`useSuppliers` key `["inventory","suppliers"]` ← the purchase/scan-invoice/vendor-bill dropdowns, `useCreateSupplier`, `useUpdateSupplier` — mutations invalidate both key families via `suppliers.ts#invalidateSupplierLists`) |
| `order-templates.ts` | `useOrderTemplates`, `useOrderTemplate`, `useCreateOrderTemplate`, `useGenerateTemplateOrder` |
| `buyer.ts` | `useBuyerProducts`, `useBuyerOrder`, `useBuyerCreateOrder`, `useBuyerCancelOrder`, `useBuyerInvoice`, `useBuyerDashboard`, `useBuyerFavorites`, `useBuyerAnalytics`, `useBuyerAuthorizations`, `useSubmitBuyerAuthorization` (W6b), `useBuyerCreateChangeRequest` (P5-10), `useBuyerStatement` (P5-13, `BuyerStatement`/`BuyerStatementTransaction` types), `useBuyerPayments` (P5-14, `GET /buyer/payments`, paginated `BuyerPayment[]`), `useBuyerRemittance` (P5-14, `GET /buyer/remittance` → `BuyerRemittance`, staleTime 5min), `useBuyerStatementMonths` (P5-15, `GET /buyer/statements` → `{months}`, staleTime 5min), `fetchStatementPdfUrl` (P5-15, imperative `GET /buyer/statements/:month` → presigned `url`; caller MUST download via `fetchPdfBlob`+programmatic `<a download>`, never `<a href>`/`window.open`) |
| `remittance.ts` | (P5-14, operator, mirrors `margin.ts`) `RemittanceConfig` type (10 optional strings) + `useRemittanceConfig()` (`GET /settings/remittance`, queryKey `["remittance-config"]`, staleTime 5min) + `useUpdateRemittanceConfig()` (`PATCH /settings/remittance`, invalidates `["remittance-config"]`) |
| `promotions.ts` | (P5-01) `usePromotions`, `usePromotion`, `useCreatePromotion`, `useUpdatePromotion`, `useSetPromotionActive`, `useDeletePromotion`; helpers `promotionStatus`/`promotionRuleLabel` + `Promotion`/`PromotionInput` types |
| `authorizations.ts` | (W6b, operator) `useCustomerAuthorizations`, `useCreate/Approve/Reject/RenewAuthorization`, `useCreateAuthorizationOverride`; helpers `parseRegulatedAuthError`/`displayAuthStatus`/`authStatusBadge` |
| `tracked-categories.ts` | `useTrackedCategories`/`useTrackedCategory`/`useCreate\|Update\|ToggleTrackedCategory`, `useTrackedSubcategories`+`useCreate\|Update\|ToggleSubcategory`, `useAssign\|UnassignProductsToCategory`, `useRegulatedLedger`; **(2026-07-30 fix round)** `useRegulatedReportPreview`, `fetchRegulatedReportCsv` (`GET /regulated/reports/{preview,csv}`, optional `columns`), `useRegulatedTemplates` (`GET /regulated/templates`) + `ReportTemplateDef`/`TemplateItemType`/`TemplateColumn`/`RegulatedReportParams`/`RegulatedReportPreview` types |
| `users.ts` | `useMe`, `useChangePassword`, `useUpdateProfile` |
| `notifications.ts` | `useNotificationCount`, `useUnreadNotifications` |
| `addons.ts` | `useDeveloperMode(): {enabled, isLoading, resolved}` — composes `tobacco.ts`'s `useTenantAddons()` (same `["tenant","addons"]` cache) and reads the hidden `DEVELOPER_MODE_ADDON` (`@routeflow/types`). `resolved` = query `isSuccess`: `useTenantAddons` is `retry: false`, so on an errored fetch `enabled` AND `isLoading` are both false. **2026-08-25 split:** `useRecurringRoutes()`/`useOrderDelivery()` read `RECURRING_ROUTES_ADDON`/`ORDER_DELIVERY_ADDON` off the same query; **`useRoutesAccess()`/`useDeliveryAccess()`** (`{enabled,resolved}`) are the composition helpers every gate should read — never the raw addon hooks alone. **2026-08-28:** those two helpers now return the matching feature hook UNCHANGED — the `devMode ||` disjunct is gone (owner decision: `developer_mode` unlocks only in-development surfaces, and web has none). `useDeveloperMode` itself stays exported but has **no remaining caller in `apps/web`** — kept for mobile-mirror parity and future in-dev surfaces. Any **stranding** gate (the `RouteGuard` prefix redirects in `(dashboard)/layout.tsx`) must key off the composed `resolved` and fail OPEN; hide-only gates (nav, `g r`/`g d` shortcuts, palette, dashboard cards) use `enabled`. Launch reversal = grep `useDeveloperMode`/`useRoutesAccess`/`useDeliveryAccess`. |
| `sales-agents.ts` | (PR-D) `useSalesAgents`, `useSalesAgent`, `useAgentAccruals`, `useCustomerCurrentAgent`, `useCreate | Update | UpdateStatus | DeleteSalesAgent`, `useAdd | RemoveAgentRate`, `useAddCustomerRate`, `useAddAssignment(agentId)`/`useBulkAssign(agentId)`/`useCloseAssignment`, `useRecomputeAgent`, `useCommissionStatements`, `useCommissionStatement`, `useGenerate | Approve | VoidStatement`, `useRecordCommissionPayout`; types mirror the Prisma `Decimal`-over-JSON reality (`number | string`) plus `RATE_SOURCE_LABELS`and`pctLabel()`. **Every query hook takes `opts?: { enabled?: boolean }`** — a gated GET that 403s trips the `api-client.ts`PLAN_GATE toast bridge, so an unflagged tenant must fire ZERO`/sales-agents*`or`/commission-statements*`requests. Invalidation: agent/rate/status →`["sales-agents"]`; assignments → that plus `["sales-agents","current-assignment",customerId]`; statements → `["commission-statements"]`**and**`["sales-agents"]` (claims move accrual state). |
| `messaging.ts` | (P6-6, operator) `useMessagingConfig` (`["messaging-config"]`, `GET /messaging/config`, lazy server-side seed), `useToggleRule` (`PATCH /messaging/rules/:id`, optimistic), `useUpdateTemplate`, `usePreviewTemplate`, `useUpdateMessagingSettings`; `extractTemplateVars(body)` client mirror of `{{var}}` parsing; types `MatrixCell`(**+`unavailable?: "NO_TRANSPORT"\|"NO_CONSENT_WRITER"\|"NO_TRIGGER"`, F23/#650**)/`MatrixEvent`/`MessagingSettings`/`MsgsMeter`/`MessagingConfig` |

### Batch 2026-07-23 (PRs #305, #309, #310)

- **Sidebar casing (#305)** — `app/(dashboard)/layout.tsx` `NavGroupSection` header button: removed the `uppercase` Tailwind token so collapsible group labels render Title Case ("Orders"/"Finance"/…) consistent with the leaf links. Label strings were already Title Case; buyer portal + mobile drawer unchanged (they already reserve caps for section headers).
- **Payment image (#309)** — `lib/api/invoices.ts` payment types gain `imageKey/imageOriginalName/imageMimeType`; `useRecordInvoicePayment` result gains `createdPaymentId`; new `useUploadPaymentImage`/`useDeletePaymentImage`/`useGetPaymentImageUrl` (FormData, cloned from `lib/api/finance.ts` receipt hooks). UI: `invoices/[id]/page.tsx` record + edit payment modals get an `accept="image/*"` attach control (deferred best-effort upload) + Payment History "View receipt"; `finance/payments/page.tsx` standalone modal + paperclip presence icon; `finance/payments/[id]/page.tsx` renders the image.
- **Unit code (#310)** — `components/ProductCreateModal.tsx` + `products/[id]` detail/variant forms add the "Unit code" field (label pair "Case code"/"Unit code"); `lib/barcode-resolve.ts` exact-preference widened to `unitSku`. All other scan callers unchanged (server `findByBarcode` widening covers them).

### 2026-09-04 — F13 recurring templates + standing-order items (B09 / B46 / B48 / B92 / B106)

- **`lib/api/invoices.ts`** — `RecurringInvoice` gains `lastRunStatus?: "SUCCESS"|"FAILED"|null` and
  `lastError?: string|null`. New exports **`RUN_UNFINALIZED_PREFIX`** (mirrors
  `RUN_UNFINALIZED_ERROR` in `apps/api/src/recurring-invoices/recurring-invoices.service.ts` —
  reword one and you must reword the other, they are coupled by a `startsWith`) and
  **`isRetryableRunFailure(lastError?): boolean`** — false for an already-billed-but-unfinalized
  cycle, so the UI never invites a Run Now that would bill the customer twice.
  `useActivateRecurringInvoice`'s comment now records WHY resume is its own endpoint: the PATCH is
  validated and whitelisted since `UpdateRecurringInvoiceDto`, which deliberately omits `isActive`.
- **`lib/api/order-templates.ts`** — `useUpdateOrderTemplate` variables are typed explicitly
  (`{id, name?, daysOfWeek?, isActive?, notes?, items?: {productId, qty, notes?}[]}`); `items` is
  the REG-B09 replace-the-list field the API gained.
- **`app/(dashboard)/invoices/recurring/page.tsx`** — the Last-run row renders the recorded outcome
  (green "Succeeded" / red "Failed" pill) and, on failure, the error text; the "use Run Now to
  retry" hint is appended ONLY when `isRetryableRunFailure(ri.lastError)` (REG-B106). Each card also
  gains an **Edit** button linking to `/invoices/recurring/[id]/edit`.
- **`app/(dashboard)/invoices/recurring/_components/RecurringInvoiceForm.tsx`** (new) — the whole
  create form (customer search, schedule fields, line items, money totals) extracted out of
  `new/page.tsx` verbatim so the new edit page reuses it; `new/page.tsx` is now a thin wrapper.
  Takes an optional existing `RecurringInvoice` to seed edit mode.
- **`app/(dashboard)/invoices/recurring/[id]/edit/page.tsx`** (new, REG-B92) — loads the template
  with `useRecurringInvoice`, renders `RecurringInvoiceForm`, saves through
  `useUpdateRecurringInvoice`. Before F13 there was no edit surface at all and the PATCH behind it
  was unvalidated.
- **`app/(dashboard)/customers/[id]/StandingOrderModal.tsx`** (REG-B09) — edit mode now saves the
  item list it displays: rows carry `notes`, and the PATCH includes `items` **only when the list
  actually differs** from the loaded template, compared by the new order-free
  **`itemSignature(items)`** helper (`productId:qty:notes` sorted and joined). Two reasons, both
  load-bearing: an untouched list must not be churned (the API replaces items by delete +
  re-create, minting new ids), and a name/day/notes-only edit stays the scalar-only shape the
  pre-F13 API accepts — api and web are independent Railway services, so that keeps every
  non-item edit working through the deploy window and behind a rollback.
- **`e2e/30-recurring-standing.spec.ts`** (new) + **`playwright.config.ts`** project
  `recurring-standing` (`dependencies: ["setup"]`, operator storage state) — **without the project
  entry the spec never runs.** Three tests: REG-B09 the Edit Standing Order modal persists item
  adds and qty changes; REG-B92 the recurring edit page persists a schedule/notes change; REG-B106
  the card shows "Succeeded" after Run Now. Mutating but self-contained — throwaway `E2E B09 …` /
  `E2E B92 …` fixtures on the approved seed tenant, the recurring template created with `nextRunAt`
  in 2099 so a leaked row can never fire the cron. ⚠️ **`DELETE /recurring-invoices/:id` is
  DEACTIVATE, not a row delete** (unlike `/order-templates/:id`), so the second test's `finally`
  voids the Run Now invoice and leaves an inert, deactivated template behind. ⚠️ Never run this
  file locally with `npx playwright test` — not even `--list`; it clobbers
  `.campaign/runs/web-e2e.json`. Both toast assertions ("Standing order updated", "Recurring
  template updated") are scoped through
  `getByRole("region", { name: /notifications/i }).getByRole("listitem")` — a bare
  `page.getByText(...)` hits 2 elements (the toast + Radix's aria-live announcer mirror);
  see [[L-076]].
- **`e2e/28-credit-note-wallet.spec.ts`** (new, F09) + **`playwright.config.ts`** project
  `credit-note-wallet` (`dependencies: ["setup"]`, operator storage state) — without the project
  entry the spec never runs (08's precedent). Two tests, both read-only (mocked API responses via
  route fulfillment, no seed mutation): REG-B19 `/credit-notes` renders the mocked row's invoice
  number, never the raw UUID (T13); REG-B18 `/credit-notes/:id` loads (number heading) with no
  "Issue Credit Note" button, using a **DRAFT** fixture on purpose — DRAFT is the phantom status
  the deleted flow keyed its button on (wire-shaped but never actually issuable post-fix, since a
  real note is created ISSUED), so a green result here is real evidence the dead button is gone,
  not an accident of an ISSUED fixture never having shown it (T14). Both heading assertions are
  scoped through `page.locator("#main-content").getByRole("heading", {...})` — the dashboard
  shell's own `<h1>` duplicates the page's title string via `setTitle`, so an unscoped match hits
  2 elements and violates Playwright's strict mode (same trap as `15-stock-count-ui.spec.ts:150-152`,
  `21-destructive-guards.spec.ts`'s `#main-content` convention).
- **`e2e/29-returns-lifecycle.spec.ts`** (new, F08 #645) + **`playwright.config.ts`** project
  `returns-lifecycle` (`dependencies: ["setup"]`, operator storage state, appended after
  `credit-note-wallet`) — a DELIVERED-order fixture built via the API (transition guards) backs
  three tests: REG-B166 search (T12), REG-B75 KPI/row value (T13), REG-B21 cancel + B82 quota
  release (T14). **Post-deploy run 34075878788 (headSha 99d5b87a): T12 passed, T13 and T14
  FAILED** (all retries). T14 (`:319`) asserts `page.getByRole("heading", { name: ret.returnNumber
})` WITHOUT the `#main-content` scope this exact trap already taught spec 28 (immediately above)
  to use — the dashboard shell's own title `<h1>` duplicates the return number a second time, so
  the bare locator hits 2 elements (strict-mode violation), never reaching the Cancel Return
  button. This reads as a TEST bug in the new spec, not a product regression — apply the
  `#main-content` scoping convention. T13 polled `before+10` but observed `before+15/25/35`,
  growing by exactly $10 per Playwright retry — consistent with the KPI/fixture not being isolated
  per attempt (each retry's setup adds another billed return without the prior attempt's being
  cleaned up or excluded). Neither failure has been root-caused to a fix; F08's T2 rows
  (B166/B75/B21) are NOT discharged pending a clean re-run. **T13 root cause + fix (#654,
  2026-09-07, B234):** the race was the KPI baseline, not the fixture — `returns/page.tsx` paints
  a fully formatted "$0.00" with no loading branch while `useReturns({ limit: 500 })` is still in
  flight, so a `toBeVisible` + DOM `textContent` read of the tile cannot tell loading-zero from
  loaded-zero. T13's `before` now comes from the API sum (#654) — `GET /returns?limit=500`,
  `refundEstimate` summed over every row excluding REJECTED/CANCELLED, mirroring the tile's own
  definition — never the DOM (L-086: a post-deploy money oracle comes from the API). Confirmed
  green post-fix: GitHub Actions run 34099966904 (deployment_status, headSha 05b6c805), job E2E
  (Playwright), project `returns-lifecycle`, test #160 REG-B75 PASSED; 139 passed / 0 failed / 26
  skipped.
- **`e2e/37-list-caps.spec.ts`** (new, F16 #656) + **`playwright.config.ts`** project `list-caps`
  (`dependencies: ["setup"]`, operator storage state) — the web leg for the four F16 rows with a
  web surface (B12/B80/B144/B110; B89/B117/B169 are api-only, proven pre-merge). Four tests,
  self-provisioned fixtures (throwaway customer/invoice/payment for B80, throwaway 25-order
  customer for B144): REG-B12 the invoices page derives its KPI tiles from `/invoices/kpi-summary`
  (never `limit=999`) and "Total Outstanding" agrees with the endpoint's own figure (API oracle,
  L-086); REG-B80 the payment receipt page fetches by id (never `useInvoicePayments(limit:200)`);
  REG-B144 an active customer search is sent server-side (`search=`) and the pager stays visible;
  REG-B110 the customer detail page's Profile and Invoices-tab Outstanding figures agree with each
  other and the statement endpoint. **Post-deploy run 34137751080 (headSha e02851af): REG-B12
  PASSED (test #168, 974ms); REG-B80/REG-B144/REG-B110 all FAILED (all 3 attempts each) on
  `Error: operator storageState carried no access token`** (`:136`/`:222`/`:290` —
  `expect(token, "operator storageState carried no access token").toBeTruthy()`). Run totals: 140
  passed / 4 failed / 25 skipped. **The fourth failure is `REG-B11` in `22-payment-truth.spec.ts`
  — a REAL, LIVE regression, not a flake:** the "Awaiting confirmation" KPI tile reads 0 after a
  DRAFT payment is recorded. Cause (team-board diagnosis, unconfirmed in this session): `m7`
  scoped `getKpiSummary`'s `awaitingConfirmationCount` to the OPEN-invoice set (the old client
  memo counted DRAFT payments across every loaded invoice, open or not), and/or the new
  `kpi-summary` query is never invalidated after a payment mutation, so the bar reads stale until
  a reload. **A hotfix light loop was already launched separately** (`fix-round-5-hotfix.md`:
  restores the memo's basis, keys the summary query under the invoices cache prefix, fixes the
  spec-37 `operatorAccessToken` ordering below) — not touched in this bookkeeping session; do not
  re-attribute this failure to a pre-existing cause. REG-B80/REG-B144/REG-B110 separately **reads
  as a TEST bug in the new spec, not a product regression** — same class as spec 28/29's
  `#main-content` trap immediately above: REG-B80,
  REG-B144 and REG-B110 each call `operatorAccessToken(page)` (`helpers/api.ts` — reads
  `localStorage` in the CURRENT page) as their first statement, before any `page.goto(...)`, so it
  evaluates on an unnavigated page; Playwright only restores a `storageState`'s `localStorage`
  entries once the browser has actually navigated to the matching origin, so the read is always
  empty. REG-B12 (which calls `page.goto("/invoices")` first and never touches
  `operatorAccessToken`) passed in the same file and run. Precedent specs
  `21-destructive-guards.spec.ts` and `22-payment-truth.spec.ts` both call `page.goto` before ever
  reading the token — `37-list-caps.spec.ts` broke that established ordering. F16's registry rows
  B80/B144/B110 (T2 tier) are therefore left `queued`, not discharged, pending a harness fix
  (move each `operatorAccessToken` call to after the test's first navigation) and a clean re-run;
  B12 (T2) is `done` on its own passing leg. See `.claude/campaign/bugs/B80.md` /`B144.md`/`B110.md`
  History for the full note. **Both root causes fixed (#659, 2026-09-07, master `4d977168`, L-090):**
  REG-B11's cause was confirmed as diagnosed above — `m7` scoped the awaiting-confirmation count to
  the money tiles' OPEN basis instead of the memo's own (none); the count now carries no
  invoice-status scope for staff, exactly the memo's basis, and `{ not: DRAFT }` for a buyer (see
  `api.md`'s F16-hotfix bullet). The "never invalidated after a mutation" half of the diagnosis did
  NOT need a code fix — `useInvoiceKpiSummary`'s query key was already `["invoices", "kpi-summary",
today]`, under the shared `["invoices"]`-prefix invalidation every payment mutation already fires,
  since #656; new `apps/web/lib/api/invoices.kpi-summary.test.tsx` now pins that behaviourally
  through a real `QueryClient` so a future re-key would fail here first. The harness ordering bug
  is also fixed: new `openApp()` (navigates to `/invoices`, waits on the "New Invoice" button) and
  `apiHeaders()` (calls `operatorAccessToken` only after `openApp`) helpers replace the three bare
  pre-navigation token reads that failed REG-B80/REG-B144/REG-B110. Deployed api `4495be33` + web
  `690cd7b7`, both SUCCESS 2026-09-07. **T2 proof for B80/B110/B144 still awaits this deployment's
  own E2E run** — do not discharge from this bullet alone; confirm the spec-37 REG lines PASSED on
  master `4d977168` first. **A second, deeper harness defect surfaced on that very run (34146107042)
  and was fixed in #661 (2026-09-07, master `92cb0fb6`, L-091):** REG-B80's `getByText(paymentNumber)`
  hit Playwright's strict-mode violation because the receipt page renders the payment number twice —
  once in the `<h2>` heading, once in a meta `<p>` (`finance/payments/[id]/page.tsx:107-109`) — fixed
  by asserting the heading through `getByRole("heading", { name, exact: true })`, which resolves the
  element by ROLE instead of by a text value that appears more than once. REG-B144's fixture provisioned
  25 pending orders for ONE customer through the staff-create endpoint, whose 2nd-and-later POST hits
  the customer-level auto-merge guard (`orders.controller.ts:110-127`, 409 `MERGE_CHOICE_REQUIRED`) —
  fixed by sending each order with `mergeChoice: "separate"` (`create-order.dto.ts:103` →
  `orders.controller.ts:107-108,273-282` sets `skipAutoMerge=true`), the API's own documented escape
  hatch, rather than working around the guard; `test.setTimeout(120_000)` added for the 25-order
  provisioning. Both are spec-only changes — `apps/web/e2e/37-list-caps.spec.ts` is the only file #661
  touched. Confirmed green: deployment E2E run 34154308035 (master `92cb0fb6`, web deployed SUCCESS
  2026-09-07 19:06Z, api SKIPPED — no api change) — REG-B12/REG-B80/REG-B144/REG-B110 all PASSED
  (list-caps project, attempt 1); run totals 143 passed / 0 failed / 26 skipped. B80/B144 (T2)
  discharged on this run; B110 (T2) was already discharged in the #659 follow-up (#660).
- **`e2e/36-marketing-site.spec.ts`** (new, marketing-port #657) + **`playwright.config.ts`**
  project `marketing` (`testMatch: /36-marketing-site\.spec\.ts/`, NO `dependencies` — signed-out
  throughout, Desktop Chrome by default; T2's mobile assertions opt into `devices["iPhone 13"]`
  via `test.use()` inside that describe block) — NOT part of the local red gate (post-deploy proof
  only, same convention as 08-create-order-escape's "without this entry the spec never runs").
  T1 per-route chrome/copy across the 9 public pages + the `/distributors` redirect + a bogus-path
  404 + `/privacy` noindex + the contact form + the company page's photo credit; T2 the mobile
  sheet (9 links) and desktop sign-in menu, the contact mailto draft, the wholesalers tab, home
  FAQ single-open; T3 crawls every internal link on the 9 pages for < 400; T12 a mobile UA still
  gets the marketing site on `/pricing` (R11 — see the middleware carve-out under `(marketing)/`
  above; B249 is the gap this project's Desktop-Chrome-only run does NOT cover); T13
  below-the-fold `.reveal-pending` clears on scroll and stays opaque under reduced-motion.

### 2026-09-11/12 — CRM: Settings → GoHighLevel tab (new, R29-R31, ux-spec.md)

- **`lib/api/crm.ts`** — TanStack Query hooks for the CRM tab: `useCrmStatus()`,
  `useCrmPipelines()`, `useCrmHandoffs(params)`, `useSaveCrmConnection()`,
  `useTestCrmConnection()`, `useDisconnectCrm()`, `useUpdateCrmConfig()`, `useSyncCrmNow()`,
  `usePreviewCrmImport()`, `useImportExistingCrmLeads()`; query keys `crmStatusKey`,
  `crmHandoffsKey(params)`, `crmPipelinesKey`; plus `useRetryHandoff()` / `useDismissHandoff()`
  (fix round 1). Calls `POST /crm/gohighlevel/sync`, `import-existing{,/preview}` and
  `handoffs/:id/{retry,dismiss}` — all 12 routes exist in `crm.controller.ts` since fix round 1
  (F1); the handoffs list is the `{data,total,page,limit}` envelope.
- **`app/(dashboard)/settings/_components/GoHighLevelSettingsTab.tsx`** —
  `GoHighLevelSettingsTab(props: GoHighLevelSettingsTabProps)` (presentational, all four
  ux-spec.md cards: Connection / trigger config / Options / Activity) and default export
  `GoHighLevelSettingsTabConnected()` (wires the hooks above). Types: `CrmActivityRow`,
  `CrmConfigView`, `GoHighLevelSettingsTabProps`.
- **`app/(dashboard)/settings/_components/SettingsHub.tsx`** / **`.../settings/page.tsx`** — add
  the "GoHighLevel" tab entry alongside the existing settings tabs.
- **`lib/hooks/useNotifications.ts`** — extended for the CRM `NEEDS_ATTENTION` /
  stale-poll notification surfaces the bell/Activity-card states rely on.
- **`app/(dashboard)/layout.tsx`** / **`app/(dashboard)/customers/page.tsx`** — bell entry point
  and a CRM-linked-customer affordance per ux-spec.md's "Entry points" section.
