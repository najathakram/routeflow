import { keptGivenPaidInstant } from "../common/paid-instant";

/**
 * SA-943 MUST 2: the dates an invoice payment EDIT writes. The edit form resends the date it shows, so a date-only value
 * equal to the stored day keeps the stored instant (no re-stamp to 00:00Z). An edit to TODAY is "now" on the DATABASE
 * clock, the clock a new payment's default and the close cutoff use. `settledAt`: key present = set or (null) clear,
 * key absent = keep what is stored. `datedDto` is the dto the closed-window guard reads.
 */
export async function resolveEditedPaymentDates<
  D extends { paidAt?: string; settledAt?: string | null },
>(
  tx: any,
  dto: D,
  payment: { paidAt: Date; settledAt: Date | null },
  tz: string | null | undefined,
) {
  let dbNowAt: Date | undefined;
  const dbNow = async () =>
    (dbNowAt ??= (await tx.$queryRaw<{ now: Date }[]>`SELECT CURRENT_TIMESTAMP AS now`)[0]
      .now as Date);
  const keptGiven = dto.paidAt ? keptGivenPaidInstant(dto.paidAt, payment.paidAt, tz) : null;
  const keptPaidAt = dto.paidAt && keptGiven === null ? await dbNow() : keptGiven;
  const keptSettledAt =
    dto.settledAt === undefined
      ? undefined
      : dto.settledAt
        ? (keptGivenPaidInstant(dto.settledAt, payment.settledAt, tz, undefined, "settledAt") ??
          (await dbNow()))
        : null;
  const movedPaidAt =
    keptPaidAt && keptPaidAt.getTime() !== payment.paidAt.getTime() ? keptPaidAt : undefined;
  return {
    keptSettledAt,
    movedPaidAt,
    datedDto: { ...dto, paidAt: keptPaidAt ?? undefined },
  };
}
