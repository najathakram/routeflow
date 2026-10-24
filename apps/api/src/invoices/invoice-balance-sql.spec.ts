/**
 * SA-770 (ACTION-ITEMS row 294): "overdue" means a balance is due. The ONE SQL predicate
 * (`balanceDueSql`) and the three readers built on it (`overdueInvoiceIds`, `overdueInvoiceCount`,
 * `markInvoicesOverdue`). The mock style records the `Prisma.Sql` each reader hands to the client,
 * so the pins are on the bound values and the fragment text — the SQL-vs-TS parity itself is the
 * real-Postgres spec `invoice-balance-sql.parity.db.spec.ts`.
 */
import { UnprocessableEntityException } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { CONFIRMED_STATUS } from "./payment-predicates";
import {
  OVERDUE_IDS_CAP,
  balanceDueSql,
  markInvoicesOverdue,
  overdueInvoiceCount,
  overdueInvoiceIds,
} from "./invoice-balance-sql";

const TENANT = "tenant-acme";
const CUTOFF = new Date("2026-10-02T00:00:00.000Z");
const OPEN = [
  InvoiceStatus.SENT,
  InvoiceStatus.VIEWED,
  InvoiceStatus.PARTIAL,
  InvoiceStatus.OVERDUE,
];

function fakeDb() {
  return {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
  };
}
const sqlOf = (fn: jest.Mock, call = 0) =>
  fn.mock.calls[call][0] as { sql: string; values: unknown[] };

describe("balanceDueSql — the one SQL balance predicate", () => {
  it("is built from the pricing CONFIRMED_STATUS constant, bound — never a typed literal", () => {
    const frag = balanceDueSql("i");
    expect(frag.values).toContain(CONFIRMED_STATUS);
    expect(frag.sql).not.toMatch(/'PAID'|'CONFIRMED'/);
  });

  it("sums every confirmed InvoicePayment row (cash, credit-note and advance applications alike)", () => {
    const { sql } = balanceDueSql("i");
    expect(sql).toMatch(/"InvoicePayment"/);
    expect(sql).toMatch(/"invoiceId"\s*=\s*"i"\."id"/);
    expect(sql).toMatch(/"status"\s*=\s*\?::"PaymentStatus"/);
    // No method filter: TS `balanceDue` subtracts the cash + credit + advance buckets together.
    expect(sql).not.toMatch(/"method"/);
  });

  it("is `total - confirmed > 0.005`, the SQL twin of roundMoney(balance) > 0", () => {
    const { sql } = balanceDueSql("i");
    expect(sql).toMatch(/"i"\."total"\s*-\s*COALESCE\(/);
    expect(sql).toMatch(/,\s*0\)\s*>\s*0\.005/);
  });

  it("uses the alias it is given (and only a plain identifier is accepted)", () => {
    expect(balanceDueSql("inv").sql).toContain('"inv"."total"');
    expect(() => balanceDueSql('i" OR 1=1 --')).toThrow(/alias/i);
    expect(() => balanceDueSql("")).toThrow(/alias/i);
  });
});

