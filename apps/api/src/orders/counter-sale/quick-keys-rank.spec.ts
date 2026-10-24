import { BadRequestException } from "@nestjs/common";
import { rankCounterProducts } from "./quick-keys-rank";

/**
 * The ranking SQL is proved against a real database in quick-keys-rank.db.spec.ts (NEED-DB). This spec pins
 * what a mock CAN prove: the statement is parameterized (no value is concatenated), the tenant is bound on
 * both tables, the window start is computed from `now`, and bad input is refused before any query.
 */
const T = "tenant-a";
const NOW = new Date("2026-10-08T12:00:00.000Z");

function fake(rows: { productId: string }[] = []) {
  const queryRaw = jest.fn(async (..._args: unknown[]) => rows);
  return { queryRaw, prisma: { $queryRaw: queryRaw } as never };
}

describe("rankCounterProducts", () => {
  it("returns the product ids in the order the query gave", async () => {
    const f = fake([{ productId: "b" }, { productId: "a" }]);
    expect(await rankCounterProducts(f.prisma, T, 30, NOW)).toEqual(["b", "a"]);
  });

  it("is one tagged-template query with every value bound: tenant, since, tenant, take", async () => {
    const f = fake();
    await rankCounterProducts(f.prisma, T, 30, NOW);
    expect(f.queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...bound] = f.queryRaw.mock.calls[0] as unknown as [string[], ...unknown[]];
    expect(Array.isArray(strings)).toBe(true);
    expect(bound).toEqual([T, new Date("2026-09-08T12:00:00.000Z"), T, 40]);
    const sql = strings.join("?");
    // the tenant is a clause on BOTH tables, and the statement text carries none of the bound values
    expect(sql).toContain('o."tenantId" = ?');
    expect(sql).toContain('p."tenantId" = ?');
    expect(sql).not.toContain(T);
    // the rule: counter orders, not cancelled, distinct orders, then units, then name
    expect(sql).toContain('o."counterSale" = true');
    expect(sql).toContain("<> 'CANCELLED'");
    expect(sql).toContain('p."isActive" = true');
    expect(sql).toContain('oi."productId" IS NOT NULL');
    expect(sql).toMatch(
      /ORDER BY COUNT\(DISTINCT oi\."orderId"\) DESC,\s+SUM\(oi\."qty"\) DESC,\s+p\."name" ASC/,
    );
  });

  it("the window start moves with windowDays", async () => {
    const f = fake();
    await rankCounterProducts(f.prisma, T, 7, NOW);
    const bound = (f.queryRaw.mock.calls[0] as unknown[]).slice(1);
    expect(bound[1]).toEqual(new Date("2026-10-01T12:00:00.000Z"));
  });

  it("refuses an empty tenant and a bad window before any query", async () => {
    const f = fake();
    await expect(rankCounterProducts(f.prisma, "", 30, NOW)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    for (const days of [0, 366, 1.5, NaN]) {
      await expect(rankCounterProducts(f.prisma, T, days, NOW)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
    expect(f.queryRaw).not.toHaveBeenCalled();
  });
});
