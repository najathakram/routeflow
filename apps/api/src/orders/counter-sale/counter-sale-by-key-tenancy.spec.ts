/**
 * GET /orders/counter-sale/by-key/:key is tenant-scoped because the REAL replay lookup rides forTenant().
 * Runs the real loadReplayCandidateByKey against a fake that models BOTH stores it consults (the
 * OrderIdempotencyKey table first, then the Order.idempotencyKey column) and filters every read by tenant;
 * nothing about the lookup is mocked. Pins each step and "another tenant's key is not found" (=> 404).
 * Scope: this spec pins ONLY the tenant-scoped key lookup. byKey additionally requires
 * Order.counterSale === true (asserted in counter-sale.service.spec).
 */
import { loadReplayCandidateByKey } from "../merge-idempotency";

const NO_CUSTOMER = "00000000-0000-0000-0000-000000000000";

type OrderRow = { id: string; tenantId: string; idempotencyKey: string | null; customerId: string };
type KeyRow = { tenantId: string; key: string; orderId: string };

function world(orders: OrderRow[], keys: KeyRow[]) {
  const calls: string[] = [];
  const deps = (tenantId: string) => {
    const orderOf = (id: string) => orders.find((o) => o.id === id && o.tenantId === tenantId);
    return {
      prisma: {
        getTenantId: () => tenantId,
        forTenant: () => ({
          orderIdempotencyKey: {
            findFirst: async ({ where }: any) => {
              calls.push("table");
              const row = keys.find(
                (k) =>
                  k.tenantId === tenantId &&
                  k.key === where.key &&
                  (where.order?.customerId == null ||
                    orderOf(k.orderId)?.customerId === where.order.customerId),
              );
              return row ? { orderId: row.orderId } : null;
            },
          },
          order: {
            findFirst: async ({ where }: any) => {
              calls.push("order");
              return (
                orders.find(
                  (o) =>
                    o.tenantId === tenantId &&
                    (where.id == null || o.id === where.id) &&
                    (where.idempotencyKey == null || o.idempotencyKey === where.idempotencyKey) &&
                    (where.customerId == null || o.customerId === where.customerId),
                ) ?? null
              );
            },
          },
        }),
      },
      logger: { warn: () => undefined },
    };
  };
  return { deps, calls };
}

describe("the by-key lookup: both stores, tenant-scoped", () => {
  it("step 1, the key TABLE: a sale whose key lives only in OrderIdempotencyKey is found by key alone", async () => {
    const w = world(
      [{ id: "ord-t", tenantId: "tA", idempotencyKey: null, customerId: "c1" }],
      [{ tenantId: "tA", key: "tbl-key", orderId: "ord-t" }],
    );
    const found = await loadReplayCandidateByKey(w.deps("tA") as never, "tbl-key", NO_CUSTOMER);
    expect(found?.id).toBe("ord-t");
    expect(w.calls[0]).toBe("table"); // the table is asked first
  });

  it("step 2, the Order COLUMN: a sale whose key is only stamped on the order is found by key alone", async () => {
    const w = world(
      [{ id: "ord-c", tenantId: "tA", idempotencyKey: "col-key", customerId: "c1" }],
      [],
    );
    const found = await loadReplayCandidateByKey(w.deps("tA") as never, "col-key", NO_CUSTOMER);
    expect(found?.id).toBe("ord-c");
    expect(w.calls).toContain("table"); // consulted first, found nothing, then the column answers
    expect(w.calls.indexOf("table")).toBeLessThan(w.calls.lastIndexOf("order"));
  });

  it("the table wins over the column when both exist for the key", async () => {
    const w = world(
      [
        { id: "ord-col", tenantId: "tA", idempotencyKey: "dup", customerId: "c1" },
        { id: "ord-tbl", tenantId: "tA", idempotencyKey: null, customerId: "c2" },
      ],
      [{ tenantId: "tA", key: "dup", orderId: "ord-tbl" }],
    );
    const found = await loadReplayCandidateByKey(w.deps("tA") as never, "dup", NO_CUSTOMER);
    expect(found?.id).toBe("ord-tbl");
  });

  it.each([
    [
      "key table",
      [{ id: "o", tenantId: "tA", idempotencyKey: null, customerId: "c1" }],
      [{ tenantId: "tA", key: "k", orderId: "o" }],
    ],
    ["order column", [{ id: "o", tenantId: "tA", idempotencyKey: "k", customerId: "c1" }], []],
  ] as [string, OrderRow[], KeyRow[]][])(
    "another tenant's identical key finds nothing in the %s (=> 404)",
    async (_n, orders, keys) => {
      const w = world(orders, keys);
      expect(await loadReplayCandidateByKey(w.deps("tB") as never, "k", NO_CUSTOMER)).toBeNull();
      expect(
        await loadReplayCandidateByKey(w.deps("tA") as never, "k", NO_CUSTOMER),
      ).not.toBeNull();
    },
  );

  it("an unknown key finds nothing in either store", async () => {
    const w = world([{ id: "o", tenantId: "tA", idempotencyKey: "x", customerId: "c1" }], []);
    expect(await loadReplayCandidateByKey(w.deps("tA") as never, "nope", NO_CUSTOMER)).toBeNull();
  });
});
