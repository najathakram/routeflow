import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { BadRequestException, RequestMethod } from "@nestjs/common";
import { PlatformAdminController } from "./platform-admin.controller";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { AdminAuditAction } from "./audit-actions.constant";
import { API_ERROR_CODES } from "../common/api-error-codes";

const PREV = { androidApkUrl: "https://example.test/old.apk", playStoreUrl: null, iosUrl: null };
const NEXT = { androidApkUrl: "https://example.test/app.apk", playStoreUrl: null, iosUrl: null };

function build() {
  const svc = { recordAdminAction: jest.fn().mockResolvedValue(undefined) };
  const platformConfig = {
    getAppLinks: jest.fn().mockResolvedValueOnce(PREV).mockResolvedValue(NEXT),
    setAppLinks: jest.fn().mockResolvedValue(NEXT),
  };
  const controller = new PlatformAdminController(
    svc as never,
    platformConfig as never,
    ...(Array<undefined>(11).fill(undefined) as [
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

describe("PlatformAdminController — app links", () => {
  it("GET/PUT app-links sit behind SuperAdminGuard and PUT writes APP_LINKS_UPDATED with previous and next", async () => {
    // Class-level guards cover both routes.
    expect(Reflect.getMetadata(GUARDS_METADATA, PlatformAdminController)).toEqual([
      JwtAuthGuard,
      SuperAdminGuard,
    ]);
    const proto = PlatformAdminController.prototype;
    expect(Reflect.getMetadata(PATH_METADATA, proto.getAppLinks)).toBe("app-links");
    expect(Reflect.getMetadata(METHOD_METADATA, proto.getAppLinks)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, proto.updateAppLinks)).toBe("app-links");
    expect(Reflect.getMetadata(METHOD_METADATA, proto.updateAppLinks)).toBe(RequestMethod.PUT);

    const { controller, svc, platformConfig } = build();
    const patch = { androidApkUrl: "https://example.test/app.apk" };
    const res = await controller.updateAppLinks(patch, { sub: "admin-1" } as never);

    expect(platformConfig.setAppLinks).toHaveBeenCalledWith(patch);
    expect(res).toEqual(NEXT);
    expect(svc.recordAdminAction).toHaveBeenCalledTimes(1);
    expect(svc.recordAdminAction).toHaveBeenCalledWith(
      null,
      "admin-1",
      AdminAuditAction.APP_LINKS_UPDATED,
      { previous: PREV, next: NEXT },
    );
  });

  it("GET returns the stored links", async () => {
    const { controller, platformConfig } = build();
    platformConfig.getAppLinks.mockReset().mockResolvedValue(NEXT);
    await expect(controller.getAppLinks()).resolves.toEqual(NEXT);
  });

  it("a rejected PUT (APP_LINK_URL_INVALID) writes no audit row", async () => {
    const { controller, svc, platformConfig } = build();
    platformConfig.setAppLinks.mockRejectedValueOnce(
      new BadRequestException({ code: API_ERROR_CODES.APP_LINK_URL_INVALID }),
    );
    await expect(
      controller.updateAppLinks({ iosUrl: "http://example.test" }, { sub: "admin-1" } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(svc.recordAdminAction).not.toHaveBeenCalled();
  });
});
