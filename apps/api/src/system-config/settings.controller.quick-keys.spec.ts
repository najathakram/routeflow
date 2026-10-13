import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { EmailService } from "../email/email.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { QuickKeysRankCache } from "./quick-keys-rank.cache";
import { QUICK_KEYS_CONFIG_KEY } from "./quick-keys-settings";
import {
  QUICK_KEYS_UNKNOWN_PRODUCT_MESSAGE,
  QuickKeysSettingsService,
} from "./quick-keys-settings.service";
import { SettingsController } from "./settings.controller";
import { SystemConfigService } from "./system-config.service";

/**
 * SA-747: the quickKeys part of GET/PATCH /settings, through the real controller, the real
 * QuickKeysSettingsService and the real cache; only the config store and prisma are stand-ins.
 */
const T = "tenant-a";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ids = (from: number, count: number) => Array.from({ length: count }, (_, i) => id(from + i));

describe("SettingsController: quickKeys", () => {
  let controller: SettingsController;
  let svc: { get: jest.Mock; set: jest.Mock; getAll: jest.Mock };
  let prisma: ReturnType<typeof createMockPrisma>;
  let cache: QuickKeysRankCache;
  let known: string[];

  beforeEach(async () => {
    prisma = createMockPrisma();
    (prisma as unknown as { getTenantId: () => string }).getTenantId = () => T;
    known = ids(1, 200);
    prisma.product.findMany.mockImplementation(async (args: any) =>
      known
        .filter((k) => args.where.id.in.includes(k) && args.where.tenantId === T)
        .map((k) => ({ id: k })),
    );
    svc = {
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
        QuickKeysSettingsService,
        QuickKeysRankCache,
      ],
    }).compile();
    controller = mod.get(SettingsController);
    cache = mod.get(QuickKeysRankCache);
  });

  describe("GET /settings", () => {
    it("returns the defaults filled when nothing is stored", async () => {
      const res = await controller.getSettings();
      expect(res.quickKeys).toEqual({
        counter: { default: { pinned: [], hidden: [] }, windowDays: 30, cap: 12 },
      });
    });

    it("returns the stored value parsed", async () => {
      svc.getAll.mockResolvedValue({
        [QUICK_KEYS_CONFIG_KEY]: JSON.stringify({
          counter: { default: { pinned: [id(1)], hidden: [id(2)] }, cap: 6 },
        }),
      });
      expect((await controller.getSettings()).quickKeys.counter).toMatchObject({
        default: { pinned: [id(1)], hidden: [id(2)] },
        cap: 6,
        windowDays: 30,
      });
    });

    it("a corrupt stored value is the defaults and never throws", async () => {
      svc.getAll.mockResolvedValue({ [QUICK_KEYS_CONFIG_KEY]: "{broken" });
      const res = await controller.getSettings();
      expect(res.quickKeys.counter.cap).toBe(12);
    });
  });

  describe("PATCH /settings", () => {
    const patch = (quickKeys: unknown, extra: Record<string, unknown> = {}) =>
      controller.updateSettings({ quickKeys, ...extra });

    it("a valid value is stored as ONE JSON string under settings.quickKeys", async () => {
      await patch({ counter: { default: { pinned: [id(1), id(2)], hidden: [id(3)] }, cap: 8 } });
      expect(svc.set).toHaveBeenCalledTimes(1);
      const [key, value] = svc.set.mock.calls[0];
      expect(key).toBe("settings.quickKeys");
      expect(JSON.parse(value)).toEqual({
        counter: { default: { pinned: [id(1), id(2)], hidden: [id(3)] }, windowDays: 30, cap: 8 },
      });
    });

    it("registers.main is stored as the default register", async () => {
      await patch({
        counter: {
          default: { pinned: [], hidden: [] },
          registers: { main: { pinned: [id(4)], hidden: [] } },
        },
      });
      expect(JSON.parse(svc.set.mock.calls[0][1]).counter.default.pinned).toEqual([id(4)]);
    });

    it("the 13th pin under the default cap is a 400 and NOTHING is written, taxRate included", async () => {
      await expect(
        patch(
          { counter: { default: { pinned: ids(1, 13), hidden: [] } } },
          { taxRate: 7, logoUrl: "u" },
        ),
      ).rejects.toThrow(BadRequestException);
      expect(svc.set).not.toHaveBeenCalled();
      expect(prisma.tenantConfig.upsert).not.toHaveBeenCalled();
    });

    it.each([
      ["a bad UUID", { counter: { default: { pinned: ["nope"], hidden: [] } } }],
      ["a duplicate pin", { counter: { default: { pinned: [id(1), id(1)], hidden: [] } } }],
      ["101 hidden", { counter: { default: { pinned: [], hidden: ids(1, 101) } } }],
      ["windowDays 0", { counter: { default: { pinned: [], hidden: [] }, windowDays: 0 } }],
      ["windowDays 366", { counter: { default: { pinned: [], hidden: [] }, windowDays: 366 } }],
      ["cap 25", { counter: { default: { pinned: [], hidden: [] }, cap: 25 } }],
      ["cap 0", { counter: { default: { pinned: [], hidden: [] }, cap: 0 } }],
      ["an unknown extra key", { counter: { default: { pinned: [], hidden: [] }, extra: 1 } }],
    ])("%s is a 400 with nothing written", async (_name, value) => {
      await expect(patch(value, { taxRate: 5 })).rejects.toThrow(BadRequestException);
      expect(svc.set).not.toHaveBeenCalled();
    });

    it("an id that was ALREADY stored but whose product is gone (hard-deleted) is pruned, not a 400", async () => {
      const gone = id(900);
      svc.get.mockResolvedValue(
        JSON.stringify({ counter: { default: { pinned: [gone, id(1)], hidden: [id(901)] } } }),
      );
      await patch({ counter: { default: { pinned: [gone, id(1), id(2)], hidden: [id(901)] } } });
      const stored = JSON.parse(svc.set.mock.calls.find((c) => c[0] === "settings.quickKeys")![1]);
      expect(stored.counter.default).toEqual({ pinned: [id(1), id(2)], hidden: [] });
    });

    it("a NEWLY added unknown id is still a 400 even when another stored id is stale", async () => {
      svc.get.mockResolvedValue(
        JSON.stringify({ counter: { default: { pinned: [id(900)], hidden: [] } } }),
      );
      await expect(
        patch({ counter: { default: { pinned: [id(900), id(901)], hidden: [] } } }),
      ).rejects.toThrow(QUICK_KEYS_UNKNOWN_PRODUCT_MESSAGE);
      expect(svc.set).not.toHaveBeenCalled();
    });

    it("a pinned or hidden id that is not this tenant's product is a 400, nothing written", async () => {
      const foreign = id(900);
      await expect(
        patch({ counter: { default: { pinned: [id(1), foreign], hidden: [] } } }, { taxRate: 5 }),
      ).rejects.toThrow(QUICK_KEYS_UNKNOWN_PRODUCT_MESSAGE);
      await expect(
        patch({ counter: { default: { pinned: [], hidden: [foreign] } } }),
      ).rejects.toThrow(BadRequestException);
      expect(svc.set).not.toHaveBeenCalled();
    });

    it("the ownership check is ONE tenant-scoped query over every id", async () => {
      await patch({ counter: { default: { pinned: [id(1)], hidden: [id(2), id(3)] } } });
      expect(prisma.product.findMany).toHaveBeenCalledTimes(1);
      const args = prisma.product.findMany.mock.calls[0][0];
      expect(args.where.tenantId).toBe(T);
      expect([...args.where.id.in].sort()).toEqual([id(1), id(2), id(3)]);
    });

    it("an empty value needs no product query", async () => {
      await patch({ counter: { default: { pinned: [], hidden: [] } } });
      expect(prisma.product.findMany).not.toHaveBeenCalled();
      expect(svc.set).toHaveBeenCalledTimes(1);
    });

    it("a successful PATCH drops the tenant's ranking cache; a rejected one does not", async () => {
      cache.set(T, "main", 30, ["a"]);
      cache.set("tenant-b", "main", 30, ["b"]);
      await expect(
        patch({ counter: { default: { pinned: ids(1, 13), hidden: [] } } }),
      ).rejects.toThrow();
      expect(cache.get(T, "main", 30)).toEqual(["a"]);
      await patch({ counter: { default: { pinned: [id(1)], hidden: [] } } });
      expect(cache.get(T, "main", 30)).toBeUndefined();
      expect(cache.get("tenant-b", "main", 30)).toEqual(["b"]);
    });

    it("a PATCH without quickKeys never touches it (other behaviour unchanged)", async () => {
      await controller.updateSettings({ taxRate: 7 });
      expect(svc.set).toHaveBeenCalledTimes(1);
      expect(svc.set).toHaveBeenCalledWith("settings.taxRate", "7");
    });

    it("refuses a session with no tenant", async () => {
      (prisma as unknown as { getTenantId: () => null }).getTenantId = () => null;
      await expect(
        patch({ counter: { default: { pinned: [id(1)], hidden: [] } } }),
      ).rejects.toThrow(BadRequestException);
      expect(svc.set).not.toHaveBeenCalled();
    });
  });
});
