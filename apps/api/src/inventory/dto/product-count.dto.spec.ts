import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate, type ValidationError } from "class-validator";
import { ProductCountDto } from "./product-count.dto";

/** SA-828 row 657: the body of `POST /inventory/products/:id/count`, validated as the global pipe does. */
const flat = (errors: ValidationError[], prefix = ""): string[] =>
  errors.flatMap((e) => [
    `${prefix}${e.property}`,
    ...flat(e.children ?? [], `${prefix}${e.property}.`),
  ]);

const check = async (body: Record<string, unknown>) => {
  const dto = plainToInstance(ProductCountDto, body);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return flat(errors);
};

const set = (over: Record<string, unknown> = {}) => ({
  mode: "SET",
  count: { unit: "Case", quantity: 3 },
  reason: "COUNT_CORRECTION",
  ...over,
});
const adjust = (over: Record<string, unknown> = {}) => ({
  mode: "ADJUST",
  delta: { unit: "Case", quantity: 1, sign: "-" },
  reason: "DAMAGED",
  ...over,
});

describe("ProductCountDto", () => {
  it("accepts a SET and an ADJUST", async () => {
    expect(await check(set())).toEqual([]);
    expect(await check(adjust())).toEqual([]);
  });

  it("refuses an unknown mode", async () => {
    expect(await check(set({ mode: "REPLACE" }))).toContain("mode");
  });

  it("SET needs `count`; ADJUST needs `delta`", async () => {
    expect(await check(set({ count: undefined }))).toContain("count");
    expect(await check(adjust({ delta: undefined }))).toContain("delta");
  });

  it("a SET of zero is fine (counted none); a negative SET is not", async () => {
    expect(await check(set({ count: { unit: "Case", quantity: 0 } }))).toEqual([]);
    expect(await check(set({ count: { quantity: -1 } }))).toContain("count.quantity");
  });

  it("an ADJUST must move by more than zero, with a + or - sign", async () => {
    expect(await check(adjust({ delta: { quantity: 0, sign: "+" } }))).toContain("delta.quantity");
    expect(await check(adjust({ delta: { quantity: 1 } }))).toContain("delta.sign");
    expect(await check(adjust({ delta: { quantity: 1, sign: "x" } }))).toContain("delta.sign");
  });

  it("allows at most 3 decimals and 9,999,999", async () => {
    expect(await check(set({ count: { quantity: 1.25 } }))).toEqual([]);
    expect(await check(set({ count: { quantity: 1.2345 } }))).toContain("count.quantity");
    expect(await check(set({ count: { quantity: 10_000_000 } }))).toContain("count.quantity");
    expect(await check(set({ count: { quantity: 9_999_999 } }))).toEqual([]);
  });

  it("the unit is an optional label of at most 60 characters (null = the pack)", async () => {
    expect(await check(set({ count: { unit: null, quantity: 1 } }))).toEqual([]);
    expect(await check(set({ count: { quantity: 1 } }))).toEqual([]);
    expect(await check(set({ count: { unit: "x".repeat(61), quantity: 1 } }))).toContain(
      "count.unit",
    );
  });

  it("a client-sent factor is refused, never read", async () => {
    expect(await check(set({ count: { unit: "Case", quantity: 3, unitsPerBox: 99 } }))).toContain(
      "count.unitsPerBox",
    );
    expect(await check(set({ factor: 99 }))).toContain("factor");
  });

  it("needs a reason; OTHER needs a 3-200 character note; effectiveDate must be a date", async () => {
    expect(await check(set({ reason: undefined }))).toContain("reason");
    expect(await check(set({ reason: "OTHER" }))).toContain("reasonNote");
    expect(await check(set({ reason: "OTHER", reasonNote: "ab" }))).toContain("reasonNote");
    expect(await check(set({ reason: "OTHER", reasonNote: "abc" }))).toEqual([]);
    expect(await check(set({ effectiveDate: "yesterday" }))).toContain("effectiveDate");
    expect(await check(set({ effectiveDate: "2026-10-01" }))).toEqual([]);
  });
});
