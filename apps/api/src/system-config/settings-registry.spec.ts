/**
 * WS5 settings registry (SA-602): every configurable setting across the three homes has a row and
 * a screen. The registry + rules live in `@routeflow/types` (`settings-registry.ts`); this spec
 * is the API half of the pin:
 *  - the rules themselves (a planted SystemConfig BEHAVIOUR key fails, a planted policy key
 *    without a surface fails);
 *  - every SystemConfig key the settings writers actually write is registered (drives the real
 *    SettingsController + SystemConfigService against a recording store, so a new key written by
 *    any of these handlers is a red spec until it gets a row);
 *  - the userPref rows are the preference allow-list.
 */
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import {
  LEGACY_SYSTEM_CONFIG_BEHAVIOUR_KEYS,
  PREFERENCE_KEYS as SHARED_PREFERENCE_KEYS,
  SETTINGS_REGISTRY,
  isRegisteredSettingKey,
  validateSettingsRegistry,
  type SettingRow,
} from "@routeflow/types";
import { SettingsController } from "./settings.controller";
import { SystemConfigService } from "./system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { EncryptionService } from "../common/encryption.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { PREFERENCE_KEYS } from "../users/dto/update-preferences.dto";
import { TOBACCO_EXCLUDE_KEY } from "../analytics/analytics.service";
import {
  CREDIT_LIMIT_DELIVERY_ENFORCE_KEY,
  CREDIT_LIMIT_ENFORCE_KEY,
} from "../orders/credit-limit-guard";
import {
  SYSTEM_CONFIG_ENABLED,
  SYSTEM_CONFIG_GOVERNING_ADDRESS,
} from "../selling-restrictions/selling-restrictions.service";

const row = (over: Partial<SettingRow>): SettingRow => ({
  key: "x.y",
  home: "systemConfig",
  kind: "config",
  status: "live",
  screen: "/settings?tab=profile",
  ...over,
});

