/**
 * Account-link hardening (PR-1): the buyer-merge verification link carries its token in the URL
 * FRAGMENT (`#t=`), never in the path or query, and the API verifies it from a POST body. The old
 * `GET verify-merge/:token` route stays only for links emailed before the change.
 */
import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
import { PATH_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { BuyerMergeController } from "./buyer-merge.controller";
import { BuyerMergeService } from "./buyer-merge.service";

describe("buyer merge verification link", () => {
  const OLD_ENV = process.env.WEB_APP_URL;
  beforeEach(() => {
    process.env.WEB_APP_URL = "https://web.test";
  });
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.WEB_APP_URL;
    else process.env.WEB_APP_URL = OLD_ENV;
  });

  function buildInitiate() {
    const prisma = {
      buyerAccount: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "primary-1", status: "ACTIVE", email: "p@x.test" }),
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: "secondary-1", status: "ACTIVE", email: "s@x.test" }),
      },
      buyerMergeRequest: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: "req-1" }),
        delete: jest.fn(),
      },
    } as any;
    const email = {
      sendMergeVerificationEmail: jest
        .fn()
        .mockResolvedValue({ delivered: true, transport: "smtp" }),
    } as any;
    return { service: new BuyerMergeService(prisma, email, {} as any), prisma, email };
  }

  it("emails a link with the token in the fragment and none in the path or query", async () => {
    const { service, prisma, email } = buildInitiate();
    await service.initiateMerge("primary-1", "s@x.test");

    const storedToken = prisma.buyerMergeRequest.create.mock.calls[0][0].data.verificationToken;
    const { verifyUrl } = email.sendMergeVerificationEmail.mock.calls[0][0];
    expect(verifyUrl).toBe(`https://web.test/buyer/verify-merge#t=${storedToken}`);
    expect(storedToken).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyUrl).not.toContain("?token=");
    expect(new URL(verifyUrl).pathname).toBe("/buyer/verify-merge");
    expect(new URL(verifyUrl).search).toBe("");
  });

  it("verifies from a POST body: the new route takes the token from the body, not the URL", async () => {
    const verifyMergeToken = jest.fn().mockResolvedValue({ success: true });
    const controller = new BuyerMergeController({ verifyMergeToken } as any);
    await controller.verifyMergeByBody({ token: "body-token" });
    expect(verifyMergeToken).toHaveBeenCalledWith("body-token");

    const proto = BuyerMergeController.prototype;
    expect(Reflect.getMetadata(METHOD_METADATA, proto.verifyMergeByBody)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(PATH_METADATA, proto.verifyMergeByBody)).toBe("verify-merge");
  });

  it("keeps the legacy path-token GET route working for links emailed before the change", async () => {
    const verifyMergeToken = jest.fn().mockResolvedValue({ success: true });
    const controller = new BuyerMergeController({ verifyMergeToken } as any);
    await controller.verifyMerge("legacy-token");
    expect(verifyMergeToken).toHaveBeenCalledWith("legacy-token");
    const proto = BuyerMergeController.prototype;
    expect(Reflect.getMetadata(METHOD_METADATA, proto.verifyMerge)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, proto.verifyMerge)).toBe("verify-merge/:token");
  });
});
