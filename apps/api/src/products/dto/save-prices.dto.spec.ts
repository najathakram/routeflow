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

  it("undo accepts a skip list (null seen allowed) and refuses a malformed item", async () => {
    const base = { auditId: "a", expectedRevision: 1, expectedPriceState: "s" };
    const good = {
      ...base,
      skip: [
        { customerId: "c1", ref: "pack", seen: null },
        { customerId: "c2", ref: "u1", seen: 4.5 },
      ],
    };
    expect(await errorsOf(UndoPricesDto, good)).toEqual([]);
    expect(
      await errorsOf(UndoPricesDto, {
        ...base,
        skip: [{ customerId: "c1", ref: "pack", seen: "x" }],
      }),
    ).toContain("skip");
    expect(await errorsOf(UndoPricesDto, { ...base, skip: [{ ref: "pack", seen: 1 }] })).toContain(
      "skip",
    );
  });
});
