import { ConflictException, Logger } from "@nestjs/common";
import { roundMoney } from "@routeflow/pricing";
import type { EntitlementsService } from "../billing/entitlements.service";
import { loadCreditExposure } from "../invoices/credit-exposure";
import { assertAmbientTenant } from "../common/ambient-tenant";
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
 *     by projectedOrderTotal instead. Exact, not approximate: an editable
 *     order's linked invoice can never carry payments —
 *     revertLinkedInvoicesForOrderEdit (already called by updateOrderItems)
 *     throws if it does;
 *   • credit notes / advance payments are NOT netted (the statement reports
 *     them separately from outstandingAmount; netting loosens a money guard);
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
  /** The order being edited (excluded from every bucket); `null` = a NEW order, nothing to exclude. */
  currentOrderId: string | null,
  projectedOrderTotal: number,
  creditCheckEnabled: boolean,
  /** What the 409 message calls the thing that would breach the limit. */
  action: "edit" | "order" | "delivery" = "edit",
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
  const { counted } = await loadCreditExposure(db, customerId, {
    excludeOrderId: currentOrderId,
  });

  const exposure = roundMoney(counted + projectedOrderTotal);
  if (exposure > limit) {
    throw new ConflictException({
      code: "CREDIT_LIMIT_EXCEEDED",
      message:
        `This ${action} would take the customer's exposure to ${exposure.toFixed(2)}, ` +
        `over their credit limit of ${limit.toFixed(2)}.`,
      limit,
      exposure,
    });
  }
}

// ─── B585: the new enforcement points (create / deliver), dark first ──────────────────────────

/**
 * Per-tenant `SystemConfig` switch (default OFF = DARK) for the credit check at order CREATE and
 * DELIVER: DARK logs "would deny" and never blocks; only the EXACT value `"true"` ENFORCES. It does
 * NOT govern the edit paths (`updateOrderItems` / change requests), which have always blocked.
 */
export const CREDIT_LIMIT_ENFORCE_KEY = "credit_limit.enforce_new_orders";

export type CreditEnforcementMode = "DARK" | "ENFORCED";

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
): Promise<CreditEnforcementMode> {
  assertAmbientTenant(prisma, tenantId, "creditEnforcementMode");
  const row: { value: string } | null = await prisma.forTenant().systemConfig.findFirst({
    where: { tenantId, key: CREDIT_LIMIT_ENFORCE_KEY },
    select: { value: true },
  });
  return row?.value === "true" ? "ENFORCED" : "DARK";
}

const isCreditLimitExceeded = (e: unknown): e is ConflictException =>
  e instanceof ConflictException &&
  (e.getResponse() as { code?: string } | undefined)?.code === "CREDIT_LIMIT_EXCEEDED";

const ACTION_LABEL = { order: "new order", delivery: "delivery" } as const;

/**
 * The credit check at a B585 enforcement point (a NEW order, or an order going out for delivery):
 * same derivation as the edit guard, behind the per-tenant switch. Runs BEFORE any write / stock
 * transaction, so nothing is half-committed and no second pooled connection is taken inside a tx.
 * When the guard would deny: ENFORCED throws its 409; DARK logs one "would deny" line (ids and
 * figures only) and allows. No tenant on the caller = DARK. DARK must never break a create that
 * works today: any failure to reach a verdict (unreadable exposure or switch) logs ERROR and
 * allows; only an ENFORCED tenant sees it. `excludeOrderId` = the order being sent out.
 *
 * ⚠ Do NOT set the switch to "true" for any tenant until the paths that still bypass this check
 * are guarded: DRAFT → PENDING promotion in `changeStatus`, the standing-order cron
 * (`order-templates` writes PENDING orders directly), and the deliver point.
 */
export async function assertCreditAtEnforcementPoint(
  deps: CreditEnforcementDeps,
  p: {
    tenantId: string | null | undefined;
    customerId: string;
    projectedTotal: number;
    excludeOrderId?: string | null;
    action?: keyof typeof ACTION_LABEL;
  },
): Promise<void> {
  const action = p.action ?? "order";
  // An unreadable switch is DARK (allow + ERROR): never a 500 for a create that works today.
  const modeOrDark = async (): Promise<CreditEnforcementMode> => {
    if (!p.tenantId) return "DARK";
    try {
      return await creditEnforcementMode(deps.prisma, p.tenantId);
    } catch (err) {
      deps.logger.error(
        `credit enforcement switch unreadable (treated as dark): tenant=${p.tenantId}`,
        err,
      );
      return "DARK";
    }
  };
  try {
    const enabled = await isCreditLimitCheckEnabled(deps);
    await assertWithinCreditLimit(
      deps.prisma.forTenant(),
      p.customerId,
      p.excludeOrderId ?? null,
      p.projectedTotal,
      enabled,
      action,
    );
  } catch (e) {
    if ((await modeOrDark()) === "ENFORCED") throw e;
    if (!isCreditLimitExceeded(e)) {
      deps.logger.error(
        `credit check unavailable, allowing (dark): tenant=${p.tenantId ?? "none"} customer=${p.customerId}`,
        e,
      );
      return;
    }
    const { limit, exposure } = e.getResponse() as { limit: number; exposure: number };
    deps.logger.warn(
      `credit limit would DENY a ${ACTION_LABEL[action]} (dark): tenant=${p.tenantId ?? "none"} ` +
        `customer=${p.customerId} exposure=${exposure} limit=${limit}`,
    );
  }
}
