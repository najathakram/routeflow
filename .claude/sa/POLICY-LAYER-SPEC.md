# Per-tenant POLICY layer — phases 1–2 (SA-138, 2026-09-24)

Senior Architect spec (Fable). Grounded at origin/master 9e7e1721. Owner answers folded in: Q1
`invoicing.priceDisclosure` = buyer portal + invoice PDFs + invoice emails, default shows everything,
driver app out of scope; Q2 = a 30 s cache is fine for money policies provided a failed read falls back
to today's behaviour (for credit, the current hard block). Owner constraint: every default reproduces
today's behaviour exactly — nothing changes on deploy day.

## 0. Verified facts the design rests on

- `SystemConfig` (platform.prisma :362-372): free text, no cache, no history, no scope. It is NOT
  migrated in phases 1–2; it keeps its current keys. A later phase moves keys into the registry one at
  a time (registry entry + backfill from SystemConfig), never a bulk move.
- Cache precedent: `EntitlementsService` (entitlements.service.ts) — per-process `Map`, 30 s TTL,
  `invalidate(tenantId)` on write, its own comment (:56-62) calls the TTL the cross-replica convergence
  window; `FeatureOverrideService` copies the shape (:68-99). Both are copied verbatim here.
- Credit: `credit-limit-guard.ts` is the only enforcement point — `isCreditLimitCheckEnabled` fails OPEN
  toward running the check (:36-41), is hoisted BEFORE the interactive tx (orders.service.ts :5067,
  "pool-starvation guard"), and `assertWithinCreditLimit` hard-blocks at `customer.creditLimit` using
  `credit-exposure.ts`. There is no approval concept anywhere.
- B18's "dead DRAFT→Issue credit-note flow" no longer exists to repurpose: `CreditNoteStatus` is
  ISSUED | APPLIED | VOID (finance.prisma :73-77) and credit-notes.controller.ts has no issue route. The
  memory's link is stale; the credit pilot is specified on its own.
- The at-door edit is the driver's change request resolved at the stop (orders.service.ts ~:5040-5067
  pre-tx hoist: restriction plan, tax rate, promos, `isCreditLimitCheckEnabled`; tx from :5069;
  MERGED_AT_STOP claim ~:5140; the ADD_ITEM merge `newQty = existing.qty + addQty` at :5318-5346). No
  amend/replace/disabled path exists; replace and disabled are new paths.
- `invoicing.priceDisclosure` has no code anchor; its surfaces are: buyer portal (web
  `app/buyer/portal/[seller]/{shop,cart,orders,invoices}`, mobile `(customer)/catalog`,
  `(customer)/invoices/[id]`), invoice PDF (`invoice-pdf-item.ts` :46-55 originalPrice strikethrough +
  msrp), invoice emails (email.service.ts :1034-1041, :1524-1540). Data: `Product.msrp`,
  `CustomerPrice.msrp` (per-customer override), `OrderItem/InvoiceItem.originalPrice` (PROMO / MANUAL).
- Mobile already reads `TenantFeaturesResponse.modes` (packages/types/api/features.ts :94; served as
  `modes: {}` at tenants.controller.ts :89) with a fail-open "unknown → today's behaviour" fallback
  (feature-modes.ts :29-39). That record is the client-side carrier for tenant-scope policy values.
- Registry precedent: `feature-registry.ts` + `addon-gate-registry.spec.ts` (P1a every call-site key has
  a row; P1b every row has a live call site; P1c/d date and state pins).
