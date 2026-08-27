# Plan: Split-payment deposits at order placement (PR-D) · in-builder order picker (PR-E)

> Authored by Fable 5 on 2026-08-26. Status: APPROVED
> This file is the ONLY context the implementation and review agents receive. It must stand
> alone: no references to "the conversation", no "as discussed".

## Objective

1. **PR-D:** tenants whose business model is "X% deposit when the order is placed, remainder
   on Net-N" get a first-class, per-tenant policy. When active, the order's mirror invoice is
   ISSUED at order placement (deposit due immediately, remainder on the resolved terms) so a
   payment can be recorded right away — while the order stays fully editable until delivery
   (owner decision: deposit = configured % of the CURRENT total until paid; once paid, the
   paid amount stands and only the remainder adjusts). Deposit visibility lands on the PDF and
   the invoice email.
2. **PR-E:** the /deliveries/new trip builder gets an in-page order picker: arriving directly
   no longer dead-ends, orders can be added/removed inside the builder, backed by a new
   eligible-orders endpoint.

## Existing machinery (build ON this — do not duplicate)

- `Invoice.depositPercent/depositDueDate` exist; `depositAmount` is DERIVED at read time via
  `computeDepositFields` (invoices.service.ts ~L244) — never stored. `depositOverdue` derived.
- `Customer.defaultDepositPercent` + `defaultPaymentTerms` exist; `resolveDefaultTerms`
  (~L167) returns `{terms, dueDays, customerDepositPercent}`; the from-order invoice path
  (~L586-650) auto-applies `customerDepositPercent > 0` as
  `{depositPercent, depositDueDate: issueDate}` via `depositFields`.
- Orders create a "pending mirror" DRAFT invoice at placement (orders.service:
  `createInvoiceFromOrder` for sales ~L2112, `createInvoiceFromOrderWithTenant` fire-and-forget
  for regular orders ~L2285). Van-sale issues immediately via `this.invoicesService.send(inv.id)`
  — `send()` marks SENT **without emailing**.
- `reconcileOrderDraftInvoice` (~L1197) syncs order edits into the mirror — currently
  restricted to the open pending-mirror **DRAFT** (comment ~L1632).
- `recomputeStatus` (~L216): DRAFT/VOID/WRITTEN_OFF terminal; paid>=total→PAID; paid>0→PARTIAL.
- Payments are allowed on SENT/VIEWED/PARTIAL/OVERDUE (web+mobile `canRecordPayment` mirrors).
- W4 split siblings: `extraInvoiceData` (incl. deposit fields) is applied to EVERY sibling.
- The API PDF template (`invoice-pdf-template.tsx`) has NO deposit rendering today.
- Trips: `TRIP_ELIGIBLE_STATUSES = [PENDING, CONFIRMED, PARTIALLY_DELIVERED]`,
  `checkEligibility(order)` (trips.service.ts ~L64: SHIP excluded, active-run/stale-link
  excluded, needs ≥1 customer address), `getEligibility(tenantId, orderIds)` scores GIVEN ids.
- Builder (deliveries/new/page.tsx): `orderIds = draft?.orderIds ?? []` read from
  sessionStorage (`lib/trip-draft.ts`, key rf-trip-draft-v1, 30-min TTL); phases
  PICKING→BUILT; TripStopList removes whole customers only; no-draft = dead-end empty state.

## Constraints & conventions

- Prettier semicolons/double quotes/printWidth 100; lint via `npm run lint` from root only.
- NO prisma schema/migrations. NO new deps. Do NOT touch `.claude/code-map/**`, Dockerfiles,
  railway.toml. Never name a real client tenant.
- Money: every stored monetary value goes through `roundMoney`; deposit stays DERIVED —
  never store a deposit dollar amount. Never re-derive `qty*unitPrice` for boxed lines.
- Jest for api (`Test.createTestingModule`, mock at module boundary); no snapshot tests.
- Behavior that must NOT change: tenants with NO deposit policy and customers with
  `defaultDepositPercent` today keep byte-identical behavior (their mirrors stay DRAFT —
  issuance-at-placement is gated ONLY on the new tenant flag). Van-sale flow unchanged.
