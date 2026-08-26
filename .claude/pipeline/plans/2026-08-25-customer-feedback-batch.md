# Plan: Customer-feedback batch — addresses CRUD, agent quick-create, deposit terms, due-soon, dead reopen, shipment gating

> Authored by Fable 5 on 2026-08-25. Status: APPROVED (owner directed 2026-08-25)
> This file is the ONLY context the implementation and review agents receive. It stands alone.

## Objective

Six owner/customer-reported items, all reproduced live and root-caused:

1. **Customer addresses**: no way to edit an address, no delete, no set-primary; the Edit
   Customer modal shows only the first address and SILENTLY DISCARDS address edits on save.
2. **Sales-agent quick-create**: when adding a customer, an agent not yet in the system can't
   be created inline.
3. **Default payment terms with deposit** ("50% upfront + 50% net 60"): make it a per-customer
   default that auto-applies to generated invoices. (Terms labels per customer already
   shipped in PR #422; the deposit half is per-invoice manual only.)
4. **Due-soon visibility**: users must see invoices due tomorrow (one day before due date).
   Today the invoices page has static KPI tiles (Due today / 30 days / Overdue) and only an
   `isOverdue` filter.
5. **Dead "Reopen Order" on DELIVERED orders** (web): fires DELIVERED→CONFIRMED which the
   server's transition map (`DELIVERED: []`) always 400s ("Cannot transition from DELIVERED
   to CONFIRMED"). Mobile already removed this exact affordance as BUG-ORD-01
   (`apps/mobile/lib/order-actions.ts:136` comment) — web never got the fix.
6. **Shipment/tracking panel on route orders**: the Shipment card ("No carrier shipment
   recorded" + Add tracking) renders on EVERY order/invoice; it must only appear for
   carrier-shipped (`fulfillPath: "SHIP"`) orders — or when tracking data already exists
   (historical rows).

## Constraints & conventions

- Monorepo npm+Turbo; web Next.js 14 App Router (Radix+Tailwind, TanStack Query, RHF+zod);
  mobile Expo (expo-router, iOS kit `@routeflow/ui/mobile/ios`); api NestJS 11 + Prisma.
  Prettier double quotes/semicolons/printWidth 100. Jest for api+mobile (mobile = pure logic
  only), NO Vitest/snapshots. Conventional commits.
- **Money discipline**: deposit math uses the EXISTING `computeDepositFields`
  (`apps/api/src/invoices/invoices.service.ts:234-256`, read-time derivation, `roundMoney`)
  — do NOT add new money math or store derived amounts.
- **Do NOT touch**: `recordDeliveryPaymentInTx`, `reconcile*` functions' internals,
  `recomputeStatus`, the delivery/run machinery, `changeStatus`'s transition map (the map is
  the doctrine — item 5 is a UI fix), pricing.ts.
- ONE migration, slot `20260905000000_customer_deposit_default` (latest on master is
  20260904…). Additive only, no backfill. After schema edits run
  `npx prisma generate --schema apps/api/prisma/schema.prisma` from the worktree root.
- Live client tenants are never test targets.

## Verified current state (do not re-derive; file:line are exact)

**Addresses** — API `apps/api/src/customers/customers.controller.ts:258-272`:
`POST :id/addresses` (CreateAddressDto: label,line1,line2?,city,state,zip,isDefault?,addressType?)
and `PATCH :id/addresses/:addrId` (UpdateAddressDto: label?,line1?,line2?,city?,state?,zip?,
isDefault? — **no addressType**). **No DELETE route.** `customers.service.ts` `addAddress`
(L736) / `updateAddress` (L764) both enforce single-default in a `tenantTransaction` (flip
others false when isDefault:true); `updateAddress` clears lat/lng on edit and re-geocodes
best-effort. `CustomerAddress` (schema L840-864): label default "default", addressType free
String default "BILLING", isDefault, lat/lng Float?, referenced by `RouteStop.customerAddressId`
and `RouteRunStop.customerAddressId`.
Web: customer detail Addresses tab `apps/web/app/(dashboard)/customers/[id]/page.tsx`
(tab L2145, body L3038-3126, `AddAddressModal` L358-472 with isDefault checkbox, groups by
addressType, renders Star+"Primary" read-only). `useUpdateCustomerAddress` exists at
`apps/web/lib/api/customers.ts:158` with ZERO call sites. No edit/delete/set-primary UI.
`CustomerFormModal.tsx`: add mode builds one address (L282-292, isDefault:true, label "Main");
edit mode prefills from `addresses[0]` only, `state` never loaded (L171), and the edit submit
payload (L305-327) OMITS address fields entirely — silent discard.
Mobile: `apps/mobile/components/CustomerForm.tsx` deliberately excludes addresses in edit mode
(documented L32-34); `apps/mobile/app/(operator)/customers/[id]/addresses.tsx` lists + Add +
"Set default" (L35-47, via useUpdateCustomerAddress) — no edit-fields, no delete.

**Agent quick-create** — `CustomerFormModal.tsx:194` uses
`useSalesAgents({status:"ACTIVE"},{enabled:isOpen&&hasSalesAgents&&mode==="add"})`; select at
L457-475; salesAgentId spread into create payload L293. Reusable create-only modal exists:
`apps/web/app/(dashboard)/sales-agents/_components/AgentFormModal.tsx` props
`{isOpen,onClose,onCreated:(id:string)=>void}` — self-contained, `POST /sales-agents` needs
only `name` (CreateSalesAgentDto).

**Terms/deposit** — `Customer.defaultPaymentTerms String?` (schema L764) with
`VALID_TERMS=["Due on Receipt","Net 15","Net 30","Net 45","Net 60"]`
(`apps/api/src/system-config/dto/update-invoice-settings.dto.ts:7`); `resolveDefaultTerms`
(`invoices.service.ts:163-176`) customer-default → tenant SystemConfig "invoice.defaultTerms"
→ "Net 30"; every dueDate-deriving path persists `Invoice.paymentTermsLabel` (L589-595,
2069-2074, 2203-2225). `Invoice.depositPercent Decimal(5,2)?` + `depositDueDate?` exist but
are settable ONLY on manual `CreateInvoiceDto` (L75-76 of create-invoice.dto.ts);
`createInvoiceFromOrder*`/`createPartialFromOrder`/`createSale` never set them.
`computeDepositFields` (L234-256) derives depositAmount/depositOverdue at read time; surfaced
on findOne/findAll (L2404-2405, 2487-2488). Customer default terms UI = inline select on
customer detail "Default Payment Terms" card (`customers/[id]/page.tsx:1025-1054`),
operator-gated. Buyer portal renders terms read-only — keep it that way (owner's "can the
customer set defaults" = the per-customer PROFILE default, not buyer self-service).

**Due-soon** — `ListInvoicesDto` has only `isOverdue` (L19). Invoices page KPI tiles are
static text; status chips only.

**Dead reopen** — web `orders/[id]/page.tsx:2401-2405`: DELIVERED branch renders
`Reopen Order` → `setDemoteTarget("CONFIRMED")` → reason dialog → PATCH status → server
`orders.service.ts:2122` rejects. Mobile's `order-actions.ts` L136 documents the removal
(BUG-ORD-01). `Edit Items` works at any stage and re-syncs invoices (#288); route-delivered
mistakes are properly reversed via the run stop's Reopen (compensating machinery).

**Shipment sites** — web `orders/[id]/page.tsx:3166` (`ShipmentCard`; the L1550 openSignal
nudge is already SHIP-aware), web `invoices/[id]/page.tsx:2569`; mobile
`(operator)/(tabs)/orders/[id].tsx:844` + `(operator)/(tabs)/invoices/[id].tsx:877`
(`ShipmentSection shipment={order|invoice}`). Orders carry `fulfillPath` on web+mobile
payloads (#435). Invoice payloads do NOT carry the order's fulfillPath — invoice sites gate on
tracking-data presence, plus `invoice.order?.fulfillPath === "SHIP"` ONLY if the payload
already includes it (check; if absent, gate on presence alone — do NOT widen the invoice
payload in this batch). `apps/web/app/(dashboard)/shipments/page.tsx` (list) is unchanged.

## Work packages

### WP1 — API: address delete + type edit + deposit defaults (one migration)

- **files:** `apps/api/prisma/schema.prisma`,
  `apps/api/prisma/migrations/20260905000000_customer_deposit_default/migration.sql`,
  `apps/api/src/customers/customers.controller.ts`, `apps/api/src/customers/customers.service.ts`,
  `apps/api/src/customers/dto/update-address.dto.ts`, `apps/api/src/customers/dto/create-customer.dto.ts`,
  `apps/api/src/customers/dto/update-customer.dto.ts`, `apps/api/src/customers/customers.service.spec.ts`
- **brief:**
  1. Schema: `Customer.defaultDepositPercent Decimal? @db.Decimal(5,2)` (nullable, no default).
     Migration SQL exactly:
     ```sql
     ALTER TABLE "Customer" ADD COLUMN "defaultDepositPercent" DECIMAL(5,2);
     ```
  2. `UpdateAddressDto` += `@IsOptional() @IsIn(["BILLING","SHIPPING","DELIVERY"]) addressType?: string;`
     and pass it through in `updateAddress`.
  3. NEW `DELETE :id/addresses/:addrId` (OPERATOR/TENANT_ADMIN, same guards as PATCH) →
     `customers.service.deleteAddress(customerId, addrId)`:
     - 404 unknown; verify the address belongs to the customer (tenant-scoped).
     - **409 ConflictException** when any `RouteStop` or `RouteRunStop` references the
       address (`customerAddressId`) — message: "This address is used by a delivery route
       stop — remove it from the route first." (Deleting it would orphan live stops.)
     - In a `tenantTransaction`: delete; if the deleted row was `isDefault` and others
       remain, promote the oldest remaining (`orderBy createdAt asc`) to `isDefault: true`.
  4. Customer DTOs: `@IsOptional() @IsNumber() @Min(0) @Max(100) defaultDepositPercent?: number`
     on Create + Update (accept `null` to clear on update: use `@ValidateIf` or transform —
     match how `defaultPaymentTerms` handles clearing, which uses `""`; for the number use
     `null`).
  5. Specs: deleteAddress (404, cross-customer 404, stop-referenced 409, default-promotion),
     updateAddress addressType passthrough, and DTO acceptance of defaultDepositPercent.

### WP2 — API: auto-apply deposit defaults on invoice generation

- **files:** `apps/api/src/invoices/invoices.service.ts`, `apps/api/src/invoices/invoices.service.spec.ts`
- **brief:** Where the order→invoice paths already resolve/persist `paymentTermsLabel`
  (`createInvoiceFromOrder` L~589-595 region, `createInvoiceFromOrderWithTenant`,
  `createPartialFromOrder` L~2203-2225), ALSO apply the customer's deposit default:
  when the invoice being created has no explicit `depositPercent` AND the customer's
  `defaultDepositPercent` is a number > 0, set `depositPercent = customer default` and
  `depositDueDate = issueDate` (the "50% upfront" semantics — deposit due immediately,
  remainder rides the terms-label dueDate). Read the customer row in the SAME query that
  already fetches `defaultPaymentTerms` (extend the select — do not add a query). Manual
  `CreateInvoiceDto` deposits keep winning (explicit ≠ overwritten). `computeDepositFields`
  untouched. Specs: (a) customer with default 50 + "Net 60" → generated invoice carries
  depositPercent 50, depositDueDate = issueDate, paymentTermsLabel "Net 60", dueDate +60d;
  (b) customer WITHOUT default → generated-invoice create data has NO depositPercent key
  (deep-equal guard on the create payload — byte-identical to today); (c) explicit dto
  deposit wins over customer default.

### WP3 — API: invoice due-window filter

- **files:** `apps/api/src/invoices/dto/list-invoices.dto.ts`, `apps/api/src/invoices/invoices.service.ts` (findAll where-builder only), `apps/api/src/invoices/invoices.service.spec.ts`
- **effort:** low
- **brief:** `ListInvoicesDto` += `@IsOptional() @IsDateString() dueFrom?: string;` and
  `dueTo?: string;`. In findAll's flat filter section: when present,
  `where.dueDate = { ...(dueFrom && {gte: new Date(dueFrom)}), ...(dueTo && {lte: new Date(dueTo)}) }`
  combined with the existing unpaid-ish semantics ONLY via composition by the caller (do NOT
  hardcode status filtering into the due window — the client sends status filters it wants).
  Spec: passthrough + omitted-leaves-where-untouched.

### WP4 — Web: addresses full CRUD + honest edit modal + agent quick-create

- **files:** `apps/web/app/(dashboard)/customers/[id]/page.tsx`,
  `apps/web/app/(dashboard)/customers/_components/CustomerFormModal.tsx`,
  `apps/web/lib/api/customers.ts`
- **brief:**
  1. `lib/api/customers.ts`: add `useDeleteCustomerAddress()`
     (`DELETE /customers/:id/addresses/:addrId`, invalidate customer detail) beside the
     existing hooks; extend the update hook's input with `addressType?`.
  2. Addresses tab: generalize `AddAddressModal` → `AddressFormModal` with
     `mode: "add" | "edit"` + `initialAddress?` (prefill EVERY field incl. state + label +
     addressType + isDefault). Each address card gains three controls (icon buttons, ≥
     tap-friendly, matching the page's card idiom): **Edit** (opens the modal in edit mode →
     `useUpdateCustomerAddress`), **Delete** (inline two-tap confirm like the orders bulkbar
     idiom; surface the server's 409 reason via toast), **Set primary** (only on non-default
     cards; `useUpdateCustomerAddress({isDefault:true})`; the current primary keeps the
     Star+"Primary" pill). Design directives: no silent failures (every mutation toasts on
     error), destructive delete needs the inline confirm, "Primary" stays visually distinct.
  3. `CustomerFormModal` edit mode: REMOVE the address section entirely (mobile's documented
     pattern) and render in its place a quiet info row: "Addresses are managed on the
     customer's Addresses tab." with a link that closes the modal and switches to the tab
     (the detail page already controls the modal — pass a callback or use the existing tab
     state setter). This kills the silent-discard trap AND the second-address confusion in
     one honest move. Add mode is unchanged (single primary address at creation).
  4. Agent quick-create: in `CustomerFormModal` add mode, next to the agent `<Select>`
     (L457-475), a ghost "+ New agent" button (visible when `hasSalesAgents`) that opens the
     EXISTING `AgentFormModal` (import from
     `../../sales-agents/_components/AgentFormModal`); `onCreated: (id) => { invalidate the
sales-agents list query; setSalesAgentId(id); }`. No restructuring of either modal.
  5. Customer detail "Default Payment Terms" card (L1025-1054): add beneath the select a
     "Deposit" row: numeric input (0–100, step 1, suffix %) bound to
     `defaultDepositPercent` via the existing customer PATCH, with helper copy exactly:
     "Deposit due on invoice date; the remainder follows the terms above. Applies to new
     invoices automatically." Empty input clears (null). Show nothing extra when unset.
- Gate NOTHING behind addons here — customers surfaces are core.

### WP5 — Web: due-soon chips + clickable KPIs; dead Reopen removal; shipment gating

- **files:** `apps/web/app/(dashboard)/invoices/page.tsx`, `apps/web/lib/api/invoices.ts`,
  `apps/web/app/(dashboard)/orders/[id]/page.tsx`, `apps/web/app/(dashboard)/invoices/[id]/page.tsx`
- **brief:**
  1. `lib/api/invoices.ts`: `useInvoices` params += `dueFrom?: string; dueTo?: string;`.
  2. Invoices page: add a second chip row (beside the status chips, same chip idiom):
     **Due today · Due tomorrow · Next 7 days** — each sets `dueFrom/dueTo` (local dates,
     YYYY-MM-DD; tomorrow = [tomorrow, tomorrow]) AND excludes终态 statuses by composing the
     existing status filter to unpaid ones (send the page's existing "unpaid" statuses the
     same way its Overdue chip does — reuse that mechanism; do not invent a new one). Chips
     are URL-backed like every other filter on the page (`useUrlFilters` touchpoints — wire
     ALL of them: seed, query call, reset-page dep, clear-all visibility, empty-state).
     Make the "DUE TODAY" KPI tile clickable → applies the Due-today chip (cursor-pointer +
     aria-label); leave other tiles as-is.
  3. Orders detail: delete the DELIVERED-branch "Reopen Order" button (L2401-2405) and its
     demote-to-CONFIRMED wiring FOR THE DELIVERED CASE ONLY (OUT_FOR_DELIVERY's
     "Return to Confirmed" demotion stays — the map allows it). In its place render muted
     helper text: "Delivered orders can't be reopened. Adjust items with Edit Items (the
     invoice re-syncs), or reopen the delivery stop from its route run." Mirror mobile's
     BUG-ORD-01 rationale in a code comment.
  4. Shipment gating: web orders detail — render `ShipmentCard` block (L3166 region) only
     when `order.fulfillPath === "SHIP" || order.shippingCarrier || order.shippingTrackingNumber`.
     Web invoice detail (L2569) — only when `invoice.shippingCarrier ||
invoice.shippingTrackingNumber || (invoice as any).order?.fulfillPath === "SHIP"` if the
     payload carries order; verify what the invoice payload has and gate on what EXISTS —
     do not widen API payloads in this package.

### WP6 — Mobile: addresses edit/delete + shipment gating (+ verify reopen clean)

- **files:** `apps/mobile/app/(operator)/customers/[id]/addresses.tsx`,
  `apps/mobile/lib/api/customers.ts`, `apps/mobile/app/(operator)/(tabs)/orders/[id].tsx`,
  `apps/mobile/app/(operator)/(tabs)/invoices/[id].tsx`
- **brief:** Mirror web: addresses screen gains per-card Edit (reuse its add-form prefilled;
  include addressType + label + isDefault) and Delete (confirm via `lib/confirm`; 409 reason
  toasted) alongside the existing Set default; `lib/api/customers.ts` gains the delete hook +
  addressType on update. Shipment gating identical semantics to WP5.4 on both screens
  (`order.fulfillPath === "SHIP" || tracking present`; invoice = tracking present). Verify
  `order-actions.ts` DELIVERED case offers no reopen (it doesn't — BUG-ORD-01) and leave it.
  44pt touch targets, pressed feedback, no silent failures (design directives).
- **dependsOn:** none (server contracts defined in WP1; mobile can code against them)

### WP7 — Code map + CHANGELOG

- **files:** `.claude/code-map/api.md`, `.claude/code-map/web.md`, `.claude/code-map/mobile.md`,
  `.claude/code-map/CHANGELOG.md`, `.claude/code-map/_meta.json`
- **effort:** low
- **dependsOn:** WP1, WP2, WP3, WP4, WP5, WP6
- **brief:** Surgical entries: address CRUD endpoints (+409 rule, default-promotion), deposit
  default resolution in the invoice-generation paths, dueFrom/dueTo, the CustomerFormModal
  honesty change, BUG-ORD-01 now fixed on web too, shipment gating. ALSO add the missing
  PR #422 payment-terms entries the map predates (the recon flagged the gap). One dated
  CHANGELOG bullet on top; REPLACE `_meta.json` notes; bump generatedAt.

## Acceptance criteria

1. An address can be edited (all fields incl. type/label), deleted (with inline confirm;
   blocked with a clear 409 message when a route stop references it; deleting the primary
   promotes the oldest remaining), and any address can be made primary — web AND mobile.
2. The Edit Customer modal no longer renders address inputs in edit mode (no silent discard);
   it links to the Addresses tab. Add mode unchanged.
3. "+ New agent" inside the add-customer modal creates an agent via the existing
   AgentFormModal and selects it, without leaving the form.
4. A customer with `defaultDepositPercent: 50` + terms "Net 60": every invoice GENERATED for
   them (order flows) carries depositPercent 50, depositDueDate = issue date, dueDate +60d.
   Customers without the default produce byte-identical invoice create payloads to today
   (spec-pinned). Explicit per-invoice deposits still win.
5. Invoices page has Due today / Due tomorrow / Next 7 days chips (URL-backed) and a
   clickable DUE TODAY tile; server filters by dueDate window.
6. DELIVERED orders show no Reopen affordance on web (helper text instead);
   OUT_FOR_DELIVERY demotion untouched; the transition map untouched.
7. Shipment card/section appears ONLY on SHIP-fulfillment orders or rows with existing
   tracking data — web+mobile, orders+invoices. `/shipments` list unchanged.
8. `npm run verify` green.

## Verification commands

- perRound: `npx tsc -p apps/api/tsconfig.build.json --noEmit`
- final: `npm run verify`

## Risks & rollback

- WP2 touches invoice-generation paths — the byte-identical no-default spec is the tripwire;
  reviewers must verify the customer fetch was extended, not duplicated, and that
  `computeDepositFields`/`recomputeStatus` are untouched.
- Address delete vs route references: the 409 guard must check BOTH RouteStop and
  RouteRunStop; reviewer verifies tenant scoping on both lookups.
- Due chips must compose with existing status filtering via the page's existing mechanism —
  reviewer checks the Overdue chip pattern was reused, not re-invented.
- Rollback: single squash revert; migration is one nullable column (additive).
