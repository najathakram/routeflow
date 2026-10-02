import { InvoicesService } from "./invoices.service";

/**
 * #2717 M3: the invoice detail read hands clients each line's frozen components through the read
 * mapper, so `displayUnitPrice4` reaches them as a number (a Prisma Decimal would serialize as a
 * string) and the tenant/parent keys never leave the server.
 */
function serviceReturning(inv: object) {
  const service = new (InvoicesService as unknown as new (...a: unknown[]) => InvoicesService)(
    ...Array(14).fill(undefined),
  );
  Object.assign(service, {
    prisma: { forTenant: () => ({ invoice: { findUnique: jest.fn().mockResolvedValue(inv) } }) },
    systemConfig: { get: jest.fn().mockResolvedValue(null) },
  });
  return service;
}

describe("InvoicesService.findOne components", () => {
  it("returns each line's components as views: displayUnitPrice4 a number, position order", async () => {
    const service = serviceReturning({
      id: "inv-1",
      status: "SENT",
      total: 30,
      dueDate: null,
      payments: [],
      items: [
        {
          id: "ii-1",
          components: [
            {
              id: "c1",
              tenantId: "t-1",
              invoiceItemId: "ii-1",
              componentProductId: "p1",
              name: "B",
              qty: 12,
              displayUnitPrice4: { toString: () => "0.6250" },
              position: 1,
            },
            {
              id: "c0",
              tenantId: "t-1",
              invoiceItemId: "ii-1",
              componentProductId: "p0",
              name: "A",
              qty: 12,
              displayUnitPrice4: null,
              position: 0,
            },
          ],
        },
        { id: "ii-2" },
      ],
    });
    const out = (await service.findOne("inv-1")) as unknown as {
      items: Array<{ id: string; components?: Array<Record<string, unknown>> }>;
    };
    const comps = out.items[0].components!;
    expect(comps.map((c) => c.position)).toEqual([0, 1]);
    expect(comps[1].displayUnitPrice4).toBe(0.625);
    expect(typeof comps[1].displayUnitPrice4).toBe("number");
    expect(comps[0].displayUnitPrice4).toBeNull();
    expect(comps[1]).not.toHaveProperty("tenantId");
    expect(comps[1]).not.toHaveProperty("invoiceItemId");
    expect(out.items[1]).not.toHaveProperty("components");
  });
});
