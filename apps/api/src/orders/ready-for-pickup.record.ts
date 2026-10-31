import type { ReadyForPickupLast, ReadyForPickupNotice } from "@routeflow/types";
import { Logger } from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service";
import type { SendOutcome } from "../messaging/messaging.service";
import { readyNoticeOf } from "./ready-for-pickup.notice";

/**
 * The record of "the customer was told" (SA-1070, W-1060): the `order.ready_for_pickup` audit row both senders write,
 * the Ready press and the PATCH status path. The action name lives here once. Note the entity type is the lowercase
 * "order" (the counter-complete claim row beside it says "Order").
 */
export const READY_FOR_PICKUP_ACTION = "order.ready_for_pickup";
export const READY_RECORD_ROWS = 20;

/**
 * Every notice a row can carry. A local copy on purpose: `@routeflow/types` resolves to raw TypeScript at runtime, so the
 * compiled API (`node dist/main.js`) may import only types from it. ready-for-pickup.record.spec.ts pins this list
 * set-equal to the shared READY_FOR_PICKUP_NOTICE_VALUES, so it cannot drift.
 */
export const READY_RECORD_NOTICES: readonly ReadyForPickupNotice[] = [
  "SENT",
  "NO_EMAIL",
  "OPTED_OUT",
  "OFF",
  "FAILED",
];

const log = new Logger("ReadyForPickupRecord");

/**
 * Newest first, capped. `lastSent` is the newest SENT row: only a send that went latches, so a later failed resend
 * never hides the first send. A record that cannot be read answers "no record" (the worst case is today's extra email;
 * the move never fails).
 */
export async function readyRecord(
  prisma: Pick<PrismaService, "forTenant">,
  tenantId: string | null | undefined,
  orderId: string,
): Promise<{ lastSent: ReadyForPickupLast | null; last: ReadyForPickupLast | null }> {
  const none = { lastSent: null, last: null };
  if (!tenantId) return none;
  try {
    const rows = await prisma.forTenant().auditLog.findMany({
      where: { tenantId, entityType: "order", entityId: orderId, action: READY_FOR_PICKUP_ACTION },
      orderBy: { createdAt: "desc" },
      take: READY_RECORD_ROWS,
      select: { meta: true, createdAt: true },
    });
    const sends: ReadyForPickupLast[] = [];
    for (const r of rows ?? []) {
      const m = (r.meta ?? {}) as { notice?: string; email?: string };
      const notice = READY_RECORD_NOTICES.find((n) => n === m.notice);
      if (!notice) continue;
      sends.push({
        notice,
        ...(m.email ? { email: m.email } : {}),
        at: new Date(r.createdAt).toISOString(),
      });
    }
    return { lastSent: sends.find((s) => s.notice === "SENT") ?? null, last: sends[0] ?? null };
  } catch (err) {
    log.warn(`ready record unreadable: ${err instanceof Error ? err.message : err}`);
    return none;
  }
}

/**
 * The PATCH status path's side of the record (SA-1070 rule 3): the READY_FOR_PICKUP email it fires now writes the same
 * row the press does. A missing result (a mocked or older engine) counts as no send; a failed write never fails the move.
 */
export async function recordPatchSend(
  deps: { prisma: PrismaService },
  order: { id: string; customerId: string },
  userSub: string | null | undefined,
  outcomes: SendOutcome[] | void,
): Promise<void> {
  if (!Array.isArray(outcomes)) return;
  try {
    const tenantId = deps.prisma.getTenantId();
    const customer = await deps.prisma.forTenant().customer.findFirst({
      where: { id: order.customerId },
      select: { email: true, orderStatusEmails: true },
    });
    const done = readyNoticeOf(outcomes, {
      email: customer?.email ?? null,
      orderStatusEmails: customer?.orderStatusEmails ?? true,
    });
    await deps.prisma.auditLog.create({
      data: {
        tenantId,
        userId: userSub ?? null,
        action: READY_FOR_PICKUP_ACTION,
        entityType: "order",
        entityId: order.id,
        meta: { notice: done.notice, ...(done.email ? { email: done.email } : {}) },
      },
    });
  } catch (err) {
    log.warn(`ready record write failed: ${err instanceof Error ? err.message : err}`);
  }
}
