import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate, type ValidationError } from "class-validator";
import { MAX_UNIT_PRICE } from "@routeflow/pricing";
import { CounterSaleItemDto } from "./counter-sale/counter-sale.dto";
import { OrderItemDto } from "./dto/create-order.dto";
import { UpdateOrderItemsDto } from "./dto/update-order-items.dto";

/**
 * SA-1067 M3: one named limit on a unit price. The three DTOs that take a line's `unitPrice` read it from `@routeflow/pricing`,
 * so the web's Apply refusal (`OVER_LIMIT`) and the server's 400 can never disagree about where the limit sits.
 */
const unitPriceErrors = (errors: ValidationError[]): ValidationError[] =>
  errors.flatMap((e) => (e.property === "unitPrice" ? [e] : unitPriceErrors(e.children ?? [])));

const forPrice = {
  "counter sale item": (unitPrice: number) =>
    plainToInstance(CounterSaleItemDto, { productId: "p1", quantity: 1, unitPrice }),
  "create order item": (unitPrice: number) =>
    plainToInstance(OrderItemDto, { productId: "p1", quantity: 1, unitPrice }),
  "update order items": (unitPrice: number) =>
    plainToInstance(UpdateOrderItemsDto, { items: [{ id: "li-1", action: "UPDATE", unitPrice }] }),
} as const;

describe("MAX_UNIT_PRICE is the one limit on a line's unit price", () => {
  it("is a million dollars", () => {
    expect(MAX_UNIT_PRICE).toBe(1_000_000);
  });

  it.each(Object.entries(forPrice))(
    "%s accepts the limit and refuses a cent over",
    async (_n, make) => {
      expect(unitPriceErrors(await validate(make(MAX_UNIT_PRICE)))).toEqual([]);
      const over = unitPriceErrors(await validate(make(MAX_UNIT_PRICE + 0.01)));
      expect(over).toHaveLength(1);
      expect(over[0].constraints).toHaveProperty("max");
    },
  );
});
