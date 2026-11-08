import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { PlatformConfigService } from "./platform-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../common/encryption.service";

/**
 * SA-1102 PR-A, items 1 and 3 (rows S-1 .. S-5): PlatformConfig `claude.apiKey` is a secret, so it is encrypted at
 * rest; the platform key order is the Railway env FIRST, then the encrypted row; a previewed key shows its last 4
 * only; and a business key is used for a bill scan only.
 */
const CIPHER = /^[0-9a-f]{32}:[0-9a-f]{32}:[A-Za-z0-9+/=]+$/;
const PLATFORM_KEY = "sk-ant-api03-PLATFORMKEYPLATFORMKEYPLATFORMKEYab12";
const ENV_KEY = "sk-ant-api03-ENVENVENVENVENVENVENVENVENVENVENVEcd34";
const BUSINESS_KEY = "sk-ant-api03-BUSINESSBUSINESSBUSINESSBUSINESSef56";

describe("PlatformConfigService — secrets at rest and key order (SA-1102)", () => {
  let service: PlatformConfigService;
  let encryption: EncryptionService;
  let store: Record<string, string>;
  let env: Record<string, string | undefined>;
  let auditCreate: jest.Mock;

  beforeEach(async () => {
    store = {};
    env = {};
    // An in-memory PlatformConfig table behind the two raw-SQL tagged templates the service uses.
    auditCreate = jest.fn().mockResolvedValue({});
    const prisma = {
      auditLog: { create: auditCreate },
      getTenantId: () => null,
      $queryRaw: jest.fn(async (_s: TemplateStringsArray, key: string) =>
        key in store ? [{ value: store[key] }] : [],
      ),
      $executeRaw: jest.fn(async (s: TemplateStringsArray, ...v: string[]) => {
        if (/DELETE/i.test(s.join(""))) delete store[v[0]];
        else store[v[0]] = v[1];
        return 1;
      }),
    };
    const mod = await Test.createTestingModule({
      providers: [
        PlatformConfigService,
        EncryptionService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: (k: string) => env[k] } },
      ],
    }).compile();
    service = mod.get(PlatformConfigService);
    encryption = mod.get(EncryptionService);
  });

  // The signature changes in this PR; the specs call it through `any` so they compile (and fail on the VALUE) on the
  // unchanged code too.
  const resolve = (task: string, businessKey?: string | null) =>
    (service as any).resolveAnthropicKey(task, businessKey);

  describe("S-1 / S-2: encrypted at rest", () => {
    it("S-1: saving the platform key stores the cipher shape, never the key", async () => {
      await service.updateAiConfig({ apiKey: PLATFORM_KEY });
      expect(store["claude.apiKey"]).toMatch(CIPHER);
      expect(store["claude.apiKey"]).not.toContain(PLATFORM_KEY);
      expect(encryption.decrypt(store["claude.apiKey"])).toBe(PLATFORM_KEY);
    });

    it("S-1: an empty key still clears the row", async () => {
      store["claude.apiKey"] = encryption.encrypt(PLATFORM_KEY);
      await service.updateAiConfig({ apiKey: "" });
      expect("claude.apiKey" in store).toBe(false);
    });

    it("S-2a: an encrypted row is decrypted on read", async () => {
      store["claude.apiKey"] = encryption.encrypt(PLATFORM_KEY);
      expect((await resolve("bill_scan")).key).toBe(PLATFORM_KEY);
    });

    it("S-2b: a legacy plaintext row passes through (the seam that ends after the script)", async () => {
      store["claude.apiKey"] = PLATFORM_KEY;
      expect((await resolve("bill_scan")).key).toBe(PLATFORM_KEY);
    });

    it("a non-secret key (claude.model) is stored as written", async () => {
      await service.updateAiConfig({ model: "claude-sonnet-5-5" });
      expect(store["claude.model"]).toBe("claude-sonnet-5-5");
    });
  });

  describe("S-3: previews show the last 4 only", () => {
    it("the super admin preview never shows the front of the key", async () => {
      env.ANTHROPIC_API_KEY = ENV_KEY;
      const cfg = await service.getAiConfig();
      expect(cfg.keyPreview).toBe("…cd34");
      expect(cfg.keyPreview).not.toContain("sk-ant");
    });

    it("a stored key previews as its last 4 as well", async () => {
      store["claude.apiKey"] = encryption.encrypt(PLATFORM_KEY);
      expect((await service.getAiConfig()).keyPreview).toBe("…ab12");
    });
  });

  describe("S-4: a business key is for bill scans only", () => {
    beforeEach(() => {
      env.ANTHROPIC_API_KEY = ENV_KEY;
    });

    it("bill_scan uses the business key and says so", async () => {
      expect(await resolve("bill_scan", BUSINESS_KEY)).toEqual({
        key: BUSINESS_KEY,
        source: "business",
      });
    });

    it.each(["receipt_scan", "statement_scan", "general"])(
      "%s ignores the business key and uses RouteFlow's",
      async (task) => {
        expect(await resolve(task, BUSINESS_KEY)).toEqual({ key: ENV_KEY, source: "routeflow" });
      },
    );

    it.each([null, undefined, ""])(
      "bill_scan with no business key (%j) falls back to RouteFlow's key",
      async (none) => {
        expect(await resolve("bill_scan", none)).toEqual({ key: ENV_KEY, source: "routeflow" });
      },
    );

    it("with no key anywhere the key is null", async () => {
      env.ANTHROPIC_API_KEY = undefined;
      expect(await resolve("receipt_scan", BUSINESS_KEY)).toEqual({
        key: null,
        source: "routeflow",
      });
    });
  });

  describe("S-5: the Railway env key wins over the DB row", () => {
    it("env set and a DB row present: env is used", async () => {
      env.ANTHROPIC_API_KEY = ENV_KEY;
      store["claude.apiKey"] = encryption.encrypt(PLATFORM_KEY);
      expect((await resolve("general")).key).toBe(ENV_KEY);
    });

    it("env unset: the DB row is used", async () => {
      store["claude.apiKey"] = encryption.encrypt(PLATFORM_KEY);
      expect((await resolve("general")).key).toBe(PLATFORM_KEY);
    });

    it("getAiConfig reports the env as the source when both exist", async () => {
      env.ANTHROPIC_API_KEY = ENV_KEY;
      store["claude.apiKey"] = encryption.encrypt(PLATFORM_KEY);
      const cfg = await service.getAiConfig();
      expect(cfg.source).toBe("environment");
      expect(cfg.keyPreview).toBe("…cd34");
    });
  });

  describe("S-15 and the cap field (platform side)", () => {
    it("saving the platform key writes one ai_key.set audit row with the last 4 only", async () => {
      await (service as any).updateAiConfig({ apiKey: PLATFORM_KEY }, "admin-1");
      expect(auditCreate).toHaveBeenCalledTimes(1);
      expect(auditCreate.mock.calls[0][0].data).toMatchObject({
        tenantId: null,
        userId: "admin-1",
        action: "ai_key.set",
        entityType: "PlatformConfig",
        meta: { last4: "ab12" },
      });
      expect(JSON.stringify(auditCreate.mock.calls)).not.toContain("sk-ant");
    });

    it("clearing writes ai_key.cleared; a model-only save writes no audit row", async () => {
      await (service as any).updateAiConfig({ apiKey: "" }, "admin-1");
      expect(auditCreate.mock.calls[0][0].data).toMatchObject({ action: "ai_key.cleared" });
      auditCreate.mockClear();
      await (service as any).updateAiConfig({ model: "claude-sonnet-5-5" }, "admin-1");
      expect(auditCreate).not.toHaveBeenCalled();
    });

    it("the monthly cap is stored, shown in the AI config, and 0 is kept as the kill switch", async () => {
      expect(((await service.getAiConfig()) as any).monthlyCapUsd).toBe(10);
      await (service as any).updateAiConfig({ monthlyCapUsd: 40 });
      expect(store["ai.monthlyCapUsd"]).toBe("40");
      expect(((await service.getAiConfig()) as any).monthlyCapUsd).toBe(40);
      await (service as any).updateAiConfig({ monthlyCapUsd: 0 });
      expect(((await service.getAiConfig()) as any).monthlyCapUsd).toBe(0);
    });
  });
});
