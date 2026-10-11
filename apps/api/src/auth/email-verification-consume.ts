import { BadRequestException } from "@nestjs/common";
import type { User } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import { hashEmailVerifyToken } from "./email-verification-token";

/** The one refusal for every dead verification link: unknown, used, expired, or not eligible. */
export const VERIFY_LINK_DEAD_MESSAGE =
  "Verification link is invalid or has expired. Please sign up again or request a new link.";

export const deadVerifyLink = () => new BadRequestException(VERIFY_LINK_DEAD_MESSAGE);

/**
 * Consumes a stored single-use verification token and activates its owner.
 *
 * The first statement in the transaction claims the token (`usedAt` null and unexpired ->
 * stamped): of any number of concurrent uses exactly one sees count 1. Only then is the account
 * activated, by a conditional update that is the whole eligibility test: a signup admin that is
 * INACTIVE, has never signed in, has no verified timestamp, is not deleted and holds no session
 * row. A count other than 1 throws, which rolls the claim back. There is NO creation-date check
 * here: the cut-off applies only when a link is issued. On success the account's other links are
 * burned in the same transaction and the activation is audited.
 *
 * Returns the activated user row for the caller to sign in.
 */
export async function consumeEmailVerificationToken(
  prisma: PrismaService,
  token: string,
  now: Date,
): Promise<User> {
  if (typeof token !== "string" || token.length === 0 || token.length > 512) {
    throw deadVerifyLink();
  }
  const tokenHash = hashEmailVerifyToken(token);

  // Cheap early exit that also yields the owner; the claim below is what decides.
  const record = await prisma.userEmailVerificationToken.findUnique({ where: { tokenHash } });
  if (!record || record.usedAt || record.expiresAt <= now) throw deadVerifyLink();
  const user = await prisma.user.findUnique({ where: { id: record.userId } });
  if (!user || user.deletedAt) throw deadVerifyLink();

  await prisma.tenantTransaction(async (tx) => {
    const claim = await tx.userEmailVerificationToken.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claim.count !== 1) throw deadVerifyLink();

    const activated = await tx.user.updateMany({
      where: {
        id: user.id,
        status: "INACTIVE",
        role: "TENANT_ADMIN",
        lastLoginAt: null,
        emailVerifiedAt: null,
        deletedAt: null,
        refreshTokens: { none: {} },
      },
      data: { status: "ACTIVE", emailVerifiedAt: now },
    });
    if (activated.count !== 1) throw deadVerifyLink();

    await tx.userEmailVerificationToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: now },
    });
    await tx.auditLog.create({
      data: {
        tenantId: user.tenantId ?? null,
        userId: user.id,
        action: "user.activate",
        entityType: "User",
        entityId: user.id,
        meta: { reason: "email_verify" },
      },
    });
  });

  return { ...user, status: "ACTIVE", emailVerifiedAt: now };
}
