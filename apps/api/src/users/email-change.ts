/**
 * B461 (SA-1116): a signed-in user's login email is not written until the NEW address confirms.
 *
 * The pending address is a `UserEmailChange` row, never a `UserEmailVerificationToken` row: since B448 an unused
 * verification row means "a live sign-up link" (`verification-link-eligibility.ts`), so a row of another purpose
 * there would let a deactivated admin back in. Only the sha256 of the link token is stored.
 *
 * SQL, not the typed client, on purpose (the SA-1096 trap, see `link-token-revocation.ts`): the table has no
 * `tenantId`, and the tenant transaction proxy adds `tenantId` to typed writes. The raw tag runs on whatever client
 * the caller holds. The caller passes ids it has already read through a tenant-scoped client.
 */
import * as crypto from "crypto";
import type { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import { hasNeverSignedIn, type VerificationDb } from "../auth/verification-link-eligibility";

/** How long an email-change link lives. The same window as the sign-up link (`SIGNUP_LINK_TTL_MS`). */
export const EMAIL_CHANGE_LINK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The ONE rule for whether an email edit waits for proof: anything but "never signed in" holds. Only a user who has
 * never signed in (`hasNeverSignedIn`, the same rule as the sign-up link: no `lastLoginAt`, created after the stamp
 * was reliable, no refresh-token row) is written at once, as before: the set-password invite sent to the corrected
 * address is the proof. A missing user, an unknown `lastLoginAt` or `createdAt` fails closed and holds.
 * `forcePasswordChange` is NOT the test: an admin password reset sets it on accounts that have signed in.
 */
export async function emailChangeNeedsHold(
  db: Pick<VerificationDb, "refreshToken">,
  user: { id: string; lastLoginAt?: Date | null; createdAt?: Date | null } | null | undefined,
): Promise<boolean> {
  if (!user) return true;
  return !(await hasNeverSignedIn(db, user));
}

/** `jane@example.com` -> `j***@e***.com`: names the mailbox without giving it away to the old address's owner. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 1) return "***";
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${local[0]}***@${host[0] ?? ""}***${tld}`;
}

export function hashEmailChangeToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

type RawDb = Pick<Prisma.TransactionClient, "$executeRaw"> | Pick<PrismaService, "$executeRaw">;

/**
 * Burn the user's live change rows (a newer request supersedes an older one), then write the new row. Returns the raw
 * link token for the mail; only its hash is stored. Call it inside the transaction that decides the edit.
 */
export async function issueEmailChange(
  tx: RawDb,
  change: { userId: string; fromEmail: string; toEmail: string; requestedByUserId: string },
  now: Date = new Date(),
): Promise<string> {
  await tx.$executeRaw`UPDATE "UserEmailChange" SET "usedAt" = ${now} WHERE "userId" = ${change.userId} AND "usedAt" IS NULL`;
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + EMAIL_CHANGE_LINK_TTL_MS);
  await tx.$executeRaw`INSERT INTO "UserEmailChange" ("id", "userId", "fromEmail", "toEmail", "tokenHash", "requestedByUserId", "expiresAt", "createdAt") VALUES (${crypto.randomUUID()}, ${change.userId}, ${change.fromEmail}, ${change.toEmail}, ${hashEmailChangeToken(token)}, ${change.requestedByUserId}, ${expiresAt}, ${now})`;
  return token;
}
