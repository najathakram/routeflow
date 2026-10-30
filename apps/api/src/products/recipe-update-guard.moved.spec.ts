import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { lockAndAssertRecipeGuards } from "./recipe-update-guard";

/**
 * Row 519: the "moved while you were editing" 409 of the recipe guard is coded (PRODUCT_CHANGED_CONCURRENTLY), so the
 * clients show fixed copy for it like every other concurrent-edit conflict. Fake tx: the locks are no-ops, the
 * post-lock read says the product's parent is no longer the one the caller saw.
 */
describe("lockAndAssertRecipeGuards: the product moved under the editor", () => {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    recipe: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn() },
    product: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ parentProductId: "other-family", unitsPerBox: null }),
    },
  };

  it("is a coded 409, not a bare message", async () => {
    const err = await lockAndAssertRecipeGuards(tx as never, {
      tenantId: "t1",
      id: "p1",
      existing: {
        parentProductId: "fam-a",
        unitsPerBox: null,
        trackedCategoryId: null,
        trackedSubcategoryId: null,
      },
      dto: { parentProductId: "fam-b" },
      effective: { trackedCategoryId: null, trackedSubcategoryId: null },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: API_ERROR_CODES.PRODUCT_CHANGED_CONCURRENTLY,
      message: "This product was moved while you were editing it. Reload it and try again.",
    });
  });
});
