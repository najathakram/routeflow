import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { OrderReviewFlagKind, OrderStatus, UserRole } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import type { PrismaService } from "../../prisma/prisma.service";
import type { CreditPointParams } from "../credit-limit-guard";

/**
 * SA-1124 PR-1a: reading and resolving an order's review flags (written by `offline-create.ts`). Staff only: a customer
 * read never selects flags (and the customer projections are allowlists that would drop them anyway).
 */

/** Kinds a person clears by hand, with a note. Informational or a human judgement (price moved, open order, backorder). */
export const MANUAL_FLAG_KINDS: readonly OrderReviewFlagKind[] = [
  OrderReviewFlagKind.PRICE_CHANGED_OFFLINE,
  OrderReviewFlagKind.OPEN_ORDER_EXISTS,
  OrderReviewFlagKind.BACKORDERED_OFFLINE,
];

/** Kinds that clear only by passing the draft's promotion (the same judgement that refused them online). */
export const GATE_FLAG_KINDS: readonly OrderReviewFlagKind[] = [
  OrderReviewFlagKind.RESTRICTED,
  OrderReviewFlagKind.LICENSE_REQUIRED,
  OrderReviewFlagKind.CREDIT_BLOCKED,
];

export const PASSED_AT_PROMOTION = "passed at promotion";
export const RESOLUTION_MIN = 3;
export const RESOLUTION_MAX = 500; // the migration's OrderReviewFlag_resolution_len CHECK

const RESOLVED_BY = { select: { id: true, username: true } } as const;

/** The `findOne` include for staff: an order's flags, oldest first, with who resolved them. */
export const REVIEW_FLAGS_INCLUDE = {
  reviewFlags: {
    orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
    include: { resolvedBy: RESOLVED_BY },
  },
};

const FLAG_READERS: readonly string[] = [
  UserRole.OPERATOR,
  UserRole.TENANT_ADMIN,
  UserRole.SUPER_ADMIN,
];

/** Whether a caller's order read carries the flags: staff only (never a buyer or a driver). */
export function seesReviewFlags(user: { role?: string } | null | undefined): boolean {
  return !!user?.role && FLAG_READERS.includes(user.role);
}

/**
 * `POST /orders/:id/review-flags/:flagId/resolve`. The flag is looked up by id, order AND the caller's tenant, so another
 * tenant's flag (or a flag of another order) is a 404. An already-resolved flag returns its current state unchanged (200,
 * idempotent: the first resolver and note stay). A RESTRICTED, LICENSE_REQUIRED or CREDIT_BLOCKED flag is 409
 * ORDER_REVIEW_FLAG_NOT_MANUAL: it clears only by passing promotion.
 */
export async function resolveReviewFlag(
  prisma: Pick<PrismaService, "forTenant" | "getTenantId">,
  p: { orderId: string; flagId: string; resolution: string; user: JwtPayload },
) {
  const tenantId = p.user.tenantId ?? prisma.getTenantId();
  if (!tenantId) throw new ForbiddenException("Review flags require a tenant-scoped session");
  const db = prisma.forTenant();
  const where = { id: p.flagId, orderId: p.orderId, tenantId };
  const found = await db.orderReviewFlag.findFirst({ where, include: { resolvedBy: RESOLVED_BY } });
  if (!found) throw new NotFoundException("Review flag not found");
  if (found.resolvedAt) return found;
  if (!MANUAL_FLAG_KINDS.includes(found.kind)) {
    throw new ConflictException({
      code: API_ERROR_CODES.ORDER_REVIEW_FLAG_NOT_MANUAL,
      message:
        "This flag clears when the order passes its checks. It can't be marked reviewed by hand.",
    });
  }
  const resolution = p.resolution?.trim() ?? "";
  if (resolution.length < RESOLUTION_MIN || resolution.length > RESOLUTION_MAX) {
    throw new BadRequestException(
      `Add a note of ${RESOLUTION_MIN} to ${RESOLUTION_MAX} characters.`,
    );
  }
  // Compare-and-set: a concurrent resolver wins, the loser reads the winner's row below (idempotent).
  await db.orderReviewFlag.updateMany({
    where: { ...where, resolvedAt: null },
    data: { resolvedAt: new Date(), resolvedById: p.user.sub, resolution },
  });
  return db.orderReviewFlag.findFirstOrThrow({ where, include: { resolvedBy: RESOLVED_BY } });
}

/**
 * Promoting an offline DRAFT that carries an open CREDIT_BLOCKED flag runs the credit gate with the order's projected
 * total, before any write (SA-1124 item 6). A plain draft is untouched: this reads one indexed count and returns.
 */
export async function assertPromotionCredit(
  prisma: Pick<PrismaService, "forTenant">,
  order: { id: string; customerId: string; total: unknown },
  creditGate: (p: CreditPointParams) => Promise<void>,
  principal: JwtPayload,
): Promise<void> {
  const open = await prisma.forTenant().orderReviewFlag.count({
    where: { orderId: order.id, kind: OrderReviewFlagKind.CREDIT_BLOCKED, resolvedAt: null },
  });
  if (open === 0) return;
  await creditGate({
    customerId: order.customerId,
    projectedTotal: roundMoney(Number(order.total)),
    excludeOrderId: order.id,
    principal,
  });
}

/** In the promotion's transaction: the open RESTRICTED, LICENSE_REQUIRED and CREDIT_BLOCKED flags passed. */
export async function resolveGateFlagsAtPromotion(
  tx: { orderReviewFlag: { updateMany(args: any): Promise<unknown> } },
  order: { id: string; tenantId: string | null },
  userId: string | null,
): Promise<void> {
  // A flag row always carries its tenant (required column), so an order with none has no flags: never an unscoped update.
  if (!order.tenantId) return;
  await tx.orderReviewFlag.updateMany({
    where: {
      orderId: order.id,
      tenantId: order.tenantId,
      kind: { in: [...GATE_FLAG_KINDS] },
      resolvedAt: null,
    },
    data: { resolvedAt: new Date(), resolvedById: userId, resolution: PASSED_AT_PROMOTION },
  });
}

/**
 * The `GET /orders` filter for `needsReview=true`: a live (not CANCELLED) order with any open flag (SA-1134 R-2: a cancel
 * resolves no flag, so a cancelled order keeps its flags; a reopen brings it back by itself). Staff only (the same callers that see the
 * flags): a customer's or driver's list is never filtered, or probed, by flags. The relation filter is NOT tenant-injected
 * by Prisma, so it carries the tenant itself (the caller's, else the request's) and so reads (tenantId, kind, resolvedAt).
 */
export function needsReviewWhere(
  needsReview: boolean | undefined,
  user: JwtPayload,
  requestTenantId?: string | null,
) {
  if (needsReview !== true || !seesReviewFlags(user)) return {};
  const tenantId = user.tenantId ?? requestTenantId ?? null;
  return {
    reviewFlags: { some: { ...(tenantId ? { tenantId } : {}), resolvedAt: null } },
    // An AND clause, not a `status` key: the list assigns this over its own `where`, whose `status` is the caller's filter.
    AND: [{ status: { not: OrderStatus.CANCELLED } }],
  };
}
