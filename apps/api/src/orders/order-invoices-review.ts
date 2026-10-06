/**
 * B1116: the staff order detail's `invoicesNeedReview` field — an office-visible "Invoices need
 * review" signal, so staff see an order whose invoices no longer match its lines BEFORE Mark
 * Delivered / Generate Invoice answers 409 ORDER_INVOICES_NEED_REVIEW. Kept out of
 * orders.service.ts (size ratchet).
 *
 *  - ON/OFF comes ONLY from #3216's derived `invoicesNeedReview(db, orderId)` — the very predicate
 *    the billing writers' guard uses — so the badge can never disagree with the 409 and clears by
 *    itself once staff fix the invoices. Never from an audit row.
 *  - STAFF ONLY, failing closed: an OPERATOR or TENANT_ADMIN who is not the buyer principal. A
 *    buyer, a customer, a driver, or a buyer pseudo-user wearing role OPERATOR (`type: "BUYER"`,
 *    how the buyer routes skip a userId lookup) gets NO field and NO extra query.
 *  - `flaggedAtStop` is decoration: when a driver's stop completion left an ORDER_INVOICES_NEED_REVIEW
 *    audit row, the latest one (tenant-scoped, by the (entityType, entityId) index) names who and when.
 *    It never changes `flagged`, and any failure reading it just leaves it out.
 *  - Advisory: a failing check never fails the order read — the field is simply absent.
 *
 * Cost (staff read only): the predicate is 3 indexed statements (Invoice.orderId, InvoiceItem.invoiceId,
 * OrderItem.orderId), and only a FLAGGED order adds the audit read (AuditLog entityType+entityId) and a
 * user primary-key read.
 */
import { Logger } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import type { OrderInvoicesNeedReview } from "@routeflow/types";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  ORDER_INVOICES_NEED_REVIEW_MESSAGE,
  invoicesNeedReview,
} from "../invoices/invoice-partition";

/**
 * The audit action a driver's stop completion writes when it leaves an order's invoices for review.
 * It is spelled exactly like the 409 code, so it goes through the same named constant (the
 * error-code parity spec forbids a bare literal of it anywhere in production source).
 */
export const ORDER_INVOICES_NEED_REVIEW_AUDIT_ACTION = API_ERROR_CODES.ORDER_INVOICES_NEED_REVIEW;

const logger = new Logger("OrderInvoicesReview");

/** The office roles that see the field. Fails closed: the buyer principal never does, whatever its role. */
export function seesInvoicesNeedReview(user: Pick<JwtPayload, "role" | "type">): boolean {
  return (
    user.type !== "BUYER" &&
    (user.role === UserRole.OPERATOR || user.role === UserRole.TENANT_ADMIN)
  );
}

interface AuditUserReader {
  auditLog: {
    findFirst(args: {
      where: { tenantId: string; action: string; entityType: { in: string[] }; entityId: string };
      orderBy: { createdAt: "desc" };
      select: { userId: true; createdAt: true };
    }): Promise<{ userId: string | null; createdAt: Date } | null>;
  };
  user: {
    findFirst(args: {
      where: { id: string; tenantId: string };
      select: { username: true; driver: { select: { contactName: true } } };
    }): Promise<{ username: string; driver: { contactName: string | null } | null } | null>;
  };
}

/** Who flagged the order at a stop, and when — from the latest tenant-scoped audit row, or undefined. */
async function flaggedAtStop(
  db: AuditUserReader,
  order: { id: string; tenantId?: string | null },
): Promise<OrderInvoicesNeedReview["flaggedAtStop"]> {
  // No tenant on the order row means no way to scope the read: leave the detail out (fail closed).
  if (!order.tenantId) return undefined;
  try {
    const row = await db.auditLog.findFirst({
      where: {
        tenantId: order.tenantId,
        action: ORDER_INVOICES_NEED_REVIEW_AUDIT_ACTION,
        entityType: { in: ["order", "Order"] },
        entityId: order.id,
      },
      orderBy: { createdAt: "desc" },
      select: { userId: true, createdAt: true },
    });
    if (!row?.userId) return undefined;
    const who = await db.user.findFirst({
      where: { id: row.userId, tenantId: order.tenantId },
      select: { username: true, driver: { select: { contactName: true } } },
    });
    if (!who) return undefined;
    return { by: who.driver?.contactName?.trim() || who.username, at: row.createdAt.toISOString() };
  } catch (err) {
    logger.warn(`flaggedAtStop for order ${order.id} skipped: ${(err as Error)?.message ?? err}`);
    return undefined;
  }
}

/**
 * Stamp `order.invoicesNeedReview` for a staff reader; do nothing (and run no query) for anyone else.
 * `db` is the tenant-scoped client (`prisma.forTenant()`).
 */
export async function attachInvoicesNeedReview(
  db: AuditUserReader,
  order: { id: string; tenantId?: string | null },
  user: Pick<JwtPayload, "role" | "type">,
): Promise<void> {
  if (!seesInvoicesNeedReview(user)) return;
  try {
    if (!(await invoicesNeedReview(db, order.id))) {
      (order as { invoicesNeedReview?: OrderInvoicesNeedReview }).invoicesNeedReview = {
        flagged: false,
      };
      return;
    }
    const out: OrderInvoicesNeedReview = {
      flagged: true,
      reason: ORDER_INVOICES_NEED_REVIEW_MESSAGE,
    };
    const stop = await flaggedAtStop(db, order);
    if (stop) out.flaggedAtStop = stop;
    (order as { invoicesNeedReview?: OrderInvoicesNeedReview }).invoicesNeedReview = out;
  } catch (err) {
    logger.warn(
      `invoicesNeedReview for order ${order.id} skipped: ${(err as Error)?.message ?? err}`,
    );
  }
}
