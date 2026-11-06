import type { PrismaService } from "../prisma/prisma.service";
import { last4 } from "./customer-identity-fields";

/**
 * SA-1084: the customer reply a staff member or the buyer themself gets. The stored tax ID never leaves the server:
 * the reply carries `taxIdLast4`, built here from a server-side select. A driver's reply carries neither (the
 * caller simply does not call this). The raw value is not on the row (the global omit), so there is nothing to strip.
 */
export async function withTaxIdLast4<T extends { id: string }>(
  prisma: PrismaService,
  customer: T,
): Promise<T & { taxIdLast4: string | null }> {
  const row = await prisma
    .forTenant()
    .customer.findFirst({ where: { id: customer.id }, select: { taxId: true } });
  return { ...customer, taxIdLast4: last4(row?.taxId) };
}
