/**
 * SA-540 conditions for the default-granted `orders_inline_returns` (owner ruling 2026-09-28),
 * plus the Opus review folds on fa6186b9:
 *   - the unit matrix {preset(row), default, grant, deny} × {flag.returns on, off}, through the
 *     REAL AddonService + AddonGuard + /tenants/me/addons handler (and hasAddon, which
 *     InlineReturnsService.assertGranted calls): one answer per cell everywhere;
 *   - M2: `requires` honours overrides (DENY flag.returns removes it; GRANT flag.returns adds it);
 *   - M1: the Feature Console's computeOldPathAll equals computeOldPath equals the runtime;
 *   - M3: disableAddon refuses a default-granted key (only a DENY removes it);
 *   - m3: a route gated on another add-on pays nothing for the default grant;
 *   - condition 1: computed at read time, never written; condition 2: isPayingRow untouched;
 *   - condition 3: the LITE preset is unchanged; condition 4: every defaultGranted add-on names
 *     its requires-flag.
 */
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { BadRequestException, ForbiddenException, type ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { AddonService } from "./addon.service";
import { AddonGuard } from "./addon.guard";
import { EntitlementAuthority } from "./entitlement-authority.service";
import { TenantsController } from "../tenants/tenants.controller";
import { DEFAULT_GRANTED_ADDON_FEATURES, FEATURE_REGISTRY } from "./feature-registry";
import { LITE_DEFINITION, LITE_FEATURE_FLAGS } from "../../prisma/plan-catalog-v12.definitions";

const KEY = "orders_inline_returns";
const OTHER = "recurring_routes"; // RequireAddon, enforced, defaultGranted:false
const TENANT = "t-acme";
type Effect = "GRANT" | "DENY";

function harness(opts: { flags: string[]; rows?: string[]; overrides?: Record<string, Effect> }) {
  const rows = opts.rows ?? [];
  const overrides = new Map<string, Effect>(Object.entries(opts.overrides ?? {}));
  const write = jest.fn(() => {
    throw new Error("the default grant must never write");
  });
  const prisma = {
    tenantAddon: {
      findMany: jest.fn().mockResolvedValue(rows.map((addonKey) => ({ addonKey }))),
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: { where: { OR: Array<{ addonKey?: string }> } }) => {
          const hit = where.OR.some(
            (c) => typeof c.addonKey === "string" && rows.includes(c.addonKey),
          );
          return Promise.resolve(hit ? { active: true } : null);
        }),
      findUnique: jest
        .fn()
        .mockImplementation(({ where }: { where: { tenantId_addonKey: { addonKey: string } } }) =>
          Promise.resolve(
            rows.includes(where.tenantId_addonKey.addonKey) ? { active: true } : null,
          ),
        ),
      create: write,
      update: write,
      upsert: write,
      updateMany: write,
      createMany: write,
      delete: write,
      deleteMany: write,
    },
  };
  const entitlements = {
    resolve: jest.fn().mockResolvedValue({ planKey: "GROWTH", flags: opts.flags }),
    isAlwaysEnforcedTenant: jest.fn().mockResolvedValue(false),
  };
  const featureOverrides = {
    get: jest
      .fn()
      .mockImplementation((_t: string, k: string) => Promise.resolve(overrides.get(k) ?? null)),
    getMany: jest.fn().mockImplementation((_t: string, keys: string[]) => {
      const m = new Map<string, Effect>();
      for (const k of keys) if (overrides.has(k)) m.set(k, overrides.get(k)!);
      return Promise.resolve(m);
    }),
    allActive: jest.fn().mockResolvedValue(overrides),
  };
  const service = new AddonService(
    prisma as never,
    {} as never,
    entitlements as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    featureOverrides as never,
  );
  const guard = async (key: string) => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue([key]) };
    const g = new AddonGuard(
      reflector as unknown as Reflector,
      service,
      entitlements as never,
      featureOverrides as never,
    );
    const ctx = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({
        getRequest: () => ({ user: { tenantId: TENANT }, method: "POST", url: "/x" }),
      }),
    } as unknown as ExecutionContext;
    try {
      return await g.canActivate(ctx);
    } catch (e) {
      if (e instanceof ForbiddenException) return false;
      throw e;
    }
  };
  const meAddons = async () =>
    (
      (await TenantsController.prototype.getMyAddons.call(
        { addonService: service, featureOverrides },
        { tenantId: TENANT } as never,
      )) as { addons: string[] }
    ).addons;
  const authority = new EntitlementAuthority(
    entitlements as never,
    featureOverrides as never,
    {} as never,
    {} as never,
    {} as never,
    prisma as never,
  );
  const oldPath = (key: string) =>
    (
      authority as unknown as { computeOldPath(t: string, k: string): Promise<boolean> }
    ).computeOldPath(TENANT, key);
  return { service, guard, meAddons, authority, oldPath, prisma, entitlements, write };
}

