import { NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import * as fs from "fs";
import * as path from "path";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { EncryptionService } from "../common/encryption.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  ADMIN_AUDIT_ACTION_FACETS,
  AdminAuditAction,
  adminAuditActionLabel,
} from "./audit-actions.constant";
import { SetTenantAiCapDto } from "./dto/set-tenant-ai-cap.dto";
import { PlatformAdminService } from "./platform-admin.service";
import { PlatformConfigService } from "./platform-config.service";

/**
 * AI limits PR-1: the per-business monthly AI allowance on RouteFlow's key, set by super admin.
 *   T4: `PATCH platform-admin/tenants/:id/ai-cap` has three states (a number sets, `null` clears, an absent key leaves),
 *   writes one audit row only when the value changes, and a business that does not exist is a 404. The read side
 *   (`getTenantAiCap`) reports the override, the platform value and the one that applies.
 */
const TENANT = "qa-tenant-1";
const ADMIN = "qa-admin-1";

describe("SetTenantAiCapDto (three states)", () => {
  const errors = async (body: object) => validate(plainToInstance(SetTenantAiCapDto, body));

  it("accepts a whole number from 0 up, null (clear) and an absent key (leave)", async () => {
    for (const body of [
      { aiMonthlyCapUsd: 0 },
      { aiMonthlyCapUsd: 10 },
      { aiMonthlyCapUsd: 100000 },
      { aiMonthlyCapUsd: null },
      {},
    ]) {
      expect(await errors(body)).toEqual([]);
    }
  });

  it("refuses a negative, a fraction, a string and a number past the ceiling", async () => {
    for (const body of [
      { aiMonthlyCapUsd: -1 },
      { aiMonthlyCapUsd: 2.5 },
      { aiMonthlyCapUsd: "10" },
      { aiMonthlyCapUsd: 100001 },
    ]) {
      expect((await errors(body)).length).toBeGreaterThan(0);
    }
  });
});

