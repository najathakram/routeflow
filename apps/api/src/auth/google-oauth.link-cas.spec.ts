/**
 * Follow-up on #2910 (lead list): `linkGoogleAccount` was check-then-update — read the user with
 * `googleId: null`, then an unconditional `update`. Two concurrent link requests (the rightful
 * user and an attacker's Google sub) could both pass the read and the loser would overwrite the
 * winner. It now links by compare-and-set (`oauth-account-link.ts`, shared with sign-in): only the
 * first writer succeeds; a lost race to a different sub is refused, to the same sub a no-op.
 */
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { ForbiddenException } from "@nestjs/common";
import { GoogleOAuthService } from "./google-oauth.service";

jest.mock("google-auth-library", () => ({ OAuth2Client: jest.fn() }));

const USER = {
  id: "user-1",
  email: "alice@example.com",
  tenantId: "tenant-1",
  googleId: null as string | null,
  deletedAt: null as Date | null,
};
const PROFILE = { linkUserId: "user-1", googleId: "google-1", email: "alice@example.com" } as any;

function build() {
  const config = {
    get: (key: string) =>
      key === "jwt" ? { secret: "test-jwt-secret-for-oauth-state-0123456789" } : undefined,
  } as unknown as ConfigService;
  const emailService = { send: jest.fn().mockResolvedValue({ delivered: true }) };
  const prisma = {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  } as any;
  const service = new GoogleOAuthService(
    prisma,
    {} as unknown as JwtService,
    config,
    emailService as any,
    { claimsFor: jest.fn().mockResolvedValue(null) } as any,
  );
  return { service, prisma, emailService };
}

describe("GoogleOAuthService.linkGoogleAccount — compare-and-set link", () => {
  it("links with a CAS scoped to the null googleId and the user's tenant (never a bare update)", async () => {
    const { service, prisma, emailService } = build();
    prisma.user.findUnique.mockResolvedValueOnce({ ...USER });

    await service.linkGoogleAccount(PROFILE);
    await Promise.resolve();

    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: "user-1", tenantId: "tenant-1", googleId: null },
      data: { googleId: "google-1", forcePasswordChange: false },
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(emailService.send).toHaveBeenCalledTimes(1);
  });

  it("a lost race to a DIFFERENT Google sub is refused (google_already_linked) with no email", async () => {
    const { service, prisma, emailService } = build();
    prisma.user.findUnique
      .mockResolvedValueOnce({ ...USER })
      .mockResolvedValueOnce({ ...USER, googleId: "attacker-sub" });
    prisma.user.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.linkGoogleAccount(PROFILE)).rejects.toThrow(
      new ForbiddenException("google_already_linked"),
    );
    await Promise.resolve();
    expect(emailService.send).not.toHaveBeenCalled();
  });

  it("a lost race to the SAME sub is a harmless duplicate: resolves, no second email", async () => {
    const { service, prisma, emailService } = build();
    prisma.user.findUnique
      .mockResolvedValueOnce({ ...USER })
      .mockResolvedValueOnce({ ...USER, googleId: "google-1" });
    prisma.user.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.linkGoogleAccount(PROFILE)).resolves.toBeUndefined();
    await Promise.resolve();
    expect(emailService.send).not.toHaveBeenCalled();
  });

  it("the read-time guards are unchanged: already linked, and a Google id taken in the tenant", async () => {
    const a = build();
    a.prisma.user.findUnique.mockResolvedValueOnce({ ...USER, googleId: "other" });
    await expect(a.service.linkGoogleAccount(PROFILE)).rejects.toThrow(
      new ForbiddenException("google_already_linked"),
    );
    expect(a.prisma.user.updateMany).not.toHaveBeenCalled();

    const b = build();
    b.prisma.user.findUnique.mockResolvedValueOnce({ ...USER });
    b.prisma.user.findFirst.mockResolvedValueOnce({ id: "user-2" });
    await expect(b.service.linkGoogleAccount(PROFILE)).rejects.toThrow(
      new ForbiddenException("google_id_taken"),
    );
    expect(b.prisma.user.updateMany).not.toHaveBeenCalled();
  });
});
