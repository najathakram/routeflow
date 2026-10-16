import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { SavePricesDto, UndoPricesDto } from "./save-prices.dto";

const ok = {
  expectedRevision: 1,
  expectedPriceState: "abc",
  patches: [{ ref: "pack", tier: 2, to: 5 }],
};

const errorsOf = async (cls: new () => object, body: object) =>
  (await validate(plainToInstance(cls, body))).map((e) => e.property);

describe("price write DTOs", () => {
  it("accepts a full save, with null (Auto) and customer moves", async () => {
    const body = {
      ...ok,
      patches: [{ ref: "pack", tier: 2, to: null }],
      customerMoves: [{ customerId: "c1", ref: "pack", tier: 1, from: null, to: 5 }],
    };
    expect(await errorsOf(SavePricesDto, body)).toEqual([]);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["a number", 5],
  ])("save refuses expectedPriceState %s", async (_n, v) => {
    expect(await errorsOf(SavePricesDto, { ...ok, expectedPriceState: v })).toContain(
      "expectedPriceState",
    );
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
  ])("undo refuses expectedPriceState %s", async (_n, v) => {
    const body = { auditId: "a", expectedRevision: 1, expectedPriceState: v };
    expect(await errorsOf(UndoPricesDto, body)).toContain("expectedPriceState");
  });

  it("refuses a bad tier, a string price and a missing revision", async () => {
    expect(
      await errorsOf(SavePricesDto, { ...ok, patches: [{ ref: "pack", tier: 6, to: 5 }] }),
    ).toContain("patches");
    expect(
      await errorsOf(SavePricesDto, { ...ok, patches: [{ ref: "pack", tier: 2, to: "5" }] }),
    ).toContain("patches");
    expect(await errorsOf(SavePricesDto, { ...ok, expectedRevision: undefined })).toContain(
      "expectedRevision",
    );
  });
});
