import { Logger } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { PolicyService } from "../policy/policy.service";
import { PolicyOversellReader } from "./policy-oversell-reader";
import { resolveOversellAllowed } from "./oversell-policy";

/**
 * WS9 layering through the REAL `PolicyService` + the REAL `PolicyOversellReader` + the REAL
 * `resolveOversellAllowed`, over a fake `policyValue` table (the `where` the service sends is
 * applied, so a wrong tenant/superseded filter is observable). Only the DB is faked.
 */
const KEY = "orders.buyerOversell";
const T = "t-1";

type Row = {
  id: string;
  tenantId: string;
  key: string;
  scopeType: "TENANT" | "CUSTOMER";
  scopeId: string | null;
  value: string;
  createdAt: Date;
  supersededAt: Date | null;
};
let n = 0;
const row = (p: Partial<Row>): Row => ({
  id: `r-${++n}`,
  tenantId: T,
  key: KEY,
  scopeType: "TENANT",
  scopeId: null,
  value: "backorder",
  createdAt: new Date(2026, 8, 1, 0, 0, n),
  supersededAt: null,
  ...p,
});

function build(table: Row[] | Error) {
  const findMany = jest.fn(async (a: { where: { tenantId: string; supersededAt: null } }) => {
    if (table instanceof Error) throw table;
    return table.filter((r) => r.tenantId === a.where.tenantId && r.supersededAt === null);
  });
  const prisma = { policyValue: { findMany } };
  const svc = new PolicyService(prisma as never);
  const reader = new PolicyOversellReader(svc);
  const allowed = (customerId: string, tenantId = T) =>
    resolveOversellAllowed(reader, {
      tenantId,
      role: UserRole.CUSTOMER,
      source: "buyer",
      customerId,
    });
  return { svc, reader, allowed, findMany };
}

describe("oversell policy layering (real PolicyService)", () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it("tenant off + CUSTOMER-scope backorder for c1 -> c1 true, c2 false", async () => {
    const { allowed } = build([
      row({ value: "off" }),
      row({ scopeType: "CUSTOMER", scopeId: "c1", value: "backorder" }),
    ]);
    expect(await allowed("c1")).toBe(true);
    expect(await allowed("c2")).toBe(false);
  });

  it("tenant backorder + CUSTOMER-scope off for c2 -> c2 false, c1 true", async () => {
    const { allowed } = build([
      row({ value: "backorder" }),
      row({ scopeType: "CUSTOMER", scopeId: "c2", value: "off" }),
    ]);
    expect(await allowed("c2")).toBe(false);
    expect(await allowed("c1")).toBe(true);
  });

  it("no rows -> false (registry default off)", async () => {
    const { allowed } = build([]);
    expect(await allowed("c1")).toBe(false);
  });

  it("a superseded or another tenant's row never applies", async () => {
    const { allowed } = build([
      row({ value: "backorder", supersededAt: new Date() }),
      row({ tenantId: "other", value: "backorder" }),
    ]);
    expect(await allowed("c1")).toBe(false);
  });

  it("a policy read error (findMany throws) -> PolicyService yields the default -> false", async () => {
    const { allowed, reader } = build(new Error("db down"));
    await expect(allowed("c1")).resolves.toBe(false);
    await expect(reader.read({ tenantId: T, customerId: "c1" })).resolves.toBe("off");
  });

  it("a row whose value no longer validates is skipped, never a backorder", async () => {
    const { allowed } = build([row({ value: "yes please" })]);
    expect(await allowed("c1")).toBe(false);
  });

  it("staff never read the policy table (staff short-circuit), CUSTOMER does exactly once", async () => {
    const { reader, findMany } = build([row({ value: "off" })]);
    await resolveOversellAllowed(reader, {
      tenantId: T,
      role: UserRole.OPERATOR,
      source: "staff_entry",
    });
    expect(findMany).not.toHaveBeenCalled();
    await resolveOversellAllowed(reader, {
      tenantId: T,
      role: UserRole.CUSTOMER,
      source: "buyer",
      customerId: "c1",
    });
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("a DRIVER never reads the policy table, even with backorder on", async () => {
    const { reader, findMany } = build([row({ value: "backorder" })]);
    await expect(
      resolveOversellAllowed(reader, {
        tenantId: T,
        role: UserRole.DRIVER,
        source: "buyer",
        customerId: "c1",
      }),
    ).resolves.toBe(false);
    expect(findMany).not.toHaveBeenCalled();
  });
});
