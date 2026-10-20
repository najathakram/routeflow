import { BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { APP_LINK_KEYS } from "@routeflow/types";
import { PlatformConfigService } from "./platform-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { API_ERROR_CODES } from "../common/api-error-codes";

describe("PlatformConfigService — app links", () => {
  let service: PlatformConfigService;
  let prisma: { $queryRaw: jest.Mock; $executeRaw: jest.Mock };
  /** key -> stored value; the mocked raw queries read the key from the tagged-template values. */
  let store: Map<string, string>;

  beforeEach(async () => {
    store = new Map();
    prisma = {
      $queryRaw: jest.fn(async (_s: TemplateStringsArray, key: string) =>
        store.has(key) ? [{ value: store.get(key) }] : [],
      ),
      // INSERT passes (key, value); DELETE passes (key) only.
      $executeRaw: jest.fn(async (_s: TemplateStringsArray, key: string, value?: string) => {
        if (value === undefined) store.delete(key);
        else store.set(key, value);
        return 1;
      }),
    };
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformConfigService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
      ],
    }).compile();
    service = mod.get(PlatformConfigService);
  });

  it("getAppLinks returns null for absent, empty and non-https values", async () => {
    expect(await service.getAppLinks()).toEqual({
      androidApkUrl: null,
      playStoreUrl: null,
      iosUrl: null,
    });
    store.set(APP_LINK_KEYS.androidApkUrl, "");
    store.set(APP_LINK_KEYS.playStoreUrl, "http://example.test/play");
    store.set(APP_LINK_KEYS.iosUrl, "javascript:alert(1)");
    expect(await service.getAppLinks()).toEqual({
      androidApkUrl: null,
      playStoreUrl: null,
      iosUrl: null,
    });
    store.set(APP_LINK_KEYS.androidApkUrl, "https://example.test/app.apk");
    expect((await service.getAppLinks()).androidApkUrl).toBe("https://example.test/app.apk");
  });

  it("setAppLinks trims and stores https URLs, deletes on empty or null", async () => {
    store.set(APP_LINK_KEYS.iosUrl, "https://example.test/ios");
    store.set(APP_LINK_KEYS.playStoreUrl, "https://example.test/play");
    const result = await service.setAppLinks({
      androidApkUrl: "  https://example.test/app.apk  ",
      iosUrl: null,
      playStoreUrl: "",
    });
    expect(store.get(APP_LINK_KEYS.androidApkUrl)).toBe("https://example.test/app.apk");
    expect(store.has(APP_LINK_KEYS.iosUrl)).toBe(false);
    expect(store.has(APP_LINK_KEYS.playStoreUrl)).toBe(false);
    expect(result).toEqual({
      androidApkUrl: "https://example.test/app.apk",
      playStoreUrl: null,
      iosUrl: null,
    });
  });

  it("setAppLinks leaves a field that is absent from the patch alone", async () => {
    store.set(APP_LINK_KEYS.iosUrl, "https://example.test/ios");
    await service.setAppLinks({ androidApkUrl: "https://example.test/app.apk" });
    expect(store.get(APP_LINK_KEYS.iosUrl)).toBe("https://example.test/ios");
  });

  it("setAppLinks rejects http:, javascript:, a hostless and a > 2048-char URL with APP_LINK_URL_INVALID", async () => {
    store.set(APP_LINK_KEYS.iosUrl, "https://example.test/ios");
    const bad = [
      "http://example.test/a",
      "javascript:alert(1)",
      "https://",
      `https://example.test/${"a".repeat(2048)}`,
      ["https://example.test/a"] as unknown as string,
      42 as unknown as string,
    ];
    for (const value of bad) {
      const err = await service
        .setAppLinks({ iosUrl: "https://example.test/new", androidApkUrl: value })
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({
        code: API_ERROR_CODES.APP_LINK_URL_INVALID,
        field: "androidApkUrl",
      });
    }
    // Validate everything before writing anything: the valid iosUrl in the same patches was not stored.
    expect(store.get(APP_LINK_KEYS.iosUrl)).toBe("https://example.test/ios");
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});

describe("API literal copy of the app-links contract", () => {
  it("keys and URL rule match packages/types", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const shared = require("@routeflow/types");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const local = require("./app-links");
    expect(local.APP_LINK_KEYS).toEqual(shared.APP_LINK_KEYS);
    expect(local.APP_LINK_MAX_LENGTH).toBe(shared.APP_LINK_MAX_LENGTH);
    for (const v of [
      "https://a.test/x",
      "http://a.test",
      "https://",
      "",
      "x",
      null,
      "javascript:alert(1)",
      `https://a.test/${"a".repeat(2049)}`,
    ]) {
      expect(local.isValidAppLinkUrl(v)).toBe(shared.isValidAppLinkUrl(v));
    }
  });
});
