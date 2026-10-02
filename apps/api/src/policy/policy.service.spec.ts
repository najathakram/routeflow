/**
 * PolicyService unit spec (SA-138 §3.3) — the mocked-boundary half. The real-Postgres half
 * (layering against real rows, supersede, lock serialisation, audit row, isolation) is
 * `policy.service.db.spec.ts`.
 */
import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { PolicyService } from "./policy.service";

jest.mock("../common/db-locks", () => {
  const actual = jest.requireActual("../common/db-locks");
  return {
    ...actual,
    withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
      acquired: true,
      value: await fn(),
    })),
  };
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const locks = require("../common/db-locks");

const T = "tenant-1";
const at = (s: number) => new Date(Date.UTC(2026, 8, 24, 0, 0, s));

function row(p: Partial<Record<string, unknown>>) {
  return {
    id: `r-${Math.random()}`,
    key: "orders.driverAtDoorEdit",
    scopeType: "TENANT",
    scopeId: null,
    value: "amend",
    createdAt: at(0),
    ...p,
  };
}

function build(rows: unknown[] | Error = []) {
  const findMany = jest.fn(async () => {
    if (rows instanceof Error) throw rows;
    return rows;
  });
  const tx = {
    policyValue: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }: any) => ({ id: "new-row", ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    policyValue: { findMany },
    customer: { findFirst: jest.fn().mockResolvedValue({ id: "cust-1" }) },
    trackedCategory: { findFirst: jest.fn().mockResolvedValue({ id: "cat-1" }) },
    tenantTransaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    getTenantId: jest.fn().mockReturnValue(null),
  };
  const svc = new PolicyService(prisma as never);
  return { svc, prisma, tx, findMany };
}

const actor = { id: "u1", name: "admin", impersonatedBy: null };

