import { Test } from "@nestjs/testing";
import { SystemConfigService } from "./system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../common/encryption.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * SA-1102 PR-A §2.2 (S-7): with no tenant in context `prisma.forTenant()` is the UNSCOPED client, so `get` would read
 * any business's row. All three methods throw a coded 500 first, and no query runs.
 */
describe("SystemConfigService without a tenant (SA-1102 S-7)", () => {
  let service: SystemConfigService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.getTenantId.mockReturnValue(null);
    const mod = await Test.createTestingModule({
      providers: [
        SystemConfigService,
        { provide: PrismaService, useValue: prisma },
        { provide: EncryptionService, useValue: { encrypt: jest.fn(), decrypt: jest.fn() } },
      ],
    }).compile();
    service = mod.get(SystemConfigService);
  });

  const coded = async (p: Promise<unknown>) => {
    const err: any = await p.then(
      () => null,
      (e) => e,
    );
    expect(err).not.toBeNull();
    expect(err.getStatus?.()).toBe(500);
    expect(err.getResponse?.()).toMatchObject({ code: "SYSTEM_CONFIG_TENANT_REQUIRED" });
  };

  it("get throws SYSTEM_CONFIG_TENANT_REQUIRED and runs no query", async () => {
    await coded(service.get("anthropic.apiKey"));
    expect(prisma.forTenant).not.toHaveBeenCalled();
    expect(prisma.systemConfig.findFirst).not.toHaveBeenCalled();
  });

  it("getAll throws and runs no query", async () => {
    await coded(service.getAll("zoho."));
    expect(prisma.systemConfig.findMany).not.toHaveBeenCalled();
  });

  it("set throws and writes nothing", async () => {
    await coded(service.set("settings.taxRate", "8"));
    expect(prisma.systemConfig.findFirst).not.toHaveBeenCalled();
    expect(prisma.systemConfig.create).not.toHaveBeenCalled();
    expect(prisma.systemConfig.update).not.toHaveBeenCalled();
  });

  it("the wrappers built on get/set fail the same way (no silent tax 0)", async () => {
    await coded(service.getRemittanceConfig());
    await coded(service.getMarginConfig());
  });

  it("with a tenant in context the read still runs", async () => {
    prisma.getTenantId.mockReturnValue("test-tenant");
    prisma.systemConfig.findFirst.mockResolvedValue({ id: "1", value: "8" });
    await expect(service.get("settings.taxRate")).resolves.toBe("8");
  });
});
