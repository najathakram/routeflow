import * as crypto from "crypto";
import type { PrismaService } from "../prisma/prisma.service";

/** How long a staff invite / admin-reset / welcome set-password link stays valid (NOTIFY-SPEC N2). */
export const SET_PASSWORD_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;

/**
 * Issues a single-use, 72h set-password link for `userId` — the same PasswordResetToken model
 * and consuming endpoint (POST /auth/reset-password) as self-service reset. Any still-live
 * unused token for the user is deleted first, so only the newest link works. Only the SHA-256
 * of the token is stored.
 *
 * Shared by UsersService (staff invite / admin reset) and PlatformAdminService.createTenant
 * (#2439: the welcome email carries this link instead of a password).
 */
export async function issueSetPasswordLink(
  prisma: Pick<PrismaService, "passwordResetToken">,
  userId: string,
  webBaseUrl: string,
): Promise<{ url: string; expiresAt: Date; expiryHours: number }> {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + SET_PASSWORD_TOKEN_TTL_MS);
  await prisma.passwordResetToken.deleteMany({
    where: { userId, usedAt: null, expiresAt: { gt: new Date() } },
  });
  await prisma.passwordResetToken.create({ data: { userId, tokenHash, expiresAt } });
  return {
    url: `${webBaseUrl.replace(/\/+$/, "")}/reset-password?token=${rawToken}`,
    expiresAt,
    expiryHours: SET_PASSWORD_TOKEN_TTL_MS / (60 * 60 * 1000),
  };
}
