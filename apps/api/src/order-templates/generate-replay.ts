import { OrderStatus, Prisma } from "@prisma/client";

/**
 * B1054: how long a manual "Generate now" stays answerable by the order an earlier press already
 * placed. A double click, a retried request or a Reorder pressed twice lands well inside it; a run
 * minutes later is a deliberate new order and is never swallowed. Measured back from the START of
 * the later request, so a call that waited on the lock behind a slow first one still replays it.
 *
 * ACCEPTED LIMIT (B1054 review): the replay is keyed on a live order carrying this template's id.
 * If that order LOSES a pending-order merge (the customer's other pending orders fold into a newer
 * winner and the loser row is deleted) inside the window, a retry finds no order and places a new
 * one. The merge winner cannot safely carry the marker: its `templateId` belongs to the winner's own
 * template, and re-pointing it would break that template's replay and its provenance. Carrying a
 * marker would also mean touching the merge inside the customer-keyed advisory lock
 * (`withAdvisoryLock`), and no second lock or transaction may be threaded in there. The window is
 * 30 s and the retry is a deliberate repeat, so this stays as is; pinned by
 * `order-templates.generate-replay.spec.ts` and the generate-race DB spec.
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

/** The slice of the tenant client / a tenant transaction the replay lookup needs. */
export type ReplayDb = {
  order: { findFirst: (args: Prisma.OrderFindFirstArgs) => Promise<unknown> };
};

/** A tenant transaction as the template lock sees it: the lookup plus a tagged raw statement. */
export type ReplayTx = ReplayDb & {
  $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
};

/**
 * The live (not cancelled) order this template already placed at or after `since`, or null. A
 * cancelled one never answers a later run: the operator cancelled it and ran again on purpose.
 * Template-keyed: a different template of the same customer is its own run.
 */
export async function findReplayOrder(
  db: ReplayDb, // the tenant client or a tenant tx
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
  tx: ReplayTx,
  templateId: string,
  tenantId: string,
  since: Date,
): Promise<GeneratedOrder | null> {
  // The id alone is unique, but the tenant predicate keeps the raw statement inside its tenant too.
  await tx.$executeRaw`SELECT id FROM "OrderTemplate" WHERE id = ${templateId} AND "tenantId" = ${tenantId} FOR NO KEY UPDATE`;
  return findReplayOrder(tx, templateId, since);
}
