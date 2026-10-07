import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { SettingsController } from "./settings.controller";
import { SystemConfigService } from "./system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("GET /settings — tenant timezone", () => {
  async function build(cfg: unknown) {
    const prisma = createMockPrisma() as any;
    prisma.getTenantId = jest.fn(() => "t1");
    prisma.tenantConfig.findUnique = jest.fn().mockResolvedValue(cfg);
    prisma.forTenant = jest.fn(() => ({ user: { findFirst: jest.fn().mockResolvedValue(null) } }));
    const m = await Test.createTestingModule({
      controllers: [SettingsController],
      providers: [
        { provide: SystemConfigService, useValue: { getAll: jest.fn().mockResolvedValue({}) } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: { send: jest.fn() } },
      ],
    }).compile();
    return m.get(SettingsController);
  }

  it("returns the tenant's own zone", async () => {
    const c = await build({ timezone: "America/Los_Angeles" });
    expect((await c.getSettings()).timezone).toBe("America/Los_Angeles");
  });

  it("defaults to America/New_York with no config row", async () => {
    const c = await build(null);
    expect((await c.getSettings()).timezone).toBe("America/New_York");
  });

  it("PATCH /settings never writes timezone (read-only regression pin)", async () => {
    const prisma = createMockPrisma() as any;
    prisma.getTenantId = jest.fn(() => "t1");
    prisma.tenantConfig.findUnique = jest.fn().mockResolvedValue({ timezone: "America/Chicago" });
    prisma.tenantConfig.upsert = jest.fn().mockResolvedValue({});
    prisma.invoice = { updateMany: jest.fn() };
    prisma.forTenant = jest.fn(() => ({ user: { findFirst: jest.fn().mockResolvedValue(null) } }));
    const m = await Test.createTestingModule({
      controllers: [SettingsController],
      providers: [
        {
          provide: SystemConfigService,
          useValue: { getAll: jest.fn().mockResolvedValue({}), set: jest.fn() },
        },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: { send: jest.fn() } },
      ],
    }).compile();
    const c = m.get(SettingsController);
    await c.updateSettings({ timezone: "Asia/Tokyo", city: "Austin" });
    const call = prisma.tenantConfig.upsert.mock.calls[0][0];
    expect(call.update).toEqual({ city: "Austin" });
    expect(call.create).not.toHaveProperty("timezone");
    expect((await c.getSettings()).timezone).toBe("America/Chicago");
  });
});