- Sequencing memory ("after bug-campaign Wave A"): no "Wave A" record exists in `.claude/campaign/`
  today, but the reason it protected against is current — orders.service.ts is under B776 (#1310),
  B785, B709 work. Phase 1 and the priceDisclosure pilot touch none of that; the two orders.service.ts
  pilots land after #1310 and B785 merge.

## 1. The one rule: policy ≠ entitlement

An ENTITLEMENT is the platform saying what a tenant MAY USE (billing); a POLICY is the tenant saying
how ITS OWN operation runs. Consequences, pinned by spec:

- A policy is written by the tenant (TENANT_ADMIN) about itself; the platform never sets one except
  under impersonation, which the audit row stamps (`impersonatedBy`). Nothing on the platform side can
  make a policy unreachable to the tenant — that is what "no kill switch" means. `disabled` on
  `orders.driverAtDoorEdit` is the tenant choosing office-only edits, and the tenant can flip it back.
- A policy value is never read by a guard: `PolicyService` is not imported by any `*.guard.ts`, no key
  starts with `flag.` or matches a `FEATURE_REGISTRY` key, and no registry entry has a boolean whose
  false value removes a capability (an enum with `disabled` names a BEHAVIOUR of a capability the
  tenant has; it never decides whether the tenant has it). Spec: `policy-registry.spec.ts` P2a-P2c.

## 2. Failure rule (one, not per key)

A failed or invalid policy read resolves to the registry DEFAULT, and every default IS today's
behaviour. So there is no fail-open/fail-closed choice to write down per key: a DB error, a cache miss
under error, or a stored value that no longer validates against the registry schema all yield the
default, with `logger.error` (the `isCreditLimitCheckEnabled` :36-41 shape). For
`credit.approvalThreshold` the default is `null` = the current hard block (Q2). Registry entries carry
no `failMode` field — a spec pins that the type has none.

Staleness: 30 s, accepted (Q2). Two design rules keep a stale read from ever REINTERPRETING an existing
row: (a) a policy is read when a decision is MADE and the decision is stamped on the row it governs
(the ChangeRequest's mode, the Order's approval band), never re-read later to re-decide; (b) reads happen
before the interactive transaction (the hoist block), never inside it.

## 3. Phase 1 — registry, storage, resolver, endpoints, audit

### 3.1 Registry (`apps/api/src/policy/policy-registry.ts`, sibling of `plan-catalog.constants.ts`)

```ts
export type PolicyScopeType = "TENANT" | "CATEGORY" | "CUSTOMER";
export interface PolicyEntry<T> {
  key: string;                      // "<area>.<name>"
  area: "orders" | "credit" | "invoicing";
  kind: "enum" | "money" | "set";
  schema: ZodType<T>;               // validates stored JSON at read AND write
  default: T;                       // today's behaviour, always
  scopes: readonly PolicyScopeType[]; // which scope layers may hold a value
  description: string;              // rendered by the admin UI
  added: string;                    // YYYY-MM-DD
  pilotPending?: true;              // phase 1 only; phase 2 removes it (shrink-only)
}
export const POLICY_REGISTRY = [ ... ] as const;
```

`policy-registry.spec.ts`: P1a every `policy.get("<key>"` / `policy.resolve("<key>"` literal in
apps/api/src is a registry key; P1b every key without `pilotPending` has ≥ 1 call site; P1c each
default validates against its schema; P1d keys unique, `<area>.<name>` shape; P2a-P2c the §1 pins;
P3 `pilotPending` set is shrink-only (an allow-list of the three, removed as each pilot lands).

### 3.2 Storage — `PolicyValue` in platform.prisma beside `SystemConfig`; `MODEL_DOMAIN` gets

`PolicyValue: "platform"`.

```prisma
enum PolicyScopeType { TENANT CATEGORY CUSTOMER }
model PolicyValue {
  id             String          @id @default(uuid())
  tenantId       String
  tenant         Tenant          @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  key            String
  scopeType      PolicyScopeType
  scopeId        String?         // null for TENANT; TrackedCategory/Customer id otherwise (no FK: soft pointer, indexed)
  value          Json
  reason         String          // required, like TenantFeatureOverride.reason
  setById        String?
  setByName      String?
  createdAt      DateTime        @default(now())
  supersededAt   DateTime?
  supersededById String?
  @@index([tenantId, key, scopeType, scopeId, supersededAt])
  @@index([tenantId])
}
```

`tenantId` is NOT NULL (the null-tenant-rows lesson). Append-only: a write supersedes the active row
(`supersededAt`, `supersededById`) and inserts the new one in ONE `tenantTransaction` under
`withAdvisoryLock` (family `policy-write`, key `${tenantId}:${key}`, mode wait — a new family for a new
table, never nested inside another). Prisma cannot express a partial unique index, so single-active-row
is guaranteed by that lock, and the resolver picks the newest `createdAt` among active rows as a
defensive tie-break. Nothing is ever updated except `supersededAt/By`; nothing is deleted. Migration:
additive; `lint:migrations` clean; `local:drift` exit 0; applied to prod BEFORE merge (L-184).

### 3.3 Resolver — `PolicyService` (`apps/api/src/policy/policy.service.ts`)

- `resolve<K>(tenantId, key, scope?: { categoryId?: string; customerId?: string }): Promise<T>`:
  loads ALL active rows for the tenant once (`where: { tenantId, supersededAt: null }`) into the 30 s
  per-tenant cache (the EntitlementsService shape, size-pruned at 1000), then layers
  default → TENANT → CATEGORY(scope.categoryId) → CUSTOMER(scope.customerId); each layer's value is
  validated against the registry schema and an invalid one is skipped with `logger.error` (§2). Any
  thrown error → default + `logger.error`. Never throws to a caller.
- `set(tenantId, key, scopeType, scopeId, value, reason, actor)` / `clear(...)`: validate against the
  registry (400 on schema or on a scope the entry does not allow), the §3.2 write, `invalidate(tenantId)`,
  and ONE `AuditLog` row per write — action `policy.set` | `policy.clear`, entityType `PolicyValue`,
  entityId = the new row id, meta `{ key, scopeType, scopeId, old, new, reason }`, `impersonatedBy`
  through the existing stamp. Risk (4) is answered: always.
- `effectiveForClient(tenantId)`: the TENANT-scope effective value of every registry key, for
  `TenantFeaturesResponse.modes` (§3.5). Category/customer values never leave the server as a map; they
  are resolved per request in the payloads that need them.

### 3.4 Endpoints (`PolicyController`, `/policies`, addon-free — a policy is not a feature)

- `GET /policies` — OPERATOR+: the registry (key, kind, schema as JSON-schema, default, scopes,
  description) plus the active rows per scope, the shape the admin UI renders from.
- `PUT /policies/:key` — TENANT_ADMIN: `{ scopeType, scopeId?, value, reason }`; 400 on schema/scope.
- `DELETE /policies/:key?scopeType=&scopeId=` — TENANT_ADMIN: clear with `reason` in the body.
- `GET /policies/:key/history` — TENANT_ADMIN: superseded rows, newest first, with `setByName`.
  `dto` classes with the whitelist; `value` validated by the registry schema, not by class-validator.

### 3.5 Client carrier

`GET /tenants/me/features` `modes` (tenants.controller.ts :89, today `{}`) gains one entry per registry
key with a TENANT scope: `modes["orders.driverAtDoorEdit"] = "amend"`, etc. Mobile and web read the
tenant-scope value through their existing feature-modes fallback (unknown → today). This is
deliberately the same record mobile already fails open on: an old build or a missing key resolves to
today's behaviour, which is also the default. Customer-scoped values ride the buyer's own payloads.

### 3.6 Phase 1 proof

- Real-Postgres spec: default when no rows; tenant row wins over default; category over tenant;
  customer over category; a superseded row is ignored; two concurrent `set`s on one key serialise on
  the lock and leave exactly one active row; an invalid stored JSON is skipped and the next layer wins;
  a DB error (mocked at the client boundary) resolves the default; `invalidate` makes the next read see
  a fresh write; the audit row exists with the meta shape; another tenant's rows are invisible under
  `forTenant()`.
- `policy-registry.spec.ts` as §3.1; compose boot gate; the migration gates.
- No behaviour change: no production call site reads a policy in phase 1 (P1b waived only by
  `pilotPending`), so the proof is the registry spec plus the full existing suite unchanged.

## 4. Phase 2 — the three pilots

Shared rules for every pilot: the read is hoisted before the tx; the decision is stamped on the row it
governs; the default path is the EXISTING code path untouched (a `switch` whose default arm is today's
statements, not a rewrite); every existing spec on the touched path passes with NO expectation edits
(the SA reads the spec diff: additions only); a real-Postgres spec per pilot with the default case
proving byte-identical rows to a fixture captured before the change.

### 4.1 `orders.driverAtDoorEdit` — enum `amend | replace | disabled`, default `amend`; scopes TENANT, CUSTOMER

- Semantics. `amend` = today: a driver's at-door change request is merged as a DELTA into the held
  line (`existing.qty + addQty`, :5318-5346) or appended. `replace` = the driver states the ABSOLUTE
  quantity actually taken: the request carries `requestedQty`, the merge sets `qty = requestedQty` and
  the mutation row's signed qty is `requestedQty − held`; a line the driver omits is untouched.
  `disabled` = the DRIVER principal cannot create an at-door change request: 409
  `AT_DOOR_EDIT_DISABLED` at the create endpoint; office (OPERATOR) change requests and the stop's
  delivery quantities are unaffected — short-pick / delivered quantities are delivery EVIDENCE
  (SA-109/116/133), not edits, and are explicitly outside this policy.
- Stamp: `ChangeRequest.atDoorEditMode String?` (nullable; null = amend, today's rows) written at
  creation from the resolved value (customer scope = the order's customer); the at-stop resolution
  reads the STAMP, never the live policy, so a flip mid-flight cannot reinterpret a pending request.
  Migration inside this PR, prod first.
- Clients: driver screens read `modes["orders.driverAtDoorEdit"]`; `disabled` hides the add/adjust
  controls (the server still refuses); `replace` changes the adjust sheet's label to "quantity taken" and
  sends `requestedQty`; unknown → `amend`. Web office: the mode shown read-only on the change-request
  review, editable in the policy admin page (PR-B).
- Proof (real Postgres): no policy → the existing at-stop ADD_ITEM fixture produces byte-identical
  rows; `replace` with held 2, requested 5 → qty 5, mutation +3; `replace` requested 0 → refused (a
  removal is a CANCEL request, not a replace); `disabled` → 409 at create for DRIVER, 201 for OPERATOR;
  a request stamped `amend` resolves as amend after the tenant flips to `disabled`; customer scope
  overrides tenant scope.

### 4.2 `credit.approvalThreshold` — money | null, default null; scopes TENANT, CUSTOMER

- Semantics. `null` = today: `assertWithinCreditLimit` hard-blocks when projected exposure > limit.
  With a threshold T ≥ 0: exposure ≤ limit → pass, unchanged; limit < exposure ≤ limit + T → the write
  is ACCEPTED and stamped as awaiting credit approval; exposure > limit + T → the same hard block as
  today. The band applies to order create and edit (the guard's `order`/`edit` actions); the
  `delivery` action (at-door) is never widened — a delivery inside the band is still the hard block,
  because nobody in the office is there to approve it.
- Stamp and gate: `Order.creditApprovalPendingAt DateTime?`, `creditApprovedAt DateTime?`,
  `creditApprovedById String?` (nullable, no backfill). While `creditApprovalPendingAt != null &&
creditApprovedAt == null`: the order is not routable — every path that attaches an order to a run
  or stop (the `NON_ROUTABLE_ORDER_STATUSES` checks) refuses with 409 `CREDIT_APPROVAL_PENDING`; it is
  not invoiceable via the delivered reconcile (never reached, since not routable); it lists with a
  badge. `POST /orders/:id/approve-credit { reason }` (OPERATOR with the existing manager role, or
  TENANT_ADMIN) sets the approved stamps + audit `order.credit_approved`; `POST /orders/:id/reject-credit`
  cancels through the existing cancel path with the reason. The band decision is made ONCE at the write
  and stamped; a later edit re-evaluates (an edit is a new decision) and may clear or set the pending
  stamp — never silently approve.
- No status enum value is added (enum parity, status maps, mobile mirrors): the stamp columns carry
  the state. Notification: the existing office notification event for a new order carries a
  `creditApprovalPending` var; no new channel.
- Failure: a policy read failure → T = null → the hard block (Q2). `isCreditLimitCheckEnabled` (the
  ENTITLEMENT flag) is unchanged and still fails open toward running the check.
- Proof (real Postgres): T null → the existing credit-limit specs unchanged and the 409 payload
  byte-identical; limit 1000, T 500: exposure 1200 → order created with the pending stamp, attach-to-run
  → 409, approve → attachable; exposure 1600 → the hard block; delivery action at 1200 → the hard block;
  customer-scope T overrides tenant T; an edit that brings exposure back under the limit clears the
  pending stamp.

### 4.3 `invoicing.priceDisclosure` — set ⊆ { originalPrice, discount, msrp }, default all three; scopes TENANT, CUSTOMER

- Semantics (Q1): which of the three price facts a BUYER sees on the buyer portal, invoice PDFs and
  invoice emails. Default = all three = today. Driver app out of scope. Money math is untouched — this
  is display only; `unitPrice`, `subtotal`, `total` always show.
- Enforcement at the SOURCE, never in the client: the buyer-portal API payloads (the buyer's own
  scope = its customer id), `invoice-pdf-item.ts`'s item model and `email.service.ts`'s item model each
  receive the resolved set and NULL the hidden fields before rendering/serialising, so a client cannot
  show what it does not receive. Web buyer portal and mobile `(customer)` screens need no logic beyond
  their existing null handling (a null `originalPrice` already renders no strikethrough; a null msrp
  renders blank per catalog.prisma :58).
- `discount` hidden = the line/document discount lines are omitted from the buyer's view and the
  buyer sees the net figures only; totals unchanged.
- Proof: with the default, the buyer-portal payload, the PDF item model and the email item model are
  deep-equal to today's for a fixture with PROMO and MANUAL-upsell lines (equality against a captured
  fixture, no snapshot files); each hidden element nulls its field on all three surfaces; customer scope
  overrides tenant scope; the operator-facing invoice PDF (office download) is NOT affected — pin it.
  Playwright captures 1440/768/390 of the buyer portal for default and for msrp-hidden (the memory rule).

## 5. PR split, order, tiers

| PR  | Content                                                                                                                                                                                                    | Depends on                      | Tier                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------- |
| A   | Phase 1 api: `PolicyValue` + enum + migration (prod first), `MODEL_DOMAIN`, registry (3 keys `pilotPending`), `PolicyService`, endpoints + DTOs, `modes` carrier, audit, registry spec, real-Postgres spec | —                               | HIGH (SA tier-1)                    |
| B   | Phase 1 web: tenant-admin policy page generated from `GET /policies` (kind → control), history drawer; Playwright 1440/768/390                                                                             | A                               | medium (SA reads the form contract) |
| C   | Pilot 1 driverAtDoorEdit: api (`ChangeRequest.atDoorEditMode` migration, create/resolve paths), mobile driver, web office badge                                                                            | A, and after #1310 + B785 merge | HIGH                                |
| D   | Pilot 2 credit.approvalThreshold: api (Order stamps migration, guard band, approve/reject, routability), web office approve UI, mobile operator approve                                                    | A, after C (same file)          | HIGH                                |
| E   | Pilot 3 priceDisclosure: api surfaces (portal payloads, PDF item, email item), web buyer portal captures, mobile customer captures                                                                         | A                               | HIGH                                |

A → (B ‖ E) → C → D. E and B touch nothing the orders lanes touch, so they run in parallel with A's
landing. Every PR: compose boot gate, `local:validate`, the pilot's DB spec, the "additions-only spec
diff" pin, tier-1 SA read at the sha, two independent PASSes for C/D/E (money paths). Deploy-day
proof for the whole series: `post-deploy-check` unchanged, and `GET /policies` on the `test` tenant shows
three keys with zero rows.

Out of scope for phases 1–2 (recorded, not built): migrating SystemConfig keys; CATEGORY scope on any
pilot (the resolver supports it; no pilot uses it yet — the registry `scopes` field keeps it closed);
driver-app price hiding; a platform-admin view across tenants (read-only, later).
