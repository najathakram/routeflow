import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { SystemConfigService } from "./system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../common/encryption.service";
import { createMockPrisma } from "../testing/prisma-mock";

// Mock encryptor whose output matches EncryptionService's real IV:TAG:CIPHERTEXT
// storage shape (32 hex + 32 hex + base64) so the service's format detector fires.
const enc = (v: string) =>
  `${"a".repeat(32)}:${"b".repeat(32)}:${Buffer.from(v).toString("base64")}`;
const dec = (stored: string) => Buffer.from(stored.split(":")[2], "base64").toString("utf8");

describe("SystemConfigService (F5-004 secret encryption)", () => {
  let service: SystemConfigService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const encryption = { encrypt: jest.fn(enc), decrypt: jest.fn(dec) };

  beforeEach(async () => {
    prisma = createMockPrisma();
    jest.clearAllMocks();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SystemConfigService,
        { provide: PrismaService, useValue: prisma },
        { provide: EncryptionService, useValue: encryption },
      ],
    }).compile();
    service = moduleRef.get(SystemConfigService);
  });

  it("encrypts a secret key on write", async () => {
    prisma.systemConfig.findFirst.mockResolvedValue(null);
    await service.set("anthropic.apiKey", "sk-secret");

    expect(encryption.encrypt).toHaveBeenCalledWith("sk-secret");
    expect(prisma.systemConfig.create).toHaveBeenCalledWith({
      data: { key: "anthropic.apiKey", value: enc("sk-secret") },
    });
  });

  it("stores a non-secret key as plaintext", async () => {
    prisma.systemConfig.findFirst.mockResolvedValue(null);
    await service.set("email.smtpHost", "smtp.example.com");

    expect(encryption.encrypt).not.toHaveBeenCalled();
    expect(prisma.systemConfig.create).toHaveBeenCalledWith({
      data: { key: "email.smtpHost", value: "smtp.example.com" },
    });
  });

  it("does not encrypt an empty (cleared) secret", async () => {
    prisma.systemConfig.findFirst.mockResolvedValue(null);
    await service.set("anthropic.apiKey", "");

    expect(encryption.encrypt).not.toHaveBeenCalled();
    expect(prisma.systemConfig.create).toHaveBeenCalledWith({
      data: { key: "anthropic.apiKey", value: "" },
    });
  });

  it("decrypts a secret key on read", async () => {
    prisma.systemConfig.findFirst.mockResolvedValue({ id: "1", value: enc("sk-secret") });
    const result = await service.get("anthropic.apiKey");

    expect(encryption.decrypt).toHaveBeenCalled();
    expect(result).toBe("sk-secret");
  });

  it("passes through a legacy plaintext secret (written before F5-004)", async () => {
    prisma.systemConfig.findFirst.mockResolvedValue({ id: "1", value: "sk-legacy-plaintext" });
    const result = await service.get("anthropic.apiKey");

    expect(encryption.decrypt).not.toHaveBeenCalled();
    expect(result).toBe("sk-legacy-plaintext");
  });

  it("getAll decrypts only the secret entries", async () => {
    prisma.systemConfig.findMany.mockResolvedValue([
      { key: "zoho.clientId", value: "public-id" },
      { key: "zoho.clientSecret", value: enc("shh") },
    ]);
    const all = await service.getAll("zoho.");

    expect(all["zoho.clientId"]).toBe("public-id");
    expect(all["zoho.clientSecret"]).toBe("shh");
  });
});

