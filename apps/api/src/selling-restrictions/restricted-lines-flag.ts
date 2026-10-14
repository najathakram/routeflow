import type { SellingRestrictionsService } from "./selling-restrictions.service";
import type { PrismaService } from "../prisma/prisma.service";
import {
  saleFulfilmentKind,
  type SaleFulfilmentFacts,
  type SaleFulfilmentKind,
} from "./sale-fulfilment";

/** One flagged catalog line — mirrors `BannedMergedLine` (merge-restriction-warning.ts). */
export interface RestrictedFlagLine {
  productId: string;
  productName: string;
  ruleId: string | null;
  message: string;
}

/**
 * F-05 (#2093, owner ruling 2026-09-25) — FLAG, NEVER BLOCK. Historical invoice IMPORT and
 * invoice SPLIT are quantity-neutral (import writes every row unchanged; a split's children
 * sum to the parent), so neither may ever be blocked by the selling-restrictions choke point —
 * they only get a visible flag plus an audit line, same shape as the merge-and-warn precedent
 * (`merge-restriction-warning.ts`). This is the non-throwing READ half: it runs
 * `checkLinesSellable` (never `assertLinesSellable`) over the CATALOG (productId != null) lines
 * only — a productless/custom line is exempt (owner ruling 2026-09-25) — and returns what BLOCK
 * or INDETERMINATE turned up. ALLOW/OFF return empty. A failing check is swallowed and logged:
 * this can NEVER throw or delay the write it is flagging. Channel is always the literal "STAFF"
 * here (channel-required.spec.ts wants a literal at the call site, not a forwarded parameter) —
 * both callers (an office invoice split, a CSV import) are staff-originated paths; neither is a
 * buyer-portal action.
 */
export async function flagRestrictedLines(
  deps: {
    restrictions: Pick<SellingRestrictionsService, "checkLinesSellable">;
    warn: (message: string) => void;
  },
  p: {
    tenantId: string;
    customerId: string | null;
    /** Catalog product ids of the lines being imported/split; a null/undefined entry is dropped. */
    productIds: ReadonlyArray<string | null | undefined>;
    /** L8: the order's fulfilment kind (counter / pickup are judged on the store state): required. */
    fulfilmentKind: SaleFulfilmentKind;
  },
): Promise<RestrictedFlagLine[]> {
  try {
    const productIds = [...new Set(p.productIds.filter((id): id is string => !!id))];
    if (productIds.length === 0) return [];
    const verdict = await deps.restrictions.checkLinesSellable({
      tenantId: p.tenantId,
      customerId: p.customerId,
      lines: productIds.map((productId) => ({ productId })),
      channel: "STAFF",
      fulfilmentKind: p.fulfilmentKind,
    });
    if (verdict.outcome !== "BLOCK" && verdict.outcome !== "INDETERMINATE") return [];
    return verdict.reasons.map((r) => ({
      productId: r.productId,
      productName: r.productName,
      ruleId: r.ruleId,
      message: r.message,
    }));
  } catch (e) {
    deps.warn(`restricted-lines flag check failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/**
 * Invoice SPLIT (#2093): flag the order's catalog lines (never block) and write the ONE audit row
 * for a non-empty set. The audit goes through `prisma` — the plain client, never the caller's tx
 * (`createInvoiceFromOrder` may run inside one, and a failed statement would abort it). It names
 * the ORDER being invoiced, so it stays true even if the caller's transaction later rolls back:
 * "invoicing this order carried restricted lines". The children inherit the returned flags.
 */
export async function flagSplitRestrictedLines(
  restrictions: Pick<SellingRestrictionsService, "checkLinesSellable">,
  prisma: { auditLog: Pick<PrismaService["auditLog"], "create"> },
  logger: { warn: (message: string) => void },
  p: {
    tenantId: string | null;
    order: { id: string; customerId: string | null } & SaleFulfilmentFacts;
    remainingItems: ReadonlyArray<{ li: { productId?: string | null } }>;
  },
): Promise<RestrictedFlagLine[]> {
  const warn = (m: string) => logger.warn(m);
  const tenantId = p.tenantId ?? "";
  const flagged = await flagRestrictedLines(
    { restrictions, warn },
    {
      tenantId,
      customerId: p.order.customerId,
      productIds: p.remainingItems.map(({ li }) => li.productId),
      fulfilmentKind: saleFulfilmentKind(p.order),
    },
  );
  if (flagged.length > 0) {
    await writeRestrictedLinesAudit(
      { prisma, warn },
      {
        tenantId,
        action: "invoice.split.restricted_lines",
        entityType: "order",
        entityId: p.order.id,
        meta: { lines: flagged },
      },
    );
  }
  return flagged;
}

/**
 * The ONE audit row for a non-empty flagged set (`invoice.split.restricted_lines` /
 * `invoice.import.restricted_lines`) — written OUTSIDE any caller transaction (`deps.prisma`
 * must be the plain/tenant-scoped client, never a `tx`), so a failed insert can never abort a
 * write that already committed. Swallowed and logged; the caller gates the empty-set case (never
 * called with nothing to report).
 */
export async function writeRestrictedLinesAudit(
  deps: {
    prisma: { auditLog: Pick<PrismaService["auditLog"], "create"> };
    warn: (message: string) => void;
  },
  p: {
    tenantId: string;
    action: string;
    entityType: string;
    entityId: string;
    meta: Record<string, any>;
  },
): Promise<void> {
  try {
    await deps.prisma.auditLog.create({
      data: {
        tenantId: p.tenantId,
        userId: null,
        action: p.action,
        entityType: p.entityType,
        entityId: p.entityId,
        meta: p.meta,
      },
    });
  } catch (e) {
    deps.warn(
      `restricted-lines audit write failed (${p.action}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
