import { ConflictException } from "@nestjs/common";
import { OrderStatus } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * B695: the reopen's claim, the first statements of its stock tx. Lock the Order row FOR UPDATE (the house
 * order's domain row, exactly as the cancel does in order-cancel-tx.ts, BEFORE any Product lock the re-booking
 * takes), then compare-and-set CANCELLED -> PENDING on the locked row. Only the caller whose update counts a
 * row goes on to re-read the cancelled lines and re-book their stock; a second concurrent reopen waits on the
 * lock, finds the order already reopened, and gets the coded 409 the cancel and edit paths give a lost race.
 * Without the claim both callers read the same CANCELLED lines and each booked them (stock short by the lines'
 * quantity, a second UNCANCEL movement).
 */
export async function claimReopenInTx(tx: any, id: string): Promise<void> {
  await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${id} FOR UPDATE`;
  const claimed = await tx.order.updateMany({
    where: { id, status: OrderStatus.CANCELLED },
    data: { status: OrderStatus.PENDING },
  });
  if (claimed.count === 0)
    throw new ConflictException({
      code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT,
      message: "The order changed while it was being reopened — review it and try again.",
    });
}
