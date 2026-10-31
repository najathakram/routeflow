import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { EmailService } from "../email/email.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { quickKeysSettingsStubProvider } from "../testing/quick-keys-settings-stub";
import { SettingsController } from "./settings.controller";
import { SystemConfigService } from "./system-config.service";

/**
 * SA-1067 Z2 (Z-3, Z-4): a tenant with no TenantConfig row that saves an address, or an invoice setting that lives on the
 * config row, must get a row on UTC (the fallback it was already read with), not the column default (New York). Before, the
 * save changed the tenant's day with no audit row.
 */
describe("SettingsController: a row-less tenant's first save creates its config row on UTC", () => {
  const build = async () => {
    const prisma = createMockPrisma();
    (prisma as unknown as { getTenantId: () => string }).getTenantId = () => "t1";
    const svc = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      getAll: jest.fn().mockResolvedValue({}),
    };
    const mod = await Test.createTestingModule({
      controllers: [SettingsController],
      providers: [
        { provide: SystemConfigService, useValue: svc },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: { send: jest.fn() } },
        quickKeysSettingsStubProvider,
      ],
    }).compile();
    return { controller: mod.get(SettingsController), prisma };
  };

  it("Z-3: PATCH /settings with an address: create names UTC, update does not touch the zone", async () => {
    const { controller, prisma } = await build();
    await controller.updateSettings({ street: "1 Main St" });
    const call = (prisma.tenantConfig.upsert as jest.Mock).mock.calls[0][0];
    expect(call.create).toMatchObject({
      tenantId: "t1",
      addressLine1: "1 Main St",
      timezone: "UTC",
    });
    expect(call.update).toEqual({ addressLine1: "1 Main St" });
  });

  it("Z-4: PATCH /settings/invoice with creditAutoApplyOnSend: create names UTC", async () => {
    const { controller, prisma } = await build();
    await controller.updateInvoiceSettings({ creditAutoApplyOnSend: true } as any);
    const call = (prisma.tenantConfig.upsert as jest.Mock).mock.calls[0][0];
    expect(call.create).toMatchObject({
      tenantId: "t1",
      timezone: "UTC",
      creditAutoApplyOnSend: true,
    });
    expect(call.update).toEqual({ creditAutoApplyOnSend: true });
  });
});
