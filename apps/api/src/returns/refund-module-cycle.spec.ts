/**
 * Load-order regression: `CASH_REFUNDED_RETURN_WHERE` (inline-return-refund.ts) is built at module top level from
 * `DEAD_RETURN_STATUSES`. When counter-sale-today.ts -> returns/refund-tender.ts -> inline-return-refund.ts ->
 * counter-sale-today.ts formed a cycle, loading today's sales FIRST left `DEAD_RETURN_STATUSES` undefined at that moment, the
 * Prisma `notIn` filter silently vanished, and the invoice-void / order-cancel cash-refund guards matched dead returns too.
 * Whichever module loads first, the list must be a real, non-empty array.
 */
describe("refund modules: no load-order dependent constants", () => {
  const dead = (where: any) => where.status.notIn as unknown[];

  it("loading counter-sale-today FIRST still yields a non-empty notIn", () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("../orders/counter-sale/counter-sale-today");
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { CASH_REFUNDED_RETURN_WHERE } = require("./inline-return-refund");
      expect(Array.isArray(dead(CASH_REFUNDED_RETURN_WHERE))).toBe(true);
      expect(dead(CASH_REFUNDED_RETURN_WHERE)).toEqual(["REJECTED", "CANCELLED"]);
    });
  });

  it("loading refund-tender FIRST (it reaches both modules) still yields a non-empty notIn", () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("./refund-tender");
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { CASH_REFUNDED_RETURN_WHERE } = require("./inline-return-refund");
      expect(dead(CASH_REFUNDED_RETURN_WHERE)).toEqual(["REJECTED", "CANCELLED"]);
    });
  });

  it("inline-return-refund.ts does not import today's sales (the leaf return-statuses module is the shared home)", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src: string = require("node:fs").readFileSync(
      require.resolve("./inline-return-refund"),
      "utf8",
    );
    expect(src).not.toMatch(/from\s+"\.\.\/orders\/counter-sale\/counter-sale-today"/);
    expect(src).toMatch(/from\s+"\.\/return-statuses"/);
  });
});
