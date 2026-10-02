import { ConflictException, Logger } from "@nestjs/common";
import { roundMoney } from "@routeflow/pricing";
import type { EntitlementsService } from "../billing/entitlements.service";
import { editedOrderContribution, loadCreditExposure } from "../invoices/credit-exposure";
import { assertAmbientTenant } from "../common/ambient-tenant";
import {
  restrictionChannelForPrincipal,
  type ChannelPrincipal,
} from "../selling-restrictions/selling-restrictions.core";
import type { PrismaService } from "../prisma/prisma.service";
import { API_ERROR_CODES } from "../common/api-error-codes";

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
  // Release toggle (review by 2027-01-31): plan-flag enforcement ships dark.
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
/**
 * The two tuning knobs of the guard, an OBJECT (not two defaulted positional parameters): a mechanical
 * merge once put a string in a boolean slot, and a dropped `invoicesSurviveEdit` fails silently in the
 * LOOSENING direction — a named option cannot be transposed.
 */
export interface CreditGuardOptions {
  /**
   * The edited order's issued invoices SURVIVE this edit untouched (a delivered, partially invoiced
   * order: neither the revert nor the re-sync runs): their stored balance is a floor. Default false —
   * the safe answer, never stricter than before the netting (see `editedOrderContribution`).
   */
  invoicesSurviveEdit?: boolean;
  /** What the 409 message calls the thing that would breach the limit. */
  action?: "edit" | "order" | "delivery";
}

export async function assertWithinCreditLimit(
  db: any,
  customerId: string,
  /** The order being edited (excluded from every bucket); `null` = a NEW order, nothing to exclude. */
  currentOrderId: string | null,
  projectedOrderTotal: number,
  creditCheckEnabled: boolean,
  opts: CreditGuardOptions = {},
): Promise<void> {
  if (!creditCheckEnabled) return;
  const { invoicesSurviveEdit = false, action = "edit" } = opts;

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
      code: API_ERROR_CODES.CREDIT_LIMIT_EXCEEDED,
      message:
        `This ${action} would take the customer's exposure to ${exposure.toFixed(2)}, ` +
        `over their credit limit of ${limit.toFixed(2)}.`,
      limit,
      exposure,
    });
  }
}

// ─── B585: the new enforcement points (create / deliver), OFF by default ──────────────────────

/**
 * Per-tenant `SystemConfig` switches for the credit check, ONE PER ENFORCEMENT POINT so an owner can
 * flip them independently: `enforce_new_orders` governs order CREATE only; `enforce_delivery` governs
 * goods leaving (`changeStatus` to OUT_FOR_DELIVERY, or CONFIRMED → DELIVERED). There is no fallback
 * between them (a fallback would re-couple the points). Each is read FIRST: a tenant that never set it
 * pays one indexed read and nothing else (the exposure derivation is several more queries on the
 * hottest write path, so a default that ran it for everyone would not be free). Absent, or any value
 * but the two below = OFF: nothing else runs. Exactly `"dark"` = OBSERVE: derive, log one "would deny"
 * line, never block. Exactly `"true"` = ENFORCE. Neither governs the edit paths (`updateOrderItems` /
 * change requests), which have always blocked.
 */
export const CREDIT_LIMIT_ENFORCE_KEY = "credit_limit.enforce_new_orders";
export const CREDIT_LIMIT_DELIVERY_ENFORCE_KEY = "credit_limit.enforce_delivery";

export type CreditEnforcementMode = "OFF" | "DARK" | "ENFORCED";

/** What the enforcement-point helpers read: the client (tenant scoping, no ambient tenant on cron). */
export interface CreditEnforcementDeps extends CreditLimitCheckDeps {
  prisma: Pick<PrismaService, "getTenantId" | "forTenant">;
  logger: Pick<Logger, "error" | "warn">;
}

/**
 * The tenant's mode. The read carries an EXPLICIT `tenantId` (L-124: with no ambient tenant,
 * `forTenant()` is unscoped) and refuses one that disagrees with the ambient tenant. A DB error
 * propagates; `assertCreditAtEnforcementPoint` decides what an unreadable switch means.
 */
export async function creditEnforcementMode(
  prisma: Pick<PrismaService, "forTenant" | "getTenantId">,
  tenantId: string,
  action: "order" | "delivery" = "order",
): Promise<CreditEnforcementMode> {
  assertAmbientTenant(prisma, tenantId, "creditEnforcementMode");
  const key = action === "delivery" ? CREDIT_LIMIT_DELIVERY_ENFORCE_KEY : CREDIT_LIMIT_ENFORCE_KEY;
  const row: { value: string } | null = await prisma.forTenant().systemConfig.findFirst({
    where: { tenantId, key },
    select: { value: true },
  });
  return row?.value === "true" ? "ENFORCED" : row?.value === "dark" ? "DARK" : "OFF";
}

const isCreditLimitExceeded = (e: unknown): e is ConflictException =>
  e instanceof ConflictException &&
  (e.getResponse() as { code?: string } | undefined)?.code ===
    API_ERROR_CODES.CREDIT_LIMIT_EXCEEDED;

