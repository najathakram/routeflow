# Plan: Sales agents & commissions — the UI (PR-D)

> ## ⚠️ WORKTREE — read before anything else
>
> ALL work happens in the git worktree
> `C:\ClaudeCode\routeflow\.claude\worktrees\ap-agents-ui` (branch
> `feat/sales-agents-ui`, already checked out at master `9d9d2717`). Your process may start
> in `C:\ClaudeCode\routeflow` (the main checkout) — you must NOT touch files there. `cd`
> into the worktree before ANY command (git, npm, npx) and use ABSOLUTE paths under the
> worktree for every file read/edit. Every relative path in this plan is relative to the
> worktree root. "Repo root" below means the WORKTREE root. Do not commit, stage, or push —
> the orchestrator handles git. **There is NO migration in this PR and no database work of
> any kind.**

> Authored by Fable 5 on 2026-08-23. Status: IMPLEMENTED (pipeline wf_0205e599-ff7 clean: 1 fix round, 0 remaining; final gate green).
> This file is the ONLY context the implementation and review agents receive.
> It must stand alone: no references to "the conversation", no "as discussed".
>
> Grounded in a code recon (2026-08-23) against **master @ `9d9d2717`** — the engine
> (PR-C, #421) plus its spec follow-up (#425), payment-terms (#422), and address/maps
> (#423) are all merged. Every line anchor below is from that state. If master gains
> commits before implementation starts, re-find anchors by the quoted symbol names, not
> line numbers.

## Objective

PR-C shipped the sales-agents ENGINE dark: records, effective-dated rates, attribution,
an idempotent commission ledger, statements → approval → payouts — all behind
`flag.sales_agents`, which **no plan grants** (addon `SALES_AGENTS` only, toggled per
tenant from platform-admin, entry already present at
`apps/web/app/(platform-admin)/admin/tenants/[id]/page.tsx:140`). PR-D builds the UI the
engine plan explicitly deferred:

- **(a)** Agents management pages (`/sales-agents`, `/sales-agents/[id]`): list / create /
  edit / status / deactivate, rates with effective dates, assignments, the accrual ledger.
- **(b)** The **"agent box"** on the customer detail page (the client's ask: assign /
  reassign the agent, show current attribution) + agent select on customer create.
- **(c)** Commission statements pages (`/finance/commissions`, `/finance/commissions/[id]`):
  generate with a period picker, review lines, approve, record payout, void — including
  the **409 "stale — regenerate" contract** with a one-click regenerate.
- **(d)** Order-level `commissionRatePct` override input (CreateOrderModal + order detail),
  staff-gated exactly like the API.
- **(e)** Everything hidden unless the tenant has the addon — house UI-gating pattern
  (`useHasAddon`, developer_mode/MSRP precedent), with the server's `PlanFlagGuard` 403s
  as the real enforcement.
- Minimal **mobile read-parity**: one read-only "Sales agent" row on the operator customer
  detail screen (the mobile-mirrors-web rule, satisfied cheaply).

**NO schema change, NO migration.** The engine schema is complete for every surface above
— verified. If an implementer believes a schema gap exists, STOP and flag it in the PR
notes; do not plan or write a migration.

**ONE deliberate API addition** (flagged prominently, see WP1): a read endpoint for "which
agent currently holds customer X". `customers.service.findOne`
(`apps/api/src/customers/customers.service.ts:363-382`) does not include
`agentAssignments`, and no existing route answers the question — the customer-page agent
box and the mobile row cannot render current attribution without it. It is read-only,
lives inside the already-gated `SalesAgentsController`, and gets spec coverage. **No other
API change is permitted in this PR** — any other temptation (report endpoints, statement
PDF, a `code` field on the 409 bodies) is out of scope.

## Constraints & conventions

- npm + Turbo monorepo. Web = Next.js 14 App Router, Radix + Tailwind, TanStack Query,
  components from `@routeflow/ui/web` (`PageHeader, Card, Button, Modal, Badge, cn`).
  Prettier: semicolons, double quotes, printWidth 100, trailing commas.
- **Money display discipline (load-bearing):** the UI renders **STORED amounts only** —
  `accruedAmount`, `payableAmount`, `claimedAmount`, `totalAmount`, `paidAmount`, line
  `amount`, and the API-computed `drift` / `adjustmentsTotal`
  (`apps/api/src/sales-agents/sales-agents.service.ts:389-397`). **Never recompute
  commission client-side** — no `base × rate / 100` anywhere in web or mobile. Prisma
  `Decimal` serializes as a JSON string: wrap every money/rate read in `Number(...)`
  (house precedent `Number(order.total)`, orders/[id]/page.tsx:1586) and format with
  `fmt()` from `apps/web/lib/formatting.ts:7`. The ONLY client arithmetic allowed is the
  display-time `total − paid` remaining in the payout modal, which the server re-derives
  and caps in-tx anyway (`commission-statements.service.ts:345-356`). Rates: render with a
  tiny `pctLabel(v) = ` + "`${Number(v)}%`" + `helper; input via`DecimalInput`
(`apps/web/components/MoneyInput.tsx:62`, `decimals={2} min={0} max={100}`). Calendar
dates (`basisDate`, `periodFrom/To`, `effectiveFrom`) → `fmtCalendarDate`
(formatting.ts:55); real timestamps (`createdAt`, `approvedAt`, `paidAt`) → `fmtDate`
  (formatting.ts:30) — the UTC-midnight rule.
- **Gating rule (e):** UI-only hide via `useHasAddon(SALES_AGENTS_ADDON)` (constant
  `"sales_agents"` — the legacy addon key the admin toggle upserts, mapped to the
  `SALES_AGENTS` SKU by `LEGACY_ADDON_KEY_TO_SKU`). Precedent: `MSRP_ADDON = "msrp"` at
  `apps/web/lib/api/addons.ts:27`; hook mechanics `useTenantAddons`/`useHasAddon` at
  `apps/web/lib/api/tobacco.ts:6-20`. The server independently 403s every route
  (`PlanFlagGuard` class-level on both controllers, sales-agents.controller.ts:122-125,
  commission-statements.controller.ts:52-55) — the client gate is UX only, never the
  source of truth. **Every new gated GET hook must take an `enabled` gate** so an
  unflagged tenant never fires it: a gated GET that 403s triggers the PLAN_GATE toast
  bridge (`apps/web/lib/api-client.ts:93` → `components/PlanGateNotice.tsx`) and would
  spam every page load. Hiding-only gates may use the bare boolean (developer_mode rule,
  `apps/web/lib/api/addons.ts` doc comment); the two full pages gate their locked state on
  `useTenantAddons().isLoading` to avoid a lock-flash.
- **No web Jest.** Web has Playwright e2e only (`apps/web/e2e/`). Web correctness rides on
  `check-types` + `lint` + the one read-only Playwright spec (WP9). API specs ONLY for
  WP1's endpoint. Mobile change is render-only — no new mobile Jest.
- Global mutation errors already toast `data.message`
  (`apps/web/app/providers.tsx:22-38`). The statements 409s carry good human messages and
  NO `code` field — do NOT add them to `HANDLED_CODES` and do NOT add a `code` server-side;
  the pages layer guided handling on top of the toast (WP6).
- **Do NOT touch:** `apps/api/src/sales-agents/commission-*.ts` engine/statements files,
  `invoices.service.ts`, `orders.service.ts`, `customers.service.ts` (WP1 touches ONLY
  `sales-agents.controller.ts` / `sales-agents.service.ts` / its spec), anything under
  `apps/api/prisma/`, `bookkeeping.service.ts`, buyer portal, `CommandPalette.tsx`
  (palette entries for the new pages are a follow-up, noted out of scope).
- Conventional Commits; branch `feat/sales-agents-ui`.

## Verified codebase facts (trust these, they were read)

**API surface (all live on master, all flag-gated + `@Roles(OPERATOR)` at class level):**

| Route                                                                                      | Anchor                                  | Notes for the UI                                                                                                                                                    |
| ------------------------------------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /sales-agents` (`status?`, `search?`, `includeDeleted?`)                              | controller:129, service `findAll`:55-78 | rows carry `openAssignmentCount` + `currentRatePct` (number\|null)                                                                                                  |
| `POST /sales-agents` `{name, email?, phone?, notes?, defaultRatePct?, rateEffectiveFrom?}` | controller:134, DTO:52-59               | creates agent + optional first rate                                                                                                                                 |
| `GET /sales-agents/:id`                                                                    | service `findOne`:103-127               | agent + full `rates[]` (desc) + open `assignments[]` (with `customer.businessName`) + `accrualTotals {accrued, payable, claimed}`                                   |
| `PATCH /sales-agents/:id`                                                                  | controller:152                          | contact fields only                                                                                                                                                 |
| `PATCH /sales-agents/:id/status` `{status, stopNewBusinessAt?}`                            | service `updateStatus`:139-158          | entering STOPPED_FOR_NEW defaults pivot to now; leaving clears it                                                                                                   |
| `DELETE /sales-agents/:id`                                                                 | service `remove`:160-189                | soft-delete; **409** with message when unconverged claims or non-PAID statement exist                                                                               |
| `POST /sales-agents/:id/rates` `{ratePct, effectiveFrom}`                                  | service `addRate`:191-213               | **backdated ⇒ response carries `recompute: {invoicesSynced}`**; 409 on duplicate effectiveFrom                                                                      |
| `DELETE /sales-agents/:id/rates/:rateId`                                                   | service `removeRate`:215-226            | future-dated rows only; 400 explains "insert a correcting row"                                                                                                      |
| `POST /sales-agents/:id/customer-rates` `{customerId, ratePct, effectiveFrom}`             | service:228-248                         | same backdate→recompute contract                                                                                                                                    |
| `POST /sales-agents/:id/assignments` `{customerId, effectiveFrom?}`                        | service:271-305                         | closes the open row + inserts; 400 if the date inverts the open interval (`assertClosesAfterStart`:258-269); backdate→recompute                                     |
| `POST /sales-agents/:id/assignments/bulk` `{customerIds[≤500], effectiveFrom?}`            | service:307-336                         | one tx, all-or-nothing                                                                                                                                              |
| `POST /sales-agents/assignments/close` `{customerId, effectiveTo?}`                        | controller:142-145, service:338-362     | two-segment route, no `:id` collision; backdate→recompute                                                                                                           |
| `GET /sales-agents/:id/accruals` (`status?`, `from?`, `to?`, `page?`, `limit?`)            | service `getAccruals`:364-399           | `{items, total, page, limit}`; each item has `invoice {invoiceNumber}`, `customer {businessName}`, `adjustmentsTotal`, `drift`                                      |
| `POST /sales-agents/:id/recompute` `{fromDate}`                                            | controller:201                          | returns `{invoicesSynced}`                                                                                                                                          |
| `GET /commission-statements` (`agentId?`, `status?`)                                       | statements service `findAll`:37-46      | rows carry `agent {id, name}`                                                                                                                                       |
| `POST /commission-statements/generate` `{agentId, periodFrom?, periodTo?}`                 | service `generate`:79-222               | **409** "Agent already has a PENDING statement (CST-…)" (:88-92); **400** "Nothing to generate" (:175-179)                                                          |
| `GET /commission-statements/:id`                                                           | service `findOne`:48-65                 | ONE query feeds the whole detail page: `lines[]` incl. `accrual.invoice.invoiceNumber`, `adjustment` (kind/reason), `carriedFrom.statementNumber`, plus `payouts[]` |
| `POST /commission-statements/:id/approve`                                                  | service `approve`:224-290               | **409 `"Statement is stale — regenerate"`** at :244/:253/:266; 409 "Only a PENDING…" otherwise                                                                      |
| `POST /commission-statements/:id/void`                                                     | service:292-327                         | PENDING only                                                                                                                                                        |
| `POST /commission-statements/:id/payouts` `{amount, method, reference?, notes?, paidAt?}`  | service `recordPayout`:329-403          | APPROVED only; 400 over cap with exact remaining in the message; books the `COMMISSIONS_AND_FEES` Expense server-side                                               |
| `GET /commission-statements/:id/payouts`                                                   | service:405-414                         | redundant with findOne's `payouts` — the detail page does NOT need it                                                                                               |

**Order override (all live):** `CreateOrderDto.commissionRatePct`
(`apps/api/src/orders/dto/create-order.dto.ts:84`) and `CreateSaleDto` (:61) — staff-gated
by `parseCommissionRatePct` (orders.service.ts:1422-1436: CUSTOMER/DRIVER → 403; `0`
valid = exempt; `null` clears). `PATCH /orders/:id/commission-rate`
(orders.controller.ts:306-315) body `{commissionRatePct: number | null}`. `GET /orders/:id`
uses `include` not `select` (orders.service.ts:324+), so the response already carries
`commissionRatePct` — no API change needed to read it.

**Web patterns to copy:**

- Addon constant + hook: `apps/web/lib/api/addons.ts` (MSRP_ADDON precedent, :27);
  `useHasAddon` / `useTenantAddons` in `apps/web/lib/api/tobacco.ts:6-20` (5-min
  staleTime, `retry: false`).
- Nav injection: `DashboardShell.navStructure` useMemo,
  `apps/web/app/(dashboard)/layout.tsx:873-905` — `hasTobacco` leaf splice at :896-898 is
  the exact template; Finance group children at :114-135; group-rewrite precedent (the
  `canActAsDriver` Dispatch splice) at :186-200.
- Locked page scaffolding: `LockedPage` in
  `apps/web/app/(dashboard)/_components/gates/PlanGates.tsx:14-51` takes a client-built
  `PlanGateBody` (`apps/web/lib/plan-gate.ts:14-20`).
- Card-with-inline-control: the "Default Pricing Tier" / "Default Payment Terms" cards,
  `apps/web/app/(dashboard)/customers/[id]/page.tsx:866-934`; `isOperator` derivation
  :779 (`user?.role === "OPERATOR" || user?.role === "TENANT_ADMIN"` via `useAuth`);
  `hasMsrpAddon = useHasAddon(MSRP_ADDON)` :783. Profile-tab right column cards:
  "Account Status" :2572, "Buyer Portal" :2620 — the agent box slots directly above
  "Account Status".
- Customer create modal: `apps/web/app/(dashboard)/customers/_components/CustomerFormModal.tsx`
  — `mode: "add" | "edit"` :82, create payload :240-269 (`useCreateCustomer` takes
  `Record<string, unknown>` — no type change needed, lib/api/customers.ts:100-107).
- Order create modal: `apps/web/app/(dashboard)/orders/_components/CreateOrderModal.tsx`
  — "Options" section :1771-1828 (orderDate input :1790-1805), submit payload :879-894,
  park/resume `draftPayload` :657-680 with hydrate at :782/:794 (`OrderDraftPayload` in
  `apps/web/lib/drafts.ts`). Order detail "Summary" `<dl>`:
  `apps/web/app/(dashboard)/orders/[id]/page.tsx:2868-2890`.
- Payment methods for the payout modal: `SELECTABLE_PAYMENT_METHODS` +
  `paymentMethodLabel` from `apps/web/lib/payment-methods.ts` — never a hand-rolled list.
- Page shell: `PageHeader` + `usePageTitle` (`apps/web/lib/page-title-context.ts`), as in
  `finance/statements/page.tsx:15-17`.

**Mobile patterns:** `useHasAddon`/`TOBACCO_ADDON` in `apps/mobile/lib/api/tobacco.ts:20/:25`;
hook style `apps/mobile/lib/api/customers.ts:246-253`; the operator customer screen's
`Row` component (`apps/mobile/app/(operator)/customers/[id].tsx:553`) with the
"Pricing tier" row at :252-259 as the insertion anchor.

**e2e:** helpers `apiBase` (`apps/web/e2e/helpers/api.ts:15-28`), `operatorAccessToken`
(:35-40), `TENANT_SLUG` (`helpers/constants.ts:14-17`). Specs run against a deployed URL;
the e2e tenant may or may not have the addon — the spec must branch on live addon state,
never assume it.

## Work packages

Waves: **WP1 ∥ WP2 ∥ WP8** → **WP3** → **WP4 ∥ WP5 ∥ WP6 ∥ WP7** → **WP9**.
File ownership is disjoint; WP2 pins the client API layer every page WP compiles against
— transplant its types/signatures, do not redesign.

### WP1 — API: current-assignment read endpoint (the ONE api change)

- **files:** `apps/api/src/sales-agents/sales-agents.controller.ts`,
  `apps/api/src/sales-agents/sales-agents.service.ts`,
  `apps/api/src/sales-agents/sales-agents.service.spec.ts`
- **dependsOn:** —
- **brief:** `GET /sales-agents/assignments/current?customerId=<uuid>` — who holds this
  customer now, plus the customer's currently-effective per-customer rate. Two-segment
  route: declare it next to `assignments/close` (controller:142-145 — same no-collision
  comment applies). It inherits the class-level `JwtAuthGuard, RolesGuard, PlanFlagGuard`
  - `@Roles(OPERATOR)` + `@RequirePlanFlag("flag.sales_agents")` — flag-off tenants 403
    with the PLAN_GATE body and CUSTOMER/DRIVER callers never reach it. Read-only, two
    indexed lookups. No other API file changes.
- **exact code — controller** (DTO inline beside the others, per the note at
  controller:40-44):

  ```ts
  export class CurrentAssignmentQueryDto {
    @IsUUID() customerId: string;
  }

  // …inside SalesAgentsController, directly under closeAssignment():
  @Get("assignments/current")
  currentAssignment(@Query() query: CurrentAssignmentQueryDto) {
    return this.salesAgentsService.currentAssignment(query.customerId);
  }
  ```

- **exact code — service** (append after `closeAssignment`):

  ```ts
  /**
   * Read side for the customer-page "agent box" and the mobile parity row:
   * the OPEN assignment (effectiveTo IS NULL — at most one, enforced by the
   * AgentAssignment_open_assignment_key partial unique index) plus the
   * customer's currently-effective per-customer rate. Display-only — the
   * engine resolves rates per-invoice on basisDate; this is "as of now".
   */
  async currentAssignment(customerId: string) {
    const assignment = await this.prisma.forTenant().agentAssignment.findFirst({
      where: { customerId, effectiveTo: null },
      include: { agent: { select: { id: true, name: true, status: true, deletedAt: true } } },
    });
    const rate = await this.prisma.forTenant().customerCommissionRate.findFirst({
      where: { customerId, effectiveFrom: { lte: new Date() } },
      orderBy: { effectiveFrom: "desc" },
      select: { ratePct: true, effectiveFrom: true },
    });
    return {
      assignment: assignment
        ? { id: assignment.id, effectiveFrom: assignment.effectiveFrom, agent: assignment.agent }
        : null,
      customerRatePct: rate ? Number(rate.ratePct) : null,
    };
  }
  ```

- **specs** (extend the existing `extendWithSalesAgentModels` harness,
  sales-agents.service.spec.ts:35+): (1) open row + rate → shaped payload with
  `Number`-coerced `customerRatePct`; (2) no open row → `{assignment: null, …}` and the
  rate query result still tolerated; (3) future-dated customer rate is NOT returned
  (assert the `findFirst` where carries `effectiveFrom: { lte: expect.any(Date) }`).

### WP2 — Web API layer + gating constants (pins every page WP)

- **files:** `apps/web/lib/api/addons.ts`, `apps/web/lib/api/sales-agents.ts` (new),
  `apps/web/lib/api/orders.ts`
- **dependsOn:** — (WP1 is a runtime dependency only; the response shape is pinned above)
- **brief:**
  1.  `addons.ts` — append after `MSRP_ADDON` (:27), same comment style:

      ```ts
      // ─── Sales agents & commissions (flag.sales_agents) ───────────────────────
      //
      // Read with `useHasAddon(SALES_AGENTS_ADDON)` (lib/api/tobacco.ts) to gate the
      // sales-agents / commissions surfaces. UX gate only — every /sales-agents and
      // /commission-statements route independently 403s via PlanFlagGuard.
      export const SALES_AGENTS_ADDON = "sales_agents";
      ```

  2.  `lib/api/sales-agents.ts` (new) — ALL types + hooks for both page families. Types
      (money/rate fields typed `number | string` — Prisma Decimal over JSON):
      `SalesAgent` (+ list extras `openAssignmentCount`, `currentRatePct`),
      `SalesAgentRate`, `AgentAssignmentOpen` (`{id, effectiveFrom, customer?: {id, businessName}}`),
      `SalesAgentDetail` (`SalesAgent & {rates, assignments, accrualTotals}`),
      `CommissionAccrualRow` (`{…, invoice: {id, invoiceNumber}, customer: {id, businessName},
adjustmentsTotal, drift, status, rateSource, basisDate}`),
      `CurrentAssignment` (`{assignment: {id, effectiveFrom, agent: {id, name, status, deletedAt}} | null,
customerRatePct: number | null}`),
      `CommissionStatement` (`{…, agent: {id, name}, totalAmount, paidAmount, status,
periodFrom, periodTo, approvedAt}`), `CommissionStatementDetail` (+ `lines[]`,
      `payouts[]`), `CommissionStatementLine`
      (`{kind: "CLAIM"|"ADJUSTMENT"|"CARRYFORWARD", amount, description, accrual?, adjustment?, carriedFrom?}`),
      `CommissionPayout`. Plus display maps:
      `RATE_SOURCE_LABELS = { ORDER_OVERRIDE: "Order override", CUSTOMER_RATE: "Customer rate", AGENT_DEFAULT: "Agent default", NONE: "No rate" }`
      and a `pctLabel(v: number | string)` helper returning `Number(v) + "%"`.
      **Every query hook takes an `opts?: { enabled?: boolean }` gate** — exact pattern:

                       ```ts
                       export function useSalesAgents(
                         params?: { status?: string; search?: string; includeDeleted?: boolean },
                         opts?: { enabled?: boolean },
                       ) {
                         return useQuery<SalesAgent[]>({
                           queryKey: ["sales-agents", params],
                           queryFn: () => apiClient.get("/sales-agents", { params }).then((r) => r.data),
                           // NEVER fire while the tenant lacks the addon — a gated GET 403s and the
                           // PLAN_GATE bridge (api-client.ts) would toast on every page load.
                           enabled: opts?.enabled !== false,
                         });
                       }

                       export function useCustomerCurrentAgent(customerId: string, opts?: { enabled?: boolean }) {
                         return useQuery<CurrentAssignment>({
                           queryKey: ["sales-agents", "current-assignment", customerId],
                           queryFn: () =>
                             apiClient
                               .get("/sales-agents/assignments/current", { params: { customerId } })
                               .then((r) => r.data),
                           enabled: !!customerId && opts?.enabled !== false,
                         });
                       }
                       ```

                       Remaining hooks (same shapes; mutations follow `useUpdateCustomer`'s invalidate
                       style, lib/api/customers.ts:109-119): `useSalesAgent(id, opts)`,
                       `useAgentAccruals(id, params, opts)`, `useCreateSalesAgent`, `useUpdateSalesAgent`,
                       `useUpdateSalesAgentStatus`, `useDeleteSalesAgent`, `useAddAgentRate`,
                       `useRemoveAgentRate`, `useAddCustomerRate`, `useAddAssignment(agentId)`,
                       `useBulkAssign(agentId)`, `useCloseAssignment`, `useRecomputeAgent`,
                       `useCommissionStatements(params, opts)`, `useCommissionStatement(id, opts)`,
                       `useGenerateStatement`, `useApproveStatement`, `useVoidStatement`,
                       `useRecordCommissionPayout`. Invalidation rules: agent/rate/status mutations →
                       `["sales-agents"]`; assignment mutations → `["sales-agents"]` AND
                       `["sales-agents", "current-assignment", customerId]`; statement mutations →
                       `["commission-statements"]` AND `["sales-agents"]` (claims move accrual state).
                       Rate/assignment mutation results may carry `recompute?: { invoicesSynced: number }`
                       — type it so pages can toast it.

  3.  `lib/api/orders.ts` — three additive edits: `Order` gains
      `commissionRatePct?: number | string | null` (beside `orderDate`, :31);
      `useCreateOrder`'s dto (:242-267) gains
      `/** Staff-only per-order commission override; 0 = exempt. */ commissionRatePct?: number;`;
      new hook:

      ```ts
      export function usePatchOrderCommissionRate() {
        const qc = useQueryClient();
        return useMutation<Order, Error, { id: string; commissionRatePct: number | null }>({
          mutationFn: ({ id, commissionRatePct }) =>
            apiClient
              .patch(`/orders/${id}/commission-rate`, { commissionRatePct })
              .then((r) => r.data),
          onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: ["orders", vars.id] }),
        });
      }
      ```

### WP3 — Nav wiring (dashboard shell)

- **files:** `apps/web/app/(dashboard)/layout.tsx`
- **dependsOn:** WP2 (imports `SALES_AGENTS_ADDON`)
- **brief:** two gated nav entries, injected in `DashboardShell`'s existing `navStructure`
  memo (:873-905) — never hardcoded into `OPERATOR_NAV` (an unflagged tenant must not see
  them). Add `const hasSalesAgents = useHasAddon(SALES_AGENTS_ADDON);` beside `hasTobacco`
  (:868) and add it to the memo deps. Import two lucide icons (`Handshake`,
  `BadgePercent`) beside the existing imports.
- **exact code** (inside the memo, after the `hasTobacco` push at :896-898, before the
  `inject.length === 0` return):

  ```ts
  let base = nav;
  if (hasSalesAgents) {
    // "Sales Agents" as a top-level leaf right after Customers; "Commissions"
    // inside the Finance group after Supplier Statements. Same splice style as
    // the canActAsDriver Dispatch rewrite above — never mutate OPERATOR_NAV.
    base = base.flatMap((entry): NavEntry[] => {
      if (entry.kind === "leaf" && entry.href === "/customers") {
        return [
          entry,
          { kind: "leaf", label: "Sales Agents", href: "/sales-agents", icon: Handshake },
        ];
      }
      if (entry.kind === "group" && entry.label === "Finance") {
        const idx = entry.children.findIndex((c) => c.href === "/finance/statements");
        const child: NavLeaf = {
          kind: "leaf",
          label: "Commissions",
          href: "/finance/commissions",
          icon: BadgePercent,
        };
        const children =
          idx === -1
            ? [...entry.children, child]
            : [...entry.children.slice(0, idx + 1), child, ...entry.children.slice(idx + 1)];
        return [{ ...entry, children }];
      }
      return [entry];
    });
  }
  ```

  (Then use `base` where the memo previously used `nav` for the tobacco/regulated splice
  target.) The nav gate is hide-only, so the bare `hasSalesAgents` boolean is correct per
  the addons.ts doc comment — no `resolved` handling needed here.

### WP4 — Agents management pages

- **files:** `apps/web/app/(dashboard)/sales-agents/page.tsx` (new),
  `apps/web/app/(dashboard)/sales-agents/[id]/page.tsx` (new),
  `apps/web/app/(dashboard)/sales-agents/_components/AgentFormModal.tsx` (new),
  `apps/web/app/(dashboard)/sales-agents/_components/AssignCustomersModal.tsx` (new)
- **dependsOn:** WP2, WP3
- **brief:**
  - **Locked-state pattern (both new page families use it — write it here, copy in WP6):**

    ```tsx
    const { data: addonsData, isLoading: addonsLoading } = useTenantAddons();
    const hasSalesAgents = addonsData?.addons?.includes(SALES_AGENTS_ADDON) ?? false;
    // …all page queries pass { enabled: hasSalesAgents } …
    if (addonsLoading) return <CenteredSpinner />; // house Loader2 pattern
    if (!hasSalesAgents)
      return (
        <LockedPage
          gate={{
            code: "PLAN_GATE",
            message: "Sales agents & commissions isn't enabled for this workspace.",
          }}
          title="Sales agents & commissions"
        >
          <Card className="h-64" />
        </LockedPage>
      );
    ```

    `LockedPage` from `@/app/(dashboard)/_components/gates/PlanGates` (:14-51),
    `useTenantAddons` from `@/lib/api/tobacco`. This is the deep-link story: nav is
    hidden, and a pasted URL renders the house upsell card instead of a toast storm.

  - **List page** (`/sales-agents`): `PageHeader` + `usePageTitle("Sales Agents")`;
    search input + status `<select>` (ACTIVE/PAUSED/STOPPED_FOR_NEW) + "Show deactivated"
    checkbox → `useSalesAgents({search, status, includeDeleted}, {enabled: hasSalesAgents})`.
    Table: Name, Status (Badge: ACTIVE→success, PAUSED→neutral/amber,
    STOPPED_FOR_NEW→warning, deleted→danger "Deactivated"), Current rate
    (`currentRatePct != null ? pctLabel : "—"`), Customers (`openAssignmentCount`),
    Email/Phone. Row → `/sales-agents/[id]`. "Add agent" → `AgentFormModal` (name
    required, email/phone/notes, optional "Default rate %" `DecimalInput` + optional
    effective-from date defaulting today) → `useCreateSalesAgent` → toast + navigate to
    the new id.
  - **Detail page** (`/sales-agents/[id]`): `useSalesAgent(id, {enabled: hasSalesAgents})`
    — one query drives everything except the ledger. Layout mirrors the customer page:
    main column + right column of cards.
    - **Header:** name, status Badge, `accrualTotals` strip — three stat boxes labelled
      "Accrued", "Payable", "Claimed", each `fmt(Number(x))` (STORED values, criterion M1).
    - **Contact card:** inline edit → `useUpdateSalesAgent` (PATCH sends only changed
      fields).
    - **Status card:** the three statuses as buttons (Account-Status card pattern,
      customers/[id]/page.tsx:2572-2617); choosing STOPPED_FOR_NEW opens a small confirm
      with an optional date input ("Stops NEW business from this date; pre-existing
      standing orders keep earning") → `useUpdateSalesAgentStatus`. Show
      `stopNewBusinessAt` via `fmtCalendarDate` when set. Below a divider: "Deactivate
      agent" → confirm → `useDeleteSalesAgent`; a 409 surfaces the server message via the
      global toast (no extra handling — the message is exact,
      sales-agents.service.ts:181-183).
    - **Default rates card:** table of `rates` (rate `pctLabel`, effective
      `fmtCalendarDate`, newest first; the top row effective ≤ today gets a "Current"
      Badge). "Add rate" → `ratePct` `DecimalInput` + `effectiveFrom` date (default
      today). On success: if response carries `recompute`, toast
      "Rate added — recomputed N invoice(s)" (N = `recompute.invoicesSynced`) else "Rate
      added". Delete icon ONLY on future-dated rows (mirror the server rule,
      service:219-223); past rows render a title tooltip "History — add a correcting row
      instead".
    - **Customer rates card:** "Add customer rate" → customer picker (async
      `useCustomers({search})` select, house combobox conventions) + rate + effectiveFrom
      → `useAddCustomerRate` (same recompute toast). Note: the API exposes no
      customer-rate list read — render only the add flow + a hint that resolution shows
      per-accrual in the ledger's `rateSource` column. Do NOT invent a list endpoint.
    - **Customers card:** `assignments` (open rows) as links to `/customers/[id]` with
      `fmtCalendarDate(effectiveFrom)`. "Assign customers" → `AssignCustomersModal`:
      multi-select of customers (search + checkboxes, cap 500 per the DTO), one
      effective-from date (default today, backdate allowed) → single ids →
      `useAddAssignment`, several → `useBulkAssign`; recompute toast as above; 400s
      (interval inversion) surface via the global toast. Per-row "End" →
      confirm → `useCloseAssignment({customerId})`.
    - **Ledger card (full width below):** `useAgentAccruals(id, {status, page}, {enabled})`.
      Columns: Invoice (link `/invoices/[id]`), Customer, Basis date (`fmtCalendarDate`),
      Base, Rate (`pctLabel(ratePct)` + small muted `RATE_SOURCE_LABELS[rateSource]`),
      Accrued, Payable, Claimed, Unclaimed (= the API's `drift`, render as returned — do
      NOT subtract client-side), Status Badge (PENDING/PARTIAL/PAYABLE/SETTLED/VOID).
      Status filter select + prev/next pager off `{total, page, limit}`. Footer row of
      buttons: "Recompute from date…" → date prompt → `useRecomputeAgent` → toast
      invoicesSynced.

### WP5 — Customer page agent box + create-modal select

- **files:** `apps/web/app/(dashboard)/customers/[id]/page.tsx`,
  `apps/web/app/(dashboard)/customers/_components/CustomerFormModal.tsx`
- **dependsOn:** WP2 (WP1 at runtime)
- **brief:**
  1. **Agent box** — new `Card title="Sales Agent"` in the profile tab's right column,
     directly ABOVE `<Card title="Account Status">` (:2572). Render the card at all only
     when `hasSalesAgents` (add `const hasSalesAgents = useHasAddon(SALES_AGENTS_ADDON);`
     beside `hasMsrpAddon`, :783). Exact shape:

     ```tsx
     {
       hasSalesAgents && (
         <Card title="Sales Agent">
           {currentAgent.isLoading ? (
             <p className="text-sm text-navy/70">Loading…</p>
           ) : currentAgent.data?.assignment ? (
             <div className="flex flex-col gap-2">
               <div className="flex items-center justify-between">
                 <Link
                   href={`/sales-agents/${currentAgent.data.assignment.agent.id}`}
                   className="text-sm font-semibold text-brand-700 hover:underline"
                 >
                   {currentAgent.data.assignment.agent.name}
                 </Link>
                 {currentAgent.data.assignment.agent.status !== "ACTIVE" && (
                   <Badge variant="warning">{currentAgent.data.assignment.agent.status}</Badge>
                 )}
               </div>
               <p className="text-xs text-navy/70">
                 Since {fmtCalendarDate(currentAgent.data.assignment.effectiveFrom)}
                 {currentAgent.data.customerRatePct != null &&
                   ` · customer rate ${pctLabel(currentAgent.data.customerRatePct)}`}
               </p>
               {isOperator && (
                 <div className="flex gap-2 border-t border-surface-border pt-3">
                   <Button size="sm" variant="secondary" onClick={() => setAgentModalOpen(true)}>
                     Reassign
                   </Button>
                   <Button size="sm" variant="ghost" onClick={handleEndAttribution}>
                     Remove
                   </Button>
                 </div>
               )}
             </div>
           ) : (
             <div className="flex flex-col gap-3">
               <p className="text-sm text-navy/70">No agent assigned (house account).</p>
               {isOperator && (
                 <Button size="sm" variant="secondary" onClick={() => setAgentModalOpen(true)}>
                   Assign agent
                 </Button>
               )}
             </div>
           )}
         </Card>
       );
     }
     ```

     Where `currentAgent = useCustomerCurrentAgent(customerId, { enabled: hasSalesAgents })`.
     The assign/reassign modal (local to this page, Modal from `@routeflow/ui/web`):
     agent `<select>` from `useSalesAgents({ status: "ACTIVE" }, { enabled: agentModalOpen && hasSalesAgents })`
     - effective-from date (default today; help text "Backdating recomputes commission
       from that date") → `useAddAssignment(agentId).mutate({ customerId, effectiveFrom })`
       → success toast (include `recompute.invoicesSynced` when present).
       `handleEndAttribution` = `confirm()` → `useCloseAssignment().mutate({ customerId })`.
       Server 400s (interval inversion) already toast globally.

  2. **CustomerFormModal (add mode only):** below the customer-type/name section, gated
     `hasSalesAgents && mode === "add"`, a "Sales agent (optional)" `<select>` fed by
     `useSalesAgents({ status: "ACTIVE" }, { enabled: isOpen && hasSalesAgents })`, held
     in local state `salesAgentId`. Thread into the create payload (:240-269):
     `...(salesAgentId ? { salesAgentId } : {})`. Edit mode gets NOTHING — reassignment
     lives in the agent box (the PATCH customer route has no agent field; the engine plan
     put assignment-open inside `create()` only).

### WP6 — Commission statements pages (the 409 contracts live here)

- **files:** `apps/web/app/(dashboard)/finance/commissions/page.tsx` (new),
  `apps/web/app/(dashboard)/finance/commissions/[id]/page.tsx` (new),
  `apps/web/app/(dashboard)/finance/commissions/_components/GenerateStatementModal.tsx` (new),
  `apps/web/app/(dashboard)/finance/commissions/_components/RecordPayoutModal.tsx` (new)
- **dependsOn:** WP2, WP3
- **brief:**
  - **List page** (`/finance/commissions`): locked-state pattern from WP4 verbatim.
    Filters: agent select (`useSalesAgents`), status select
    (PENDING/APPROVED/PAID/VOID) → `useCommissionStatements({agentId, status}, {enabled})`.
    Table: Number, Agent, Status Badge, Period
    (`periodFrom/periodTo` via `fmtCalendarDate`, "Open period" when both null), Total
    `fmt(Number(totalAmount))`, Paid `fmt(Number(paidAmount))`, Created `fmtDate`.
    Row → detail. "Generate statement" → `GenerateStatementModal`.
  - **GenerateStatementModal:** agent select (required) + optional period from/to date
    inputs (help text: "The period narrows which invoices are claimed; adjustments and
    carryforwards are always swept"). Submit → `useGenerateStatement`. **Exact error
    handling:**

    ```tsx
    generate.mutate(dto, {
      onSuccess: (stmt) => router.push(`/finance/commissions/${stmt.id}`),
      onError: async (err) => {
        const res = (err as any)?.response;
        // 409 = this agent already has a PENDING statement (service:88-92). The id
        // isn't in the body — fetch it and route there. The global toast already
        // showed the server message; this adds the useful next step.
        if (res?.status === 409) {
          const { data } = await apiClient.get("/commission-statements", {
            params: { agentId: dto.agentId, status: "PENDING" },
          });
          if (data?.[0]?.id) router.push(`/finance/commissions/${data[0].id}`);
        }
        // 400 "Nothing to generate" needs nothing extra — the toast message is exact.
      },
    });
    ```

  - **Detail page** (`/finance/commissions/[id]`): ONE query —
    `useCommissionStatement(id, {enabled})` (findOne returns lines + payouts,
    commission-statements.service.ts:48-65). Header: statement number, agent link,
    Status Badge, period, `approvedAt` (`fmtDate`). Totals strip (STORED values):
    Total `fmt(Number(totalAmount))`, Paid `fmt(Number(paidAmount))`, Remaining
    `fmt(Number(totalAmount) - Number(paidAmount))` (display-only subtraction — the
    server re-derives the cap in-tx). **Lines table:** Kind Badge
    (CLAIM→success, ADJUSTMENT→warning, CARRYFORWARD→neutral), Reference (CLAIM →
    `line.accrual.invoice.invoiceNumber` linked to `/invoices/[id]`; ADJUSTMENT →
    `line.adjustment.kind` + description; CARRYFORWARD → `line.carriedFrom.statementNumber`
    linked), Amount `fmt(Number(amount))` (negatives in `text-danger`). **Payouts card**
    (from `statement.payouts`): date `fmtDate(paidAt)`, method `paymentMethodLabel`,
    reference, amount.
    **Actions by status:**
    - PENDING → "Approve" + "Void" (confirm; `useVoidStatement`).
    - APPROVED with `Number(totalAmount) > 0` and remaining > 0 → "Record payout".
    - APPROVED with `Number(totalAmount) <= 0` → muted note "Negative statement — the
      balance carries into the next generation; payouts are blocked." (server enforces).
    - PAID / VOID → read-only.
  - **The stale-409 one-click regenerate (exact code — this is the contract the task
    calls out):** approving a PENDING statement 409s `"Statement is stale — regenerate"`
    when the ledger moved after generation (approve re-validation,
    commission-statements.service.ts:244/253/266). The fix is void-then-regenerate with
    the SAME agent/period, then land on the fresh statement:

    ```tsx
    const [staleGate, setStaleGate] = React.useState(false);

    const handleApprove = () =>
      approve.mutate(statement.id, {
        onError: (err) => {
          const res = (err as any)?.response;
          const msg: string = res?.data?.message ?? "";
          // Approve throws exactly two 409s: "Only a PENDING statement…" (state raced —
          // refetch covers it) and the stale contract. Match on "stale", not status alone.
          if (res?.status === 409 && msg.toLowerCase().includes("stale")) setStaleGate(true);
        },
      });

    // One click: void the stale PENDING statement, regenerate with the same
    // period, navigate to the replacement. Both steps are the server's own
    // sanctioned path (void releases every claim/sweep atomically; generate
    // re-claims live drift), so a crash between them leaves a clean ledger —
    // the worst case is "voided but not regenerated", fixed by clicking
    // Generate on the list page.
    const regenerate = useMutation({
      mutationFn: async () => {
        await apiClient.post(`/commission-statements/${statement.id}/void`);
        const { data } = await apiClient.post("/commission-statements/generate", {
          agentId: statement.agentId,
          periodFrom: statement.periodFrom ?? undefined,
          periodTo: statement.periodTo ?? undefined,
        });
        return data;
      },
      onSuccess: (fresh) => {
        qc.invalidateQueries({ queryKey: ["commission-statements"] });
        qc.invalidateQueries({ queryKey: ["sales-agents"] });
        toast({ title: `Regenerated as ${fresh.statementNumber}`, variant: "success" });
        router.replace(`/finance/commissions/${fresh.id}`);
      },
    });

    // …in the JSX, when staleGate:
    <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
      <p className="font-medium">This statement is stale.</p>
      <p className="mt-0.5">
        Commission moved after it was generated (a payment, clawback, or reassignment). Regenerating
        voids this statement and issues a fresh one with current amounts.
      </p>
      <Button
        size="sm"
        className="mt-2"
        onClick={() => regenerate.mutate()}
        disabled={regenerate.isPending}
      >
        {regenerate.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Void & regenerate"}
      </Button>
    </div>;
    ```

    (The regenerate's own 400 "Nothing to generate" — everything clawed back to zero —
    surfaces via the global toast; also `router.replace("/finance/commissions")` in that
    branch's onError since the old statement is now VOID.)

  - **RecordPayoutModal:** amount `MoneyInput` (default = remaining), method select from
    `SELECTABLE_PAYMENT_METHODS` (`ALL_PAYMENT_METHODS`'s CREDIT_NOTE/ADVANCE make no
    sense for a payout even though the enum admits them), optional reference/notes/paidAt
    (date, default today) → `useRecordCommissionPayout`. Over-cap 400 carries the exact
    remaining in its message — global toast suffices. On success: toast + the hook's
    invalidation refreshes the page (statement flips to PAID at the cap server-side —
    display the returned state, never predict it).

### WP7 — Order-level commission override

- **files:** `apps/web/app/(dashboard)/orders/_components/CreateOrderModal.tsx`,
  `apps/web/app/(dashboard)/orders/[id]/page.tsx`, `apps/web/lib/drafts.ts`
- **dependsOn:** WP2
- **brief:**
  1. **CreateOrderModal:** add `useAuth()` (the modal has none today) →
     `const isStaff = user?.role === "OPERATOR" || user?.role === "TENANT_ADMIN";` and
     `const hasSalesAgents = useHasAddon(SALES_AGENTS_ADDON);`. State beside `orderDate`
     (:650): `const [commissionRatePct, setCommissionRatePct] = React.useState<number | null>(null);`.
     In the "Options" section, directly after the dates grid (:1806), gated
     `isStaff && hasSalesAgents`:

     ```tsx
     {
       isStaff && hasSalesAgents && (
         <div className="space-y-1">
           <label className="block text-xs font-medium text-navy/70" htmlFor="commission-rate">
             Commission rate override <span className="font-normal text-navy/70">(optional)</span>
           </label>
           <DecimalInput
             id="commission-rate"
             value={commissionRatePct}
             onChange={setCommissionRatePct}
             decimals={2}
             min={0}
             max={100}
             placeholder="Agent / customer default"
             className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
           />
           <p className="text-[11px] leading-snug text-navy/70">
             Percent of the goods subtotal for this order only. 0 = exempt (no commission). Blank =
             the customer/agent default rate.
           </p>
         </div>
       );
     }
     ```

     Submit payload (:879-894): `...(commissionRatePct != null ? { commissionRatePct } : {})`
     — note `0` MUST be sent (it means exempt), which `!= null` preserves. Park/resume:
     `OrderDraftPayload` in `lib/drafts.ts` gains
     `commissionRatePct?: number | null;` (optional — old parked drafts stay valid);
     thread it into `draftPayload` (:657-680, + memo deps) and hydrate with
     `setCommissionRatePct(p.commissionRatePct ?? null)` at both restore sites
     (:782 region and :794 region). Reset it with the other state on modal close.

  2. **Order detail** (`orders/[id]/page.tsx`): add `useAuth()` + the two gates. In the
     "Summary" card's `<dl>` (:2868-2890), after the Order-date row, render only when
     `hasSalesAgents`:

     ```tsx
     {
       hasSalesAgents && (
         <div className="flex items-center justify-between gap-3">
           <dt className="text-navy/70">Commission</dt>
           <dd className="flex items-center gap-2 font-medium text-navy">
             {order.commissionRatePct == null
               ? "Default"
               : Number(order.commissionRatePct) === 0
                 ? "Exempt (0%)"
                 : `${Number(order.commissionRatePct)}% (override)`}
             {isStaff && (
               <button
                 className="text-xs font-medium text-brand-700 hover:underline"
                 onClick={() => setCommissionEditOpen(true)}
               >
                 Edit
               </button>
             )}
           </dd>
         </div>
       );
     }
     ```

     The edit modal: `DecimalInput` (same bounds) prefilled from the order + a "Clear
     override" button sending `null` → `usePatchOrderCommissionRate`. The server resyncs
     every issued invoice of the order in the same tx (`setCommissionRate` →
     `syncOrderInvoices`) — the UI just refetches; it never predicts ledger effects.

### WP8 — Mobile read-parity (one row, read-only)

- **files:** `apps/mobile/lib/api/tobacco.ts`, `apps/mobile/lib/api/customers.ts`,
  `apps/mobile/app/(operator)/customers/[id].tsx`
- **dependsOn:** — (WP1 at runtime)
- **brief:** the cheapest honest mirror: show WHO holds the customer; all management
  stays on web (matches the supplier-statements precedent — capture/read on mobile,
  review on web).
  1. `lib/api/tobacco.ts`: `export const SALES_AGENTS_ADDON = "sales_agents";` beside
     `TOBACCO_ADDON` (:25) with a one-line comment pointing at the web constant.
  2. `lib/api/customers.ts`: append (style of `useCustomer`, :246-253):

     ```ts
     export interface CustomerCurrentAgent {
       assignment: {
         id: string;
         effectiveFrom: string;
         agent: { id: string; name: string; status: string; deletedAt: string | null };
       } | null;
       customerRatePct: number | null;
     }

     /** Read-only mirror of web's agent box. MUST stay `enabled`-gated: the route is
      *  plan-flag gated and 403s for tenants without the sales_agents addon. */
     export function useCustomerCurrentAgent(customerId: string, enabled: boolean) {
       return useQuery<CustomerCurrentAgent>({
         queryKey: ["sales-agents", "current-assignment", customerId],
         queryFn: () =>
           apiClient
             .get("/sales-agents/assignments/current", { params: { customerId } })
             .then((r) => r.data),
         enabled: !!customerId && enabled,
         staleTime: 2 * 60_000,
       });
     }
     ```

  3. `(operator)/customers/[id].tsx`: `const hasSalesAgents = useHasAddon(SALES_AGENTS_ADDON);`
     - `const { data: currentAgent } = useCustomerCurrentAgent(id, hasSalesAgents);`,
       then directly after the "Pricing tier" `Row` (:252-259):

     ```tsx
     {
       hasSalesAgents && currentAgent?.assignment ? (
         <Row
           label="Sales agent"
           value={<Text style={styles.rowValue}>{currentAgent.assignment.agent.name}</Text>}
         />
       ) : null;
     }
     ```

     No row when unflagged or unassigned — absence is the mobile empty state.

### WP9 — Playwright gate spec + code-map upkeep

- **files:** `apps/web/e2e/18-sales-agents-gate.spec.ts` (new),
  `.claude/code-map/INDEX.md`, `.claude/code-map/web.md`, `.claude/code-map/mobile.md`,
  `.claude/code-map/CHANGELOG.md`, `.claude/code-map/_meta.json`
- **dependsOn:** WP3, WP4, WP6
- **brief:**
  1. **Spec — read-only by construction, branches on live addon state** (the e2e tenant
     may have the addon on or off; both halves are valid runs):

     ```ts
     /**
      * PR-D (18): Sales-agents UI entitlement gate. READ-ONLY: GETs and renders only —
      * no create/approve/payout is ever clicked. Branches on the tenant's live addon
      * state via GET /tenants/me/addons (helpers/api.ts pattern) so it is green both
      * before and after the sales_agents addon is enabled on the e2e tenant.
      */
     import { test, expect } from "@playwright/test";
     import { apiBase, operatorAccessToken } from "./helpers/api";

     test("sales-agents surfaces follow the addon flag", async ({ page }) => {
       await page.goto("/dashboard");
       const token = await operatorAccessToken(page);
       test.skip(!token, "no operator token — auth setup did not run");
       const res = await page.request.get(`${apiBase(page.url())}/api/v1/tenants/me/addons`, {
         headers: { Authorization: `Bearer ${token}` },
       });
       const { addons = [] } = await res.json();
       const enabled = addons.includes("sales_agents");

       const nav = page.getByRole("navigation");
       if (!enabled) {
         await expect(nav.getByText("Sales Agents")).toHaveCount(0);
         // Deep-link renders the locked card, not a crash or a toast storm.
         await page.goto("/sales-agents");
         await expect(page.getByText(/isn't enabled for this workspace/i)).toBeVisible();
       } else {
         await expect(nav.getByText("Sales Agents")).toBeVisible();
         await page.goto("/sales-agents");
         await expect(page.getByRole("button", { name: /add agent/i })).toBeVisible();
         await page.goto("/finance/commissions");
         await expect(page.getByRole("button", { name: /generate/i })).toBeVisible();
       }
     });
     ```

  2. **Code map:** INDEX.md "Sales agents & commissions" row — replace "no UI (PR-D)"
     with the web/mobile surface pointers; web.md gains a PR-D bullet (pages, hooks file,
     nav gate, the enabled-gating rule, the stale-regenerate flow); mobile.md gains the
     one-row parity note; CHANGELOG.md new dated bullet at top; `_meta.json` note per its
     convention.

## Out of scope (do NOT build in this PR — flag any drift in review)

Statement PDF/CSV export; `GET /bookkeeping/reports/commissions-by-agent` (an API change —
deferred with the reports family); any other API change beyond WP1's read endpoint (in
particular: no `code` field on the 409 bodies, no customer-rate list endpoint, no include
changes to `customers.service.findOne`); CommandPalette entries for the new pages; agent
select in the web sale flow (`invoices/new` — the order-detail PATCH covers post-hoc
fixes) and in mobile order/sale builders; any mobile write surface for agents; buyer
portal anything; `feature-smoke.mjs` section (write-path smoke needs the addon on the
smoke tenant — a deliberate ops decision, not this PR); enabling the addon anywhere (the
owner does that per tenant from platform-admin).

## Acceptance criteria (each checkable by a spec-compliance reviewer)

1. **No migration, no schema change, no Prisma file touched.** `git diff --stat` shows
   nothing under `apps/api/prisma/`.
2. The ONLY API change is WP1: `GET /sales-agents/assignments/current?customerId=` on
   `SalesAgentsController` (inherits class-level flag+role guards), its service method,
   and ≥3 new spec cases in `sales-agents.service.spec.ts`. No other `apps/api` file in
   the diff.
3. `SALES_AGENTS_ADDON = "sales_agents"` exists in web `lib/api/addons.ts` and mobile
   `lib/api/tobacco.ts`; every new query hook is `enabled`-gated so an unflagged tenant
   fires ZERO `/sales-agents*` or `/commission-statements*` requests (inspect: no gated
   GET without an `enabled` condition).
4. Flag OFF ⇒ no "Sales Agents" / "Commissions" nav entries (injected in the
   `navStructure` memo, never in `OPERATOR_NAV`), the customer agent box and order
   commission row don't render, the mobile row doesn't render, and deep-links to
   `/sales-agents` and `/finance/commissions` render the `LockedPage` card after the
   addons query resolves (no lock-flash while loading, no PLAN_GATE toast burst).
5. Agents list shows name/status/current rate/open-assignment count from the list
   payload; create modal drives `POST /sales-agents` incl. optional first rate.
6. Agent detail renders `accrualTotals` and the ledger from STORED fields only — grep
   the new pages for `* rate`, `ratePct / 100`, or any accrued/payable arithmetic:
   **none may exist** (M1). "Unclaimed" is the API's `drift` verbatim.
7. Rates: add-rate with a past `effectiveFrom` toasts the returned
   `recompute.invoicesSynced`; delete renders only for future-dated rows; the past-row
   400 message is surfaced not swallowed.
8. Assignments: single + bulk (≤500) + close all work from the agent page; the customer
   page box assigns/reassigns/removes; every backdated write toasts the recompute count;
   inversion 400s surface via the global toast.
9. Customer create modal (add mode, flag on) sends `salesAgentId` only when picked; edit
   mode never sends it.
10. Statements list + generate modal work; generate's 409 routes to the existing PENDING
    statement (fetched by `{agentId, status: "PENDING"}`); the 400 "Nothing to generate"
    is not special-cased.
11. Statement detail is fed by the single `findOne` payload (no `GET :id/payouts` call);
    lines render kind badges + the correct reference per kind (invoice link / adjustment
    kind / carried-from statement); approve/void/payout buttons follow status exactly
    (payout hidden when `totalAmount ≤ 0` or remaining ≤ 0, with the negative-statement
    note).
12. **Approve 409 with "stale" in the message shows the regenerate banner; the one-click
    action voids then generates with the SAME agentId/periodFrom/periodTo and
    `router.replace`s to the new statement.** A non-stale 409 does not trigger the banner.
13. Payout modal defaults to remaining, offers `SELECTABLE_PAYMENT_METHODS` only, and
    displays post-mutation state from the refetch (no client-side status flip).
14. Order override: CreateOrderModal input renders only for staff + flag, sends `0`
    (exempt) but not `null`, and survives draft park/resume; order detail shows
    Default / Exempt (0%) / N% (override) and the staff Edit modal PATCHes incl. a
    "Clear override" (null).
15. Mobile: the "Sales agent" row appears on the operator customer screen only when the
    addon is on AND an assignment exists; the query is `enabled`-gated.
16. e2e spec 18 exists, is read-only (GETs + renders only), and passes in BOTH addon
    states; **no Jest specs were added under `apps/web`** (web has no Jest runner).
17. `npm run check-types`, `npm run lint`, `npm run test` all green from the repo root;
    the full pre-existing API suite passes with only additive spec changes.
18. Code-map entries updated per WP9.

## Verification commands

Run from the repo root (worktree):

- `npm run check-types`
- `npm run lint`
- `npm run test`

Optional (deployed env with the e2e tenant): `npm run test:e2e -- 18-sales-agents-gate`
— green in either addon state by design.

## Risks & rollback

- **PLAN_GATE toast bursts** are the sneaky failure mode: one un-`enabled`-gated GET on a
  shared surface (customer page, order modal) toasts every unflagged tenant. Criterion 3
  is the reviewer's grep-check; the `useTenantAddons` 5-min cache keeps the gate cheap.
- **The regenerate chain is two requests, not one tx.** A crash between void and generate
  leaves a VOID statement and no replacement — the ledger is clean (void releases claims
  atomically server-side) and the recovery is the normal Generate button. Documented in
  the WP6 code comment; do not "improve" this into anything that retries the void.
- **Stale detection matches on message text** (`includes("stale")`) because the 409 body
  carries no machine code and adding one is an API change this PR forbids. If the server
  message ever changes, the banner degrades to the plain toast — annoying, not wrong.
- **CreateOrderModal is shared state-heavy**; the override rides the existing
  option-field pattern (state + payload spread + draft payload field) and touches no
  pricing math. The draft-payload field is optional, so previously parked drafts hydrate
  fine.
- **Rollback:** every surface is behind `useHasAddon` on the client and `PlanFlagGuard`
  on the server; disabling the `sales_agents` addon per tenant blanks the whole UI within
  the entitlement cache window. Reverting the PR removes only additive files plus small
  additive edits in the seven shared files listed below.

### Critical Files for Implementation

- C:\ClaudeCode\routeflow\.claude\worktrees\ap-agents-ui\apps\web\lib\api\sales-agents.ts (new — pins every page WP)
- C:\ClaudeCode\routeflow\.claude\worktrees\ap-agents-ui\apps\api\src\sales-agents\sales-agents.service.ts (WP1 read endpoint)
- C:\ClaudeCode\routeflow\.claude\worktrees\ap-agents-ui\apps\web\app\(dashboard)\layout.tsx (nav gate)
- C:\ClaudeCode\routeflow\.claude\worktrees\ap-agents-ui\apps\web\app\(dashboard)\customers\[id]\page.tsx (the client-requested agent box)
- C:\ClaudeCode\routeflow\.claude\worktrees\ap-agents-ui\apps\web\app\(dashboard)\orders_components\CreateOrderModal.tsx (override input + draft threading)
