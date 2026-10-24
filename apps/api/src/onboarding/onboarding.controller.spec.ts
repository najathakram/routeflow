import { GUARDS_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { ONBOARDING_CONFLICT_CODES } from "@routeflow/types";
import * as fs from "fs";
import * as path from "path";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { OnboardingController } from "./onboarding.controller";

describe("OnboardingController (#2159 S1)", () => {
  it("is super-admin only: JwtAuthGuard then SuperAdminGuard on the whole controller", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, OnboardingController)).toEqual([
      JwtAuthGuard,
      SuperAdminGuard,
    ]);
    expect(Reflect.getMetadata(PATH_METADATA, OnboardingController)).toBe("platform-admin");
  });

  it("declares no per-route guard that could loosen the class guards", () => {
    for (const name of Object.getOwnPropertyNames(OnboardingController.prototype)) {
      if (name === "constructor") continue;
      const fn = (OnboardingController.prototype as unknown as Record<string, unknown>)[name];
      expect(Reflect.getMetadata(GUARDS_METADATA, fn as object)).toBeUndefined();
    }
  });

  it("every 409 code the service throws is listed in the shared contract, and vice versa", () => {
    const src = fs.readFileSync(path.join(__dirname, "onboarding.service.ts"), "utf8");
    const thrown = new Set(
      [...src.matchAll(/code: (?:"|API_ERROR_CODES\.)(ONBOARDING_[A-Z_]+)\b/g)].map((m) => m[1]),
    );
    expect([...thrown].sort()).toEqual([...ONBOARDING_CONFLICT_CODES].sort());
  });
});