const ACTION_LABEL = { order: "new order", delivery: "delivery" } as const;

/** What an ENFORCED denial tells someone who may not see the customer's figures (a buyer). */
const GENERIC_DENIAL = "This order can't be placed right now. Please contact your account manager.";

/** One enforcement point's facts (the tenant is added by the caller's own client). */
export interface CreditPointParams {
  customerId: string;
  projectedTotal: number;
  /** The order being sent out (excluded from every bucket); absent = a NEW order. */
  excludeOrderId?: string | null;
  action?: keyof typeof ACTION_LABEL;
  /** Who is acting. Only a positively-staff principal sees limit / exposure in a denial; absent = generic. */
  principal?: ChannelPrincipal | null;
}

/**
 * The credit check at a B585 enforcement point (a NEW order, or an order going out for delivery):
 * same derivation as the edit guard, behind the per-tenant switch, which is read FIRST (OFF costs
 * that one read). Runs BEFORE any write / stock transaction, so nothing is half-committed and no
 * second pooled connection is taken inside a tx. When the guard would deny: ENFORCED throws its 409
 * (generic for a non-staff principal: no limit, no exposure); DARK logs one "would deny" line (ids
 * and figures only) and allows. No tenant on the caller = OFF. DARK must never break a create that
 * works today: a failure to reach a verdict logs ERROR and allows; an unreadable switch is OFF with
 * an ERROR; only an ENFORCED tenant sees a failure. `excludeOrderId` = the order being sent out.
 *
 * ⚠ Do NOT set either key to "true" for any tenant while these paths still bypass it:
 *   - `enforce_new_orders`: DRAFT → PENDING promotion in `changeStatus`, and the standing-order cron
 *     (`order-templates` writes PENDING orders directly);
 *   - `enforce_delivery`: an OPERATOR-role `completeStop` / `completeWithPayment` (RoutesService marks
 *     every linked order DELIVERED, ungated: an operator refused at the counter can complete the
 *     order's stop from the office). A DRIVER's completion is EXCLUDED on purpose (the goods are
 *     already at the door); RoutesService may only OBSERVE credit — pinned in
 *     `orders.deliver-credit-gate.spec.ts`.
 * Route DISPATCH and stop COMPLETION are OBSERVATION-ONLY (run start only logs; `completeStop` flips
 * orders to DELIVERED directly), so "already out = gated" holds only for an order that was dispatched
 * through `changeStatus` while `enforce_delivery` was "true".
 * Guarded: a new order; `changeStatus` to OUT_FOR_DELIVERY (not a re-dispatch of a PARTIALLY_DELIVERED
 * order, whose goods already left); CONFIRMED → DELIVERED. A demotion (OUT_FOR_DELIVERY → CONFIRMED,
 * with a reason) then a re-dispatch is a NEW dispatch and is gated. (`updateOrderItems` is not a
 * bypass: it has always run the edit guard, independent of these keys.)
 *
 * Known limit: the gate runs outside any transaction and takes no customer advisory lock, so two
 * concurrent creates / hand-overs for one customer can both pass on the same exposure.
 */
export async function assertCreditAtEnforcementPoint(
  deps: CreditEnforcementDeps,
  p: CreditPointParams & { tenantId: string | null | undefined },
): Promise<void> {
  const action = p.action ?? "order";
  if (!p.tenantId) return; // no tenant = no switch to read = OFF
  let mode: CreditEnforcementMode;
  try {
    mode = await creditEnforcementMode(deps.prisma, p.tenantId, action);
  } catch (err) {
    deps.logger.error(
      `credit enforcement switch unreadable (treated as off): tenant=${p.tenantId}`,
      err,
    );
    return;
  }
  if (mode === "OFF") return;
  try {
    const enabled = await isCreditLimitCheckEnabled(deps);
    await assertWithinCreditLimit(
      deps.prisma.forTenant(),
      p.customerId,
      p.excludeOrderId ?? null,
      p.projectedTotal,
      enabled,
      { action },
    );
  } catch (e) {
    if (mode === "ENFORCED") {
      if (isCreditLimitExceeded(e) && restrictionChannelForPrincipal(p.principal) !== "STAFF")
        throw new ConflictException({
          code: API_ERROR_CODES.CREDIT_LIMIT_EXCEEDED,
          message: GENERIC_DENIAL,
        });
      throw e;
    }
    if (!isCreditLimitExceeded(e)) {
      deps.logger.error(
        `credit check unavailable, allowing (dark): tenant=${p.tenantId} customer=${p.customerId}`,
        e,
      );
      return;
    }
    const { limit, exposure } = e.getResponse() as { limit: number; exposure: number };
    deps.logger.warn(
      `credit limit would DENY a ${ACTION_LABEL[action]} (dark): tenant=${p.tenantId} ` +
        `customer=${p.customerId} exposure=${exposure} limit=${limit}`,
    );
  }
}