- Work in the given worktree; absolute paths.

## Work packages

### WP-D1 — api: tenant deposit policy, order-time issuance, editable-order reconcile

- **files:** `apps/api/src/invoices/invoices.service.ts`,
  `apps/api/src/system-config/settings.controller.ts`,
  `apps/api/src/system-config/dto/update-invoice-settings.dto.ts`,
  `apps/api/src/system-config/settings.controller.spec.ts`,
  `apps/api/src/invoices/invoices.service.spec.ts`
- **brief:**
  1. Settings: extend GET/PATCH `/settings/invoice` with two keys —
     `invoice.depositDefaultPercent` (number 0–100, stored as string; absent/0 = no tenant
     deposit) and `invoice.depositCollectAtOrder` ("true"/"false"). DTO:
     `@IsOptional() @IsNumber() @Min(0) @Max(100) depositDefaultPercent?: number;`
     `@IsOptional() @IsBoolean() depositCollectAtOrder?: boolean;`
     GET returns both (number|null and boolean). Spec cases follow the existing style.
  2. `resolveDefaultTerms`: also read the tenant percent and return
     `effectiveDepositPercent: number | null` computed as:
     ```ts
     // Customer wins when SET: >0 = their percent, 0 = explicit opt-out.
     // null/undefined = inherit the tenant default (if any).
     const tenantDepositRaw = await this.systemConfig.get("invoice.depositDefaultPercent");
     const tenantDepositPercent = tenantDepositRaw ? Number(tenantDepositRaw) : null;
     const effectiveDepositPercent =
       customerDepositPercent != null
         ? customerDepositPercent > 0
           ? customerDepositPercent
           : null
         : tenantDepositPercent && tenantDepositPercent > 0
           ? tenantDepositPercent
           : null;
     ```
     Keep returning `customerDepositPercent` too (other callers read it).
  3. From-order deposit fields (~L622): switch the fallback branch from
     `customerDepositPercent` to `effectiveDepositPercent` (explicit `overrides.depositPercent`
     still wins). NOTE the existing `customerDepositPercent > 0` guard becomes redundant —
     effective is already null-or-positive.
  4. **Issuance at placement:** in `createInvoiceFromOrder` (the shared from-order path),
     AFTER `createSplitInvoices` returns and ONLY when ALL of: the created invoices are fresh
     DRAFTs · the order is NOT delivered (`order.status !== DELIVERED`) · the invoice carries
     `depositPercent != null` · `(await this.systemConfig.get("invoice.depositCollectAtOrder")) === "true"`
     → call `await this.send(inv.id)` for each created sibling and return the SENT versions.
     `send()` marks SENT without emailing (van-sale precedent, orders.service ~L2130). Do NOT
     issue when the caller is a reconcile/rebuild path — only the create path.
  5. **Reconcile follows the editable order:** widen `reconcileOrderDraftInvoice`'s
     mirror-eligibility so an order-linked invoice ALSO reconciles when
     `status ∈ {SENT, VIEWED, PARTIAL, OVERDUE}` AND `depositPercent != null` AND the linked
     order is not DELIVERED/CANCELLED. Totals rebuild exactly as the DRAFT path does;
     payments rows are untouched; after totals change, re-run the existing status recompute so
     paid-vs-new-total lands on PARTIAL/PAID correctly. `depositDueDate` and `dueDate` are
     PRESERVED (they anchor to placement/terms, not to edits). Document in a comment: if an
     edit drops total below the amount already paid, status recomputes to PAID and balanceDue
     floors at 0 — the overpayment is surfaced by the existing credit-note workflow, not here.
  6. **Email visibility:** wherever `send-email` builds the invoice email body in
     invoices.service.ts, when the invoice has `depositPercent != null` add one line:
     "Deposit due: $<depositAmount> by <depositDueDate> · Remainder due by <dueDate>"
     (compute via `computeDepositFields`; format money with the file's existing helper).
  7. Specs (invoices.service.spec.ts, existing mock style): resolution matrix (customer
     null/0/50 × tenant unset/30) → effective percent; collect-at-order=true issues the
     mirror SENT at create while false leaves DRAFT; reconcile of a SENT+deposit mirror
     updates totals and preserves payments; deposit amount derives from the CURRENT total.
- **exact code:** the resolution snippet above; everything else follows existing patterns in
  the named regions.

### WP-D2 — api: deposit on the PDF

- **files:** `apps/api/src/invoices/invoice-pdf-template.tsx`,
  `apps/api/src/invoices/invoice-pdf.service.ts`
- **effort:** low
- **brief:** Thread `depositPercent`/`depositDueDate` (+ a computed `depositAmount`,
  `roundMoney(total*percent/100)` computed in the pdf service, passed as data — the template
  stays dumb) into `InvoicePdfData`. In the totals block, when a deposit exists render two
  lines after Total: "Deposit due <date> $X" and "Remainder due <date> $Y" (Y = total −
  X − nothing else; amounts already-paid rendering stays as-is). Style-match the existing
  totals rows. Render NOTHING when depositPercent is null (byte-identical output).

### WP-D3 — web: deposit settings UI + buyer-portal visibility

- **files:** `apps/web/app/(dashboard)/settings/page.tsx`, `apps/web/lib/api/invoices.ts`,
  `apps/web/app/buyer/portal/[seller]/invoices/[id]/page.tsx` (locate the buyer invoice
  detail page under `apps/web/app/buyer/portal/[seller]/` — if the path differs, use the real
  one; it is the ONLY buyer file in scope)
- **brief:**
  - `lib/api/invoices.ts`: widen the `InvoiceSettings` type with
    `depositDefaultPercent?: number | null; depositCollectAtOrder?: boolean;`.
  - Settings page, in the invoice-defaults card (where `defaultTerms` +
    `hideOriginalPrice` live): add a "Deposits" sub-section — a percent number input
    (0–100, empty = none) labeled "Default deposit (% of order total)" with help text
    "Customers with their own deposit % override this; 0 on a customer disables it.", and a
    toggle "Collect deposit at order placement" with help "Issues the order's invoice
    immediately so the deposit can be paid; the order stays editable until delivery." Both
    save via the same mutation+toast pattern the card already uses.
  - Buyer portal invoice detail: when the invoice payload carries `depositPercent != null`,
    show a highlighted line/banner: "Deposit due <date>: $<depositAmount> · Remainder due
    <dueDate>" using payload fields (`depositAmount` is server-computed on the detail
    endpoint). Nothing renders when null.

