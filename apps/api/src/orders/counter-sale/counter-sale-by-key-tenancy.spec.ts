/**
 * GET /orders/counter-sale/by-key/:key is tenant-scoped because the REAL replay lookup rides forTenant():
 * another tenant's key is simply not found (the 404 the service maps). Runs the real
 * loadReplayCandidateByKey against a tenant-filtering fake client; nothing about the lookup is mocked.
 */
import { loadReplayCandidateByKey } from "../merge-idempotency";

const rows = [
  {
    id: "ord-a",
    tenantId: "tA",
    idempotencyKey: "shared-key",
    customerId: "c1",
    fulfillPath: "PICKUP",
  },
];

const deps = (tenantId: string) => {
  const scope = (list: any[]) => list.filter((r) => r.tenantId === tenantId);
  const match = (r: any, where: any) =>
    Object.entries(where).every(([k, v]) =>
      v && typeof v === "object" ? true : (r as any)[k] === v,
    );
  return {
    prisma: {
      getTenantId: () => tenantId,
      forTenant: () => ({
        orderIdempotencyKey: { findFirst: async () => null },
        order: {
          findFirst: async ({ where }: any) => scope(rows).find((r) => match(r, where)) ?? null,
        },
      }),
    },
    logger: { warn: () => undefined },
  };
};

describe("the by-key lookup is tenant-scoped", () => {
  it("the owning tenant finds the sale by key alone (a customer id no row holds)", async () => {
    const found = await loadReplayCandidateByKey(
      deps("tA") as never,
      "shared-key",
      "00000000-0000-0000-0000-000000000000",
    );
    expect(found?.id).toBe("ord-a");
  });

  it("another tenant's identical key finds nothing (=> 404)", async () => {
    expect(
      await loadReplayCandidateByKey(
        deps("tB") as never,
        "shared-key",
        "00000000-0000-0000-0000-000000000000",
      ),
    ).toBeNull();
  });
});