describe("PlatformAdminService.setTenantAiCap (T4)", () => {
  let current: { aiMonthlyCapUsd: number | null } | null;
  let prisma: { tenant: { findUnique: jest.Mock; update: jest.Mock } };
  let recordAdminAction: jest.Mock;
  const call = (cap: number | null | undefined) =>
    PlatformAdminService.prototype.setTenantAiCap.call(
      { prisma, recordAdminAction },
      TENANT,
      cap,
      ADMIN,
    );

  beforeEach(() => {
    current = { aiMonthlyCapUsd: null };
    prisma = { tenant: { findUnique: jest.fn(async () => current), update: jest.fn() } };
    recordAdminAction = jest.fn();
  });

  it("a number sets the override and writes one audit row with the old and new value only", async () => {
    await call(10);
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT },
      data: { aiMonthlyCapUsd: 10 },
    });
    // the audit convention (audit-actions.constant.ts): an AdminAuditAction code keyed to the TARGET business, so the row
    // shows under the per-business filter with a label and a facet (recordAdminAction sets entityType "tenant")
    expect(recordAdminAction).toHaveBeenCalledTimes(1);
    expect(recordAdminAction).toHaveBeenCalledWith(
      TENANT,
      ADMIN,
      AdminAuditAction.TENANT_AI_CAP_CHANGED,
      { from: null, to: 10 },
    );
  });

  it("null clears the override (the platform value applies again)", async () => {
    current = { aiMonthlyCapUsd: 40 };
    await call(null);
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT },
      data: { aiMonthlyCapUsd: null },
    });
    expect(recordAdminAction.mock.calls[0][3]).toEqual({ from: 40, to: null });
  });

  it("0 is a real value: AI off on RouteFlow's key for that business", async () => {
    await call(0);
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT },
      data: { aiMonthlyCapUsd: 0 },
    });
  });

  it("an absent key, or the value it already has, writes nothing and audits nothing", async () => {
    current = { aiMonthlyCapUsd: 25 };
    await call(undefined);
    await call(25);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(recordAdminAction).not.toHaveBeenCalled();
  });

  it("an unknown business is a 404 and nothing is written", async () => {
    current = null;
    await expect(call(10)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it("the audit row is written after the change, never before it", async () => {
    const order: string[] = [];
    prisma.tenant.update.mockImplementation(async () => order.push("update"));
    recordAdminAction.mockImplementation(async () => order.push("audit"));
    await call(10);
    expect(order).toEqual(["update", "audit"]);
  });
});

describe("the ai-cap audit code is registered (label and facet)", () => {
  it("TENANT_AI_CAP_CHANGED has a plain label and shows in the audit-log filter", () => {
    expect(adminAuditActionLabel(AdminAuditAction.TENANT_AI_CAP_CHANGED)).toBe(
      "AI allowance changed",
    );
    expect(ADMIN_AUDIT_ACTION_FACETS.map((f) => f.code)).toContain(
      AdminAuditAction.TENANT_AI_CAP_CHANGED,
    );
  });
});

describe("the migration lock order (A Low 1)", () => {
  const sql = fs
    .readFileSync(
      path.join(
        __dirname,
        "../../prisma/migrations/20261107000000_tenant_ai_monthly_cap/migration.sql",
      ),
      "utf8",
    )
    .replace(/--.*$/gm, "");

  it("builds the AiUsageEvent index BEFORE the Tenant ALTER, so Tenant's ACCESS EXCLUSIVE lock covers only the commit tail", () => {
    const index = sql.indexOf('CREATE INDEX "AiUsageEvent_tenantId_createdAt_idx"');
    const alter = sql.indexOf('ALTER TABLE "Tenant" ADD COLUMN "aiMonthlyCapUsd"');
    expect(index).toBeGreaterThan(-1);
    expect(alter).toBeGreaterThan(-1);
    expect(index).toBeLessThan(alter);
  });
});

describe("PlatformConfigService.getTenantAiCap (T4)", () => {
  let service: PlatformConfigService;
  let row: { aiMonthlyCapUsd: number | null } | null;
  let platformValue: string | null;

  beforeEach(async () => {
    row = { aiMonthlyCapUsd: null };
    platformValue = null;
    const prisma = {
      tenant: { findUnique: jest.fn(async () => row) },
      $queryRaw: jest.fn(async () => (platformValue === null ? [] : [{ value: platformValue }])),
    };
    const mod = await Test.createTestingModule({
      providers: [
        PlatformConfigService,
        EncryptionService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    service = mod.get(PlatformConfigService);
  });

  it("no override: the effective cap is the platform value (the $10 fallback when unset)", async () => {
    expect(await service.getTenantAiCap(TENANT)).toEqual({
      tenantId: TENANT,
      aiMonthlyCapUsd: null,
      platformCapUsd: 10,
      effectiveCapUsd: 10,
    });
    platformValue = "30";
    expect(await service.getTenantAiCap(TENANT)).toMatchObject({
      platformCapUsd: 30,
      effectiveCapUsd: 30,
    });
  });

  it("an override is reported next to the platform value and wins", async () => {
    platformValue = "10";
    row = { aiMonthlyCapUsd: 50 };
    expect(await service.getTenantAiCap(TENANT)).toEqual({
      tenantId: TENANT,
      aiMonthlyCapUsd: 50,
      platformCapUsd: 10,
      effectiveCapUsd: 50,
    });
  });

  it("the platform's 0 (kill switch) shows as the effective cap even when the business has an override", async () => {
    platformValue = "0";
    row = { aiMonthlyCapUsd: 50 };
    expect(await service.getTenantAiCap(TENANT)).toEqual({
      tenantId: TENANT,
      aiMonthlyCapUsd: 50,
      platformCapUsd: 0,
      effectiveCapUsd: 0,
    });
  });

  it("an unknown business is a 404", async () => {
    row = null;
    await expect(service.getTenantAiCap(TENANT)).rejects.toBeInstanceOf(NotFoundException);
  });
});
