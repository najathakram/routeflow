import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * B1095: runs `OrdersService.changeStatus`'s generic status write, which the caller issues as
 * `order.update({ where: { id, status: <the status the transition was validated against> } })` — a
 * compare-and-set. A cancel (or any other status change) that committed between the unlocked pre-read
 * and this write leaves no row matching, Prisma raises P2025, and it becomes the same 409 the cancel's
 * own claim answers with — never an overwrite of the newer status (a cancelled order resurrected with
 * its invoices voided and its stock already credited back). Any other error passes through untouched.
 */
export async function writeStatusIfUnchanged<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    if ((e as { code?: string } | null)?.code !== "P2025") throw e;
    throw new ConflictException({
      code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT,
      message:
        "The order's status changed while this change was being made — review it and try again.",
    });
  }
}
