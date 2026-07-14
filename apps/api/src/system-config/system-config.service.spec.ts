import { Test, TestingModule } from "@nestjs/testing";
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
