import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SystemConfigService } from "./system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../common/encryption.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * SA-1102 PR-A §2.2 + A-1(b) (S-7): with no tenant in context `prisma.forTenant()` is the UNSCOPED client, so a read
 * would return ANY business's row and a write would overwrite one. So:
 *   - a SECRET get, a getAll whose prefix covers a secret key, and EVERY set throw a coded 500 first (no query runs);
 *   - any other read still works as before (a SUPER_ADMIN with no business reaches about 20 of them) and logs one
 *     WARN per key per process, with no value. Flipping those to a throw rides the TenantRequiredInterceptor
 *     enforcement as its own ruling.
 */
describe("SystemConfigService without a tenant (SA-1102 S-7)", () => {
  let service: SystemConfigService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let warn: jest.SpyInstance;

  beforeEach(async () => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
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

  afterEach(() => warn.mockRestore());

  const coded = async (p: Promise<unknown>) => {
    const err: any = await p.then(
      () => null,
      (e) => e,
    );
    expect(err).not.toBeNull();
    expect(err.getStatus?.()).toBe(500);
    expect(err.getResponse?.()).toMatchObject({ code: "SYSTEM_CONFIG_TENANT_REQUIRED" });
  };

  it.each(["anthropic.apiKey", "email.smtpPassword", "zoho.clientSecret", "zoho.refreshToken"])(
    "a secret get (%s) throws SYSTEM_CONFIG_TENANT_REQUIRED and runs no query",
    async (key) => {
      await coded(service.get(key));
      expect(prisma.forTenant).not.toHaveBeenCalled();
      expect(prisma.systemConfig.findFirst).not.toHaveBeenCalled();
    },
  );

  it("getAll throws when the prefix covers a secret key, and runs no query", async () => {
    await coded(service.getAll("zoho."));
    await coded(service.getAll("anthropic."));
    await coded(service.getAll(""));
    expect(prisma.systemConfig.findMany).not.toHaveBeenCalled();
  });

  it("every set throws, secret or not, and writes nothing", async () => {
    await coded(service.set("settings.taxRate", "8"));
    await coded(service.set("route.defaultDepotLat", "1"));
    await coded(service.set("anthropic.apiKey", "x"));
    expect(prisma.systemConfig.findFirst).not.toHaveBeenCalled();
    expect(prisma.systemConfig.create).not.toHaveBeenCalled();
    expect(prisma.systemConfig.update).not.toHaveBeenCalled();
  });

  it("a non-secret get still reads, and warns once per key per process with no value", async () => {
    prisma.systemConfig.findFirst.mockResolvedValue({ id: "1", value: "8.5" });
    await expect(service.get("s7.once.a")).resolves.toBe("8.5");
    await expect(service.get("s7.once.a")).resolves.toBe("8.5");
    await expect(service.get("s7.once.b")).resolves.toBe("8.5");
    const msgs = warn.mock.calls.map((c) => String(c[0]));
    expect(msgs.filter((m) => m.includes("s7.once.a"))).toHaveLength(1);
    expect(msgs.filter((m) => m.includes("s7.once.b"))).toHaveLength(1);
    expect(msgs[0]).toContain("SystemConfig read without a business");
    expect(msgs.join(" ")).not.toContain("8.5");
  });

  it("a non-secret getAll still reads and warns", async () => {
    prisma.systemConfig.findMany.mockResolvedValue([{ key: "s7.all.x", value: "1" }]);
    await expect(service.getAll("s7.all.")).resolves.toEqual({ "s7.all.x": "1" });
    expect(warn).toHaveBeenCalled();
  });

  it("the wrappers: remittance and margin reads work, the zoho read (secrets) throws", async () => {
    prisma.systemConfig.findFirst.mockResolvedValue(null);
    prisma.systemConfig.findMany.mockResolvedValue([]);
    await expect(service.getRemittanceConfig()).resolves.toEqual({});
    await expect(service.getMarginConfig()).resolves.toMatchObject({
      costingMethod: "WEIGHTED_AVERAGE",
    });
    await coded(service.getZohoConfig());
  });

  it("with a tenant in context the read runs and does not warn", async () => {
    prisma.getTenantId.mockReturnValue("test-tenant");
    prisma.systemConfig.findFirst.mockResolvedValue({ id: "1", value: "8" });
    await expect(service.get("settings.taxRate")).resolves.toBe("8");
    expect(warn).not.toHaveBeenCalled();
  });
});
