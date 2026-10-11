import { ExecutionContext, ForbiddenException, Logger } from "@nestjs/common";
import { AddonGuard } from "./addon.guard";

// Synthetic, token-shaped (43 url-safe chars); not a real secret.
const TOKEN = "Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0Ab0";
const UUID = "3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b";

const ctx = (req: Record<string, unknown>) =>
  ({
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user: { tenantId: "tenant-1" }, ...req }) }),
  }) as unknown as ExecutionContext;

describe("AddonGuard — the route in its log lines never carries a path-borne token", () => {
  let warnSpy: jest.SpyInstance;
  let guard: AddonGuard;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(["ocr"]) };
    const addonService = { getActiveAddons: jest.fn().mockResolvedValue([]) };
    const entitlements = { isAlwaysEnforcedTenant: jest.fn().mockResolvedValue(false) };
    const featureOverrides = { getMany: jest.fn().mockResolvedValue(new Map()) };
    guard = new AddonGuard(
      reflector as any,
      addonService as any,
      entitlements as any,
      featureOverrides as any,
    );
  });
  afterEach(() => warnSpy.mockRestore());

  it("a dark-key would-deny line carries the template, not the raw URL", async () => {
    await guard.canActivate(
      ctx({
        method: "POST",
        originalUrl: `/api/v1/buyer/invites/${TOKEN}/accept?t=${TOKEN}`,
        route: { path: "/api/v1/buyer/invites/:token/accept" },
      }),
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = String(warnSpy.mock.calls[0][0]);
    expect(line).toContain("route=POST /buyer/invites/:token/accept");
    expect(line).not.toContain(TOKEN);
  });

  it("an unmatched path has its token segment redacted and its uuid kept", async () => {
    await guard.canActivate(
      ctx({ method: "GET", originalUrl: `/api/v1/orders/${UUID}/files/${TOKEN}` }),
    );
    const line = String(warnSpy.mock.calls[0][0]);
    expect(line).toContain(`route=GET /api/v1/orders/${UUID}/files/:redacted`);
    expect(line).not.toContain(TOKEN);
  });

  it("the denial path (override-denied on a dark key) is redacted as well", async () => {
    const overrides = { getMany: jest.fn().mockResolvedValue(new Map([["ocr", "DENY"]])) };
    const denying = new AddonGuard(
      { getAllAndOverride: jest.fn().mockReturnValue(["ocr"]) } as any,
      { getActiveAddons: jest.fn().mockResolvedValue([]) } as any,
      { isAlwaysEnforcedTenant: jest.fn().mockResolvedValue(false) } as any,
      overrides as any,
    );
    await expect(
      denying.canActivate(
        ctx({ method: "POST", originalUrl: `/api/v1/anything/${TOKEN}`, route: undefined }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(warnSpy.mock.calls.length).toBeGreaterThan(0);
    for (const call of warnSpy.mock.calls) expect(String(call[0])).not.toContain(TOKEN);
  });
});
