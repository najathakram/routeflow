import "reflect-metadata";
import { readFileSync } from "fs";
import { join } from "path";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { BUYER_LINE_QTY_MAX as SHARED_MAX } from "@routeflow/types";
import { BUYER_LINE_QTY_MAX } from "../../common/buyer-line-qty";
import { BuyerCreateOrderDto } from "./buyer-create-order.dto";

/**
 * B1382 (SA-1281 part 3): the buyer line limit is ONE number, `BUYER_LINE_QTY_MAX` in @routeflow/types. The API
 * may not value-import that package (no-runtime-workspace-imports.spec.ts), so it reads a type-pinned mirror in
 * common/; this spec pins the two values equal and the DTO to the mirror.
 */
const order = (qty: number) =>
  plainToInstance(BuyerCreateOrderDto, {
    items: [{ productId: "p1", qty }],
  });

const qtyErrors = async (qty: number) => {
  const errors = await validate(order(qty), { skipMissingProperties: false });
  return JSON.stringify(errors).includes("qty");
};

describe("buyer line quantity limit (B1382)", () => {
  it("the API mirror equals the shared constant (100,000)", () => {
    expect(BUYER_LINE_QTY_MAX).toBe(SHARED_MAX);
    expect(SHARED_MAX).toBe(100_000);
  });

  it("accepts the limit and refuses above it", async () => {
    expect(await qtyErrors(BUYER_LINE_QTY_MAX)).toBe(false);
    expect(await qtyErrors(BUYER_LINE_QTY_MAX + 1)).toBe(true);
    expect(await qtyErrors(99_999_999)).toBe(true);
  });

  it("the DTO reads the constant, with no literal limit", () => {
    const src = readFileSync(join(__dirname, "buyer-create-order.dto.ts"), "utf8");
    expect(src).toContain("BUYER_LINE_QTY_MAX");
    expect(src).not.toMatch(/100_?000/);
  });
});
