import { restrictionChannelForPrincipal } from "../selling-restrictions/selling-restrictions.core";
import type { ChannelPrincipal } from "../selling-restrictions/selling-restrictions.core";
import type { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import type { NotificationsService } from "../notifications/notifications.service";
import type { PrismaService } from "../prisma/prisma.service";

/** One banned line of a merged order, surfaced to whoever acted (SA-255). */
export interface BannedMergedLine {
  productId: string;
  productName: string;
  ruleId: string | null;
  message: string;
}

/** What the merge callers pass through: who acted and where the banned lines go (see below). */
export interface MergeWarnOpts {
  /** The acting principal; omitted = an automatic run (judged as the stricter buyer channel). */
  actor?: ChannelPrincipal | null;
  /** F-05 (SA-255): the banned lines of the merged order, for the acting UI (beside onPackMismatch). */
  onBannedLines?: (lines: BannedMergedLine[]) => void;
}
export type MergeWinner = { id: string; tenantId?: string | null } & MergeSide;
export type MergeLosers = Array<{ id: string } & MergeSide>;
type MergeSide = { lineItems: Array<{ productId: string | null }> };
/** What a warning run hands back for the caller to run AFTER it releases the merge lock. */
export type MergePush = (() => Promise<void>) | undefined;

/**
 * F-05 (#2093, SA-255) — MERGE AND WARN. A merge folds orders that were each checked when placed; it sells
 * nothing new, so it is NEVER blocked and never drops or changes a line. It does tell people:
 *  - the non-throwing `checkLinesSellable` runs on the WINNER's folded lines (winner + loser catalog lines)
 *    at the ACTOR's channel: a staff actor is STAFF; a buyer or an automatic run (no principal) is the
 *    stricter BUYER_PORTAL. BLOCK and INDETERMINATE both warn;
 *  - a non-empty set writes ONE AuditLog row (winner, losers, products, rules, channel), an empty set writes
 *    nothing and notifies no one;
 *  - the lines go to `onBannedLines` (beside `onPackMismatch`) so the acting UI can show them;
 *  - ONE operator notification, and only when no staff actor sees the result: a buyer, an automatic run, or a
 *    merge path that wires no `onBannedLines` at all (nobody is shown the lines, so operators are told). The
 *    push is RETURNED as a thunk for the caller to run after it releases the merge lock, never inside it;
 * A standalone function (not a class method) because the merge writes its lines through the pack-group plan;
 * every failure here is swallowed and logged: a warning can never fail a merge that already committed.
 */
export async function warnBannedMergedLines(
  deps: {
    restrictions: Pick<SellingRestrictionsService, "checkLinesSellable">;
    prisma: Pick<PrismaService, "forTenant" | "getTenantId"> & { auditLog: any; user: any };
    notifications: Pick<NotificationsService, "sendToUser">;
    warn: (message: string) => void;
  },
  p: {
    /** Resolved INSIDE the try: a tenant-less caller must never fail a merge that already committed. */
    tenantId: () => string;
    customerId: string;
    winner: { id: string; lineItems: ReadonlyArray<{ productId: string | null }> };
    losers: ReadonlyArray<{ id: string; lineItems: ReadonlyArray<{ productId: string | null }> }>;
    /** The acting principal; null / undefined = an automatic run (sweep, cron), judged as the buyer. */
    actor?: ChannelPrincipal | null;
    onBannedLines?: (lines: BannedMergedLine[]) => void;
  },
): Promise<(() => Promise<void>) | undefined> {
  try {
    const tenantId = p.tenantId();
    const productIds = [
      ...new Set(
        [p.winner, ...p.losers].flatMap((o) =>
          o.lineItems.flatMap((li) => (li.productId ? [li.productId] : [])),
        ),
      ),
    ];
    if (productIds.length === 0) return undefined;
    const channel = restrictionChannelForPrincipal(p.actor);
    const verdict = await deps.restrictions.checkLinesSellable({
      tenantId,
      customerId: p.customerId,
      lines: productIds.map((productId) => ({ productId })),
      channel,
    });
    if (verdict.outcome !== "BLOCK" && verdict.outcome !== "INDETERMINATE") return undefined;
    const banned: BannedMergedLine[] = verdict.reasons.map((r) => ({
      productId: r.productId,
      productName: r.productName,
      ruleId: r.ruleId,
      message: r.message,
    }));
    if (banned.length === 0) return undefined;

    // Rule detail is for staff only (B612): a buyer-side actor gets names, never the rule text.
    p.onBannedLines?.(
      channel === "STAFF"
        ? banned
        : banned.map((b) => ({
            ...b,
            ruleId: null,
            message: `${b.productName} can't be sold right now`,
          })),
    );

    await deps.prisma.auditLog.create({
      data: {
        tenantId,
        userId: null,
        action: "order.merge-banned-lines",
        entityType: "orders",
        entityId: p.winner.id,
        meta: {
          winnerId: p.winner.id,
          loserIds: p.losers.map((l) => l.id),
          productIds: [...new Set(banned.map((b) => b.productId))],
          ruleIds: [...new Set(banned.map((b) => b.ruleId).filter(Boolean))],
          channel,
        },
      },
    });
    // A staff actor who is shown the lines needs no push. Everyone else does — and the push is deferred.
    if (channel === "STAFF" && p.onBannedLines) return undefined;
    const names = [...new Set(banned.map((b) => b.productName))].join(", ");
    return async () => {
      try {
        const operators = await deps.prisma.user.findMany({
          where: { tenantId, role: { in: ["OPERATOR", "TENANT_ADMIN"] }, status: "ACTIVE" },
          select: { id: true },
        });
        for (const op of operators as { id: string }[]) {
          await deps.notifications
            .sendToUser(op.id, {
              title: "Merged order holds restricted items",
              body: `Order ${p.winner.id} was merged and now includes items under a selling restriction (${names}). Review it before dispatch.`,
            })
            .catch(() => {});
        }
      } catch (e) {
        deps.warn(
          `merge notification failed for order ${p.winner.id}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    };
  } catch (e) {
    deps.warn(
      `merge warning failed for order ${p.winner.id}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return undefined;
  }
}
