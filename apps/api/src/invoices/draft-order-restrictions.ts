import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { channelsToJudge, resolveLineAuthors } from "../orders/line-author-channel";
import { EDIT_REVISIONS } from "../orders/ship-state-markers";
import { requireRestrictionTenantId } from "../selling-restrictions/restriction-tenant";
import type { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import type { InvoicesService } from "./invoices.service";

type Restrictions = Pick<SellingRestrictionsService, "assertLinesSellable">;

const uniqueIds = (ids: ReadonlyArray<string | null | undefined>): string[] => [
  ...new Set(ids.filter((id): id is string => !!id)),
];

/**
 * F2: a DRAFT order has not been judged by the selling-restrictions engine for these lines since it was placed, so
 * billing it is a sale. It is judged like its PROMOTION: each billed line at the STRICTER of the acting STAFF channel
 * and the channel of whoever authored it (`resolveLineAuthors` / `channelsToJudge`, the same helpers
 * `judgeDraftPromotion` uses), so a buyer-authored draft billed with a deposit (a SENT mirror) is judged on
 * BUYER_PORTAL. Any other status keeps F-05's flag-not-block. Runs BEFORE the transaction and the number
 * reservation. Returns the product ids it judged (null for a non-DRAFT order) so `rejudgeDraftOrderInTx` can tell
 * whether the order moved afterwards. Read-only.
 */
export async function assertDraftOrderSellable(
  deps: {
    restrictions: Restrictions;
    prisma: { forTenant(): any };
  },
  tenantId: string | null | undefined,
  order: {
    id?: string;
    status?: string | null;
    customerId: string | null;
    source?: string | null;
    sourceRecorded?: boolean | null;
    createdAt?: Date | string | null;
    lineItems?: ReadonlyArray<{
      productId?: string | null;
      /** SA ruling (#3418): the line's explicit author marker (NULL = the order-level rule). */
      authorChannel?: string | null;
    }> | null;
  },
  productIds: ReadonlyArray<string | null | undefined>,
): Promise<ReadonlySet<string> | null> {
  if (order.status !== "DRAFT") return null;
  const ids = uniqueIds(productIds);
  const revisions =
    (order.id
      ? await deps.prisma.forTenant().orderRevision.findMany({
          where: { orderId: order.id, ...EDIT_REVISIONS.where },
          orderBy: EDIT_REVISIONS.orderBy,
          select: { editedByRole: true, snapshot: true },
        })
      : null) ?? [];
  const authors = resolveLineAuthors(order, revisions, order.lineItems ?? []);
  const tenant = requireRestrictionTenantId(tenantId);
  const groups = channelsToJudge(ids, authors, "STAFF");
  const idsOn = (c: string) => groups.find((g) => g.channel === c)?.productIds ?? [];
  const lines = (pids: string[]) => pids.map((productId) => ({ productId }));
  const base = { tenantId: tenant, customerId: order.customerId };
  // BUYER_PORTAL first: the always-applying side refuses before the optional one.
  if (idsOn("BUYER_PORTAL").length)
    await deps.restrictions.assertLinesSellable({
      ...base,
      lines: lines(idsOn("BUYER_PORTAL")),
      channel: "BUYER_PORTAL",
    });
  if (idsOn("STAFF").length)
    await deps.restrictions.assertLinesSellable({
      ...base,
      lines: lines(idsOn("STAFF")),
      channel: "STAFF",
    });
  return new Set(ids);
}

/**
 * F2b: the pre-check above runs outside the transaction, so a DRAFT edited between it and the write (a banned product
 * added or swapped) must not be billed on the strength of that stale verdict. INSIDE the transaction, right after the
 * Order row lock and before the invoice row is written, re-read the order's status and the billed lines' CURRENT
 * products and only COMPARE them with the set the pre-check judged. The engine is never called here: it opens its own
 * connection, and doing that while this transaction holds the Order row lock is the nested open the promotion path
 * avoids too (REG-B100-C). A changed set is a retryable 409 ORDER_CHANGED_DURING_EDIT (the promotion path's code); the
 * client retries and the retry re-runs the pre-check. Skipped when the order is no longer a DRAFT (its promotion judged
 * it). A billed line that vanished is the same 409. Read-only; throws before any write.
 */
export async function rejudgeDraftOrderInTx(
  tx: {
    order: { findFirst(args: any): Promise<any> };
    orderItem: { findMany(args: any): Promise<any[]> };
  },
  tenantId: string | null | undefined,
  order: { id: string },
  billedLineIds: readonly string[],
  judged: ReadonlySet<string> | null,
): Promise<void> {
  const row = await tx.order.findFirst({
    where: { id: order.id, ...(tenantId ? { tenantId } : {}) },
    select: { status: true },
  });
  if (row?.status !== "DRAFT") return;
  const lines =
    (await tx.orderItem.findMany({
      where: { id: { in: [...billedLineIds] } },
      select: { id: true, productId: true },
    })) ?? [];
  const changed = () =>
    new ConflictException({
      code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT,
      message: "The order changed while the invoice was being created — review it and try again.",
    });
  if (lines.length !== new Set(billedLineIds).size) throw changed();
  const ids = uniqueIds(lines.map((l) => l.productId));
  if (judged && ids.length === judged.size && ids.every((id) => judged.has(id))) return;
  throw changed();
}

/**
 * Train M1: `assertDraftOrderSellable` with the invoices service's own two deps, so its two call sites stay one
 * statement each (invoices.service.ts sits at its size-ratchet cap). Same check, same 409. The service's deps are
 * private, so they are read with element access (TypeScript's sanctioned escape hatch), never re-typed.
 */
export const judgeDraftOrderSale = (
  svc: InvoicesService,
  tenantId: string | null | undefined,
  order: Parameters<typeof assertDraftOrderSellable>[2],
  productIds: Parameters<typeof assertDraftOrderSellable>[3],
) =>
  assertDraftOrderSellable(
    { restrictions: svc["sellingRestrictions"], prisma: svc["prisma"] },
    tenantId,
    order,
    productIds,
  );
