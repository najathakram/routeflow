import { ConflictException } from "@nestjs/common";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import type { PrismaService } from "../prisma/prisma.service";
import { restrictionChannelForPrincipal } from "../selling-restrictions/selling-restrictions.core";
import type { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { channelsToJudge, resolveLineAuthors } from "./line-author-channel";
import { latestEditRevisionNumber } from "./order-revisions";
import { EDIT_REVISIONS } from "./ship-state-markers";

/**
 * What `OrdersService.changeStatus` judged when it promoted a DRAFT: the product ids the selling-restrictions check
 * saw and the order's latest edit revision at that moment. Both are re-read INSIDE the promotion transaction
 * (`assertJudgementHolds`): a product added, or a line quantity raised (a new revision), after the check was never
 * judged on its author's channel.
 */
export interface DraftPromotionJudgement {
  productIds: ReadonlySet<string>;
  revision: number;
}

/**
 * Promoting a DRAFT is when it becomes a real sale, so the license guard and the selling-restrictions choke point run
 * now (drafts are created and edited without them: the "draft escape"). Extracted verbatim from `changeStatus` (size
 * ratchet) and extended (F1 i): each LISTED line is judged at the STRICTER of the promoter's channel and the channel of
 * the line's author (`line-author-channel.ts`), one choke-point call per distinct channel (ONE for a staff-built draft
 * a staff member promotes). Runs before any status write; a refusal throws with nothing written.
 */
export async function judgeDraftPromotion(
  deps: {
    prisma: PrismaService;
    authGuard: Pick<AuthorizationGuardService, "assertAuthorizedOrThrow">;
    restrictions: Pick<SellingRestrictionsService, "assertLinesSellable">;
  },
  a: {
    order: {
      id: string;
      customerId: string;
      source?: string | null;
      sourceRecorded?: boolean | null;
      createdAt?: Date | string | null;
    };
    user: JwtPayload;
    tenantId: string;
  },
): Promise<DraftPromotionJudgement> {
  const { prisma, authGuard, restrictions } = deps;
  const { order, user, tenantId } = a;
  const items = await prisma.forTenant().orderItem.findMany({
    where: { orderId: order.id, status: { not: "CANCELLED" } },
    // SA ruling (#3418): each line's explicit author marker; never its createdAt.
    select: { productId: true, trackedCategoryId: true, authorChannel: true },
  });
  const pids = items.map((li) => li.productId).filter(Boolean) as string[];
  const products = pids.length
    ? await prisma.forTenant().product.findMany({
        where: { id: { in: pids } },
        select: { id: true, trackedCategoryId: true },
      })
    : [];
  const catByProduct = new Map(products.map((p) => [p.id, p.trackedCategoryId]));
  await authGuard.assertAuthorizedOrThrow({
    customerId: order.customerId,
    lines: items.map((li) => ({
      trackedCategoryId:
        li.trackedCategoryId ?? (li.productId ? (catByProduct.get(li.productId) ?? null) : null),
    })),
    orderId: order.id,
  });
  const revisions =
    (await prisma.forTenant().orderRevision.findMany({
      where: { orderId: order.id, ...EDIT_REVISIONS.where },
      orderBy: EDIT_REVISIONS.orderBy,
      select: { revisionNumber: true, editedByRole: true, snapshot: true },
    })) ?? [];
  const authors = resolveLineAuthors(order, revisions, items);
  const promoter = restrictionChannelForPrincipal(user); // judged at ENTRY time, like the license guard
  const groups = channelsToJudge([...new Set(pids)], authors, promoter);
  const idsOn = (c: string) => groups.find((g) => g.channel === c)?.productIds ?? [];
  const lines = (ids: string[]) => ids.map((productId) => ({ productId }));
  const base = { tenantId, customerId: order.customerId };
  // BUYER_PORTAL first: the always-applying side refuses before the optional one.
  if (idsOn("BUYER_PORTAL").length)
    await restrictions.assertLinesSellable({
      ...base,
      lines: lines(idsOn("BUYER_PORTAL")),
      channel: "BUYER_PORTAL",
    });
  if (idsOn("STAFF").length)
    await restrictions.assertLinesSellable({
      ...base,
      lines: lines(idsOn("STAFF")),
      channel: "STAFF",
    });
  return {
    productIds: new Set(pids),
    revision: Math.max(0, ...revisions.map((r) => r.revisionNumber ?? 0)),
  };
}

/** In the promotion transaction: refuses (409, retryable) when the order changed since `judgeDraftPromotion` read it. */
export async function assertJudgementHolds(
  judged: DraftPromotionJudgement | undefined,
  tx: { orderRevision: { aggregate(args: any): Promise<any> } },
  orderId: string,
  activeItems: ReadonlyArray<{ productId: string | null }>,
): Promise<void> {
  if (
    !judged ||
    activeItems.some((li) => li.productId && !judged.productIds.has(li.productId)) ||
    (await latestEditRevisionNumber(tx, orderId)) !== judged.revision
  )
    throw new ConflictException(
      "The order's items changed while it was being promoted — review it and promote again.",
    );
}
