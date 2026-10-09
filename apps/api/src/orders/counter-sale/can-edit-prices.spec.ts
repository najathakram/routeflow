import { API_ERROR_CODES } from "../../common/api-error-codes";
import { canEditPrices } from "./can-edit-prices";

/**
 * POS-5: the ONE truth table of `canEditPrices`. The web helper (apps/web/lib/can-edit-prices.ts) is pinned to
 * the SAME table in its own spec; change both together.
 */
describe("canEditPrices (counter sale)", () => {
  it.each([
    ["TENANT_ADMIN", true],
    ["SUPER_ADMIN", true],
    ["OPERATOR", false],
    ["DRIVER", false],
    ["CUSTOMER", false],
  ])("%s -> %s", (role, expected) => {
    expect(canEditPrices({ role } as never)).toBe(expected);
  });

  it.each([[null], [undefined], [{}], [{ role: undefined }]])("%j -> false", (user) => {
    expect(canEditPrices(user as never)).toBe(false);
  });

  it("the refusal code is registered in the API list", () => {
    expect(API_ERROR_CODES.PRICE_EDIT_NOT_PERMITTED).toBe("PRICE_EDIT_NOT_PERMITTED");
  });
});
