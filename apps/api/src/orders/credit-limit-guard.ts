import { ConflictException, Logger } from "@nestjs/common";
import { roundMoney } from "@routeflow/pricing";
import type { EntitlementsService } from "../billing/entitlements.service";
import { editedOrderContribution, loadCreditExposure } from "../invoices/credit-exposure";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * The credit-limit guard, lifted out of `OrdersService` (B585) so that new enforcement points cost
 * the 6.7k-line service a call, not a copy. `OrdersService` calls `assertWithinCreditLimit`
 * directly and keeps one private adapter (`isCreditLimitCheckEnabled`) that binds its own prisma /
 * entitlements / logger. `invoices/credit-exposure-coverage.spec.ts` pins that the guard reads
 * exposure ONLY through `loadCreditExposure` and that the service carries no copy of it.
 */

/** What `isCreditLimitCheckEnabled` reads — the service's own collaborators, passed in. */
export interface CreditLimitCheckDeps {
  prisma: Pick<PrismaService, "getTenantId">;
  entitlements: Pick<EntitlementsService, "hasFlag">;
  logger: Pick<Logger, "error">;
}

/**
 * WP3: resolves whether the credit-limit check applies to this tenant.
 *
 * MUST be called BEFORE opening an interactive transaction (pool-starvation
 * guard, :1660-1672): EntitlementsService reads the tenant row on its OWN
 * pooled connection, so a cache miss inside an open tx would check out a
 * second connection while the first is held — N concurrent edits on a cold
 * cache then deadlock the pool (P2024) and every edit rolls back.
 *
 * Both fallbacks resolve to TRUE (run the check) because the legacy,
 * pre-flag behavior is that the check ALWAYS runs, and assertWithinCreditLimit
 * throws inside the order-edit transaction: a catalog/DB hiccup must degrade
 * to the money guard staying ON, never to a rolled-back edit reporting a
 * billing-catalog error. (PlanFlagGuard fails CLOSED instead — it can deny a
 * request cleanly; this call site cannot.)
 */
export async function isCreditLimitCheckEnabled(deps: CreditLimitCheckDeps): Promise<boolean> {
  // Release toggle (REMOVE by 2026-10-01): plan-flag enforcement ships dark.
  // "on" = enforce; anything else = legacy behavior (always check).
  if ((process.env.PLAN_FLAG_ENFORCEMENT ?? "off") !== "on") return true;
  const tenantId = deps.prisma.getTenantId();
  if (!tenantId) return true;
  try {
    return await deps.entitlements.hasFlag(tenantId, "flag.credit_limits");
  } catch (err) {
    deps.logger.error(
      `Entitlement resolution failed for tenant ${tenantId}; running the credit check (legacy)`,
      err as Error,
    );
    return true;
  }
}

