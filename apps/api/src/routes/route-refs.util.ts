import { NotFoundException } from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * Reference checks for ids that arrive on route / run writes. Every lookup goes through
 * `forTenant()`, so "resolves" means "resolves inside the caller's tenant".
 */

/**
 * A driver id on a route/run write must resolve inside the caller's tenant before it is stored.
 * Empty/absent values are the caller's "no driver" and are left alone.
 */
export async function assertDriverInTenant(
  prisma: PrismaService,
  driverId: string | null | undefined,
): Promise<void> {
  if (!driverId) return;
  const driver = await prisma
    .forTenant()
    .driver.findFirst({ where: { id: driverId }, select: { id: true } });
  if (!driver) {
    throw new NotFoundException({
      statusCode: 404,
      code: "DRIVER_NOT_FOUND",
      message: "Driver not found",
    });
  }
}

/**
 * Customer and address references stored on a stop must be in the caller's tenant, and an address
 * must belong to the customer it is stored beside. `refs` may carry a null customer or address
 * (legacy stops); only non-null ids are checked. `checkCustomers: false` is for a caller that has
 * already resolved the customer itself.
 */
export async function assertStopRefsInTenant(
  prisma: PrismaService,
  refs: ReadonlyArray<{ customerId?: string | null; customerAddressId?: string | null }>,
  { checkCustomers = true }: { checkCustomers?: boolean } = {},
): Promise<void> {
  const customerIds = checkCustomers
    ? [...new Set(refs.map((r) => r.customerId).filter((v): v is string => !!v))]
    : [];
  if (customerIds.length > 0) {
    const found = await prisma
      .forTenant()
      .customer.findMany({ where: { id: { in: customerIds } }, select: { id: true } });
    if ((found ?? []).length !== customerIds.length) {
      throw new NotFoundException("Customer not found");
    }
  }
  const withAddress = refs.filter((r) => !!r.customerAddressId);
  if (withAddress.length === 0) return;

  const addressIds = [...new Set(withAddress.map((r) => r.customerAddressId as string))];
  const found = await prisma.forTenant().customerAddress.findMany({
    where: { id: { in: addressIds } },
    select: { id: true, customerId: true },
  });
  const ownerById = new Map((found ?? []).map((a) => [a.id, a.customerId]));
  for (const r of withAddress) {
    const addressId = r.customerAddressId as string;
    if (!ownerById.has(addressId) || (r.customerId && ownerById.get(addressId) !== r.customerId)) {
      throw new NotFoundException({
        statusCode: 404,
        code: "CUSTOMER_ADDRESS_NOT_FOUND",
        message: "Customer address not found",
      });
    }
  }
}

/** A caller-supplied address id must resolve in the tenant AND belong to `customerId`. */
export function assertAddressBelongsToCustomer(
  prisma: PrismaService,
  customerId: string,
  customerAddressId: string,
): Promise<void> {
  return assertStopRefsInTenant(prisma, [{ customerId, customerAddressId }], {
    checkCustomers: false,
  });
}