describe("SystemConfigService — remittance config (P5-14)", () => {
  let service: SystemConfigService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const encryption = { encrypt: jest.fn(enc), decrypt: jest.fn(dec) };

  beforeEach(async () => {
    prisma = createMockPrisma();
    jest.clearAllMocks();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SystemConfigService,
        { provide: PrismaService, useValue: prisma },
        { provide: EncryptionService, useValue: encryption },
      ],
    }).compile();
    service = moduleRef.get(SystemConfigService);
  });

  it("returns {} when nothing is stored", async () => {
    prisma.systemConfig.findFirst.mockResolvedValue(null);
    const result = await service.getRemittanceConfig();
    expect(result).toEqual({});
  });

  it("parse drops unknown, empty-string, and non-string fields", async () => {
    prisma.systemConfig.findFirst.mockResolvedValue({
      id: "1",
      value: JSON.stringify({
        payToName: "Acme Wholesale",
        bankName: "",
        accountNumber: 12345,
        notARemittanceField: "ignored",
      }),
    });
    const result = await service.getRemittanceConfig();
    expect(result).toEqual({ payToName: "Acme Wholesale" });
  });

  it("returns {} (never throws) on corrupt JSON", async () => {
    prisma.systemConfig.findFirst.mockResolvedValue({ id: "1", value: "{not valid json" });
    const result = await service.getRemittanceConfig();
    expect(result).toEqual({});
  });

  it("set merges over the existing config and clears empty-string fields", async () => {
    prisma.systemConfig.findFirst
      // getRemittanceConfig() read inside setRemittanceConfig
      .mockResolvedValueOnce({
        id: "1",
        value: JSON.stringify({ payToName: "Acme Wholesale", bankName: "First Bank" }),
      })
      // set()'s own findFirst before update
      .mockResolvedValueOnce({ id: "1", value: JSON.stringify({}) });

    await service.setRemittanceConfig({ bankName: "", accountName: "Acme LLC" });

    expect(prisma.systemConfig.update).toHaveBeenCalledWith({
      where: { id: "1" },
      data: {
        value: JSON.stringify({ payToName: "Acme Wholesale", accountName: "Acme LLC" }),
      },
    });
  });

  it("set creates the row when none exists (plaintext, never encrypted)", async () => {
    prisma.systemConfig.findFirst.mockResolvedValue(null);

    await service.setRemittanceConfig({ payToName: "Acme Wholesale" });

    expect(encryption.encrypt).not.toHaveBeenCalled();
    expect(prisma.systemConfig.create).toHaveBeenCalledWith({
      data: {
        key: "remittance.config",
        value: JSON.stringify({ payToName: "Acme Wholesale" }),
      },
    });
  });
});

describe("SystemConfigService margin config: retired costing methods (SA-804 (1) / B1232)", () => {
  let service: SystemConfigService;
  let prisma: ReturnType<typeof createMockPrisma>;

  /** `costing.method` is stored as `stored`; every other key reads as unset. */
  const storedMethod = (stored: string | null) =>
    prisma.systemConfig.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where?.key === "costing.method" && stored != null
          ? { id: "cfg-1", key: "costing.method", value: stored }
          : null,
      ),
    );

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.systemConfig.findMany.mockResolvedValue([]);
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SystemConfigService,
        { provide: PrismaService, useValue: prisma },
        { provide: EncryptionService, useValue: { encrypt: jest.fn(), decrypt: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(SystemConfigService);
  });

  it.each(["FIFO", "LIFO"])(
    "setMarginConfig refuses %s with 400 COSTING_METHOD_RETIRED and writes nothing (not even the floor)",
    async (method) => {
      storedMethod(null);

      const err: any = await service
        .setMarginConfig({ costingMethod: method, defaultMarginFloor: 0.2 })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({ code: "COSTING_METHOD_RETIRED" });
      expect(prisma.systemConfig.create).not.toHaveBeenCalled();
      expect(prisma.systemConfig.update).not.toHaveBeenCalled();
    },
  );

  it.each(["WEIGHTED_AVERAGE", "LAST_COST"])("setMarginConfig still accepts %s", async (method) => {
    storedMethod(null);

    await service.setMarginConfig({ costingMethod: method });

    expect(prisma.systemConfig.create).toHaveBeenCalledWith({
      data: { key: "costing.method", value: method },
    });
  });

  it("a PATCH that leaves a stored FIFO unchanged (floor only, or the same value) does not fail", async () => {
    storedMethod("FIFO");

    await expect(service.setMarginConfig({ defaultMarginFloor: 0.3 })).resolves.toBeUndefined();
    await expect(service.setMarginConfig({ costingMethod: "FIFO" })).resolves.toBeUndefined();
  });

  it("getMarginConfig reads a stored FIFO as WEIGHTED_AVERAGE (the average cost it is costed by)", async () => {
    storedMethod("FIFO");

    const cfg = await service.getMarginConfig();

    expect(cfg.costingMethod).toBe("WEIGHTED_AVERAGE");
  });

  it("getMarginConfig keeps LAST_COST", async () => {
    storedMethod("LAST_COST");

    expect((await service.getMarginConfig()).costingMethod).toBe("LAST_COST");
  });
});