### WP-E1 — api: eligible-orders endpoint for the trip builder

- **files:** `apps/api/src/trips/trips.service.ts`, `apps/api/src/trips/trips.controller.ts`,
  `apps/api/src/trips/dto/eligible-orders.dto.ts` (new),
  `apps/api/src/trips/trips.service.spec.ts` (extend if present; create following api spec
  conventions if not)
- **brief:** `GET /trips/eligible-orders?search=&page=&limit=&exclude=id,id` (OPERATOR-gated
  exactly like the existing trips endpoints). Query orders WHERE status IN
  TRIP_ELIGIBLE_STATUSES AND fulfillPath != SHIP AND (routeRunStopId IS NULL OR its run is
  finished — reuse the loadOrders include + `checkEligibility` to make the FINAL call per row,
  so the list can never disagree with POST /trips), customer include for businessName +
  addresses count; search filters orderNumber/customer businessName (insensitive contains);
  paginate (default limit 20, max 50, newest first); response rows
  `{orderId, orderNumber, customerId, customerName, total, itemCount, deliveryDate, eligible: true}` —
  ineligible rows are FILTERED OUT server-side (the picker only offers addable orders).
  `exclude` (comma list) drops ids already in the builder. Spec: eligibility filtering,
  exclude, search, SHIP exclusion.

### WP-E2 — web: the in-builder order picker

- **files:** `apps/web/app/(dashboard)/deliveries/new/page.tsx`,
  `apps/web/app/(dashboard)/deliveries/_components/TripStopList.tsx`,
  `apps/web/app/(dashboard)/deliveries/_components/OrderPickerPanel.tsx` (new),
  `apps/web/lib/api/trips.ts`, `apps/web/lib/trip-draft.ts`
