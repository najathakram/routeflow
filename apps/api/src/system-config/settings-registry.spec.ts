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
import * as fs from "fs";
import * as path from "path";
import {
  CREDIT_LIMIT_MOVING_KEYS,
  LEGACY_SYSTEM_CONFIG_BEHAVIOUR,
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
    expect(Object.keys(LEGACY_SYSTEM_CONFIG_BEHAVIOUR)).toContain("selling_restrictions.enabled");
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

  it("the legacy allow-list is FROZEN: exact keys, each with a reason and a policy target", () => {
    expect(Object.keys(LEGACY_SYSTEM_CONFIG_BEHAVIOUR).sort()).toEqual([
      "invoice.depositCollectAtOrder",
      "selling_restrictions.enabled",
      "selling_restrictions.governing_address",
    ]);
    for (const [k, v] of Object.entries(LEGACY_SYSTEM_CONFIG_BEHAVIOUR)) {
      expect(v.reason.length).toBeGreaterThan(20);
      expect(v.target).toMatch(/policy/i);
      expect(k).toBeTruthy();
    }
  });

  it("'moves to policy (PR-3)' is tied to the two named credit_limit.* keys only", () => {
    expect([...CREDIT_LIMIT_MOVING_KEYS].sort()).toEqual([
      "credit_limit.enforce_delivery",
      "credit_limit.enforce_new_orders",
    ]);
    const planted = row({
      key: "some.other.switch",
      kind: "behaviour",
      status: "moves to policy (PR-3)",
      screen: undefined,
      plannedSurface: "later",
    });
    expect(validateSettingsRegistry([planted]).join("\n")).toMatch(/only the named credit_limit/);
  });

  it("a pending or moving row cannot claim a screen (it must name a plannedSurface)", () => {
    const planted = row({
      key: "staffSomething",
      home: "userPref",
      kind: "preference",
      status: "pending WS4",
      screen: "/settings?tab=notifications",
    });
    expect(validateSettingsRegistry([planted]).join("\n")).toMatch(
      /pending rows cannot claim a screen/,
    );
    const staffBuyer = SETTINGS_REGISTRY.find((r) => r.key === "staffBuyerChangeEmail")!;
    expect(staffBuyer.screen).toBeUndefined();
    expect(staffBuyer.plannedSurface).toBeTruthy();
  });

  it("both staff-email prefs name the My account 'Email me about' card as their planned surface", () => {
    for (const k of ["staffOrderEmail", "staffBuyerChangeEmail"]) {
      const r = SETTINGS_REGISTRY.find((x) => x.key === k)!;
      expect(r.screen).toBeUndefined();
      expect(r.plannedSurface).toMatch(/My account/);
    }
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

/**
 * STRUCTURAL completeness (#2866 review): a source scan of every non-spec api file that writes
 * SystemConfig. Hand-driving handlers (above) cannot see a writer that is stubbed or added later;
 * this scan can. Three nets:
 *  (A) the set of writer FILES is frozen — a new writer file is red until it is added here (and its
 *      keys registered);
 *  (B) every literal passed straight to a `set(` call (or a `prefix.${...}` template) is registered;
 *  (C) every key CONSTANT declared in a writer file (`const K = "ns.key"`) in a registered
 *      namespace is registered (catches `SENDING_DOMAIN_KEY = "email.sendingDomain"`). Reads of a
 *      key are deliberately not matched.
 */
const SRC = path.resolve(__dirname, "..");

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "testing" || e.name === "node_modules") continue;
      listSourceFiles(full, out);
    } else if (/\.ts$/.test(e.name) && !/\.(spec|test|d)\.ts$/.test(e.name)) out.push(full);
  }
  return out;
}

