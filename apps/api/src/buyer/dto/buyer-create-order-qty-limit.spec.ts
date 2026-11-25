import "reflect-metadata";
import { readFileSync } from "fs";
import { join } from "path";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { BUYER_LINE_QTY_MAX } from "@routeflow/pricing";
import { BuyerCreateOrderDto } from "./buyer-create-order.dto";

/**
 * B1382 (SA-1281 part 3, SA-1285): the buyer line limit is ONE number, `BUYER_LINE_QTY_MAX` in @routeflow/pricing,
 * read by this DTO and by the web and mobile buyer carts.
 */
const qtyRefused = async (qty: number) => {
  const dto = plainToInstance(BuyerCreateOrderDto, { items: [{ productId: "p1", qty }] });
  return JSON.stringify(await validate(dto)).includes("qty");
};

describe("buyer line quantity limit (B1382)", () => {
  it("is the server's 100,000", () => {
    expect(BUYER_LINE_QTY_MAX).toBe(100_000);
  });

  it("accepts the limit and refuses above it", async () => {
    expect(await qtyRefused(BUYER_LINE_QTY_MAX)).toBe(false);
    expect(await qtyRefused(BUYER_LINE_QTY_MAX + 1)).toBe(true);
    expect(await qtyRefused(99_999_999)).toBe(true);
  });

  it("the DTO reads the constant, with no literal limit", () => {
    const src = readFileSync(join(__dirname, "buyer-create-order.dto.ts"), "utf8");
    expect(src).toContain("BUYER_LINE_QTY_MAX");
    expect(src).not.toMatch(/100_?000/);
  });
});
