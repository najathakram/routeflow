import { BadRequestException, type ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { RolesGuard } from "../auth/guards/roles.guard";
import { EmailService } from "../email/email.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { NAV_LAYOUT_CONFIG_KEY } from "./nav-layout-settings";
import { QuickKeysRankCache } from "./quick-keys-rank.cache";
import { QuickKeysSettingsService } from "./quick-keys-settings.service";
import { SettingsController } from "./settings.controller";
import { SystemConfigService } from "./system-config.service";

/**
 * SA-1209 F-1: the sidebar layout through the real controller and the real roles guard. Only the config store (one
 * row per tenant and key) and prisma are stand-ins. Tenants are the placeholders `acme` and `test`.
 */
describe("SettingsController: navLayout (SA-1209 F-1)", () => {
  let controller: SettingsController;
  let tenant: string;
  let store: Map<string, string>;
  const k = (key: string) => `${tenant}:${key}`;

  beforeEach(async () => {
    tenant = "acme";
    store = new Map();
    const prisma = createMockPrisma();
    (prisma as unknown as { getTenantId: () => string }).getTenantId = () => tenant;
    const svc = {
      get: jest.fn(async (key: string) => store.get(k(key)) ?? null),
      set: jest.fn(async (key: string, v: string) => void store.set(k(key), v)),
      getAll: jest.fn(async (prefix: string) =>
        Object.fromEntries(
          [...store.entries()]
            .filter(([sk]) => sk.startsWith(`${tenant}:${prefix}`))
            .map(([sk, v]) => [sk.slice(tenant.length + 1), v]),
        ),
      ),
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
  });

  const layout = (pinned: string[] = [], order: string[] = [], hidden: string[] = []) => ({
    pinned,
    order,
    hidden,
  });

  it("an OPERATOR calling PATCH /settings/nav-layout is refused by the roles guard (403)", () => {
    const guard = new RolesGuard(new Reflector());
    const ctx = (role: UserRole) =>
      ({
        getHandler: () => SettingsController.prototype.updateNavLayout,
        getClass: () => SettingsController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role, sub: "u1" } }) }),
      }) as unknown as ExecutionContext;
    expect(guard.canActivate(ctx(UserRole.OPERATOR))).toBe(false);
    expect(guard.canActivate(ctx(UserRole.TENANT_ADMIN))).toBe(true);
  });

  it("the generic PATCH /settings refuses navLayout and the stored value is unchanged", async () => {
    await controller.updateNavLayout(layout(["/invoices"]));
    const before = store.get(k(NAV_LAYOUT_CONFIG_KEY));
    await expect(controller.updateSettings({ navLayout: layout(["/customers"]) })).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      controller.updateSettings({
        [NAV_LAYOUT_CONFIG_KEY]: JSON.stringify(layout(["/customers"])),
      }),
    ).rejects.toThrow(BadRequestException);
    expect(store.get(k(NAV_LAYOUT_CONFIG_KEY))).toBe(before);
    expect((await controller.getSettings()).navLayout.pinned).toEqual(["/invoices"]);
  });

  it("tenant acme pinning /invoices leaves tenant test's read unchanged", async () => {
    await controller.updateNavLayout(layout(["/invoices"]));
    expect((await controller.getSettings()).navLayout.pinned).toEqual(["/invoices"]);
    tenant = "test";
    expect((await controller.getSettings()).navLayout).toEqual(layout());
  });

  it.each([["junk"], ["[1,2]"], ['{"pinned":"/invoices","order":[],"hidden":[]}'], ["{broken"]])(
    "a stored value of %s reads as the default layout, no error",
    async (raw) => {
      store.set(k(NAV_LAYOUT_CONFIG_KEY), raw);
      await expect(controller.getSettings()).resolves.toMatchObject({ navLayout: layout() });
    },
  );

  it("a bare array is refused by the writer (nothing legacy is accepted)", async () => {
    await expect(controller.updateNavLayout(["/invoices"])).rejects.toThrow(BadRequestException);
    expect(store.size).toBe(0);
  });

  it("pinned of 6 hrefs is a 400 and stores nothing; 5 is saved", async () => {
    const six = ["/a", "/b", "/c", "/d", "/e", "/f"];
    await expect(controller.updateNavLayout(layout(six))).rejects.toThrow(BadRequestException);
    expect(store.size).toBe(0);
    await expect(controller.updateNavLayout(layout(six.slice(0, 5)))).resolves.toEqual(
      layout(six.slice(0, 5)),
    );
  });

  it("an href that does not start with one slash is a 400", async () => {
    for (const bad of ["invoices", "//evil.example", ""]) {
      await expect(controller.updateNavLayout(layout([bad]))).rejects.toThrow(BadRequestException);
      await expect(controller.updateNavLayout(layout([], [], [bad]))).rejects.toThrow(
        BadRequestException,
      );
    }
  });

  it("the reader drops /settings from hidden and collapses duplicates", async () => {
    await controller.updateNavLayout(
      layout(["/invoices", "/invoices"], ["g"], ["/settings", "/returns"]),
    );
    expect((await controller.getSettings()).navLayout).toEqual(
      layout(["/invoices"], ["g"], ["/returns"]),
    );
  });
});
