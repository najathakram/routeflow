/**
 * M2: the Feature Console writers (`set()` PUT, `clear()` DELETE) and the tenant Settings PATCH
 * serialise on ONE advisory lock, family "fulfilment-settings", key = tenantId, for the two
 * fulfilment keys ONLY. Plus the new in-transaction writer `setAuditedInTx` the tenant PATCH uses
 * (the audit is awaited in the SAME transaction, not AuditService.log).
 */
import "reflect-metadata";
import * as fs from "fs";
import * as path from "path";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { LOCK_FAMILIES, LockTimeoutError } from "../common/db-locks";
import { lockState, resetLockState } from "../settings-fulfilment/testing/lock-mock";
import { createWorld, TENANT_ID } from "../settings-fulfilment/testing/fulfilment-world";
import { FLEET_KEYS } from "./fulfilment-capability";

jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.requireActual("../settings-fulfilment/testing/lock-mock")
    .fakeWithAdvisoryLock,
}));

beforeEach(() => resetLockState());

const lockFor = (tenantId: string) => ({
  family: "fulfilment-settings",
  key: tenantId,
  mode: "wait",
});

async function codeOf(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return { status: (e as any).getStatus?.(), ...((e as any).getResponse?.() ?? {}) };
  }
  throw new Error("expected a rejection");
}

describe("the lock family", () => {
  it("is registered in the closed list", () => {
    expect(LOCK_FAMILIES).toContain("fulfilment-settings");
  });
});

describe("set() / clear() take the lock for the two fulfilment keys only", () => {
  it.each(["fulfilment_model", "counter_sales"])("set(%s) runs under the lock", async (key) => {
    const w = createWorld({ fleet: true });
    const mode = key === "counter_sales" ? "on" : "ship";
    await w.featureConfig.set(TENANT_ID, key, mode, "console", "sa-1");
    expect(lockState.calls).toEqual([expect.objectContaining(lockFor(TENANT_ID))]);
    expect(lockState.events).toContain(`lock:acquire:fulfilment-settings:${TENANT_ID}`);
    expect(w.row(key as never)!.mode).toBe(mode);
  });

  it.each(["fulfilment_model", "counter_sales"])("clear(%s) runs under the lock", async (key) => {
    const w = createWorld({ fleet: true, rows: [{ featureKey: key as never, mode: "on" }] });
    await w.featureConfig.clear(TENANT_ID, key, "cleared", "sa-1");
    expect(lockState.calls).toEqual([expect.objectContaining(lockFor(TENANT_ID))]);
  });

  it("the write happens WHILE the lock is held, and the audit too", async () => {
    const w = createWorld({ fleet: true });
    w.prisma.tenantFeatureConfig.upsert.mockImplementationOnce(async () => {
      expect(lockState.held.has(`fulfilment-settings:${TENANT_ID}`)).toBe(true);
      return {};
    });
    w.audit.log.mockImplementationOnce(async () => {
      expect(lockState.held.has(`fulfilment-settings:${TENANT_ID}`)).toBe(true);
    });
    await w.featureConfig.set(TENANT_ID, "fulfilment_model", "ship", "console", "sa-1");
    expect(lockState.held.size).toBe(0); // and the lock is released afterwards
    expect.assertions(3);
  });

  it("any other config key does not touch the lock", async () => {
    const w = createWorld({ fleet: true });
    await w.featureConfig.set(TENANT_ID, "routes_dispatch", "scheduled", "console", "sa-1");
    await w.featureConfig.clear(TENANT_ID, "routes_dispatch", "cleared", "sa-1");
    expect(lockState.calls).toEqual([]);
  });

  it("a lock timeout surfaces as a retryable 409 CONCURRENT_UPDATE and writes nothing", async () => {
    const w = createWorld({ fleet: true });
    lockState.failWith = new LockTimeoutError("fulfilment-settings", TENANT_ID, 10_000);
    const e = await codeOf(
      w.featureConfig.set(TENANT_ID, "fulfilment_model", "ship", "console", "sa-1"),
    );
    expect(e.status).toBe(409);
    expect(e.code).toBe(API_ERROR_CODES.CONCURRENT_UPDATE);
    expect(w.rowCount()).toBe(0);
  });

  it("set() behaviour is unchanged: same row, same AuditService.log payload, same invalidation", async () => {
    const w = createWorld({ fleet: true });
    const invalidate = jest.spyOn(w.store, "invalidate");
    await w.featureConfig.set(TENANT_ID, "fulfilment_model", "ship", "why", "sa-1");
    expect(w.row("fulfilment_model")).toMatchObject({
      mode: "ship",
      reason: "why",
      updatedById: "sa-1",
    });
    expect(invalidate).toHaveBeenCalledWith(TENANT_ID, "fulfilment_model");
    expect(w.audit.log).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: "sa-1",
      action: "FEATURE_CONFIG_SET",
      entityType: "TenantFeatureConfig",
      entityId: "fulfilment_model",
      meta: { key: "fulfilment_model", mode: "ship", reason: "why" },
    });
  });

  it("clear() behaviour is unchanged: deleteMany scoped to the tenant, same audit payload", async () => {
    const w = createWorld({
      fleet: true,
      rows: [{ featureKey: "fulfilment_model", mode: "ship" }],
    });
    await w.featureConfig.clear(TENANT_ID, "fulfilment_model", "bye", "sa-1");
    expect(w.prisma.tenantFeatureConfig.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID, featureKey: "fulfilment_model" },
    });
    expect(w.audit.log).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: "sa-1",
      action: "FEATURE_CONFIG_CLEARED",
      entityType: "TenantFeatureConfig",
      entityId: "fulfilment_model",
      meta: { key: "fulfilment_model", reason: "bye" },
    });
  });

  it("set() keeps its refusals: unknown key / mode, unavailable mode, needs-fleet", async () => {
    const w = createWorld({ fleet: false });
    expect((await codeOf(w.featureConfig.set(TENANT_ID, "nope", "x", "r", "a"))).status).toBe(400);
    expect(
      (await codeOf(w.featureConfig.set(TENANT_ID, "fulfilment_model", "teleport", "r", "a")))
        .status,
    ).toBe(400);
    const fleet = await codeOf(
      w.featureConfig.set(TENANT_ID, "fulfilment_model", "delivery", "r", "a"),
    );
    expect(fleet).toMatchObject({
      status: 409,
      code: API_ERROR_CODES.FULFILMENT_MODE_NEEDS_FLEET,
      missing: [...FLEET_KEYS],
    });
    expect(w.rowCount()).toBe(0);
  });
});

