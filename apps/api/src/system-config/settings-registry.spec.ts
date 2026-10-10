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
  OFF_HUB_SCREENS,
  PREFERENCE_KEYS as SHARED_PREFERENCE_KEYS,
  SETTINGS_REGISTRY,
  isRegisteredSettingKey,
  validateSettingsRegistry,
  type SettingRow,
} from "@routeflow/types";
import { SettingsController } from "./settings.controller";
import { SystemConfigService } from "./system-config.service";
import { QuickKeysSettingsService } from "./quick-keys-settings.service";
import { QuickKeysRankCache } from "./quick-keys-rank.cache";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { EncryptionService } from "../common/encryption.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { PREFERENCE_KEYS } from "../users/dto/update-preferences.dto";
import { QUICK_KEYS_CONFIG_KEY } from "./quick-keys-settings";
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

  it("orders.posMode is live: the Create Order switch (an off-hub screen) edits it", () => {
    const r = SETTINGS_REGISTRY.find((x) => x.key === "orders.posMode")!;
    expect(r.status).toBe("live");
    expect(r.plannedSurface).toBeUndefined();
    expect(Object.keys(OFF_HUB_SCREENS)).toContain(r.screen);
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
    for (const r of policy) {
      expect(r).toMatchObject({
        status: r.key === "orders.buyerOversell" ? "live" : "pending #1337",
        kind: "behaviour",
      });
    }
  });

  it("the out-of-stock switch is LIVE: its screen is the in-hub card anchor and operators can open it", () => {
    const r = SETTINGS_REGISTRY.find((x) => x.key === "orders.buyerOversell")!;
    expect(r).toMatchObject({ home: "policy", status: "live", screen: "#out-of-stock-ordering" });
    expect(r.adminOnly).toBeFalsy();
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
        QuickKeysSettingsService,
        QuickKeysRankCache,
      ],
    }).compile();
    controller = mod.get(SettingsController);

    await controller.updateSettings({
      taxRate: 5,
      logoUrl: "u",
      receiptFooter: "Thank you",
      // Every other field the handler accepts is NOT tenant-editable: none may reach SystemConfig.
      businessName: "b",
      ownerName: "o",
      email: "e@example.com",
      street: "s",
      city: "c",
      state: "st",
      zip: "z",
      phone: "p",
    });
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

  it("driving every settings.* field writes only settings.taxRate, settings.logoUrl and settings.receiptFooter", () => {
    expect([...written].filter((k) => k.startsWith("settings.")).sort()).toEqual([
      "settings.logoUrl",
      "settings.receiptFooter",
      "settings.taxRate",
    ]);
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
/**
 * KNOWN LIMITS of this scan (documented, not chased). It reads source text, so it cannot see:
 *  - a SystemConfigService reached through an optional/union-typed parameter or field;
 *  - one fetched via `moduleRef.get(...)` or held in a delegate variable (`const c = this.svc; c.set`);
 *  - schema-qualified raw SQL (`"public"."SystemConfig"`);
 *  - new entries added to an existing `allowed` list (settings.controller's `settings.${k}` /
 *    `email.${k}` templates) — the handler-driven tests above pin those fields instead.
 * A writer hidden by one of these still needs a registry row; review catches it, this scan does not.
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

/** Receiver names a SystemConfigService is reached by; plus any field TYPED SystemConfigService. */
const DEFAULT_RECEIVERS = ["svc", "systemConfig", "systemConfigService"];

function receiversIn(src: string): string[] {
  const typed = [...src.matchAll(/\b(\w+)\s*:\s*SystemConfigService\b/g)].map((m) => m[1]);
  return [...new Set([...DEFAULT_RECEIVERS, ...typed])];
}

/** `recv.set(` for any receiver, `this.recv.set(` included (the `this.` prefix is optional). */
function setCallRegex(src: string, flags = ""): RegExp {
  const recv = [...receiversIn(src), "this"].join("|");
  return new RegExp(`\\b(?:${recv})\\s*\\.\\s*set\\(\\s*`, flags);
}

// `systemConfig.create as any)(…)` and `.createMany(` are writers too: no `(` required after the verb.
const PRISMA_WRITE = /systemConfig\s*\.\s*(?:create|update|upsert|createMany|updateMany)\b/;
const RAW_SQL_WRITE = /(?:INSERT\s+INTO|UPDATE)\s+"?SystemConfig"?/i;
const KEY_DECL =
  /(?:const|readonly)\s+[A-Za-z_]+(?:\s*:\s*[^=]+)?\s*=\s*"([a-z][A-Za-z_]*\.[A-Za-z_][A-Za-z_.]*)"/g;

/** Key prefixes a writer file may mention without a registry row, each with the reason. */
const EXEMPT_KEY_PREFIXES: Record<string, string> = {
  "zoho.":
    "SystemConfigService.setZohoConfig has no caller in api or web (dead code; separate cleanup)",
};

function isWriterFile(rel: string, src: string): boolean {
  if (PRISMA_WRITE.test(src) || RAW_SQL_WRITE.test(src)) return true;
  const recv = receiversIn(src).join("|");
  if (new RegExp(`\\b(?:${recv})\\s*\\.\\s*set\\(`).test(src)) return true;
  return rel.endsWith("system-config/system-config.service.ts") && /this\.set\(/.test(src);
}

/**
 * First arguments of `set(` that are NOT a string/template literal — an identifier, a constant, a
 * concatenation (`PREFIX + k`) or a call (`keyFor(x)`). The key is indirect, so each is pinned.
 */
export function indirectKeyArgs(src: string): string[] {
  const re = new RegExp(setCallRegex(src).source + "([^\"'`\\s][^,]*?)\\s*,", "g");
  return [...new Set([...src.matchAll(re)].map((m) => m[1].trim()))];
}

/** Keys (and template prefixes, marked with a trailing `*`) a file writes, by nets B and C. */
export function scanKeys(src: string, namespaces: Set<string>): string[] {
  const found = new Set<string>();
  const direct = new RegExp(setCallRegex(src).source + '(?:"([^"]+)"|`([^`$]*)(\\$\\{)?)', "g");
  for (const m of src.matchAll(direct)) {
    if (m[1]) found.add(m[1]);
    else if (m[2] !== undefined) found.add(m[3] ? `${m[2]}*` : m[2]);
  }
  for (const m of src.matchAll(KEY_DECL)) {
    if (namespaces.has(m[1].split(".")[0])) found.add(m[1]);
  }
  // `systemConfig.create({ data: { key: "ns.key", … } })` — a literal key in a prisma write.
  if (PRISMA_WRITE.test(src)) {
    for (const m of src.matchAll(/\bkey\s*:\s*"([^"]+)"/g)) found.add(m[1]);
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
      "messaging/staff-email-settings.service.ts",
      "restrictions-settings/restrictions-settings.service.ts",
      "route-optimization/route-optimization.service.ts",
      "system-config/quick-keys-settings.service.ts",
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

  /**
   * Writers that pass the key through a variable / imported constant. Each identifier is listed
   * with the registered keys it carries, so an indirect write is never invisible.
   */
  const INDIRECT_KEY_WRITERS: Record<string, Record<string, string[]>> = {
    "tobacco/tobacco.service.ts": { TOBACCO_EXCLUDE_KEY: [TOBACCO_EXCLUDE_KEY] },
    // SA-747: the counter quick keys value is ONE JSON string under this constant (quick-keys-settings.ts)
    "system-config/quick-keys-settings.service.ts": {
      QUICK_KEYS_CONFIG_KEY: [QUICK_KEYS_CONFIG_KEY],
    },
    // static key constants inside SystemConfigService itself (the generic set(key) is a definition)
    "system-config/system-config.service.ts": {
      "SystemConfigService.REMITTANCE_KEY": ["remittance.config"],
      "SystemConfigService.TIER_LABELS_KEY": ["pricing.tierLabels"],
    },
  };

  it("every indirect (variable/constant) key a writer passes is declared and registered", () => {
    const found: Record<string, string[]> = {};
    for (const w of writers) {
      const ids = indirectKeyArgs(w.src);
      if (ids.length) found[w.rel] = ids.sort();
    }
    const declared = Object.fromEntries(
      Object.entries(INDIRECT_KEY_WRITERS).map(([f, m]) => [f, Object.keys(m).sort()]),
    );
    expect(found).toEqual(declared);
    for (const m of Object.values(INDIRECT_KEY_WRITERS)) {
      for (const keys of Object.values(m))
        for (const k of keys) expect(isRegisteredSettingKey(k)).toBe(true);
    }
  });

  it("restrictions-settings writes exactly the two selling_restrictions constants, in order", () => {
    const r = writers.find(
      (w) => w.rel === "restrictions-settings/restrictions-settings.service.ts",
    )!;
    const pushed = [...r.src.matchAll(/writes\.push\(\[\s*([^,\]]+)/g)].map((m) => m[1].trim());
    expect(pushed).toEqual(["SYSTEM_CONFIG_GOVERNING_ADDRESS", "SYSTEM_CONFIG_ENABLED"]);
    for (const k of [SYSTEM_CONFIG_ENABLED, SYSTEM_CONFIG_GOVERNING_ADDRESS]) {
      expect(isRegisteredSettingKey(k)).toBe(true);
    }
  });

  it("the prisma-direct writer files are frozen, each with a pinned key source", () => {
    const direct = writers.filter((w) => PRISMA_WRITE.test(w.src)).map((w) => w.rel);
    expect(direct.sort()).toEqual([
      "email/email.service.ts",
      "messaging/staff-email-settings.service.ts",
      "restrictions-settings/restrictions-settings.service.ts",
      "system-config/system-config.service.ts",
    ]);
    // email: the sending-domain write takes its key from ONE constant.
    const email = writers.find((w) => w.rel === "email/email.service.ts")!;
    expect([...email.src.matchAll(/const key = ([^;]+);/g)].map((m) => m[1].trim())).toEqual([
      "EmailService.SENDING_DOMAIN_KEY",
    ]);
    expect(email.src).toMatch(/SENDING_DOMAIN_KEY = "email\.sendingDomain"/);
    // system-config.service: the generic set(key, value) — every caller is scanned above.
    const sc = writers.find((w) => w.rel === "system-config/system-config.service.ts")!;
    expect(sc.src).toMatch(/async set\(key: string, value: string\)/);
  });

  it("finds email.sendingDomain (defined as a constant in email.service.ts)", () => {
    const email = writers.find((w) => w.rel === "email/email.service.ts")!;
    expect(scanKeys(email.src, NAMESPACES)).toContain("email.sendingDomain");
  });

  it("messaging/staff-email-settings writes ONE key, from one constant, and it is registered", () => {
    const w = writers.find((x) => x.rel === "messaging/staff-email-settings.service.ts")!;
    expect(w.src).toMatch(/const STAFF_CC_KEY = "notifications\.staffCc"/);
    // every `key:` in the file is that constant (no second key can slip in)
    const keyArgs = [...w.src.matchAll(/\bkey\s*:\s*([^,}\s]+)/g)].map((m) => m[1]);
    expect(keyArgs.length).toBeGreaterThan(0);
    expect(new Set(keyArgs)).toEqual(new Set(["STAFF_CC_KEY"]));
    expect(scanKeys(w.src, NAMESPACES)).toEqual(["notifications.staffCc"]);
    expect(SETTINGS_REGISTRY.find((r) => r.key === "notifications.staffCc")).toMatchObject({
      home: "systemConfig",
      kind: "config",
      status: "pending WS4",
    });
  });

  it("planted writers are detected: the cast form, a renamed field, createMany, raw SQL", () => {
    const rel = "planted/x.service.ts";
    expect(
      isWriterFile(
        rel,
        "await (this.prisma.forTenant().systemConfig.create as any)({ data: { key, value } });",
      ),
    ).toBe(true);
    const renamed =
      'constructor(private readonly config: SystemConfigService) {}\n  async a() { await this.config.set("planted.viaRename", "1"); }';
    expect(isWriterFile(rel, renamed)).toBe(true);
    expect(scanKeys(renamed, NAMESPACES)).toContain("planted.viaRename");
    expect(isWriterFile(rel, "await tx.systemConfig.createMany({ data: rows });")).toBe(true);
    expect(
      isWriterFile(rel, 'await db.$executeRaw`INSERT INTO "SystemConfig" (key) VALUES (${k})`;'),
    ).toBe(true);
    expect(
      isWriterFile(rel, "const v = await this.prisma.forTenant().systemConfig.findFirst({});"),
    ).toBe(false);
    expect(
      indirectKeyArgs('await this.config2.set(someKey, "v");  await this.svc.set(K.X, "v");'),
    ).toEqual(["K.X"]);
    // A computed first argument is indirect too: a concatenation and a call.
    expect(indirectKeyArgs("await this.svc.set(PREFIX + k, v);")).toEqual(["PREFIX + k"]);
    expect(indirectKeyArgs("await this.svc.set(keyFor(x), v);")).toEqual(["keyFor(x)"]);
    expect(
      indirectKeyArgs('await this.svc.set("lit.key", v); await this.svc.set(`t.${k}`, v);'),
    ).toEqual([]);
    // A literal `key:` in a prisma write is a key too.
    expect(
      scanKeys(
        'await tx.systemConfig.create({ data: { tenantId, key: "planted.prismaKey", value } });',
        NAMESPACES,
      ),
    ).toContain("planted.prismaKey");
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
