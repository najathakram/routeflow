import * as crypto from "crypto";
import type { PrismaService } from "../prisma/prisma.service";

/** How long an emailed verification link stays valid (the same 24h the signed link had). */
export const EMAIL_VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** How many unused, unexpired links one account may hold at once; a new issue burns the older. */
export const EMAIL_VERIFY_LIVE_TOKENS_KEPT = 2;

/** SHA-256 hex of the emailed token: the only form that is ever stored or looked up. */
export function hashEmailVerifyToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * The emailed link. The token rides in the URL FRAGMENT (`#t=`), which a browser never sends to
 * any server and never puts in a referrer.
 */
export function emailVerifyUrl(webBase: string, token: string): string {
  return `${webBase.replace(/\/+$/, "")}/verify-email#t=${token}`;
}

/** A stored token is opaque base64url; a legacy signed link always carries two dots. */
export function looksLikeLegacySignedLink(token: string): boolean {
  return token.split(".").length === 3;
}

/**
 * Issues one verification link for `userId`: 32 random bytes (base64url) go in the email, only
 * their SHA-256 is stored. In the same transaction every unused, unexpired link beyond the newest
 * `EMAIL_VERIFY_LIVE_TOKENS_KEPT` (this one included) is burned, so a mailbox never holds a pile
 * of live links. Uses a plain transaction: the token table has no tenant column.
 */
export async function issueEmailVerificationToken(
  prisma: Pick<PrismaService, "$transaction">,
  userId: string,
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + EMAIL_VERIFY_TOKEN_TTL_MS);
  await prisma.$transaction(async (tx) => {
    const created = await tx.userEmailVerificationToken.create({
      data: { userId, tokenHash: hashEmailVerifyToken(token), expiresAt },
      select: { id: true },
    });
    const others = await tx.userEmailVerificationToken.findMany({
      where: { userId, usedAt: null, expiresAt: { gt: now }, id: { not: created.id } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    const excess = others.slice(EMAIL_VERIFY_LIVE_TOKENS_KEPT - 1).map((r) => r.id);
    if (excess.length > 0) {
      await tx.userEmailVerificationToken.updateMany({
        where: { id: { in: excess }, userId, usedAt: null },
        data: { usedAt: now },
      });
    }
  });
  return { token, expiresAt };
}
