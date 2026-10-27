import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CounterSaleDto } from "./counter-sale.dto";
import { PickupCompleteDto } from "./pickup-complete.dto";

/**
 * W-887 (PK-6a, SA-948 F07.8): the counter sale's `payment` must be ONE object with a recognised method. A list (or an
 * empty list) used to pass `@ValidateNested()` and save a walk-in sale unpaid, and a missing payment reached the service
 * as undefined (a 500). Both are refused at the body edge, 400, before anything is written. The pickup hand-over's payment
 * is optional (omitted = on account) but a list is the same malformed shape.
 */
const ITEM = { productId: "6f1c2b9e-3a4d-4c5e-9f00-1a2b3c4d5e6f", qty: 1 };
const fields = async (cls: new () => object, body: Record<string, unknown>) =>
  (await validate(plainToInstance(cls, body) as object, { whitelist: true })).map(
    (e) => e.property,
  );
const sale = (over: Record<string, unknown>) => ({ walkIn: true, items: [ITEM], ...over });

describe("CounterSaleDto.payment (W-887)", () => {
  it("a proper payment object passes", async () => {
    expect(await fields(CounterSaleDto, sale({ payment: { method: "CASH" } }))).toEqual([]);
    expect(await fields(CounterSaleDto, sale({ payment: { method: "ON_ACCOUNT" } }))).toEqual([]);
  });

  it.each([
    ["an empty list", []],
    ["a list holding a payment", [{ method: "CASH" }]],
    ["a string", "CASH"],
    ["a number", 5],
    ["null", null],
  ])("refuses %s (never saved unpaid)", async (_label, payment) => {
    expect(await fields(CounterSaleDto, sale({ payment }))).toContain("payment");
  });

  it("refuses a missing payment as a validation error, not a 500 in the service", async () => {
    expect(await fields(CounterSaleDto, sale({}))).toContain("payment");
  });

  it("still refuses an unknown method and a negative amount inside a real object", async () => {
    expect(await fields(CounterSaleDto, sale({ payment: { method: "BITCOIN" } }))).toContain(
      "payment",
    );
    expect(
      await fields(CounterSaleDto, sale({ payment: { method: "CASH", amount: -1 } })),
    ).toContain("payment");
  });
});

describe("PickupCompleteDto.payment (same malformed shape)", () => {
  it("is optional: omitted passes; an object passes", async () => {
    expect(await fields(PickupCompleteDto, {})).toEqual([]);
    expect(await fields(PickupCompleteDto, { payment: { method: "CASH" } })).toEqual([]);
  });

  it.each([
    ["an empty list", []],
    ["a list holding a payment", [{ method: "CASH" }]],
    ["a string", "CASH"],
  ])("refuses %s", async (_label, payment) => {
    expect(await fields(PickupCompleteDto, { payment })).toContain("payment");
  });
});