describe("settings registry — rules", () => {
  it("the shipped registry is valid", () => {
    expect(validateSettingsRegistry()).toEqual([]);
  });

  it("a planted SystemConfig BEHAVIOUR key fails", () => {
    const planted = row({ key: "orders.autoConfirm", kind: "behaviour" });
    expect(validateSettingsRegistry([planted]).join("\n")).toMatch(/policy store/);
  });

  it("a planted policy key without a surface fails", () => {
    const planted = row({
      key: "orders.someSwitch",
      home: "policy",
      kind: "behaviour",
      status: "pending #1337",
      screen: undefined,
    });
    expect(validateSettingsRegistry([planted]).join("\n")).toMatch(
      /no screen and no plannedSurface/,
    );
  });

  it("a live row with only a plannedSurface fails; a duplicate key fails", () => {
    expect(
      validateSettingsRegistry([row({ screen: undefined, plannedSurface: "later" })]).join("\n"),
    ).toMatch(/live rows need a screen/);
    expect(validateSettingsRegistry([row({}), row({})]).join("\n")).toMatch(/duplicate/);
  });

  it("a policy row may only be a behaviour switch, pending until #1337", () => {
    const bad = row({ home: "policy", kind: "config", status: "legacy" });
    const out = validateSettingsRegistry([bad]).join("\n");
    expect(out).toMatch(/pending #1337/);
    expect(out).toMatch(/behaviour switches only/);
  });

  it("selling_restrictions.enabled is allow-listed as legacy; credit_limit.* move to policy", () => {
    const find = (k: string) => SETTINGS_REGISTRY.find((r) => r.key === k)!;
    expect(find("selling_restrictions.enabled")).toMatchObject({
      kind: "behaviour",
      status: "legacy",
    });
    expect(LEGACY_SYSTEM_CONFIG_BEHAVIOUR_KEYS).toContain("selling_restrictions.enabled");
    for (const k of ["credit_limit.enforce_new_orders", "credit_limit.enforce_delivery"]) {
      expect(find(k)).toMatchObject({ home: "systemConfig", status: "moves to policy (PR-3)" });
    }
    // A grandfathered key must keep its legacy status.
    expect(
      validateSettingsRegistry([
        row({ key: "selling_restrictions.enabled", kind: "behaviour", status: "live" }),
      ]).join("\n"),
    ).toMatch(/must carry status "legacy"/);
  });

  it("seeds the policy rows by the SA's camelCase names, pending #1337", () => {
    const policy = SETTINGS_REGISTRY.filter((r) => r.home === "policy");
    expect(policy.map((r) => r.key).sort()).toEqual([
      "credit.enforceDelivery",
      "credit.enforceNewOrders",
      "notifications.staffOrderEmail",
      "orders.buyerOversell",
    ]);
    for (const r of policy) expect(r).toMatchObject({ status: "pending #1337", kind: "behaviour" });
  });

  it("userPref rows are exactly the shared and api preference allow-lists", () => {
    const keys = SETTINGS_REGISTRY.filter((r) => r.home === "userPref")
      .map((r) => r.key)
      .sort();
    expect(keys).toEqual([...SHARED_PREFERENCE_KEYS].sort());
    expect(keys).toEqual([...PREFERENCE_KEYS].sort());
  });
});

describe("settings registry — every SystemConfig key the settings writers write is registered", () => {
  let controller: SettingsController;
  const written = new Set<string>();

  beforeAll(async () => {
    const prisma = createMockPrisma();
    const sc = prisma.forTenant().systemConfig as any;
    sc.findFirst.mockResolvedValue(null);
    sc.findMany.mockResolvedValue([]);
    sc.create.mockImplementation(async ({ data }: any) => {
      written.add(data.key);
    });
    const mod = await Test.createTestingModule({
      controllers: [SettingsController],
      providers: [
        SystemConfigService,
        {
          provide: EncryptionService,
          useValue: { encrypt: (v: string) => v, decrypt: (v: string) => v },
        },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: { isEmailConfigured: jest.fn(async () => true) } },
      ],
    }).compile();
    controller = mod.get(SettingsController);

    await controller.updateSettings({ taxRate: 5, logoUrl: "u" });
    await controller.updateEmailSettings({
      fromName: "a",
      fromEmail: "a@example.com",
      smtpHost: "h",
      smtpPort: 587,
      smtpUser: "u",
      smtpPassword: "p",
      smtpSecure: true,
    });
    await controller.updateAnthropicSettings({ apiKey: "k" });
    await controller.updateRouteSettings({
      serviceTimeMinutes: 10,
      defaultStartTime: "08:00",
      averageSpeedKmh: 40,
      depotLat: 1,
      depotLng: 2,
    });
    await controller.updateInvoiceSettings({
      defaultTerms: "Net 30",
      hideOriginalPrice: true,
      depositDefaultPercent: 10,
      depositCollectAtOrder: true,
    } as any);
    await controller.updateMarginConfig({
      costingMethod: "FIFO",
      defaultMarginFloor: 10,
      categoryFloors: { SNACKS: 20 },
    });
    await controller.updateRemittanceConfig({ payToName: "x" } as any);
    await controller.updatePricingTierLabels({ tier1: "Retail" } as any);
  });

  it("drove the writers (guard against a silent no-op harness)", () => {
    expect(written.size).toBeGreaterThan(20);
    expect(written).toContain("route.defaultDepotLat");
    expect(written).toContain("margin.floor.category.SNACKS");
  });

  it("every written key has a registry row", () => {
    const unregistered = [...written].filter((k) => !isRegisteredSettingKey(k));
    expect(unregistered).toEqual([]);
  });

  it("the keys other services write (exported constants) have rows too", () => {
    for (const k of [
      TOBACCO_EXCLUDE_KEY,
      CREDIT_LIMIT_ENFORCE_KEY,
      CREDIT_LIMIT_DELIVERY_ENFORCE_KEY,
      SYSTEM_CONFIG_ENABLED,
      SYSTEM_CONFIG_GOVERNING_ADDRESS,
    ]) {
      expect(isRegisteredSettingKey(k)).toBe(true);
    }
  });

  it("a planted unregistered key is reported", () => {
    expect(isRegisteredSettingKey("planted.newSwitch")).toBe(false);
    expect(isRegisteredSettingKey("margin.floor.category.ANYTHING")).toBe(true);
  });
});
