import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * SA-750r3: a closed day's totals never move. Every writer that takes the SHARED counter-close lock (`lockCounterClose`) asks
 * this next: is the instant a payment or refund is DATED (`paidAt` / `refundedAt`, both stamped from the database clock after
 * the lock) inside a window whose close is still in force? A reopened close (`reopenedAt` set) is open again.
 */
type CloseReader = {
  counterDayClose: {
    findFirst: (args: {
      where: {
        tenantId: string;
        registerKey: string;
        reopenedAt: null;
        windowStart: { lte: Date };
        windowEnd: { gt: Date };
      };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
  };
};

/** True when `at` falls inside a window of this (tenant, register) whose close is in force. */
export async function counterWindowClosed(
  db: CloseReader,
  tenantId: string,
  registerKey: string,
  at: Date,
): Promise<boolean> {
  const row = await db.counterDayClose.findFirst({
    where: {
      tenantId,
      registerKey,
      reopenedAt: null,
      windowStart: { lte: at },
      windowEnd: { gt: at },
    },
    select: { id: true },
  });
  return row != null;
}

/** The refusal every closed-window writer throws (fixed copy, 409). */
export function dayClosedConflict(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED,
    message: "This day has been closed. Reopen the close first.",
  });
}

/** Throws COUNTER_SALE_DAY_CLOSED when `at` falls in a closed window of this (tenant, register). */
export async function assertCounterWindowOpen(
  db: CloseReader,
  tenantId: string,
  registerKey: string,
  at: Date,
): Promise<void> {
  if (await counterWindowClosed(db, tenantId, registerKey, at)) throw dayClosedConflict();
}
