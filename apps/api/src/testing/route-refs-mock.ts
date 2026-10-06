import type { MockPrisma } from "./prisma-mock";

/**
 * RoutesService validates the driver / customer / address ids on route and run writes against the
 * caller's tenant. In a mocked-Prisma spec "in the tenant" means "the mock resolves it", so this
 * makes every id the service asks about resolve (the mock is the tenant). Addresses resolve to the
 * customer given in `addressOwners` (address id -> customer id); an address id not listed there
 * does NOT resolve, which is how a spec states "this address belongs to someone else".
 */
export function mockRouteRefsInTenant(
  prisma: MockPrisma,
  addressOwners: Record<string, string> = {},
): void {
  prisma.driver.findFirst.mockImplementation(async (args: any) =>
    args?.where?.id ? { id: args.where.id } : null,
  );
  prisma.customer.findMany.mockImplementation(async (args: any) =>
    (args?.where?.id?.in ?? []).map((id: string) => ({ id })),
  );
  prisma.customerAddress.findMany.mockImplementation(async (args: any) =>
    (args?.where?.id?.in ?? [])
      .filter((id: string) => id in addressOwners)
      .map((id: string) => ({ id, customerId: addressOwners[id] })),
  );
}
