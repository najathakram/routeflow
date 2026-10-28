/**
 * Row 562 S1: the ONE batched writer of pre-filled StockCountLine rows (a count amendment today; the
 * stock reset and its undo next). `stock-count-line-writers.spec.ts` pins that nothing else creates a line
 * except `upsertStockCountLine` (one line a person adds).
 *
 * WHY BATCHED. An amendment used to take one advisory lock per product and create one line per product in a
 * SINGLE 15 s transaction: a 3.4k-line count cannot finish in it. Now every batch of COUNT_SEED_BATCH lines
 * is its own short transaction, in the order of the sorted product ids:
 *   0. the session's SHARED `stock-count:<sessionId>` try-lock (the one `upsertStockCountLine` takes) and a
 *      read of the session's status, both in this transaction: a committer holding the count, or a session that is
 *      no longer OPEN, refuses the batch with the 409 STOCK_COUNT_COMMITTING before a line is written. A commit or
 *      discard that lands between two batches stops the seed at the next one, so nothing is written to a
 *      COMMITTED / DISCARDED count after it;
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
 *
 * SA-999 - THE SEED-STATE. The caller sets `StockCountSession.seedPlannedLines` in the same create that makes the
 * session OPEN; the FINAL batch stamps `seedCompletedAt` inside its own transaction, under the shared lock and
 * after the OPEN check, so the last lines and the stamp commit together. A count with a planned number and no stamp
 * is "seeding" (`stockCountSeedState`): the commit refuses it with 409 STOCK_COUNT_SEEDING, whether the seed is
 * between two batches or its process died (a column survives a crash; a lock dies with its holder). The stamp
 * is written in ONE place, `seedCompletionStamp`, which the final batch and the create of a 0-line seed both
 * use (`stock-count-seed-state.spec.ts` pins the count of writers at 1).
 */
import { NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { advisoryXactLocks, tryAdvisoryXactLockShared } from "../common/db-locks";
import { STOCK_TX_OPTIONS } from "../common/product-locks";
import type { PrismaService } from "../prisma/prisma.service";
import { retryStockTx } from "../common/tx-retry";
import {
  OPEN_COUNT_STATUSES,
  productInOpenCount,
  STOCK_COUNT_LOCK_FAMILY,
  STOCK_COUNT_PRODUCT_LOCK_FAMILY,
  stockCountCommitting,
  type OpenCountConflict,
} from "./stock-count-commit";

/** Lines per seeding transaction: bounds how long one batch holds its product locks. */
export const COUNT_SEED_BATCH = 200;

/**
 * SA-999: the ONE place `StockCountSession.seedCompletedAt` is written. The final seed batch spreads it into its
 * session update; the create of a 0-line seed spreads it into the create. A second writer is a second way a count
 * can read "complete" while lines are missing, so the census pins this module's single site.
 */
export function seedCompletionStamp(at: Date = new Date()): { seedCompletedAt: Date } {
  return { seedCompletedAt: at };
}

/** A line to pre-fill: the count as the caller wants it. `expectedQty` is stamped here, never passed in. */
export interface SeedLine {
  productId: string;
  mode: "REPLACE" | "ADD";
  countedQty: Prisma.Decimal;
  boxes: number | null;
  pieces: number | null;
}

/**
 * The lines a seed writes: a product given twice is one line (the first wins: the table is unique per session and
 * product), in the order of the sorted product ids. `seedPlannedLines` is this array's length, so the number the
 * session is created with is the number the seed will write.
 */
export function planSeedLines(lines: SeedLine[]): SeedLine[] {
  const byProduct = new Map<string, SeedLine>();
  for (const l of lines) if (!byProduct.has(l.productId)) byProduct.set(l.productId, l);
  return [...byProduct.values()].sort((a, b) =>
    a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0,
  );
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
 * The first thing each seeding batch does, inside its own transaction: the session's SHARED `stock-count`
 * try-lock (the key pair a line edit and a discard take, and the committer holds exclusively across its
 * batches), then the session's status read under it. A busy lock or any status but OPEN is the existing 409
 * STOCK_COUNT_COMMITTING, so a seed can never write a line into a count a commit or discard has taken.
 */
async function enterSeedBatch(tx: Prisma.TransactionClient, sessionId: string): Promise<void> {
  if (!(await tryAdvisoryXactLockShared(tx, STOCK_COUNT_LOCK_FAMILY, sessionId))) {
    throw stockCountCommitting();
  }
  const session = await tx.stockCountSession.findFirst({
    where: { id: sessionId },
    select: { id: true, status: true },
  });
  if (!session) throw new NotFoundException("Stock count session not found");
  if (session.status !== "OPEN") throw stockCountCommitting();
}

/**
 * Seed `lines` into the (already created) session `sessionId`, COUNT_SEED_BATCH per transaction. A product
 * given twice is one line (the first wins: the table is unique per session and product). Throws the coded
 * 409 PRODUCT_IN_OPEN_COUNT on the first batch that finds a conflict (earlier batches stay written: the
 * caller discards the session), the coded 409 STOCK_COUNT_COMMITTING when a committer holds the count or the
 * session is no longer OPEN (a commit or discard raced the seed), or the coded 503 LOCK_UNAVAILABLE when a
 * batch's locks stay busy.
 */
export async function seedStockCountLines(
  prisma: PrismaService,
  args: { sessionId: string; userId: string; lines: SeedLine[]; batchSize?: number },
): Promise<{ seeded: number; batches: number }> {
  const { sessionId, userId } = args;
  const size = Math.max(1, Math.floor(args.batchSize ?? COUNT_SEED_BATCH));
  const lines = planSeedLines(args.lines);
  // A seed of 0 lines has no batch: the caller stamped the completion in the create (seedCompletionStamp).
  if (lines.length === 0) return { seeded: 0, batches: 0 };

  const tenantId = prisma.getTenantId() ?? "";
  let batches = 0;
  for (let i = 0; i < lines.length; i += size) {
    const batch = lines.slice(i, i + size);
    const ids = batch.map((l) => l.productId);
    const isFinalBatch = i + size >= lines.length;
    // eslint-disable-next-line no-await-in-loop
    await retryStockTx("inventory.seedStockCountLines", () =>
      prisma.tenantTransaction(async (tx) => {
        await enterSeedBatch(tx, sessionId);
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
        // SA-999: the final batch stamps the completion in THIS transaction, so the last lines and the stamp commit
        // together (a crash before the commit leaves neither). Only a session created with this seed's planned
        // number is stamped: a direct seeder call on a session without one stays "legacy", never "complete".
        if (isFinalBatch) {
          await tx.stockCountSession.updateMany({
            where: {
              id: sessionId,
              status: "OPEN",
              seedPlannedLines: lines.length,
              seedCompletedAt: null,
            },
            data: seedCompletionStamp(),
          });
        }
      }, STOCK_TX_OPTIONS),
    );
    batches += 1;
  }
  return { seeded: lines.length, batches };
}

/**
 * A seed that failed part-way leaves a session with some of its lines. Flip the session to DISCARDED by CAS on
 * OPEN / REVIEW, then remove its lines, in one transaction: the session then holds no product, and the
 * caller can start again. A session a person already committed or discarded is left alone, lines included, and
 * so is one a committer holds: the shared `stock-count` try-lock is taken first, and a busy lock means the
 * committer owns the session now (flipping it here would put a DISCARDED status under a running commit).
 */
export async function discardUnfinishedSeed(
  prisma: PrismaService,
  sessionId: string,
): Promise<void> {
  await prisma.tenantTransaction(async (tx) => {
    if (!(await tryAdvisoryXactLockShared(tx, STOCK_COUNT_LOCK_FAMILY, sessionId))) return;
    const flipped = await tx.stockCountSession.updateMany({
      where: { id: sessionId, status: { in: [...OPEN_COUNT_STATUSES] } },
      data: { status: "DISCARDED", discardedAt: new Date() },
    });
    if (flipped.count > 0) await tx.stockCountLine.deleteMany({ where: { sessionId } });
  });
}
