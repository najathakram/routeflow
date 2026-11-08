import { ExecutionContext, RequestMethod } from "@nestjs/common";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { buildGlobalValidationPipe } from "../common/global-validation-pipe";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { SetTenantAiCapDto } from "./dto/set-tenant-ai-cap.dto";
import { PlatformAdminController } from "./platform-admin.controller";

/**
 * AI limits PR-1: `GET` / `PATCH platform-admin/tenants/:id/ai-cap` wiring (review A Low 3). The service rules are in
 * `tenant-ai-cap.spec.ts`; this pins what only the controller decides: super admin only, the body validated by the
 * global pipe before the handler runs, and the DTO's three states (a number, null, an absent key) forwarded to the
 * service unchanged, with the acting admin's id.
 */
const TENANT = "qa-tenant-1";
const ADMIN = { sub: "qa-admin-1" } as never;

function build() {
  const svc = { setTenantAiCap: jest.fn().mockResolvedValue(undefined) };
  const platformConfig = {
    getTenantAiCap: jest.fn().mockResolvedValue({ tenantId: TENANT, effectiveCapUsd: 10 }),
  };
  const controller = new PlatformAdminController(
    svc as never,
    platformConfig as never,
    ...(Array<undefined>(12).fill(undefined) as [
      never,
      never,
      never,
      never,
      never,
      never,
      never,
      never,
      never,
      never,
      never,
      never,
    ]),
  );
  return { controller, svc, platformConfig };
}

const proto = PlatformAdminController.prototype;

describe("PlatformAdminController ai-cap routes", () => {
  it("both routes sit behind the class-level JwtAuthGuard + SuperAdminGuard, with no method-level override", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PlatformAdminController)).toEqual([
      JwtAuthGuard,
      SuperAdminGuard,
    ]);
    for (const handler of [proto.getTenantAiCap, proto.setTenantAiCap]) {
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toBeUndefined();
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe("tenants/:id/ai-cap");
    }
    expect(Reflect.getMetadata(METHOD_METADATA, proto.getTenantAiCap)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(METHOD_METADATA, proto.setTenantAiCap)).toBe(RequestMethod.PATCH);
  });

  it("the guard lets a super admin through and refuses every tenant role and no user", () => {
    const guard = new SuperAdminGuard();
    const ctx = (user: unknown) =>
      ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as unknown as ExecutionContext;
    expect(guard.canActivate(ctx({ role: UserRole.SUPER_ADMIN }))).toBe(true);
    for (const role of [
      UserRole.TENANT_ADMIN,
      UserRole.OPERATOR,
      UserRole.DRIVER,
      UserRole.CUSTOMER,
    ]) {
      expect(guard.canActivate(ctx({ role, tenantId: TENANT }))).toBe(false);
    }
    expect(guard.canActivate(ctx(undefined))).toBe(false);
  });

  describe("the body goes through the global validation pipe first", () => {
    const pipe = buildGlobalValidationPipe();
    const run = (body: unknown) =>
      pipe.transform(body, { type: "body", metatype: SetTenantAiCapDto });

    it("passes a number, 0, null and an empty body through", async () => {
      await expect(run({ aiMonthlyCapUsd: 7 })).resolves.toEqual({ aiMonthlyCapUsd: 7 });
      await expect(run({ aiMonthlyCapUsd: 0 })).resolves.toEqual({ aiMonthlyCapUsd: 0 });
      await expect(run({ aiMonthlyCapUsd: null })).resolves.toEqual({ aiMonthlyCapUsd: null });
      await expect(run({})).resolves.toEqual({});
    });

    it("refuses a negative, a fraction, a string, a boolean, a number past the ceiling and a stray field", async () => {
      for (const body of [
        { aiMonthlyCapUsd: -1 },
        { aiMonthlyCapUsd: 2.5 },
        { aiMonthlyCapUsd: "10" },
        { aiMonthlyCapUsd: true },
        { aiMonthlyCapUsd: 100001 },
        { aiMonthlyCapUsd: 5, tenantId: "other" },
      ]) {
        await expect(run(body)).rejects.toMatchObject({ status: 400 });
      }
    });
  });

  it("PATCH forwards the value unchanged (a number, 0, null, absent) with the acting admin, then returns the read model", async () => {
    for (const [body, forwarded] of [
      [{ aiMonthlyCapUsd: 7 }, 7],
      [{ aiMonthlyCapUsd: 0 }, 0],
      [{ aiMonthlyCapUsd: null }, null],
      [{}, undefined],
    ] as const) {
      const { controller, svc, platformConfig } = build();
      const res = await controller.setTenantAiCap(TENANT, body as SetTenantAiCapDto, ADMIN);
      expect(svc.setTenantAiCap).toHaveBeenCalledTimes(1);
      expect(svc.setTenantAiCap).toHaveBeenCalledWith(TENANT, forwarded, "qa-admin-1");
      expect(platformConfig.getTenantAiCap).toHaveBeenCalledWith(TENANT);
      expect(res).toEqual({ tenantId: TENANT, effectiveCapUsd: 10 });
    }
  });

  it("PATCH writes before it reads, so the response shows the new value", async () => {
    const order: string[] = [];
    const { controller, svc, platformConfig } = build();
    svc.setTenantAiCap.mockImplementation(async () => order.push("write"));
    platformConfig.getTenantAiCap.mockImplementation(async () => order.push("read"));
    await controller.setTenantAiCap(TENANT, { aiMonthlyCapUsd: 3 }, ADMIN);
    expect(order).toEqual(["write", "read"]);
  });

  it("GET reads the business's cap and writes nothing", async () => {
    const { controller, svc, platformConfig } = build();
    await expect(controller.getTenantAiCap(TENANT)).resolves.toEqual({
      tenantId: TENANT,
      effectiveCapUsd: 10,
    });
    expect(platformConfig.getTenantAiCap).toHaveBeenCalledWith(TENANT);
    expect(svc.setTenantAiCap).not.toHaveBeenCalled();
  });
});
