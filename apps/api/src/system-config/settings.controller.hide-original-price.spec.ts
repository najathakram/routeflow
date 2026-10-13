import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { SettingsController } from "./settings.controller";
import { SystemConfigService } from "./system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { quickKeysSettingsStubProvider } from "../testing/quick-keys-settings-stub";

/**
 * GET /settings serves the tenant's `invoice.hideOriginalPrice` (the invoices' own setting) so the live counter receipt and
 * the Today's-sales reprint apply the same original-price rule as the emailed receipt and the invoices: no struck price and
 * no Discounts row when it is on.
 */
describe("SettingsController: hideOriginalPrice on GET /settings (receipts follow the invoices' rule)", () => {
  const build = async (stored: Record<string, string>) => {
    const svc = {
      get: jest.fn(async (k: string) => stored[k] ?? null),
      set: jest.fn(),
      getAll: jest.fn(async () => ({})),
    };
    const mod = await Test.createTestingModule({
      controllers: [SettingsController],
      providers: [
        { provide: SystemConfigService, useValue: svc },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: PrismaService, useValue: createMockPrisma() },
        { provide: EmailService, useValue: { send: jest.fn() } },
        quickKeysSettingsStubProvider,
      ],
    }).compile();
    return { controller: mod.get(SettingsController), svc };
  };

  it('is true only when invoice.hideOriginalPrice is stored as "true"', async () => {
    const on = await build({ "invoice.hideOriginalPrice": "true" });
    expect((await on.controller.getSettings()).hideOriginalPrice).toBe(true);
    expect(on.svc.get).toHaveBeenCalledWith("invoice.hideOriginalPrice");
  });

  it('is false when the tenant never set it or stored "false"', async () => {
    expect((await (await build({})).controller.getSettings()).hideOriginalPrice).toBe(false);
    const off = await build({ "invoice.hideOriginalPrice": "false" });
    expect((await off.controller.getSettings()).hideOriginalPrice).toBe(false);
  });
});
