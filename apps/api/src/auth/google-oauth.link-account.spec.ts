import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { GoogleOAuthService } from "./google-oauth.service";

/**
 * SA-599b (b): linkGoogleAccount writes through the shared oauth-account-link CAS, mirroring
 * AppleOAuthService.linkAppleAccount — tenant-scoped, 409 on a lost race to a different sub,
 * and the notification email only when THIS call performed the link.
 */
describe("GoogleOAuthService.linkGoogleAccount — SA-599b shared CAS", () => {
  const USER = {
    id: "user-1",
    tenantId: "tenant-1",
    email: "op@acme.example",
    googleId: null as string | null,
    deletedAt: null,
  };
  const profile = (over: Record<string, unknown> = {}) =>
    ({
      linkUserId: "user-1",
      googleId: "google-sub-1",
      email: "op@acme.example",
      type: "tenant",
      ...over,
    }) as any;

  function build() {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ ...USER }),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    } as any;
    const emailService = { send: jest.fn().mockResolvedValue({ delivered: true }) };
    const config = {
      get: (k: string) =>
        k === "jwt"
          ? { secret: "s", refreshSecret: "r", expiresIn: "15m", refreshExpiresIn: "30d" }
          : undefined,
    } as unknown as ConfigService;
    const service = new GoogleOAuthService(
      prisma,
      { sign: jest.fn(), decode: jest.fn() } as unknown as JwtService,
      config,
      emailService as any,
      { claimsFor: jest.fn().mockResolvedValue(null) } as any,
    );
    return { service, prisma, emailService };
  }

  it("links by CAS scoped to id + tenantId + googleId:null, never a bare update", async () => {
    const { service, prisma } = build();
    await service.linkGoogleAccount(profile());
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: "user-1", tenantId: "tenant-1", googleId: null },
      data: { googleId: "google-sub-1", forcePasswordChange: false },
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("a win sends the linked email exactly once", async () => {
    const { service, emailService } = build();
    await service.linkGoogleAccount(profile());
    expect(emailService.send).toHaveBeenCalledTimes(1);
  });

  it("a lost race to a DIFFERENT sub is a 409 google_account_mismatch and sends NO email", async () => {
    const { service, prisma, emailService } = build();
    prisma.user.updateMany.mockResolvedValue({ count: 0 });
    prisma.user.findUnique
      .mockResolvedValueOnce({ ...USER })
      .mockResolvedValueOnce({ ...USER, googleId: "google-sub-other" });
    const err = await service.linkGoogleAccount(profile()).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe("google_account_mismatch");
    expect(emailService.send).not.toHaveBeenCalled();
  });

  it("a lost race to the SAME sub resolves with no email", async () => {
    const { service, prisma, emailService } = build();
    prisma.user.updateMany.mockResolvedValue({ count: 0 });
    prisma.user.findUnique
      .mockResolvedValueOnce({ ...USER })
      .mockResolvedValueOnce({ ...USER, googleId: "google-sub-1" });
    await expect(service.linkGoogleAccount(profile())).resolves.toBeUndefined();
    expect(emailService.send).not.toHaveBeenCalled();
  });

  it("a falsy sub refuses before any write", async () => {
    const { service, prisma, emailService } = build();
    await expect(service.linkGoogleAccount(profile({ googleId: "" }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(emailService.send).not.toHaveBeenCalled();
  });

  it("keeps the pre-checks: already-linked and id-taken", async () => {
    const a = build();
    a.prisma.user.findUnique.mockResolvedValue({ ...USER, googleId: "x" });
    await expect(a.service.linkGoogleAccount(profile())).rejects.toThrow("google_already_linked");
    const b = build();
    b.prisma.user.findFirst.mockResolvedValue({ id: "other" });
    await expect(b.service.linkGoogleAccount(profile())).rejects.toThrow("google_id_taken");
    expect(a.prisma.user.updateMany).not.toHaveBeenCalled();
    expect(b.prisma.user.updateMany).not.toHaveBeenCalled();
  });
});
