import { GUARDS_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { ONBOARDING_SIGN_OFF_STEP_KEY, TENANT_ONBOARDING_CONFLICT_CODES } from "@routeflow/types";
import * as fs from "fs";
import * as path from "path";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { OnboardingTenantController } from "./onboarding-tenant.controller";
import { OnboardingTenantService } from "./onboarding-tenant.service";
import { SIGN_OFF_STEP_KEY, catalogStep } from "./onboarding-catalog";

describe("tenant onboarding (#2159 S4)", () => {
  it("the controller is /onboarding/me behind JwtAuthGuard + RolesGuard", () => {
    expect(Reflect.getMetadata(PATH_METADATA, OnboardingTenantController)).toBe("onboarding/me");
    expect(Reflect.getMetadata(GUARDS_METADATA, OnboardingTenantController)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
  });

  it("GET is for staff (OPERATOR+); sign-off is TENANT_ADMIN only", () => {
    const proto = OnboardingTenantController.prototype;
    expect(Reflect.getMetadata(ROLES_KEY, proto.get)).toEqual([UserRole.OPERATOR]);
    expect(Reflect.getMetadata(ROLES_KEY, proto.signOff)).toEqual([UserRole.TENANT_ADMIN]);
  });

  it("the sign-off key is one shared constant, and a required CUSTOMER step in VERIFY_TRAIN", () => {
    expect(SIGN_OFF_STEP_KEY).toBe(ONBOARDING_SIGN_OFF_STEP_KEY);
    expect(catalogStep(SIGN_OFF_STEP_KEY)).toMatchObject({
      stage: "VERIFY_TRAIN",
      owner: "CUSTOMER",
      required: true,
    });
  });

  it("every 409 code the tenant service throws is in the shared contract, and vice versa", () => {
    const src = fs.readFileSync(path.join(__dirname, "onboarding-tenant.service.ts"), "utf8");
    const thrown = new Set(
      [...src.matchAll(/code: (?:"|API_ERROR_CODES\.)(ONBOARDING_[A-Z_]+)\b/g)].map((m) => m[1]),
    );
    expect([...thrown].sort()).toEqual([...TENANT_ONBOARDING_CONFLICT_CODES].sort());
  });

  describe("sign-off refusals that must happen before any DB access", () => {
    const prisma = { $transaction: jest.fn(), onboardingCase: { findUnique: jest.fn() } };
    const svc = new OnboardingTenantService(prisma as never, { log: jest.fn() } as never);
    const base = { userId: "u1", tenantId: "t1", ip: null, userAgent: null };
    beforeEach(() => jest.clearAllMocks());

    it("an impersonation token is refused (403)", async () => {
      await expect(
        svc.signOff({ ...base, impersonatedBy: "sa-1" }, "Pat Example"),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it.each(["", "   ", "P", "x".repeat(121)])(
      "a bad typed name %p is refused (400)",
      async (n) => {
        await expect(svc.signOff(base, n)).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );
  });

  it("a tenant-less caller (SUPER_ADMIN) is refused rather than reaching the service", () => {
    const svc = { getForTenant: jest.fn(), signOff: jest.fn() };
    const ctrl = new OnboardingTenantController(svc as never);
    expect(() => ctrl.get({ id: "sa", tenantId: null })).toThrow(ForbiddenException);
    expect(svc.getForTenant).not.toHaveBeenCalled();
  });
});