/** Every surface's answer for KEY, so a cell is one assertion and a split shows which surface. */
async function answers(h: ReturnType<typeof harness>) {
  const all = await h.authority.computeOldPathAll(TENANT);
  return {
    guard: await h.guard(KEY),
    meAddons: (await h.meAddons()).includes(KEY),
    hasAddon: await h.service.hasAddon(TENANT, KEY),
    oldPath: await h.oldPath(KEY),
    oldPathAll: all.get(KEY) === true,
  };
}
const every = (v: boolean) => ({ guard: v, meAddons: v, hasAddon: v, oldPath: v, oldPathAll: v });

describe("SA-540 matrix: {preset, default, grant, deny} × {flag.returns on, off}", () => {
  const FLAG_ON = ["flag.returns"];
  const FLAG_OFF = ["flag.analytics"];
  const cells: Array<[string, Parameters<typeof harness>[0], boolean]> = [
    ["preset (held row), flag on", { flags: FLAG_ON, rows: [KEY] }, true],
    // A held row is not re-checked against `requires` at runtime (B524 checks it at grant time).
    ["preset (held row), flag off", { flags: FLAG_OFF, rows: [KEY] }, true],
    ["default (no row), flag on", { flags: FLAG_ON }, true],
    ["default (no row), flag off", { flags: FLAG_OFF }, false],
    ["GRANT override, flag on", { flags: FLAG_ON, overrides: { [KEY]: "GRANT" } }, true],
    // An override is absolute (owner ruling, feature-grants PR-1), as it always was in the guard.
    ["GRANT override, flag off", { flags: FLAG_OFF, overrides: { [KEY]: "GRANT" } }, true],
    ["DENY override, flag on", { flags: FLAG_ON, overrides: { [KEY]: "DENY" } }, false],
    ["DENY override, flag off", { flags: FLAG_OFF, overrides: { [KEY]: "DENY" } }, false],
    [
      "DENY override beats a held row",
      { flags: FLAG_ON, rows: [KEY], overrides: { [KEY]: "DENY" } },
      false,
    ],
  ];
  it.each(cells)("%s", async (_name, opts, expected) => {
    expect(await answers(harness(opts))).toEqual(every(expected));
  });
});

describe("M2: `requires` honours overrides on flag.returns", () => {
  it("a DENY on flag.returns removes inline returns even though the plan carries it", async () => {
    const h = harness({ flags: ["flag.returns"], overrides: { "flag.returns": "DENY" } });
    expect(await answers(h)).toEqual(every(false));
  });
  it("a GRANT on flag.returns for a plan without it satisfies the requirement", async () => {
    const h = harness({ flags: [], overrides: { "flag.returns": "GRANT" } });
    expect(await answers(h)).toEqual(every(true));
  });
});

describe("M3 / m3 / condition 1", () => {
  it("disableAddon refuses a default-granted key and names the DENY override", async () => {
    const h = harness({ flags: ["flag.returns"], rows: [KEY] });
    await expect(h.service.disableAddon(TENANT, KEY)).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.service.disableAddon(TENANT, KEY)).rejects.toMatchObject({
      response: { code: "ADDON_DEFAULT_GRANTED" },
    });
  });

  it("a route gated on a non-default add-on does not compute the default grant", async () => {
    const h = harness({ flags: ["flag.returns"], rows: [OTHER] });
    expect(await h.guard(OTHER)).toBe(true);
    expect(h.entitlements.resolve).not.toHaveBeenCalled();
  });

  it("every surface computes at read time and writes nothing", async () => {
    const h = harness({ flags: ["flag.returns"] });
    await answers(h);
    await h.service.getActiveAddons(TENANT);
    expect(h.write).not.toHaveBeenCalled();
  });
});

describe("SA-540 conditions 2–4 (static pins)", () => {
  it("condition 2: isPayingRow (mrr.service.ts, SA-513) is byte-identical", () => {
    const src = readFileSync(join(__dirname, "mrr.service.ts"), "utf8");
    const start = src.indexOf("export function isPayingRow(");
    const end = src.indexOf("\n}\n", start);
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, end + 2);
    expect(createHash("sha256").update(body.replace(/\r\n/g, "\n")).digest("hex")).toBe(
      ISPAYINGROW_SHA256,
    );
  });

  it("condition 3: the LITE preset is unchanged (no flags; the default applies via requires)", () => {
    expect(LITE_FEATURE_FLAGS).toEqual([]);
    expect(LITE_DEFINITION.planKey).toBe("LITE");
    expect(JSON.stringify(LITE_DEFINITION)).not.toContain(KEY);
  });

  it("condition 4: every defaultGranted add-on names the plan flag it requires", () => {
    expect(DEFAULT_GRANTED_ADDON_FEATURES.length).toBeGreaterThan(0);
    for (const f of DEFAULT_GRANTED_ADDON_FEATURES) {
      const named = [...(f.requires?.allOf ?? []), ...(f.requires?.anyOf ?? [])];
      expect([f.key, named.some((k) => k.startsWith("flag."))]).toEqual([f.key, true]);
      for (const k of named) expect(FEATURE_REGISTRY.some((r) => r.key === k)).toBe(true);
    }
  });
});

/** sha256 of isPayingRow's source as of the SA-540 ruling; a change must be a deliberate re-pin. */
const ISPAYINGROW_SHA256 = "ef863e60894228563d58438020fe824a507488ee683cd83db63851ec483f0666";
