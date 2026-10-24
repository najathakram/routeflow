import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { UserRole } from "@prisma/client";
import { SettingsController } from "./settings.controller";
import { SystemConfigService } from "./system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { quickKeysSettingsStubProvider } from "../testing/quick-keys-settings-stub";
import { createMockPrisma } from "../testing/prisma-mock";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { resetTenantZoneWarnings } from "../common/tenant-time-zone";
import { CounterSaleTodayService } from "../orders/counter-sale/counter-sale-today.service";
import { TENANT_TIMEZONE_CHANGED_ACTION } from "./tenant-timezone.writer";
import type { JwtPayload } from "../auth/jwt-payload.interface";

const admin = { sub: "u-admin", role: UserRole.TENANT_ADMIN } as JwtPayload;
const operator = { sub: "u-op", role: UserRole.OPERATOR } as JwtPayload;

async function build(cfg: unknown, opts: { set?: jest.Mock } = {}) {
  const prisma = createMockPrisma() as any;
  prisma.getTenantId = jest.fn(() => "t1");
  prisma.tenantConfig.findUnique = jest.fn().mockResolvedValue(cfg);
  prisma.tenantConfig.upsert = jest.fn().mockResolvedValue({});
  prisma.auditLog.create = jest.fn().mockResolvedValue({});
  // The zone write runs in tenantTransaction on its OWN tx object, so a test can tell the audited
  // transactional write from the plain outer-client upsert the other fields use.
  const tx = {
    tenantConfig: {
      findUnique: jest.fn().mockResolvedValue(cfg),
      upsert: jest.fn().mockResolvedValue({}),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  prisma.tenantTransaction = jest.fn((fn: any) => fn(tx));
  prisma.invoice = { updateMany: jest.fn() };
  prisma.forTenant = jest.fn(() => ({ user: { findFirst: jest.fn().mockResolvedValue(null) } }));
  const set = opts.set ?? jest.fn();
  const m = await Test.createTestingModule({
    controllers: [SettingsController],
    providers: [
      {
        provide: SystemConfigService,
        useValue: {
          getAll: jest.fn().mockResolvedValue({}),
          get: jest.fn().mockResolvedValue(null),
          set,
        },
      },
      { provide: ConfigService, useValue: { get: jest.fn() } },
      { provide: PrismaService, useValue: prisma },
      { provide: EmailService, useValue: { send: jest.fn() } },
      quickKeysSettingsStubProvider,
    ],
  }).compile();
  return { c: m.get(SettingsController), prisma, tx, set };
}

describe("GET /settings: tenant timezone (SA-738, one resolver)", () => {
  beforeEach(() => resetTenantZoneWarnings());

  it("returns the tenant's own zone", async () => {
    const { c } = await build({ timezone: "America/Los_Angeles" });
    expect((await c.getSettings()).timezone).toBe("America/Los_Angeles");
  });

  it("a tenant with no config row gets UTC, the same zone the server's other paths use", async () => {
    const { c } = await build(null);
    expect((await c.getSettings()).timezone).toBe("UTC");
  });

  it("never echoes an invalid stored zone: Mars/Phobos resolves to UTC", async () => {
    const { c } = await build({ timezone: "Mars/Phobos" });
    expect((await c.getSettings()).timezone).toBe("UTC");
  });

  it("HEADLINE: GET /settings timezone equals the counter window's meta.timezone for a no-row tenant", async () => {
    const { c, prisma } = await build(null);
    prisma.forTenant = jest.fn(() => ({
      user: { findFirst: jest.fn().mockResolvedValue(null) },
      systemConfig: { findFirst: jest.fn().mockResolvedValue(null) },
      order: prisma.order,
      invoicePayment: prisma.invoicePayment,
      return: prisma.return,
      creditNote: prisma.creditNote,
    }));
    prisma.creditNote.findMany.mockResolvedValue([]);
    prisma.order.findMany.mockResolvedValue([]);
    prisma.order.count.mockResolvedValue(0);
    const counter = new CounterSaleTodayService(prisma as never);
    const today = await counter.today(
      { page: 1, limit: 50 } as never,
      new Date("2026-10-07T15:00:00Z"),
    );
    expect((await c.getSettings()).timezone).toBe(today.meta.timezone);
    expect(today.meta.timezone).toBe("UTC");
  });
});

describe("PATCH /settings: timezone writer (SA-738 R16-4)", () => {
  beforeEach(() => resetTenantZoneWarnings());

  it("TENANT_ADMIN writes a valid zone and an audit row (actor, old, new)", async () => {
    const { c, tx } = await build({ timezone: "America/New_York" });
    await c.updateSettings({ timezone: "America/Chicago" }, admin);
    expect(tx.tenantConfig.upsert).toHaveBeenCalledWith({
      where: { tenantId: "t1" },
      create: { tenantId: "t1", timezone: "America/Chicago" },
      update: { timezone: "America/Chicago" },
    });
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({
      tenantId: "t1",
      userId: "u-admin",
      impersonatedBy: null,
      action: TENANT_TIMEZONE_CHANGED_ACTION,
      entityType: "TenantConfig",
      entityId: "t1",
      meta: { old: "America/New_York", new: "America/Chicago" },
    });
  });

  it("writes the zone and the audit row on the SAME transaction object, never the outer client", async () => {
    const { c, prisma, tx } = await build({ timezone: "America/New_York" });
    await c.updateSettings({ timezone: "Asia/Tokyo" }, admin);
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    expect(tx.tenantConfig.upsert).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.tenantConfig.upsert).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("SUPER_ADMIN may change the zone, and the audit row stamps impersonatedBy", async () => {
    const { c, tx } = await build({ timezone: "America/New_York" });
    const impersonating = {
      sub: "u-imp",
      role: UserRole.SUPER_ADMIN,
      impersonatedBy: "sa-1",
    } as JwtPayload;
    await c.updateSettings({ timezone: "Europe/London" }, impersonating);
    expect(tx.tenantConfig.upsert).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({
      userId: "u-imp",
      impersonatedBy: "sa-1",
    });
  });

  it("stores the case-corrected name", async () => {
    const { c, tx } = await build({ timezone: "America/New_York" });
    await c.updateSettings({ timezone: "america/chicago" }, admin);
    expect(tx.tenantConfig.upsert.mock.calls[0][0].update).toEqual({ timezone: "America/Chicago" });
    expect(tx.auditLog.create.mock.calls[0][0].data.meta).toEqual({
      old: "America/New_York",
      new: "America/Chicago",
    });
  });

  it("an OPERATOR gets 403 and nothing is written (not even the other fields)", async () => {
    const { c, prisma, tx, set } = await build({ timezone: "America/New_York" });
    await expect(
      c.updateSettings({ timezone: "America/Chicago", taxRate: 5 }, operator),
    ).rejects.toThrow(ForbiddenException);
    expect(tx.tenantConfig.upsert).not.toHaveBeenCalled();
    expect(prisma.tenantConfig.upsert).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it("no authenticated user is 403 too", async () => {
    const { c, tx } = await build({ timezone: "America/New_York" });
    await expect(c.updateSettings({ timezone: "America/Chicago" })).rejects.toThrow(
      ForbiddenException,
    );
    expect(tx.tenantConfig.upsert).not.toHaveBeenCalled();
  });

  it.each(["Mars/Phobos", "", "+01:00", "EST", "Etc/GMT+5", 42, null])(
    "a bad zone %p is a 400 INVALID_TIME_ZONE, nothing written",
    async (bad) => {
      const { c, prisma, tx, set } = await build({ timezone: "America/New_York" });
      const err = await c.updateSettings({ timezone: bad, taxRate: 5 }, admin).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: API_ERROR_CODES.INVALID_TIME_ZONE,
      });
      expect(tx.tenantConfig.upsert).not.toHaveBeenCalled();
      expect(prisma.tenantConfig.upsert).not.toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
    },
  );

  it("saving the zone the tenant already has writes nothing and no audit row", async () => {
    const { c, tx } = await build({ timezone: "America/Chicago" });
    await c.updateSettings({ timezone: "America/Chicago" }, admin);
    expect(tx.tenantConfig.upsert).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("a stored lower-case spelling of the same zone is not rewritten (compared on the canonical form)", async () => {
    const { c, tx } = await build({ timezone: "america/chicago" });
    await c.updateSettings({ timezone: "America/Chicago" }, admin);
    expect(tx.tenantConfig.upsert).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("a PATCH without timezone never touches the zone (and needs no admin)", async () => {
    const { c, prisma, tx } = await build({ timezone: "America/Chicago" });
    await c.updateSettings({ city: "Austin" }, operator);
    const call = prisma.tenantConfig.upsert.mock.calls[0][0];
    expect(call.update).toEqual({ city: "Austin" });
    expect(call.create).not.toHaveProperty("timezone");
    expect(tx.tenantConfig.upsert).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("the zone, the other TenantConfig fields and the audit row are ONE write on the tx", async () => {
    const { c, prisma, tx } = await build({ timezone: "America/New_York" });
    await c.updateSettings({ timezone: "America/Chicago", city: "Austin" }, admin);
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    expect(tx.tenantConfig.upsert).toHaveBeenCalledTimes(1);
    expect(tx.tenantConfig.upsert.mock.calls[0][0]).toEqual({
      where: { tenantId: "t1" },
      create: { tenantId: "t1", city: "Austin", timezone: "America/Chicago" },
      update: { city: "Austin", timezone: "America/Chicago" },
    });
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.tenantConfig.upsert).not.toHaveBeenCalled();
  });

  it("an unchanged zone still saves the other fields, in the tx, with no audit row", async () => {
    const { c, prisma, tx } = await build({ timezone: "America/Chicago" });
    await c.updateSettings({ timezone: "America/Chicago", city: "Austin" }, admin);
    expect(tx.tenantConfig.upsert.mock.calls[0][0].update).toEqual({ city: "Austin" });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(prisma.tenantConfig.upsert).not.toHaveBeenCalled();
  });

  // The zone used to commit in its OWN transaction before the other fields were written, so a
  // failed field write left the new zone behind. Model a real rollback: writes are staged and only
  // "commit" when the tx callback returns; the field write (the upsert carrying `city`) throws.
  it("a failed field write rolls the zone and its audit row back: nothing is committed", async () => {
    const { c, prisma } = await build({ timezone: "America/New_York" });
    const committed: string[] = [];
    prisma.tenantTransaction = jest.fn(async (fn: any) => {
      const staged: string[] = [];
      const journalTx = {
        tenantConfig: {
          findUnique: jest.fn().mockResolvedValue({ timezone: "America/New_York" }),
          upsert: jest.fn(async (args: any) => {
            staged.push(`config:${JSON.stringify(args.update)}`);
            if ("city" in args.update) throw new Error("field write failed");
          }),
        },
        auditLog: { create: jest.fn(async () => void staged.push("audit")) },
      };
      const result = await fn(journalTx);
      committed.push(...staged);
      return result;
    });
    prisma.tenantConfig.upsert = jest.fn().mockRejectedValue(new Error("field write failed"));
    await expect(
      c.updateSettings({ timezone: "America/Chicago", city: "Austin" }, admin),
    ).rejects.toThrow("field write failed");
    expect(committed).toEqual([]);
  });

  // taxRate / logoUrl live in SystemConfig and are written LAST: a 403, a 400 or a failed TenantConfig
  // save leaves them untouched.
  it("a failed TenantConfig save (zone tx) leaves taxRate and logoUrl unwritten", async () => {
    const { c, tx, set } = await build({ timezone: "America/New_York" });
    tx.tenantConfig.upsert.mockRejectedValue(new Error("db down"));
    await expect(
      c.updateSettings({ timezone: "America/Chicago", taxRate: 5, logoUrl: "logo.png" }, admin),
    ).rejects.toThrow("db down");
    expect(set).not.toHaveBeenCalled();
  });

  it("a failed TenantConfig save (fields only) leaves taxRate and logoUrl unwritten", async () => {
    const { c, prisma, set } = await build({ timezone: "America/New_York" });
    prisma.tenantConfig.upsert.mockRejectedValue(new Error("db down"));
    await expect(
      c.updateSettings({ city: "Austin", taxRate: 5, logoUrl: "logo.png" }, operator),
    ).rejects.toThrow("db down");
    expect(set).not.toHaveBeenCalled();
  });

  // SA-747 merge: quickKeys is validated BEFORE any write (a bad value rejects everything), then saved
  // last with the other SystemConfig-side keys.
  it("quickKeys is prepared before any write and saved only after the TenantConfig save", async () => {
    const stub = quickKeysSettingsStubProvider.useValue;
    const prepared = { pins: ["p1"] };
    stub.prepare.mockResolvedValueOnce(prepared as never);
    stub.save.mockClear();
    const { c, tx, set } = await build({ timezone: "America/New_York" });
    await c.updateSettings(
      { timezone: "America/Chicago", taxRate: 5, quickKeys: { pins: ["p1"] } },
      admin,
    );
    expect(stub.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      tx.tenantConfig.upsert.mock.invocationCallOrder[0],
    );
    expect(stub.save).toHaveBeenCalledWith(prepared);
    expect(stub.save.mock.invocationCallOrder[0]).toBeGreaterThan(
      tx.tenantConfig.upsert.mock.invocationCallOrder[0],
    );
    expect(set).toHaveBeenCalledWith("settings.taxRate", "5");
  });

  it("a failed TenantConfig save leaves the validated quickKeys unsaved", async () => {
    const stub = quickKeysSettingsStubProvider.useValue;
    stub.prepare.mockResolvedValueOnce({ pins: ["p1"] } as never);
    stub.save.mockClear();
    const { c, tx } = await build({ timezone: "America/New_York" });
    tx.tenantConfig.upsert.mockRejectedValue(new Error("db down"));
    await expect(
      c.updateSettings({ timezone: "America/Chicago", quickKeys: { pins: ["p1"] } }, admin),
    ).rejects.toThrow("db down");
    expect(stub.save).not.toHaveBeenCalled();
  });

  it("when everything succeeds taxRate and logoUrl are written after the TenantConfig save", async () => {
    const { c, tx, set } = await build({ timezone: "America/New_York" });
    await c.updateSettings({ timezone: "America/Chicago", taxRate: 5, logoUrl: "logo.png" }, admin);
    expect(set).toHaveBeenCalledWith("settings.taxRate", "5");
    expect(set).toHaveBeenCalledWith("settings.logoUrl", "logo.png");
    expect(tx.tenantConfig.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      set.mock.invocationCallOrder[0],
    );
  });

  it("the response shows the (resolved) zone after the write", async () => {
    const { c } = await build({ timezone: "America/Chicago" });
    expect((await c.updateSettings({ city: "Austin" }, operator)).timezone).toBe("America/Chicago");
  });
});
