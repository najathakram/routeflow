import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CounterSaleTodayDto } from "./counter-sale-today.dto";

/** The query edge of GET /orders/counter-sale/today (the same transform + whitelist the app's global pipe applies). */
const check = async (query: Record<string, unknown>) => {
  const dto = plainToInstance(CounterSaleTodayDto, query);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return { dto, fields: errors.map((e) => e.property) };
};

describe("CounterSaleTodayDto", () => {
  it("defaults: page 1, limit 50, no day", async () => {
    const { dto, fields } = await check({});
    expect(fields).toEqual([]);
    expect(dto).toMatchObject({ page: 1, limit: 50 });
    expect(dto.day).toBeUndefined();
  });

  it("5. a real calendar day passes; 2026-02-30, 2026-13-01, abc and a datetime are refused", async () => {
    expect((await check({ day: "2026-03-08" })).fields).toEqual([]);
    expect((await check({ day: "2024-02-29" })).fields).toEqual([]);
    for (const day of ["2026-02-30", "2026-13-01", "abc", "2026-10-07T00:00:00Z", "26-10-07", ""]) {
      expect((await check({ day })).fields).toEqual(["day"]);
    }
  });

  it("4. limit is 1..100 (101 refused), page is at least 1 (0 refused); strings are coerced", async () => {
    expect((await check({ limit: "100", page: "3" })).dto).toMatchObject({ limit: 100, page: 3 });
    expect((await check({ limit: "101" })).fields).toEqual(["limit"]);
    expect((await check({ limit: "0" })).fields).toEqual(["limit"]);
    expect((await check({ page: "0" })).fields).toEqual(["page"]);
    expect((await check({ page: "-1" })).fields).toEqual(["page"]);
    expect((await check({ page: "1.5" })).fields).toEqual(["page"]);
  });

  it("an unknown query key is refused (whitelist)", async () => {
    expect((await check({ clerk: "u-1" })).fields).toEqual(["clerk"]);
  });
});
