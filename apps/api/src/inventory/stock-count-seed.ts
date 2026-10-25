/**
 * Row 562 S1: the ONE batched writer of pre-filled StockCountLine rows (a count amendment today; the
 * stock reset and its undo next). `stock-count-line-writers.spec.ts` pins that nothing else creates a line
 * except `upsertStockCountLine` (one line a person adds).
 *
 * WHY BATCHED. An amendment used to take one advisory lock per product and create one line per product in a
 * SINGLE 15 s transaction: a 3.4k-line count cannot finish in it. Now every batch of COUNT_SEED_BATCH lines
 * is its own short transaction, in the order of the sorted product ids:
 *   1. the batch's `stock-count-product:<tenantId>:<productId>` locks, in ONE sorted statement
 *      (`advisoryXactLocks`), so two seeders can never deadlock and an add of the same product waits;
 *   2. the one-open-count-per-product re-check (SA-767 r-note 5 SA-3), read AFTER the locks;
 *   3. the live stock of the batch's products, read in the same transaction: the line's `expectedQty`
 *      baseline (a sale that lands later survives, because the commit applies `counted - expected`);
 *   4. `createMany(skipDuplicates)`. The tenant extension injects `tenantId` into a direct createMany
 *      (a NESTED write would bypass it), and skipDuplicates makes a retried batch a no-op.
 * An order waits for at most one batch: the seeder takes no Product row lock.
 *
 * A conflict found in a later batch means other counts took products after the caller's pre-check: the
 * seeder throws the 409 and the caller discards its session (`discardUnfinishedSeed`), so a half-seeded
 * OPEN count never blocks products. The caller owns that, because it created the session.
 */
import { Prisma } from "@prisma/client";
import { advisoryXactLocks } from "../common/db-locks";
import { STOCK_TX_OPTIONS } from "../common/product-locks";
import type { PrismaService } from "../prisma/prisma.service";
import { retryStockTx } from "../common/tx-retry";
import {
  OPEN_COUNT_STATUSES,
  productInOpenCount,
  STOCK_COUNT_PRODUCT_LOCK_FAMILY,
  type OpenCountConflict,
} from "./stock-count-commit";

/** Lines per seeding transaction: bounds how long one batch holds its product locks. */
export const COUNT_SEED_BATCH = 200;

/** A line to pre-fill: the count as the caller wants it. `expectedQty` is stamped here, never passed in. */
export interface SeedLine {
  productId: string;
  mode: "REPLACE" | "ADD";
  countedQty: Prisma.Decimal;
  boxes: number | null;
  pieces: number | null;
}

/**
 * SA-767 r-note 5 SA-3: the products among `productIds` that already have a line on ANOTHER open
 * (OPEN / REVIEW) count of the tenant, one row per (product, session). `excludeSessionId` is the count
 * being added to / committed. Read it AFTER the product lock when deciding an add.
 */