describe("PolicyService.resolve", () => {
  it("returns the registry default when the tenant has no rows", async () => {
    const { svc } = build([]);
    expect(await svc.resolve(T, "orders.driverAtDoorEdit")).toBe("amend");
    expect(await svc.resolve(T, "credit.approvalThreshold")).toBeNull();
    expect(await svc.resolve(T, "invoicing.priceDisclosure")).toEqual([
      "originalPrice",
      "discount",
      "msrp",
    ]);
  });

  it("layers default → TENANT → CUSTOMER, the most specific winning; a CUSTOMER row only applies to its customer", async () => {
    const { svc } = build([
      row({ value: "replace" }),
      row({ scopeType: "CUSTOMER", scopeId: "cust-1", value: "disabled" }),
    ]);
    expect(await svc.resolve(T, "orders.driverAtDoorEdit")).toBe("replace");
    expect(await svc.resolve(T, "orders.driverAtDoorEdit", { customerId: "cust-1" })).toBe(
      "disabled",
    );
    expect(await svc.resolve(T, "orders.driverAtDoorEdit", { customerId: "cust-2" })).toBe(
      "replace",
    );
  });

  it("ignores a CATEGORY row for a key whose registry scopes exclude CATEGORY", async () => {
    const { svc } = build([row({ scopeType: "CATEGORY", scopeId: "cat-1", value: "disabled" })]);
    expect(await svc.resolve(T, "orders.driverAtDoorEdit", { categoryId: "cat-1" })).toBe("amend");
  });

  it("skips an invalid stored layer and keeps the layer below it", async () => {
    const { svc } = build([
      row({ value: "replace" }),
      row({ scopeType: "CUSTOMER", scopeId: "cust-1", value: "bogus" }),
    ]);
    expect(await svc.resolve(T, "orders.driverAtDoorEdit", { customerId: "cust-1" })).toBe(
      "replace",
    );
  });

  it("tie-breaks two active rows at one scope on the newest createdAt", async () => {
    const { svc } = build([
      row({ value: "disabled", createdAt: at(1) }),
      row({ value: "replace", createdAt: at(2) }),
    ]);
    expect(await svc.resolve(T, "orders.driverAtDoorEdit")).toBe("replace");
  });

  it("NEVER throws: a DB error resolves the default", async () => {
    const { svc } = build(new Error("connection refused"));
    await expect(svc.resolve(T, "credit.approvalThreshold")).resolves.toBeNull();
  });

  it("a read that races an invalidate() never re-caches its pre-write rows", async () => {
    const { svc, findMany } = build([]);
    let release!: () => void;
    findMany.mockImplementationOnce(
      () => new Promise((r) => (release = () => r([row({ value: "amend" })]))),
    );
    const inFlight = svc.resolve(T, "orders.driverAtDoorEdit");
    await Promise.resolve();
    svc.invalidate(T); // a write committed while the read was awaiting
    release();
    await inFlight;
    findMany.mockResolvedValueOnce([row({ value: "replace" })]);
    expect(await svc.resolve(T, "orders.driverAtDoorEdit")).toBe("replace"); // re-read, not stale
  });

  it("an exact createdAt tie is broken deterministically by id", async () => {
    const rows = [
      row({ id: "b", value: "disabled", createdAt: at(1) }),
      row({ id: "a", value: "replace", createdAt: at(1) }),
    ];
    expect(await build(rows).svc.resolve(T, "orders.driverAtDoorEdit")).toBe("disabled");
    expect(await build([...rows].reverse()).svc.resolve(T, "orders.driverAtDoorEdit")).toBe(
      "disabled",
    );
  });

  it("caches per tenant for 30 s and invalidate() forces a fresh read", async () => {
    const { svc, findMany } = build([]);
    await svc.resolve(T, "orders.driverAtDoorEdit");
    await svc.resolve(T, "credit.approvalThreshold");
    expect(findMany).toHaveBeenCalledTimes(1);
    svc.invalidate(T);
    await svc.resolve(T, "orders.driverAtDoorEdit");
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});

describe("PolicyService.effectiveForClient", () => {
  it("encodes enum values verbatim and set values as JSON text", async () => {
    const { svc } = build([row({ key: "invoicing.priceDisclosure", value: ["discount"] })]);
    expect(await svc.effectiveForClient(T)).toEqual({
      "orders.driverAtDoorEdit": "amend",
      "invoicing.priceDisclosure": '["discount"]',
    });
  });

  it("with no rows every value is today's default", async () => {
    const { svc } = build([]);
    expect(await svc.effectiveForClient(T)).toEqual({
      "orders.driverAtDoorEdit": "amend",
      "invoicing.priceDisclosure": '["originalPrice","discount","msrp"]',
    });
  });

  it("never exposes a clientVisible:false key — the credit band stays server-side even when set", async () => {
    const { svc } = build([row({ key: "credit.approvalThreshold", value: 250 })]);
    expect(await svc.effectiveForClient(T)).not.toHaveProperty(["credit.approvalThreshold"]);
    expect(await svc.resolve(T, "credit.approvalThreshold")).toBe(250); // the server still sees it
  });
});

describe("PolicyService.set / clear validation (400s never reach the lock)", () => {
  beforeEach(() => (locks.withAdvisoryLock as jest.Mock).mockClear());

  const base = {
    tenantId: T,
    key: "orders.driverAtDoorEdit",
    scopeType: "TENANT" as const,
    value: "replace",
    reason: "office wants it",
    actor,
  };

  it.each([
    ["an unknown key", { key: "orders.nope" }, "POLICY_KEY_UNKNOWN"],
    ["a value the schema rejects", { value: "sometimes" }, "POLICY_VALUE_INVALID"],
    [
      "a scope the entry does not allow",
      { scopeType: "CATEGORY", scopeId: "cat-1" },
      "POLICY_SCOPE_NOT_ALLOWED",
    ],
    ["a TENANT scope with a scopeId", { scopeId: "x" }, "POLICY_SCOPE_ID_INVALID"],
    ["a CUSTOMER scope without a scopeId", { scopeType: "CUSTOMER" }, "POLICY_SCOPE_ID_INVALID"],
    ["a blank reason", { reason: "   " }, "POLICY_REASON_REQUIRED"],
    [
      "a money value with fractional cents",
      { key: "credit.approvalThreshold", value: 1.005 },
      "POLICY_VALUE_INVALID",
    ],
    [
      "a negative money value",
      { key: "credit.approvalThreshold", value: -1 },
      "POLICY_VALUE_INVALID",
    ],
    [
      "a set with a duplicate",
      { key: "invoicing.priceDisclosure", value: ["msrp", "msrp"] },
      "POLICY_VALUE_INVALID",
    ],
  ] as const)("400 on %s", async (_label, patch, code) => {
    const { svc } = build([]);
    const err = await svc.set({ ...base, ...(patch as object) } as never).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().code).toBe(code);
    expect(locks.withAdvisoryLock).not.toHaveBeenCalled();
  });

  it("400 when a CUSTOMER scopeId is not a customer of this tenant", async () => {
    const { svc, prisma } = build([]);
    prisma.customer.findFirst.mockResolvedValueOnce(null);
    const err = await svc
      .set({ ...base, scopeType: "CUSTOMER", scopeId: "other-tenant-customer" })
      .catch((e) => e);
    expect(err.getResponse().code).toBe("POLICY_SCOPE_TARGET_UNKNOWN");
    expect(prisma.customer.findFirst).toHaveBeenCalledWith({
      where: { id: "other-tenant-customer", tenantId: T },
      select: { id: true },
    });
  });

  it("takes the policy-write lock keyed `${tenantId}:${key}`, writes one audit row, and invalidates", async () => {
    const { svc, tx, findMany } = build([]);
    await svc.resolve(T, "orders.driverAtDoorEdit"); // warm the cache
    await svc.set(base);
    expect(locks.withAdvisoryLock).toHaveBeenCalledWith(
      expect.objectContaining({ family: "policy-write", key: `${T}:orders.driverAtDoorEdit` }),
      expect.any(Function),
    );
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: "policy.set",
      entityType: "PolicyValue",
      entityId: "new-row",
      meta: {
        key: "orders.driverAtDoorEdit",
        scopeType: "TENANT",
        scopeId: null,
        old: null,
        new: "replace",
        reason: "office wants it",
      },
    });
    await svc.resolve(T, "orders.driverAtDoorEdit");
    expect(findMany).toHaveBeenCalledTimes(2); // the write dropped the cached rows
  });

  it("maps a lock timeout to a retryable 503", async () => {
    const { svc } = build([]);
    (locks.withAdvisoryLock as jest.Mock).mockRejectedValueOnce(
      new locks.LockTimeoutError("policy-write", `${T}:orders.driverAtDoorEdit`, 10_000),
    );
    await expect(svc.set(base)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("403 when the request context names a different tenant than the write", async () => {
    const { svc, prisma } = build([]);
    prisma.getTenantId.mockReturnValue("tenant-2");
    const err = await svc.set(base).catch((e) => e);
    expect(err.getResponse().code).toBe("POLICY_TENANT_MISMATCH");
    expect(locks.withAdvisoryLock).not.toHaveBeenCalled();
  });

  it("clear 404s when nothing is set at that scope", async () => {
    const { svc } = build([]);
    const err = await svc
      .clear({ tenantId: T, key: base.key, scopeType: "TENANT", reason: "revert", actor })
      .catch((e) => e);
    expect(err.getResponse().code).toBe("POLICY_NOT_SET");
  });
});
