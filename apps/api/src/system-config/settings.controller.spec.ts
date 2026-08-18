import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { BadRequestException } from "@nestjs/common";
import { SettingsController } from "./settings.controller";
import { SystemConfigService } from "./system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { createMockPrisma } from "../testing/prisma-mock";

// WP2: settings.taxRate is stored as a PERCENT (0-100, string) — see
// apps/api/src/common/tax-rate.ts. A direct PATCH call can otherwise store an
// out-of-range value (bypassing the web form's min(0).max(100)) that later
// gets divided by 100 into a fraction by every reader.
describe("SettingsController — PATCH /settings taxRate validation", () => {
  let controller: SettingsController;
  let svc: { get: jest.Mock; set: jest.Mock; getAll: jest.Mock };
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    svc = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      getAll: jest.fn().mockResolvedValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SettingsController],
      providers: [
        { provide: SystemConfigService, useValue: svc },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: { send: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    controller = module.get<SettingsController>(SettingsController);
  });

  it("accepts a taxRate within 0-100 and stores it under settings.taxRate", async () => {
    await controller.updateSettings({ taxRate: "10" });
    expect(svc.set).toHaveBeenCalledWith("settings.taxRate", "10");
  });

  it("rejects a taxRate above 100 with a 400 and does not write it", async () => {
    await expect(controller.updateSettings({ taxRate: "150" })).rejects.toThrow(
      BadRequestException,
    );
    await expect(controller.updateSettings({ taxRate: "150" })).rejects.toThrow(
      "Tax rate must be between 0 and 100 (percent)",
    );
    expect(svc.set).not.toHaveBeenCalled();
  });

  it("rejects a negative taxRate with a 400 and does not write it", async () => {
    await expect(controller.updateSettings({ taxRate: "-1" })).rejects.toThrow(BadRequestException);
    expect(svc.set).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric taxRate with a 400 and does not write it", async () => {
    await expect(controller.updateSettings({ taxRate: "abc" })).rejects.toThrow(
      BadRequestException,
    );
    expect(svc.set).not.toHaveBeenCalled();
  });

  it("leaves a non-taxRate key (logoUrl) writing unchanged", async () => {
    await controller.updateSettings({ logoUrl: "https://example.com/logo.png" });
    expect(svc.set).toHaveBeenCalledWith("settings.logoUrl", "https://example.com/logo.png");
  });
});