describe("snapshot restore stays OUTSIDE the lock (last writer wins)", () => {
  it("tenant-config-snapshot.service does not take the fulfilment lock and says why", () => {
    const src = fs.readFileSync(path.join(__dirname, "tenant-config-snapshot.service.ts"), "utf8");
    expect(src).not.toMatch(/fulfilment-settings/);
    expect(src).toMatch(/last writer wins/i);
  });
});

describe("setAuditedInTx", () => {
  const actor = {
    userId: "u-ada",
    impersonatedBy: null as string | null,
    reason: "Changed in Settings → Fulfillment",
  };
  const meta = {
    from: "unset",
    to: "ship",
    via: "tenant_settings",
    fingerprint: "0123456789abcdef",
  };

  function tx() {
    return {
      tenantFeatureConfig: { upsert: jest.fn(async () => ({})) },
      auditLog: { create: jest.fn(async () => ({})) },
    };
  }

  it("upserts on (tenantId, featureKey) through the tx and awaits the audit in the SAME tx", async () => {
    const w = createWorld({ fleet: true });
    const t = tx();
    await w.featureConfig.setAuditedInTx(t, TENANT_ID, "fulfilment_model", "ship", actor, meta);
    expect(t.tenantFeatureConfig.upsert).toHaveBeenCalledWith({
      where: { tenantId_featureKey: { tenantId: TENANT_ID, featureKey: "fulfilment_model" } },
      create: {
        tenantId: TENANT_ID,
        featureKey: "fulfilment_model",
        mode: "ship",
        reason: actor.reason,
        updatedById: "u-ada",
      },
      update: { mode: "ship", reason: actor.reason, updatedById: "u-ada" },
    });
    expect(t.auditLog.create).toHaveBeenCalledWith({
      data: {
        tenantId: TENANT_ID,
        userId: "u-ada",
        impersonatedBy: null,
        action: "FEATURE_CONFIG_SET",
        entityType: "TenantFeatureConfig",
        entityId: "fulfilment_model",
        meta: { key: "fulfilment_model", mode: "ship", ...meta },
      },
    });
    // Nothing leaves the transaction: no direct prisma write, no AuditService.log, no lock, no cache drop.
    expect(w.prisma.tenantFeatureConfig.upsert).not.toHaveBeenCalled();
    expect(w.audit.log).not.toHaveBeenCalled();
    expect(lockState.calls).toEqual([]);
  });

  it("does not swallow an audit failure (the caller's transaction must roll back)", async () => {
    const w = createWorld({ fleet: true });
    const t = tx();
    t.auditLog.create.mockRejectedValueOnce(new Error("audit down"));
    await expect(
      w.featureConfig.setAuditedInTx(t, TENANT_ID, "counter_sales", "on", actor, meta),
    ).rejects.toThrow("audit down");
  });

  it("validates exactly like set(): own delivery without a fleet is the 409 and nothing is written", async () => {
    const w = createWorld({ fleet: false });
    const t = tx();
    const e = await codeOf(
      w.featureConfig.setAuditedInTx(t, TENANT_ID, "fulfilment_model", "delivery", actor, meta),
    );
    expect(e).toMatchObject({ status: 409, code: API_ERROR_CODES.FULFILMENT_MODE_NEEDS_FLEET });
    expect(t.tenantFeatureConfig.upsert).not.toHaveBeenCalled();
    expect(t.auditLog.create).not.toHaveBeenCalled();
  });

  it("refuses an unknown key, an unknown mode and an unavailable mode with a 400", async () => {
    const w = createWorld({ fleet: true });
    const t = tx();
    for (const [key, mode] of [
      ["nope", "x"],
      ["fulfilment_model", "teleport"],
    ] as const) {
      expect(
        (await codeOf(w.featureConfig.setAuditedInTx(t, TENANT_ID, key, mode, actor, meta))).status,
      ).toBe(400);
    }
    expect(t.tenantFeatureConfig.upsert).not.toHaveBeenCalled();
  });
});
