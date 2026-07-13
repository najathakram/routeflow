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
