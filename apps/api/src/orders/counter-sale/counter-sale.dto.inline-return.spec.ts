import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CounterSaleDto } from "./counter-sale.dto";
import { InlineReturnLinesDto } from "../../returns/dto/capture-inline-return.dto";

/**
 * W-863 (SA-945 PR-1 MUST 3): the counter sale carries Create Order's `inlineReturn` field, the SAME dto, so the one
 * return writer (create() -> applyReturn) is the only writer. Red on master: the field is not declared, so it is not
 * transformed to InlineReturnLinesDto and a malformed return is never refused at the body edge.
 */
const ITEM = { productId: "6f1c2b9e-3a4d-4c5e-9f00-1a2b3c4d5e6f", qty: 1 };
const RETURN_ITEM = { productId: ITEM.productId, qty: 1, boxes: 0, pieces: 1 };
const body = (inlineReturn: unknown) => ({
  customerId: "0d4c4a40-7d6b-4b53-8c3a-9d7a5d5c1a11",
  items: [ITEM],
  payment: { method: "CASH" },
  inlineReturn,
});
const check = async (inlineReturn: unknown) => {
  const dto = plainToInstance(CounterSaleDto, body(inlineReturn));
  const errors = await validate(dto as object, { whitelist: true });
  return { dto, fields: errors.map((e) => e.property) };
};

describe("CounterSaleDto.inlineReturn (W-863)", () => {
  it("is Create Order's InlineReturnLinesDto, not a second shape", async () => {
    const { dto, fields } = await check({ returnKey: "k-1", items: [RETURN_ITEM] });
    expect(dto.inlineReturn).toBeInstanceOf(InlineReturnLinesDto);
    expect(fields).toEqual([]);
  });

  it("is optional: a sale with no return is unchanged", async () => {
    const dto = plainToInstance(CounterSaleDto, { ...body(undefined) });
    expect(await validate(dto as object, { whitelist: true })).toEqual([]);
    expect(dto.inlineReturn).toBeUndefined();
  });

  it.each([
    ["no return key", { items: [RETURN_ITEM] }],
    ["no items", { returnKey: "k-1", items: [] }],
    ["items not a list", { returnKey: "k-1", items: "x" }],
  ])("refuses a return with %s at the body edge", async (_label, inlineReturn) => {
    expect((await check(inlineReturn)).fields).toContain("inlineReturn");
  });
});
