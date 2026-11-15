// SA-1153 (W-989 PR-2, round 3), rows 19 and 20, with the cutover SET (the harness):
//   row 19  order-totals.ts:99      an existing order's edit re-total reads the ORDER's own mode
//   row 20  orders.service.ts:559   the order detail's `discountTaxBase` reads the order's own mode (R7)
// Rows 21-24 (merge winner x2, standing order, create order) are structural only: `discount: 0` or NEW (the pin).
import {
  AFTER,
  BEFORE,
  FIXTURE,
  expectFixtureDiscriminates,
  settled,
  underCutover,
  withDiscountCutover,
} from "../common/testing/discount-cutover";

jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { OrdersService } from "./orders.service";
import { editedOrderTotals } from "./order-totals";

describe("SA-1153 order rows 19 and 20 (cutover set)", () => {
  withDiscountCutover();

  describe("row 19: editedOrderTotals (the item edit's and the change-request apply's re-total)", () => {
    // 100 @10% with discount 20, a line edited up to 120; the order's stored tax was levied LEGACY.
    const retotal = (createdAt: Date) => {
      const t = editedOrderTotals(
        [{ subtotal: 120, categoryTaxAmount: 0 }],
        { discountAmount: FIXTURE.discount, createdAt },
        { taxRate: FIXTURE.rate, isTaxExempt: false, shipping: FIXTURE.shipping, subtotal: 120 },
      );
      return { tax: t.tax, total: t.total };
    };

    it("an order made BEFORE the cutover, a line edited: the order's tax and total equal the cutover-null run", async () => {
      expectFixtureDiscriminates();
      const dark = await underCutover(null, () => retotal(BEFORE));
      expect(await settled(() => retotal(AFTER))).not.toEqual(dark); // 1: a PRE_TAX-dated order re-totals differently
      expect(retotal(BEFORE)).toEqual(dark); // 2: the BEFORE order keeps master's re-total
    });
  });

  describe("row 20: the order detail's discountTaxBase (R7)", () => {
    const operator = {
      sub: "u-op",
      username: "op",
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
    } as never;
    const detail = async (createdAt: Date) => {
      const findUnique = jest.fn().mockResolvedValue({
        id: "o-1",
        status: "PENDING",
        customerId: "c-1",
        routeRun: null,
        lineItems: [],
        createdAt,
      });
      const service = Object.assign(Object.create(OrdersService.prototype), {
        prisma: { forTenant: () => ({ order: { findUnique } }) },
      }) as OrdersService;
      return ((await service.findOne("o-1", operator)) as unknown as { discountTaxBase: string })
        .discountTaxBase;
    };

    it("an order created BEFORE the cutover reads LEGACY_POST_TAX, as the cutover-null run", async () => {
      const dark = await underCutover(null, () => detail(BEFORE));
      expect(await detail(AFTER)).toBe("PRE_TAX"); // 1: a PRE_TAX-dated order reads PRE_TAX
      expect(await detail(BEFORE)).toBe(dark); // 2: the BEFORE order equals the null run ...
      expect(dark).toBe("LEGACY_POST_TAX"); // ... which is LEGACY
    });
  });
});
