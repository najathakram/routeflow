import { OrderStatus, Prisma } from "@prisma/client";

/**
 * B1054: how long a manual "Generate now" stays answerable by the order an earlier press already
 * placed. A double click, a retried request or a Reorder pressed twice lands well inside it; a run
 * minutes later is a deliberate new order and is never swallowed. Measured back from the START of
 * the later request, so a call that waited on the lock behind a slow first one still replays it.
 */
export const GENERATE_NOW_REPLAY_WINDOW_MS = 30_000;

/** The relations a generated order is returned with: one shape for a fresh order and a replayed one. */
export const GENERATED_ORDER_INCLUDE = {
  lineItems: { include: { product: { select: { id: true, name: true, unit: true } } } },
  customer: { select: { id: true, businessName: true } },
} satisfies Prisma.OrderInclude;

export type GeneratedOrder = Prisma.OrderGetPayload<{ include: typeof GENERATED_ORDER_INCLUDE }>;

/** The earliest `createdAt` an earlier order may carry and still be the replay of a run that started at `startedAt`. */
export const replayCutoff = (startedAt: Date): Date =>
  new Date(startedAt.getTime() - GENERATE_NOW_REPLAY_WINDOW_MS);

/**
 * The live (not cancelled) order this template already placed at or after `since`, or null. A
 * cancelled one never answers a later run: the operator cancelled it and ran again on purpose.
 * Template-keyed: a different template of the same customer is its own run.
 */
export async function findReplayOrder(
  db: { order: { findFirst: (args: any) => Promise<unknown> } }, // the tenant client or a tenant tx
  templateId: string,
  since: Date,
): Promise<GeneratedOrder | null> {
  return (await db.order.findFirst({
    where: { templateId, status: { not: OrderStatus.CANCELLED }, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    include: GENERATED_ORDER_INCLUDE,
  })) as GeneratedOrder | null;
}

/**
 * The generating transaction's FIRST statement: serialise manual runs of ONE template on its row
 * (`FOR NO KEY UPDATE` conflicts with itself, not with the `FOR KEY SHARE` an order insert's FK
 * check takes, so nothing else is held up), then look again. A concurrent twin that committed while
 * this call waited is visible to that second read (READ COMMITTED takes a fresh snapshot per
 * statement), so exactly one of two simultaneous presses places an order. The lock lives on the
 * transaction's own connection and ends with it: no in-process lock, no extra pool.
 */
export async function lockTemplateThenFindReplay(
  tx: any,
  templateId: string,
  since: Date,
): Promise<GeneratedOrder | null> {
  await tx.$executeRaw`SELECT id FROM "OrderTemplate" WHERE id = ${templateId} FOR NO KEY UPDATE`;
  return findReplayOrder(tx, templateId, since);
}