/**
 * P5-08b credit-limit guard — the FIRST credit enforcement in the codebase
 * (verified: no other creditLimit read exists in apps/api/src outside DTOs).
 *
 * Exposure comes from the ONE shared derivation (`loadCreditExposure`,
 * invoices/credit-exposure.ts) that the operator statement also uses, so the
 * statement's exposure panel can never disagree with this block (L-119).
 * It mirrors customers.service.ts getStatementForOperator — do NOT invent a
 * second balance formula here:
 *   • invoice balances: status ∉ {PAID, VOID, WRITTEN_OFF}, each worth
 *     Number(total) − Σ non-VOID payments.amount. D6 / B462 owner ruling
 *     (option B): a standalone unissued DRAFT is not a receivable — a DRAFT with
 *     NO open/delivered order behind it (`isUnbackedDraft`) is NOT counted and is
 *     surfaced as the statement's "pending exposure" instead — but a DRAFT whose
 *     order is OPEN or DELIVERED DOES count, so delivered goods are never
 *     unguarded. The DRAFT-PAYMENT basis (non-VOID, so a DRAFT bank-import
 *     payment counts as paid) is deliberately unchanged;
 *   • open-order totals: status ∈ {PENDING, CONFIRMED, OUT_FOR_DELIVERY}
 *     (statement's `pendingOrdersAmount`). An order with counted invoices (issued
 *     or backed drafts) counts max(order total, Σ its invoices) ONCE — the
 *     unbilled remainder is added on top of the invoice balances, never the
 *     order total AND the invoice (reconcileOrderDraftInvoice keeps a mirror
 *     invoice in lockstep, so counting both would double-count);
 *   • the order being edited is EXCLUDED from both buckets and represented
 *     by projectedOrderTotal instead, LESS the money already RECEIVED toward
 *     it (`excludedOrderPaid`: confirmed cash / advance on its issued-or-paid
 *     invoices, capped per invoice — a CREDIT_NOTE application is never cash,
 *     B421) and never below what its unsettled invoices (SENT/VIEWED/PARTIAL/
 *     OVERDUE) owe (`editedOrderContribution`). An editable order CAN carry
 *     payments (a PAID/PARTIAL invoice is not reverted; nothing is for
 *     OUT_FOR_DELIVERY+ edits), so a prepaid order was blocked for money
 *     already paid. Invoices that SURVIVE the edit (`invoicesSurviveEdit`)
 *     keep their balance as a floor; ones the edit REWRITES count only up to
 *     the projected total (B577 follow-up);
 *   • UNAPPLIED credit notes / advance balances are NOT netted (netting loosens
 *     a money guard) — only what was already APPLIED to this order's invoices;
 *   • the Transaction model is NOT read — delivered orders have BOTH a
 *     Transaction and an invoice, so mixing the two double-counts.
 *
 * creditLimit == null (or customer row not found) → no limit → no check.
 * Blocks ALL roles — money exposure is stricter than stock (operators may
 * oversell, they may not silently extend credit); the shared error code
 * leaves room for a future explicit operator-override flow.
 *
 * Runs INSIDE the updateOrderItems transaction, after the totals recompute:
 * projectedOrderTotal is the SAME roundMoney(subtotal + tax) the order.update
 * persists. A throw rolls the whole edit back.
 *
 * flag.credit_limits gates the CHECK itself, not customer CRUD — an
 * unflagged tenant's stored creditLimit values persist but are inert. Same
 * PLAN_FLAG_ENFORCEMENT kill switch as PlanFlagGuard (see plan-flag.guard.ts):
 * legacy behavior (kill switch off) is that this check ALWAYS runs, so the
 * off-path must keep running it, not skip it. The decision is resolved by
 * isCreditLimitCheckEnabled OUTSIDE the transaction and passed in — this
 * function issues NO query on the non-transactional client.
 */
export async function assertWithinCreditLimit(
  db: any,
  customerId: string,
  currentOrderId: string,
  projectedOrderTotal: number,
  creditCheckEnabled: boolean,
  invoicesSurviveEdit = false,
): Promise<void> {
  if (!creditCheckEnabled) return;

  const customer = await db.customer.findFirst({
    where: { id: customerId },
    select: { creditLimit: true },
  });
  if (customer?.creditLimit == null) return;
  const limit = Number(customer.creditLimit);

  // `db` is the caller's (transaction) client. The edited order is excluded from
  // every bucket and represented by projectedOrderTotal below.
  const { counted, excludedOrderPaid, excludedOrderUnsettledOutstanding } =
    await loadCreditExposure(db, customerId, { excludeOrderId: currentOrderId });

  // The edited order counts its still-UNPAID projected total, floored by its unsettled invoices.
  const exposure = roundMoney(
    counted +
      editedOrderContribution(
        projectedOrderTotal,
        excludedOrderPaid ?? 0,
        excludedOrderUnsettledOutstanding ?? 0,
        invoicesSurviveEdit,
      ),
  );
  if (exposure > limit) {
    throw new ConflictException({
      code: "CREDIT_LIMIT_EXCEEDED",
      message:
        `This edit would take the customer's exposure to ${exposure.toFixed(2)}, ` +
        `over their credit limit of ${limit.toFixed(2)}.`,
      limit,
      exposure,
    });
  }
}
