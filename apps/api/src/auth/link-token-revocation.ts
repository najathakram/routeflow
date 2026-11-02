import type { Prisma } from "@prisma/client";

/**
 * F03 slice 2 (SA-1096): the ONE place an account change burns the account's live one-time links.
 *
 * A reset or verification link outlives the account state it was minted for unless the writer that changes the
 * state burns it too. Every writer that makes a staff user non-active, deletes it, or changes its role or email
 * calls this inside the SAME transaction as the write (`link-token-revocation.pin.spec.ts` is the inventory pin).
 * Rows are marked used, not deleted, so the claim path refuses them with the same answer as a spent link.
 *
 * Not called on a refused link click: a signup admin who is legitimately INACTIVE while waiting to verify must
 * keep their verification token.
 */
type LinkTokenDb = Pick<
  Prisma.TransactionClient,
  "passwordResetToken" | "userEmailVerificationToken"
>;
type BuyerLinkTokenDb = Pick<
  Prisma.TransactionClient,
  "buyerPasswordResetToken" | "buyerEmailVerificationToken"
>;

export async function revokeUserLinkTokens(db: LinkTokenDb, userId: string): Promise<void> {
  const data = { usedAt: new Date() };
  await db.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data });
  await db.userEmailVerificationToken.updateMany({ where: { userId, usedAt: null }, data });
}

export async function revokeBuyerLinkTokens(
  db: BuyerLinkTokenDb,
  buyerAccountId: string,
): Promise<void> {
  const data = { usedAt: new Date() };
  await db.buyerPasswordResetToken.updateMany({ where: { buyerAccountId, usedAt: null }, data });
  await db.buyerEmailVerificationToken.updateMany({
    where: { buyerAccountId, usedAt: null },
    data,
  });
}
