import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * W1: the one place that touches a tenant's first-question marker, a `SystemConfig` row. It starts `pending` when a
 * sign-up is registered, and ends `answered` (the answer was applied) or `closed` (a setup was kept, or the back office
 * got there first). No existing tenant holds the row, so no existing tenant ever sees the card.
 *
 * The close is UPDATE-ONLY and only moves a `pending` row: a back-office apply on a tenant with no marker (or an
 * already-closed one) writes nothing here, and a row is never created outside `createPendingFirstRun`.
 */
export const FIRST_RUN_KEY = "signup.firstRun";
export type FirstRunMarker = "pending" | "answered" | "closed";

type Db = Pick<PrismaClient | Prisma.TransactionClient, "systemConfig">;

export async function readFirstRun(db: Db, tenantId: string): Promise<FirstRunMarker | null> {
  const row = await db.systemConfig.findUnique({
    where: { tenantId_key: { tenantId, key: FIRST_RUN_KEY } },
    select: { value: true },
  });
  if (row?.value === "pending" || row?.value === "answered" || row?.value === "closed") {
    return row.value;
  }
  return null;
}

/** Called by `register()` inside its transaction, so the marker exists exactly when the tenant does. */
export async function createPendingFirstRun(db: Db, tenantId: string): Promise<void> {
  await db.systemConfig.create({ data: { tenantId, key: FIRST_RUN_KEY, value: "pending" } });
}

/** `pending` -> `answered` | `closed`. True when a row moved. Never creates a row; never moves a closed one. */
export async function closeFirstRun(
  db: Db,
  tenantId: string,
  to: "answered" | "closed",
): Promise<boolean> {
  const { count } = await db.systemConfig.updateMany({
    where: { tenantId, key: FIRST_RUN_KEY, value: "pending" },
    data: { value: to },
  });
  return count > 0;
}