const WRITE_CALL =
  /\b(?:svc|systemConfig|systemConfigService)\.set\(|\.systemConfig\.(?:create|update|upsert)\(|\btx\.systemConfig\.(?:create|update|upsert)\(/;
const DIRECT_SET =
  /\b(?:svc|systemConfig|systemConfigService|this)\.set\(\s*(?:"([^"]+)"|`([^`$]*)(\$\{)?)/g;
const KEY_DECL =
  /(?:const|readonly)\s+[A-Za-z_]+(?:\s*:\s*[^=]+)?\s*=\s*"([a-z][A-Za-z_]*\.[A-Za-z_][A-Za-z_.]*)"/g;

/** Key prefixes a writer file may mention without a registry row, each with the reason. */
const EXEMPT_KEY_PREFIXES: Record<string, string> = {
  "zoho.":
    "SystemConfigService.setZohoConfig has no caller in api or web (dead code; separate cleanup)",
};

function isWriterFile(rel: string, src: string): boolean {
  return (
    WRITE_CALL.test(src) ||
    (rel.endsWith("system-config/system-config.service.ts") && /this\.set\(/.test(src))
  );
}

/** Keys (and template prefixes, marked with a trailing `*`) a file writes, by nets B and C. */
export function scanKeys(src: string, namespaces: Set<string>): string[] {
  const found = new Set<string>();
  for (const m of src.matchAll(DIRECT_SET)) {
    if (m[1]) found.add(m[1]);
    else if (m[2] !== undefined) found.add(m[3] ? `${m[2]}*` : m[2]);
  }
  for (const m of src.matchAll(KEY_DECL)) {
    if (namespaces.has(m[1].split(".")[0])) found.add(m[1]);
  }
  return [...found];
}

function coveredByRegistry(key: string): boolean {
  if (Object.keys(EXEMPT_KEY_PREFIXES).some((p) => key.startsWith(p))) return true;
  if (key.endsWith("*")) {
    const prefix = key.slice(0, -1);
    return SETTINGS_REGISTRY.some(
      (r) => r.key.startsWith(prefix) || prefix.startsWith(r.key.replace(/\*$/, "")),
    );
  }
  return isRegisteredSettingKey(key);
}

const NAMESPACES = new Set(
  SETTINGS_REGISTRY.filter((r) => r.home === "systemConfig").map((r) => r.key.split(".")[0]),
);

describe("settings registry — structural source scan of every SystemConfig writer", () => {
  const files = listSourceFiles(SRC);
  const writers = files
    .map((f) => ({
      rel: path.relative(SRC, f).split(path.sep).join("/"),
      src: fs.readFileSync(f, "utf8"),
    }))
    .filter((f) => isWriterFile(f.rel, f.src));

  it("the scan reads real files (guards a path typo making it vacuous)", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(writers.length).toBeGreaterThan(3);
  });

  it("the writer FILE list is frozen (a new writer must be added here with its registry rows)", () => {
    expect(writers.map((w) => w.rel).sort()).toEqual([
      "email/email.service.ts",
      "restrictions-settings/restrictions-settings.service.ts",
      "route-optimization/route-optimization.service.ts",
      "system-config/settings.controller.ts",
      "system-config/system-config.service.ts",
      "tobacco/tobacco.service.ts",
      "trips/trips.service.ts",
    ]);
  });

  it("every key a writer file writes is registered", () => {
    const missing: string[] = [];
    for (const w of writers) {
      for (const k of scanKeys(w.src, NAMESPACES)) {
        if (!coveredByRegistry(k)) missing.push(`${w.rel}: ${k}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("finds email.sendingDomain (defined as a constant in email.service.ts)", () => {
    const email = writers.find((w) => w.rel === "email/email.service.ts")!;
    expect(scanKeys(email.src, NAMESPACES)).toContain("email.sendingDomain");
  });

  it("planted misses are caught: a direct literal, a template prefix, a constant in a known namespace", () => {
    const planted = [
      'await this.svc.set("planted.newSwitch", "x");',
      "await this.svc.set(`newns.${k}`, v);",
      'private static readonly K = "email.plantedConstant";',
    ].join("\n");
    const keys = scanKeys(planted, NAMESPACES);
    expect(keys).toEqual(
      expect.arrayContaining(["planted.newSwitch", "newns.*", "email.plantedConstant"]),
    );
    expect(keys.filter((k) => !coveredByRegistry(k)).sort()).toEqual([
      "email.plantedConstant",
      "newns.*",
      "planted.newSwitch",
    ]);
  });
});
