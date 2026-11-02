import type { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * F03 slice 2 (SA-1096): the ONE place an account change burns the account's live one-time links.
 *
 * A reset or verification link outlives the account state it was minted for unless the writer that changes the
 * state burns it too. Every writer that makes a staff user or a buyer non-active, deletes it, or changes its role or
 * email calls this inside the SAME transaction as the write (`link-token-revocation.pin.spec.ts` is the inventory pin,
 * `link-revocation-writers.db.spec.ts` drives each writer on a real database). Rows are marked used, not deleted, so
 * the claim path refuses them with the same answer as a spent link.
 *
 * Not called on a refused link click: a signup admin who is legitimately INACTIVE while waiting to verify must
 * keep their verification token.
 *
 * SQL, not the typed client, on purpose. The tenant transaction proxy adds `tenantId` to the `where` of every
 * `updateMany`, and the four token tables have no `tenantId` column, so a typed `updateMany` through a tenant
 * transaction throws `Unknown argument tenantId` and rolls the caller's whole write back. The raw tag is not
 * rewritten by the proxy and runs on whatever client the caller holds (a tenant transaction, a plain one, or the
 * service). Callers pass ids they have already read through a tenant-scoped client; nothing here reaches another
 * account, because the statement is keyed on exactly those ids.
 */
type RawDb = Pick<Prisma.TransactionClient, "$executeRaw"> | Pick<PrismaService, "$executeRaw">;

const idList = (id: string | readonly string[]) => (typeof id === "string" ? [id] : [...id]);

/** Burn the live reset and verification links of one or many staff users. */
export async function revokeUserLinkTokens(
  db: RawDb,
  userId: string | readonly string[],
): Promise<void> {
  const list = idList(userId);
  if (list.length === 0) return;
  await db.$executeRaw`UPDATE "PasswordResetToken" SET "usedAt" = now() WHERE "userId" = ANY(${list}::text[]) AND "usedAt" IS NULL`;
  await db.$executeRaw`UPDATE "UserEmailVerificationToken" SET "usedAt" = now() WHERE "userId" = ANY(${list}::text[]) AND "usedAt" IS NULL`;
}

/** Burn the live reset and verification links of one or many buyer accounts. */
export async function revokeBuyerLinkTokens(
  db: RawDb,
  buyerAccountId: string | readonly string[],
): Promise<void> {
  const list = idList(buyerAccountId);
  if (list.length === 0) return;
  await db.$executeRaw`UPDATE "BuyerPasswordResetToken" SET "usedAt" = now() WHERE "buyerAccountId" = ANY(${list}::text[]) AND "usedAt" IS NULL`;
  await db.$executeRaw`UPDATE "BuyerEmailVerificationToken" SET "usedAt" = now() WHERE "buyerAccountId" = ANY(${list}::text[]) AND "usedAt" IS NULL`;
}