describe("overdueInvoiceIds", () => {
  it("returns the ids the query selects", async () => {
    const db = fakeDb();
    db.$queryRaw.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    await expect(overdueInvoiceIds(db as any, TENANT, CUTOFF, { statuses: OPEN })).resolves.toEqual(
      ["a", "b"],
    );
  });

  it("binds tenant, cutoff and every status — nothing is interpolated into the SQL text", async () => {
    const db = fakeDb();
    db.$queryRaw.mockResolvedValue([]);
    await overdueInvoiceIds(db as any, TENANT, CUTOFF, { statuses: OPEN });
    const { sql, values } = sqlOf(db.$queryRaw);
    expect(values).toEqual(expect.arrayContaining([TENANT, ...OPEN, CONFIRMED_STATUS]));
    expect(values).toContain(CUTOFF.toISOString());
    for (const v of [TENANT, CUTOFF.toISOString(), "SENT", "VIEWED", "PARTIAL"]) {
      expect(sql).not.toContain(v);
    }
    expect(sql).toMatch(/"tenantId"\s*=\s*\?/);
    expect(sql).toMatch(/"dueDate"\s*<\s*\?::timestamp/);
    expect(sql).toMatch(/"i"\."total"\s*-\s*COALESCE\(/); // the balance predicate is in the query
  });

  it("scopes to one customer when asked, as a bound value", async () => {
    const db = fakeDb();
    db.$queryRaw.mockResolvedValue([]);
    await overdueInvoiceIds(db as any, TENANT, CUTOFF, { statuses: OPEN, customerId: "cust-1" });
    const { sql, values } = sqlOf(db.$queryRaw);
    expect(values).toContain("cust-1");
    expect(sql).toMatch(/"customerId"\s*=\s*\?/);
    expect(sql).not.toContain("cust-1");
  });

  it("refuses to run without a tenant (fail closed, no query)", async () => {
    const db = fakeDb();
    await expect(overdueInvoiceIds(db as any, "", CUTOFF, { statuses: OPEN })).rejects.toThrow(
      /tenant/i,
    );
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("an empty status list selects nothing and runs no query", async () => {
    const db = fakeDb();
    await expect(overdueInvoiceIds(db as any, TENANT, CUTOFF, { statuses: [] })).resolves.toEqual(
      [],
    );
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("asks for at most cap + 1 rows, so over-cap is detected without fetching the whole set", async () => {
    const db = fakeDb();
    db.$queryRaw.mockResolvedValue([]);
    await overdueInvoiceIds(db as any, TENANT, CUTOFF, { statuses: OPEN });
    expect(sqlOf(db.$queryRaw).values).toContain(OVERDUE_IDS_CAP + 1);
  });

  it("exactly at the cap is fine", async () => {
    const db = fakeDb();
    db.$queryRaw.mockResolvedValue(
      Array.from({ length: OVERDUE_IDS_CAP }, (_, i) => ({ id: `i${i}` })),
    );
    const ids = await overdueInvoiceIds(db as any, TENANT, CUTOFF, { statuses: OPEN });
    expect(ids).toHaveLength(OVERDUE_IDS_CAP);
  });

  it("past the cap throws a coded 422 OVERDUE_FILTER_TOO_BROAD — it never truncates", async () => {
    const db = fakeDb();
    db.$queryRaw.mockResolvedValue(
      Array.from({ length: OVERDUE_IDS_CAP + 1 }, (_, i) => ({ id: `i${i}` })),
    );
    const err = await overdueInvoiceIds(db as any, TENANT, CUTOFF, { statuses: OPEN }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(err.getStatus()).toBe(422);
    expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.OVERDUE_FILTER_TOO_BROAD });
    expect(API_ERROR_CODES.OVERDUE_FILTER_TOO_BROAD).toBe("OVERDUE_FILTER_TOO_BROAD");
  });

  it("the cap is the named 10 000", () => {
    expect(OVERDUE_IDS_CAP).toBe(10_000);
  });
});

describe("overdueInvoiceCount", () => {
  it("counts with the same predicate, bound, tenant-scoped, and returns a plain number", async () => {
    const db = fakeDb();
    db.$queryRaw.mockResolvedValue([{ count: 7 }]);
    await expect(overdueInvoiceCount(db as any, TENANT, CUTOFF, { statuses: OPEN })).resolves.toBe(
      7,
    );
    const { sql, values } = sqlOf(db.$queryRaw);
    expect(sql).toMatch(/COUNT\(\*\)/i);
    expect(sql).toMatch(/"i"\."total"\s*-\s*COALESCE\(/);
    expect(values).toEqual(
      expect.arrayContaining([TENANT, CUTOFF.toISOString(), CONFIRMED_STATUS]),
    );
    expect(sql).not.toContain(TENANT);
  });

  it("is not capped (a dashboard count must not 422)", async () => {
    const db = fakeDb();
    db.$queryRaw.mockResolvedValue([{ count: OVERDUE_IDS_CAP * 3 }]);
    await expect(overdueInvoiceCount(db as any, TENANT, CUTOFF, { statuses: OPEN })).resolves.toBe(
      OVERDUE_IDS_CAP * 3,
    );
  });

  it("fails closed without a tenant, and an empty status list is zero with no query", async () => {
    const db = fakeDb();
    await expect(overdueInvoiceCount(db as any, "", CUTOFF, { statuses: OPEN })).rejects.toThrow(
      /tenant/i,
    );
    await expect(overdueInvoiceCount(db as any, TENANT, CUTOFF, { statuses: [] })).resolves.toBe(0);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("markInvoicesOverdue — the sweep's write", () => {
  it("is ONE atomic UPDATE carrying the balance predicate, bound and tenant-scoped", async () => {
    const db = fakeDb();
    db.$executeRaw.mockResolvedValue(4);
    const n = await markInvoicesOverdue(db as any, TENANT, CUTOFF, [
      InvoiceStatus.SENT,
      InvoiceStatus.VIEWED,
    ]);
    expect(n).toBe(4);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    const { sql, values } = sqlOf(db.$executeRaw);
    expect(sql).toMatch(/^\s*UPDATE "Invoice"/);
    expect(sql).toMatch(/SET "status"\s*=\s*\?::"InvoiceStatus"/);
    expect(sql).toMatch(/"updatedAt"\s*=\s*NOW\(\)/i);
    expect(sql).toMatch(/"tenantId"\s*=\s*\?/);
    expect(sql).toMatch(/"i"\."total"\s*-\s*COALESCE\(/);
    expect(values).toEqual(
      expect.arrayContaining([
        TENANT,
        "OVERDUE",
        "SENT",
        "VIEWED",
        CUTOFF.toISOString(),
        CONFIRMED_STATUS,
      ]),
    );
    expect(sql).not.toContain(TENANT);
    expect(sql).not.toContain("OVERDUE'");
  });

  it("fails closed without a tenant; an empty status list writes nothing", async () => {
    const db = fakeDb();
    await expect(markInvoicesOverdue(db as any, "", CUTOFF, [InvoiceStatus.SENT])).rejects.toThrow(
      /tenant/i,
    );
    await expect(markInvoicesOverdue(db as any, TENANT, CUTOFF, [])).resolves.toBe(0);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
});
