import { recordOrderDated } from "./order-date";

/**
 * W-1188 review SHOULD (reader B, M1): the `order.dated` audit row judges the entry day on the TENANT zone.
 * An order entered at 23:30 Chicago on Nov 9 is already Nov 10 in UTC; a zone dropped from the audit call would
 * log enteredDay 2026-11-10 and days -4.
 */
describe("recordOrderDated: entry day on the tenant calendar", () => {
  const user = { role: "OPERATOR", sub: "u1", tenantId: "t-1" };
  const created = {
    id: "ord-1",
    createdAt: new Date("2026-11-10T05:30:00.000Z"), // 23:30 CST on Nov 9
    orderNumber: "ORD-1",
  };
  const run = async (zone: string | null) => {
    const create = jest.fn().mockResolvedValue({});
    await recordOrderDated({ auditLog: { create } }, user, created, {
      orderDate: new Date("2026-11-06T00:00:00.000Z"),
      zone,
      options: { counterSale: true },
    });
    return create;
  };

  it("Chicago evening: entered 2026-11-09, dated 2026-11-06, three days back", async () => {
    const create = await run("America/Chicago");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data.meta).toMatchObject({
      orderDay: "2026-11-06",
      enteredDay: "2026-11-09",
      direction: "BACK",
      days: -3,
      surface: "counter",
    });
  });

  it("no zone reads UTC (guard): the same instant is entered 2026-11-10, four days back", async () => {
    const create = await run(null);
    expect(create.mock.calls[0][0].data.meta).toMatchObject({ enteredDay: "2026-11-10", days: -4 });
  });
});
