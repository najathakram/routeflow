import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate, type ValidationError } from "class-validator";
import {
  ADJUSTMENT_REASON_NOTE_MAX as SHARED_NOTE_MAX,
  ADJUSTMENT_REASON_NOTE_MIN as SHARED_NOTE_MIN,
} from "@routeflow/types";
import { ProductCountDto } from "./product-count.dto";
import { ADJUSTMENT_REASON_NOTE_MAX, ADJUSTMENT_REASON_NOTE_MIN } from "./adjustment-reason.dto";

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
  parts: [{ unit: "Case", quantity: 3 }],
  reason: "COUNT_CORRECTION",
  ...over,
});
const adjust = (over: Record<string, unknown> = {}) => ({
  mode: "ADJUST",
  parts: [{ unit: "Case", quantity: 1 }],
  sign: "-",
  reason: "DAMAGED",
  ...over,
});
const one = (part: Record<string, unknown>) => ({ parts: [part] });

describe("ProductCountDto (SA-828a: the count takes parts)", () => {
  it("accepts a SET and an ADJUST", async () => {
    expect(await check(set())).toEqual([]);
    expect(await check(adjust())).toEqual([]);
  });

  it('accepts several parts: "3 cases + 4 boxes"', async () => {
    const parts = [
      { unit: "Case", quantity: 3 },
      { unit: "Box", quantity: 4 },
    ];
    expect(await check(set({ parts }))).toEqual([]);
    expect(await check(adjust({ parts }))).toEqual([]);
  });

  it("refuses an unknown mode", async () => {
    expect(await check(set({ mode: "REPLACE" }))).toContain("mode");
  });

  it("needs at least one part", async () => {
    expect(await check(set({ parts: undefined }))).toContain("parts");
    expect(await check(set({ parts: [] }))).toContain("parts");
    expect(await check(set({ parts: { unit: "Case", quantity: 1 } }))).toContain("parts");
  });

  it("a duplicate unit is refused (case and spaces do not make it new; two packs are one unit)", async () => {
    const dup = (a: unknown, b: unknown) => ({
      parts: [
        { unit: a, quantity: 1 },
        { unit: b, quantity: 2 },
      ],
    });
    expect(await check(set(dup("Case", "Case")))).toContain("parts");
    expect(await check(set(dup("Case", " case ")))).toContain("parts");
    expect(await check(set(dup(null, undefined)))).toContain("parts");
    expect(await check(set(dup(null, "")))).toContain("parts");
  });

  it("the old single count / delta shape is refused, never read", async () => {
    expect(await check(set({ count: { unit: "Case", quantity: 3 } }))).toContain("count");
    expect(await check(adjust({ delta: { unit: "Case", quantity: 1, sign: "-" } }))).toContain(
      "delta",
    );
  });

  it("each quantity is >= 0 (zero is a real count); a negative part is refused", async () => {
    expect(await check(set(one({ unit: "Case", quantity: 0 })))).toEqual([]);
    expect(await check(set(one({ quantity: -1 })))).toContain("parts.0.quantity");
    expect(await check(adjust(one({ quantity: -1 })))).toContain("parts.0.quantity");
  });

  it("an ADJUST takes one + or - sign for the whole delta", async () => {
    expect(await check(adjust({ sign: undefined }))).toContain("sign");
    expect(await check(adjust({ sign: "x" }))).toContain("sign");
    expect(await check(adjust({ sign: "+" }))).toEqual([]);
    expect(await check(adjust({ parts: [{ quantity: 1, sign: "-" }] }))).toContain("parts.0.sign");
  });

  it("allows at most 3 decimals and 9,999,999 per part", async () => {
    expect(await check(set(one({ quantity: 1.25 })))).toEqual([]);
    expect(await check(set(one({ quantity: 1.2345 })))).toContain("parts.0.quantity");
    expect(await check(set(one({ quantity: 10_000_000 })))).toContain("parts.0.quantity");
    expect(await check(set(one({ quantity: 9_999_999 })))).toEqual([]);
  });

  it("the unit is an optional label of at most 60 characters (null = the pack)", async () => {
    expect(await check(set(one({ unit: null, quantity: 1 })))).toEqual([]);
    expect(await check(set(one({ quantity: 1 })))).toEqual([]);
    expect(await check(set(one({ unit: "x".repeat(61), quantity: 1 })))).toContain("parts.0.unit");
  });

  it("a client-sent factor is refused, never read", async () => {
    expect(await check(set(one({ unit: "Case", quantity: 3, unitsPerBox: 99 })))).toContain(
      "parts.0.unitsPerBox",
    );
    expect(await check(set(one({ unit: "Case", quantity: 3, factor: 99 })))).toContain(
      "parts.0.factor",
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

  it("the API's note bounds equal the shared ones web and mobile validate with", () => {
    expect(ADJUSTMENT_REASON_NOTE_MIN).toBe(SHARED_NOTE_MIN);
    expect(ADJUSTMENT_REASON_NOTE_MAX).toBe(SHARED_NOTE_MAX);
  });
});
