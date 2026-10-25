/**
 * Row 562 S1: `GET inventory/stock-counts/:id/progress`, the read behind "Resetting 1,200 of 3,412" and
 * "Partly saved". A PURE read (no write, no lock, no transaction): one session row with its line count, and,
 * only while the count is OPEN / REVIEW, the movements of its reference. The lines are loaded only when such
 * a movement exists, to say how many of the lines that write one are done (`computeCommitProgress`).
 */
import { NotFoundException } from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service";
import {
  computeCommitProgress,
  OPEN_COUNT_STATUSES,
  stockCountReference,
  type StockCountProgress,
} from "./stock-count-commit";

export async function readStockCountProgress(
  prisma: PrismaService,
  id: string,
): Promise<StockCountProgress> {
  const db = prisma.forTenant();
  const session = await db.stockCountSession.findUnique({
    where: { id },
    select: { id: true, status: true, startedAt: true, _count: { select: { lines: true } } },
  });
  if (!session) throw new NotFoundException("Stock count session not found");
  const base = {
    status: session.status as StockCountProgress["status"],
    lineCount: session._count.lines,
  };
  if (!(OPEN_COUNT_STATUSES as readonly string[]).includes(session.status)) {
    return { ...base, commit: null };
  }
  const moves = await db.stockMovement.findMany({
    where: { reference: stockCountReference(id), createdAt: { gte: session.startedAt } },
    select: { productId: true, type: true },
  });
  if (moves.length === 0) return { ...base, commit: null };
  const lines = await db.stockCountLine.findMany({
    where: { sessionId: id },
    select: { productId: true, mode: true, countedQty: true, expectedQty: true },
  });
  return { ...base, commit: computeCommitProgress(lines, moves) };
}