- **brief:**
  - `lib/api/trips.ts`: add `useEligibleTripOrders({search, page, exclude})` querying WP-E1's
    endpoint (follow the file's existing hook style).
  - Builder: `orderIds` becomes real state seeded ONCE from `loadTripDraft()` (keep the
    hydration-safe two-step the page already uses for `draft`). Every add/remove calls
    `saveTripDraft(nextIds)` so a refresh keeps the selection. PICKING phase only.
  - `OrderPickerPanel` (new): collapsible "Add orders" section in the left column above
    `TripStopList` — search box + the eligible list (paginated, "Load more" is fine), each row
    order# · customer · total · delivery date with an Add button; rows already selected are
    excluded via `exclude`. Adding appends to `orderIds` (the existing `useTripEligibility`
    revalidates the set exactly as today).
  - `TripStopList`: alongside the existing whole-customer remove, allow removing a SINGLE
    order from a multi-order customer group (small × per order line; single-order groups keep
    the existing customer-level remove only).
  - Direct-nav empty state: REPLACE the "go to Orders" dead-end with the picker open by
    default plus one hint line "You can also select orders on the Orders list and choose
    'Plan delivery trip'." Keep `?n=` count param behavior harmless when absent.
  - BUILT phase is untouched (frozen ids snapshot, exactly as today).

## Acceptance criteria

1. GET /settings/invoice returns `depositDefaultPercent` + `depositCollectAtOrder`; PATCH
   persists both; spec covers unset/set/absent.
2. Effective-deposit resolution: customer 50 → 50 regardless of tenant; customer 0 → none
   even when tenant 30; customer null + tenant 30 → 30; customer null + tenant unset → none;
   explicit `overrides.depositPercent` always wins.
3. With `depositCollectAtOrder=true` and an effective percent, a NON-delivered order's
   from-order invoice(s) are SENT at creation (no email sent); with the flag false/unset the
   mirror stays DRAFT — byte-identical to today. Van-sale path unchanged.
4. Editing an order whose deposit-mirror is SENT/PARTIAL re-syncs invoice lines/totals,
   preserves payment rows, preserves depositDueDate/dueDate, and recomputes status; DRAFT
   mirrors behave exactly as before.
5. `computeDepositFields` continues to derive the deposit from the CURRENT total (this is
   what makes "deposit follows edits until paid" true); no stored dollar amounts anywhere.
6. PDF: deposit + remainder lines render only when depositPercent != null; otherwise the PDF
   is byte-identical. Invoice email carries the deposit line under the same condition.
7. Settings UI saves both new fields; buyer portal invoice shows the deposit banner when
   present.
8. GET /trips/eligible-orders returns only orders `checkEligibility` would accept, honors
   search/exclude/pagination, and is OPERATOR-gated.
9. Builder: direct navigation to /deliveries/new shows the picker (no dead-end); adding and
   removing orders (including one order out of a multi-order customer) updates stops and
   persists across a refresh via the trip draft; Build/Send flow unchanged.
10. `npm run verify` green; no schema changes; no files outside the listed packages (except
    the plan file and code map, which the orchestrator owns).

## Verification commands

Per-round: `npm run check-types`. Final: `npm run verify`.

## Risks & rollback

- WP-D1 step 5 is the risk center: the reconcile widening must NEVER touch non-deposit SENT
  invoices (operator-issued real invoices) — the `depositPercent != null` + order-linked +
  order-not-delivered guards are the fence. Review walks this hard.
- Issuance-at-placement interacts with the pending-mirror UI locks (web/mobile
  `isPendingOrderMirror` gates Edit/Send until delivery): a SENT deposit mirror will now show
  payment actions pre-delivery — that is the FEATURE. Invoice EDITING stays blocked
  (`update()` rejects non-DRAFT), which is correct: the order is the edit surface.
- Rollback: tenant flips `depositCollectAtOrder` off — new orders revert to DRAFT mirrors
  instantly; code rollback = revert the PR.