export async function findOpenCountConflicts(
  db: {
    stockCountLine: { findMany(args: Prisma.StockCountLineFindManyArgs): Promise<unknown[]> };
  },
  productIds: string[],
  excludeSessionId?: string,
): Promise<OpenCountConflict[]> {
  if (productIds.length === 0) return [];
  const rows = (await db.stockCountLine.findMany({
    where: {
      productId: { in: productIds },
      ...(excludeSessionId ? { sessionId: { not: excludeSessionId } } : {}),
      session: { status: { in: [...OPEN_COUNT_STATUSES] } },
    },
    select: {
      productId: true,
      product: { select: { name: true } },
      session: { select: { id: true, name: true } },
    },
    orderBy: [{ productId: "asc" }, { sessionId: "asc" }],
  })) as Array<{
    productId: string;
    product?: { name?: string | null } | null;
    session: { id: string; name: string | null };
  }>;
  const seen = new Set<string>();
  const out: OpenCountConflict[] = [];
  for (const r of rows ?? []) {
    const key = `${r.productId}:${r.session.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      productId: r.productId,
      productName: r.product?.name ?? null,
      sessionId: r.session.id,
      sessionName: r.session.name ?? null,
    });
  }
  // Deterministic whatever order the rows came in: by product, then by the other count.
  return out.sort(
    (x, y) => x.productId.localeCompare(y.productId) || x.sessionId.localeCompare(y.sessionId),
  );
}

/**
 * Seed `lines` into the (already created) session `sessionId`, COUNT_SEED_BATCH per transaction. A product
 * given twice is one line (the first wins: the table is unique per session and product). Throws the coded
 * 409 PRODUCT_IN_OPEN_COUNT on the first batch that finds a conflict (earlier batches stay written: the
 * caller discards the session), or the coded 503 LOCK_UNAVAILABLE when a batch's locks stay busy.
 */
export async function seedStockCountLines(
  prisma: PrismaService,
  args: { sessionId: string; userId: string; lines: SeedLine[]; batchSize?: number },
): Promise<{ seeded: number; batches: number }> {
  const { sessionId, userId } = args;
  const size = Math.max(1, Math.floor(args.batchSize ?? COUNT_SEED_BATCH));
  const byProduct = new Map<string, SeedLine>();
  for (const l of args.lines) if (!byProduct.has(l.productId)) byProduct.set(l.productId, l);
  const lines = [...byProduct.values()].sort((a, b) =>
    a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0,
  );
  if (lines.length === 0) return { seeded: 0, batches: 0 };

  const tenantId = prisma.getTenantId() ?? "";
  let batches = 0;
  for (let i = 0; i < lines.length; i += size) {
    const batch = lines.slice(i, i + size);
    const ids = batch.map((l) => l.productId);
    // eslint-disable-next-line no-await-in-loop
    await retryStockTx("inventory.seedStockCountLines", () =>
      prisma.tenantTransaction(async (tx) => {
        await advisoryXactLocks(
          tx,
          STOCK_COUNT_PRODUCT_LOCK_FAMILY,
          ids.map((id) => `${tenantId}:${id}`),
        );
        const taken = await findOpenCountConflicts(tx, ids, sessionId);
        if (taken.length > 0) throw productInOpenCount(taken);
        // The baseline: today's on-hand, read after the locks in this same transaction. A plain read, not a
        // stock write, so no Product row lock (an order is never made to wait for a seed).
        const products = await tx.product.findMany({
          where: { id: { in: ids } },
          select: { id: true, currentStock: true },
        });
        const stockById = new Map(products.map((p) => [p.id, p.currentStock]));
        await tx.stockCountLine.createMany({
          data: batch.map((l) => ({
            sessionId,
            productId: l.productId,
            mode: l.mode,
            countedQty: l.countedQty,
            boxes: l.boxes,
            pieces: l.pieces,
            expectedQty: stockById.get(l.productId) ?? new Prisma.Decimal(0),
            countedById: userId,
          })),
          skipDuplicates: true,
        });
      }, STOCK_TX_OPTIONS),
    );
    batches += 1;
  }
  return { seeded: lines.length, batches };
}

/**
 * A seed that failed part-way leaves a session with some of its lines. Flip the session to DISCARDED by CAS on
 * OPEN / REVIEW, then remove its lines, in one transaction: the session then holds no product, and the
 * caller can start again. A session a person already committed or discarded is left alone, lines included.
 */
export async function discardUnfinishedSeed(
  prisma: PrismaService,
  sessionId: string,
): Promise<void> {
  await prisma.tenantTransaction(async (tx) => {
    const flipped = await tx.stockCountSession.updateMany({
      where: { id: sessionId, status: { in: [...OPEN_COUNT_STATUSES] } },
      data: { status: "DISCARDED", discardedAt: new Date() },
    });
    if (flipped.count > 0) await tx.stockCountLine.deleteMany({ where: { sessionId } });
  });
}
