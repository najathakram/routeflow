import type { PaymentMethod } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import { paidInstantOf } from "../common/paid-instant";
import { tenantTimeZone } from "../common/tenant-time-zone";

/** The advance-payment row a receipt creates. SA-943: a date-only receivedAt is the tenant-local day (today = now). */
export async function advancePaymentData(
  prisma: Parameters<typeof tenantTimeZone>[0],
  customerId: string,
  dto: {
    amount: number;
    method: PaymentMethod;
    reference?: string;
    notes?: string;
    receivedAt?: string;
  },
) {
  const tz = await tenantTimeZone(prisma);
  return {
    customerId,
    amount: roundMoney(dto.amount),
    balance: roundMoney(dto.amount), // initial balance equals amount
    method: dto.method,
    reference: dto.reference,
    notes: dto.notes,
    receivedAt: paidInstantOf(dto.receivedAt, tz, new Date(), "receivedAt"),
  };
}
