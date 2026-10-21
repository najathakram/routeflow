import { GUARDS_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { AppLinksController } from "./app-links.controller";

describe("GET /app-links", () => {
  it("GET /app-links: guards are JwtAuthGuard + RolesGuard and roles are OPERATOR, DRIVER, CUSTOMER", () => {
    expect(Reflect.getMetadata(PATH_METADATA, AppLinksController)).toBe("app-links");
    expect(Reflect.getMetadata(GUARDS_METADATA, AppLinksController)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, AppLinksController.prototype.get)).toEqual([
      UserRole.OPERATOR,
      UserRole.DRIVER,
      UserRole.CUSTOMER,
    ]);
  });

  it("returns the service's links unchanged", async () => {
    const links = {
      androidApkUrl: "https://example.test/app.apk",
      playStoreUrl: null,
      iosUrl: "https://example.test/ios",
    };
    const platformConfig = { getAppLinks: jest.fn().mockResolvedValue(links) };
    const controller = new AppLinksController(platformConfig as never);
    await expect(controller.get()).resolves.toBe(links);
    expect(platformConfig.getAppLinks).toHaveBeenCalledTimes(1);
  });
});
