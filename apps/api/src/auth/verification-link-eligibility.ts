/**
 * Who may use an emailed verification link to be activated and signed in.
 *
 * Only a signup admin that has never signed in AND still holds a live sign-up link. Every other account (already
 * active, any other role, signed in before, holding a session row, created before the sign-in timestamp was
 * recorded, or whose links were all burned) is refused and must sign in the normal way.
 *
 * B448: status alone cannot tell "never verified" from "deactivated by another admin" (both are INACTIVE). The live
 * link row is the discriminator: registration writes one (`issueSignupLink`), a resend rotates it, a use consumes it,
 * and every deactivation, email change or role change burns it in the same transaction (`revokeUserLinkTokens`,
 * SA-1096). So a deactivated admin has no live row and can neither use an old link nor get a new one.
 */
import * as crypto from "crypto";
import type { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";

/** Earliest creation date for which the sign-in timestamp (`User.lastLoginAt`) is reliable. */
export const SIGN_IN_TIMESTAMP_RELIABLE_FROM = new Date("2026-09-29T00:00:00.000Z");

/**
 * B448 legacy window: an account created before this instant may have registered before sign-up links were written
 * to `UserEmailVerificationToken`. Such an account, with no link row ever written, is treated as pending only while it
 * is the sole account of its business (nobody else exists who could have deactivated it). Accounts created from this
 * instant on are judged by their link rows alone. STOP RULE: must sit after the deploy that ships `issueSignupLink`;
 * if that deploy is not live a week before this date, move the date in the same window (a sign-up registered after the
 * date but before the deploy has no row and would be refused).
 * remove the legacy branch once a census reads zero row-less pending sign-ups, added 2026-11-09
 */
export const SIGNUP_LINK_ROWS_FROM = new Date("2027-01-15T00:00:00.000Z");

/** How long a sign-up link lives; the JWT and its row carry the same life. */
export const SIGNUP_LINK_TTL_MS = 24 * 60 * 60 * 1000;

/** Coded 400 payload for a refused link. Same copy for every refused class. */
export const VERIFICATION_REFUSED = {
  statusCode: 400,
  code: "ALREADY_VERIFIED",
  message: "Already verified — please sign in",
  error: "Bad Request",
} as const;

export interface VerificationCandidate {
  id: string;
  role: string;
  status: string;
  lastLoginAt: Date | null;
  createdAt: Date;
  tenantId: string | null;
}

export interface VerificationDb {
  refreshToken: { count(args: { where: { userId: string } }): Promise<number> };
  userEmailVerificationToken: {
    count(args: { where: { userId: string; usedAt?: null } }): Promise<number>;
  };
  user: { count(args: { where: { tenantId: string; deletedAt: null } }): Promise<number> };
}

/** `live`: holds an unused link row. `legacy`: pre-row sign-up, sole account of its business. `none`: refused. */
export type SignupLinkState = "live" | "legacy" | "none";

export function hashSignupLinkId(jti: string): string {
  return crypto.createHash("sha256").update(jti).digest("hex");
}

export async function signupLinkState(
  db: VerificationDb,
  user: VerificationCandidate,
): Promise<SignupLinkState> {
  const live = await db.userEmailVerificationToken.count({
    where: { userId: user.id, usedAt: null },
  });
  if (live > 0) return "live";
  // A row that exists but is used means the link was consumed, rotated, or burned by a deactivation.
  const ever = await db.userEmailVerificationToken.count({ where: { userId: user.id } });
  if (ever > 0) return "none";
  if (!user.tenantId || !(user.createdAt instanceof Date)) return "none";
  if (user.createdAt >= SIGNUP_LINK_ROWS_FROM) return "none";
  const accounts = await db.user.count({ where: { tenantId: user.tenantId, deletedAt: null } });
  return accounts === 1 ? "legacy" : "none";
}

/** The account-class test plus the link state; `none` for every refused case. */
export async function verificationLinkState(
  db: VerificationDb,
  user: VerificationCandidate,
): Promise<SignupLinkState> {
  if (user.status !== "INACTIVE") return "none";
  if (user.role !== "TENANT_ADMIN") return "none";
  if (user.lastLoginAt) return "none";
  if (!(user.createdAt instanceof Date) || user.createdAt < SIGN_IN_TIMESTAMP_RELIABLE_FROM) {
    return "none";
  }
  if ((await db.refreshToken.count({ where: { userId: user.id } })) !== 0) return "none";
  return signupLinkState(db, user);
}

export async function mayUseVerificationLink(
  db: VerificationDb,
  user: VerificationCandidate,
): Promise<boolean> {
  return (await verificationLinkState(db, user)) !== "none";
}

/**
 * SQL, not the typed client, for the same reason as `link-token-revocation.ts`: the tenant transaction proxy adds
 * `tenantId` to typed writes and the token table has no such column. The raw tag runs on whatever client the caller
 * holds (a tenant transaction, a plain one, or the service).
 */
type RawDb = Pick<Prisma.TransactionClient, "$executeRaw"> | Pick<PrismaService, "$executeRaw">;

/**
 * Write a fresh sign-up link row for the user, burning any live one first (a resend makes earlier links dead).
 * Returns the link id (`jti`) the JWT must carry; only its hash is stored.
 */
export async function issueSignupLink(
  tx: RawDb,
  userId: string,
  now: Date = new Date(),
): Promise<string> {
  await tx.$executeRaw`UPDATE "UserEmailVerificationToken" SET "usedAt" = ${now} WHERE "userId" = ${userId} AND "usedAt" IS NULL`;
  const jti = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + SIGNUP_LINK_TTL_MS);
  await tx.$executeRaw`INSERT INTO "UserEmailVerificationToken" ("id", "userId", "tokenHash", "expiresAt", "createdAt") VALUES (${crypto.randomUUID()}, ${userId}, ${hashSignupLinkId(jti)}, ${expiresAt}, ${now})`;
  return jti;
}

/** Consume the live, unexpired row the link names. True only for the one caller that wins it. */
export async function claimSignupLink(
  tx: RawDb,
  userId: string,
  jti: string,
  now: Date = new Date(),
): Promise<boolean> {
  const count =
    await tx.$executeRaw`UPDATE "UserEmailVerificationToken" SET "usedAt" = ${now} WHERE "userId" = ${userId} AND "tokenHash" = ${hashSignupLinkId(jti)} AND "usedAt" IS NULL AND "expiresAt" > ${now}`;
  return count === 1;
}
