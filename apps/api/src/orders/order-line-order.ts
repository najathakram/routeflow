import {
  BadRequestException,
  Logger,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { UserRole, type Prisma } from "@prisma/client";
import type { ReorderLinesResponse } from "@routeflow/types";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { lockRowsNoWait } from "../common/db-locks";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { PrismaService } from "../prisma/prisma.service";
import { computeEditWindow } from "./edit-window";
import { seesInvoicesNeedReview } from "./order-invoices-review";
import { followOrderLineOrder } from "../invoices/invoice-follow-order";
import { ORDER_LINE_ORDER_BY } from "./line-position";
import type { ReorderLinesDto } from "./dto/reorder-lines.dto";

const logger = new Logger("OrderLineOrder");

/** The audit action both reorder routes write, and the staff order read looks up. */
export const LINES_REORDERED_ACTION = "order.lines.reordered";

export interface ReorderDeps {
  prisma: PrismaService;
  /** The buyer-facing sentence of a closed edit window (`buyerEditClosedMessage`), for the 403. */
  closedMessage(order: { status: string; tenantId?: string | null }): Promise<string>;
}

/** The refusal for a stale token or a line set that is not the order's lines: the client refetches and retries. */
const changed = () =>
  new ConflictException({
    code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT,
    message: "This order changed on another screen. Reload and try again.",
  });

/**
 * W-1187 (SA ruling D5): put an order's lines in the order the caller arranged them. Its OWN transaction (never through
 * `updateOrderItems`): a caller with no tenant is refused first (403: the scoped `where` would otherwise match any order
 * by id). Then, still before any lock:
 *   1. a buyer must own the order: a bare 403 that names no status and no line (REG-B131 `deletedAt: null`); checked before
 *      the lock so a same-tenant non-owner never gets the lock's 409 and never holds the row;
 * then lock the Order row (NOWAIT: a drag that meets an edit in flight answers a retryable 409 instead of queueing) and,
 * in this order and before anything is written:
 *   2. the status gate: CANCELLED is refused for everyone; a buyer is also refused once the edit window is closed;
 *   3. the CAS on `Order.updatedAt` (409 ORDER_CHANGED_DURING_EDIT);
 *   4. the id set: every line of the order, cancelled and staff-added rows included, each exactly once (the same 409).
 * Only the rows whose position changes are written, as dense 0..n-1; the order's `updatedAt` moves (the next CAS token);
 * one audit row names the caller, their role and the id lists before and after. Reordering is presentation, not the
 * sale: no revision, no ledger, no money, no email. An unchanged order writes nothing and answers the same way.
 */
export async function reorderOrderLines(
  deps: ReorderDeps,
  orderId: string,
  dto: ReorderLinesDto,
  user: JwtPayload,
): Promise<ReorderLinesResponse> {
  const tenantId = deps.prisma.getTenantId();
  // fail closed: without a tenant the scoped `where` below would be `{}` and match any order by id
  if (!tenantId) throw new ForbiddenException("Rearranging lines needs a tenant-scoped session");
  const scoped = { tenantId };
  return deps.prisma.tenantTransaction(async (tx: Prisma.TransactionClient) => {
    // a foreign (or unknown) id is a 404, found before any lock is taken on it
    const known = await tx.order.findFirst({
      where: { id: orderId, ...scoped },
      select: { id: true, customerId: true },
    });
    if (!known) throw new NotFoundException("Order not found");
    // a buyer must own the order, checked BEFORE the lock: a non-owner is a 403, never the lock's 409
    const isBuyer = user.role === UserRole.CUSTOMER;
    if (isBuyer) {
      const owner = await tx.customer.findFirst({ where: { userId: user.sub, deletedAt: null } });
      if (!owner || owner.id !== known.customerId) throw new ForbiddenException();
    }
    await lockRowsNoWait(tx, "Order", [orderId], "ORDER_LINE_ORDER_BUSY");

    const order = await tx.order.findFirst({
      where: { id: orderId, ...scoped },
      select: { id: true, tenantId: true, customerId: true, status: true, updatedAt: true },
    });
    if (!order) throw new NotFoundException("Order not found");

    // the locked read is the truth: an order that changed hands between the two reads is not the buyer's any more
    if (isBuyer && order.customerId !== known.customerId) throw new ForbiddenException();
    if (order.status === "CANCELLED") {
      throw new BadRequestException("Lines can't be rearranged on a cancelled order");
    }
    if (isBuyer && !computeEditWindow(order, UserRole.CUSTOMER).editable) {
      throw new ForbiddenException(await deps.closedMessage(order));
    }
    if (new Date(dto.expectedUpdatedAt).getTime() !== order.updatedAt.getTime()) throw changed();

    const lines = await tx.orderItem.findMany({
      where: { orderId },
      select: { id: true, position: true },
      orderBy: ORDER_LINE_ORDER_BY,
    });
    const have = new Set(lines.map((l) => l.id));
    if (dto.lineIds.length !== lines.length || !dto.lineIds.every((id) => have.has(id))) {
      throw changed(); // missing, extra or foreign (the DTO already refused a duplicate)
    }

    const before = lines.map((l) => l.id);
    const rearranged = dto.lineIds.some((id, i) => id !== before[i]);
    const stored = new Map(lines.map((l) => [l.id, l.position]));
    for (let i = 0; i < dto.lineIds.length; i++) {
      if (stored.get(dto.lineIds[i]) !== i) {
        await tx.orderItem.update({ where: { id: dto.lineIds[i] }, data: { position: i } });
      }
    }

    let updatedAt = order.updatedAt;
    let at = new Date();
    if (rearranged) {
      updatedAt = new Date();
      await tx.order.update({ where: { id: orderId }, data: { updatedAt } });
      await followOrderLineOrder(tx, orderId); // PR-1e: the invoices take the new order in this transaction
      await tx.auditLog.create({
        data: {
          tenantId: order.tenantId,
          userId: user.sub,
          action: LINES_REORDERED_ACTION,
          entityType: "Order",
          entityId: orderId,
          meta: { role: user.role, before, after: dto.lineIds },
        },
      });
    } else {
      const last = await latestRearrangement(tx, orderId);
      at = last?.at ?? at;
    }
    return {
      id: orderId,
      updatedAt: updatedAt.toISOString(),
      lineIds: dto.lineIds,
      linesRearranged: {
        by: user.role === UserRole.CUSTOMER ? "CUSTOMER" : "STAFF",
        at: at.toISOString(),
      },
    };
  });
}

/** The latest reorder of an order from its audit trail: who (by role) and when. Null when it was never rearranged. */
export async function latestRearrangement(
  db: { auditLog: { findFirst: (args: any) => Promise<any> } },
  orderId: string,
): Promise<{ by: "CUSTOMER" | "STAFF"; at: Date } | null> {
  const row = await db.auditLog.findFirst({
    where: { entityType: "Order", entityId: orderId, action: LINES_REORDERED_ACTION },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, meta: true },
  });
  if (!row) return null;
  const role = (row.meta as { role?: string } | null)?.role;
  return { by: role === UserRole.CUSTOMER ? "CUSTOMER" : "STAFF", at: row.createdAt };
}

/**
 * The staff order read's `linesRearranged` ("Customer rearranged the lines · 2:14 PM"): from the latest audit row, one
 * `findFirst` on the (entityType, entityId) index. STAFF ONLY, failing closed (the same office roles as the
 * invoices-need-review signal): a buyer, a driver or a buyer pseudo-user gets no field and no query. Advisory: a failing
 * read leaves the field out, it never fails the order read.
 */
export async function attachLinesRearranged(
  db: Parameters<typeof latestRearrangement>[0],
  order: { id: string },
  user: Pick<JwtPayload, "role" | "type">,
): Promise<void> {
  if (!seesInvoicesNeedReview(user)) return;
  try {
    const last = await latestRearrangement(db, order.id);
    if (last) {
      Object.assign(order, { linesRearranged: { by: last.by, at: last.at.toISOString() } });
    }
  } catch (err) {
    logger.warn(`linesRearranged for order ${order.id} skipped: ${(err as Error)?.message ?? err}`);
  }
}
