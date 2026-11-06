import type { PrismaService } from "../prisma/prisma.service";
import { tenantTimeZone } from "../common/tenant-time-zone";
import { OPEN_BALANCE_INVOICE_SELECT, OPEN_BALANCE_INVOICE_WHERE } from "./account-statement";
import { statementOutstandingAmount } from "./customer-statement";

/**
 * SA-1078 (W-1096) PR-5: each customer's Open balance for the customers list and its CSV. One invoice read for the whole set of
 * customers (never one per row), the statement's own where and select, grouped by customer and summed by the one helper the
 * sheet and the customer page use, so the list can never disagree with the sheet it opens. `now` is read once by the caller.
 * Ids are read in chunks so a large export never builds one enormous IN list.
 */
const CHUNK = 1000;

export async function openBalancesByCustomer(
  prisma: PrismaService,
  customerIds: readonly string[],
  now: Date,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (customerIds.length === 0) return out;
  const zone = await tenantTimeZone(prisma);
  for (let i = 0; i < customerIds.length; i += CHUNK) {
    const ids = customerIds.slice(i, i + CHUNK);
    const invoices = await prisma.forTenant().invoice.findMany({
      where: { customerId: { in: ids }, ...OPEN_BALANCE_INVOICE_WHERE },
      select: OPEN_BALANCE_INVOICE_SELECT,
    });
    const byCustomer = new Map<string, typeof invoices>();
    for (const inv of invoices) {
      const group = byCustomer.get(inv.customerId);
      if (group) group.push(inv);
      else byCustomer.set(inv.customerId, [inv]);
    }
    for (const [customerId, group] of byCustomer) {
      out.set(customerId, statementOutstandingAmount(group, zone, now));
    }
  }
  return out;
}
