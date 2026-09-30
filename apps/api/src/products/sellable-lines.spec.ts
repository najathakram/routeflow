import { BadRequestException } from "@nestjs/common";
import { assertSellableLines } from "./sellable-lines";

describe("assertSellableLines (WS8: a FAMILY is never a line)", () => {
  it("passes STANDARD / VARIANT / RECIPE products and rows with no kind loaded", () => {
    expect(() =>
      assertSellableLines([
        { id: "a", kind: "STANDARD" },
        { id: "b", kind: "VARIANT" },
        { id: "c", kind: "RECIPE" },
        { id: "d" },
      ]),
    ).not.toThrow();
  });

  it("a FAMILY is a 400 FAMILY_NOT_SELLABLE naming every family", () => {
    let err: unknown;
    try {
      assertSellableLines([
        { id: "a", name: "Soda", kind: "FAMILY" },
        { id: "b", name: "Cola", kind: "VARIANT" },
        { id: "c", name: "Juice", kind: "FAMILY" },
      ]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BadRequestException);
    const body = (err as BadRequestException).getResponse() as Record<string, unknown>;
    expect(body).toMatchObject({ code: "FAMILY_NOT_SELLABLE", productIds: ["a", "c"] });
    expect(String(body.message)).toMatch(/2 product families/);
  });

  it("a single family gets a plain, actionable sentence", () => {
    try {
      assertSellableLines([{ id: "a", name: "Soda", kind: "FAMILY" }]);
    } catch (e) {
      expect(((e as BadRequestException).getResponse() as { message: string }).message).toBe(
        '"Soda" is a product family, not a sellable item. Add one of its variants instead.',
      );
      return;
    }
    throw new Error("expected a throw");
  });
});
