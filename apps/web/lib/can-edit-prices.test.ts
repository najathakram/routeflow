import { canEditPrices } from "./can-edit-prices";

/** The SAME role table as apps/api/src/orders/counter-sale/can-edit-prices.spec.ts; change both together. */
describe("canEditPrices (counter sale)", () => {
  it.each([
    ["TENANT_ADMIN", true],
    ["SUPER_ADMIN", true],
    ["OPERATOR", false],
    ["DRIVER", false],
    ["CUSTOMER", false],
  ])("%s -> %s", (role, expected) => {
    expect(canEditPrices({ role })).toBe(expected);
  });

  it.each([[null], [undefined], [{}], [{ role: undefined }], [{ role: "ADMIN" }]])(
    "%j -> false",
    (user) => {
      expect(canEditPrices(user as never)).toBe(false);
    },
  );
});
