import * as crypto from "crypto";
import type { Prisma } from "@prisma/client";
import { LEGACY_INVITE_ACCEPT_UNTIL } from "../auth/legacy-link-windows";

/**
 * The ONE place that reads or writes the invite-token columns of a customer link.
 *
 * A new invite stores only `inviteTokenHash` (SHA-256 hex of the emailed token). The older
 * plaintext `inviteToken` column is honoured only for invites issued before the switch, and only
 * until `LEGACY_INVITE_ACCEPT_UNTIL`. The inventory spec (`invite-token-reads.inventory.spec.ts`)
 * fails the build if any other production file touches the plaintext column.
 *
 * The hash is a plain SHA-256 over 32 random bytes and is looked up through a unique index, so no
 * constant-time comparison is needed.
 */

/** SHA-256 hex of an invite token: what is stored, and what a lookup is keyed on. */
export function hashInviteToken(plain: string): string {
  return crypto.createHash("sha256").update(plain).digest("hex");
}

/** A fresh invite token (64 hex chars, 256 bits). */
export function newInviteToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** True while an invite stored as plaintext (issued before hashing) is still accepted. */
export function legacyInviteAccepted(now: Date): boolean {
  return now.getTime() < LEGACY_INVITE_ACCEPT_UNTIL.getTime();
}

/** The columns to write when issuing a token: the hash is stored, the plaintext column is emptied. */
export function issueInviteData(plain: string): { inviteToken: null; inviteTokenHash: string } {
  return { inviteToken: null, inviteTokenHash: hashInviteToken(plain) };
}

/** Merge into any link write that consumes or revokes an invite: nulls BOTH token columns. */
export function clearInvite<T extends object>(
  data?: T,
): T & { inviteToken: null; inviteTokenHash: null } {
  return { ...(data as T), inviteToken: null, inviteTokenHash: null };
}

/** The `where` that matches a link by the presented token (hash, else legacy plaintext in window). */
export function inviteTokenWhere(plain: string, now: Date): Prisma.CustomerLinkWhereInput {
  return legacyInviteAccepted(now)
    ? { OR: [{ inviteTokenHash: hashInviteToken(plain) }, { inviteToken: plain }] }
    : { inviteTokenHash: hashInviteToken(plain) };
}

type LinkReader = Pick<Prisma.TransactionClient, "customerLink">;

/**
 * Look up the link a token belongs to: by hash first, else (inside the legacy window only) by the
 * plaintext column. A link whose customer was removed is never returned, so it reads as "not
 * found" like a consumed token (a removed customer cannot be reconnected). Status and expiry are
 * the caller's to judge, because each caller answers them differently.
 */
export async function findLiveInvite<
  A extends Pick<Prisma.CustomerLinkFindFirstArgs, "include" | "select"> = Record<string, never>,
>(
  db: LinkReader,
  plainToken: string,
  now: Date,
  args?: A,
): Promise<Prisma.CustomerLinkGetPayload<A> | null> {
  const common = { ...(args ?? {}) } as Prisma.CustomerLinkFindFirstArgs;
  const byHash = await db.customerLink.findFirst({
    ...common,
    where: { inviteTokenHash: hashInviteToken(plainToken), customer: { deletedAt: null } },
  });
  if (byHash) return byHash as Prisma.CustomerLinkGetPayload<A>;
  if (!legacyInviteAccepted(now)) return null;
  const legacy = await db.customerLink.findFirst({
    ...common,
    where: { inviteToken: plainToken, customer: { deletedAt: null } },
  });
  return (legacy as Prisma.CustomerLinkGetPayload<A> | null) ?? null;
}

/**
 * The conditional-update `where` that consumes an invite: the link by id, still carrying the
 * presented token, still redeemable (INVITED, or a buyer-initiated request that kept the token),
 * customer not removed, not expired. Every accept path (web and Google) claims with this, and
 * requires `count === 1`, so a concurrent accept of the same link has exactly one winner.
 */
export function inviteClaimWhere(
  linkId: string,
  plain: string,
  now: Date,
): Prisma.CustomerLinkWhereInput {
  return {
    id: linkId,
    status: { in: ["INVITED", "PENDING_SELLER_APPROVAL"] },
    customer: { deletedAt: null },
    AND: [
      inviteTokenWhere(plain, now),
      { OR: [{ inviteExpiresAt: null }, { inviteExpiresAt: { gt: now } }] },
    ],
  };
}

/**
 * Does this link hold an invite that could still be redeemed? Either column counts (the plaintext
 * one only inside the legacy window), and an expired invite does not.
 */
export function hasLiveInviteToken(
  link: {
    inviteToken?: string | null;
    inviteTokenHash?: string | null;
    inviteExpiresAt?: Date | null;
  },
  now: Date,
): boolean {
  const holdsToken = !!link.inviteTokenHash || (!!link.inviteToken && legacyInviteAccepted(now));
  return holdsToken && (!link.inviteExpiresAt || link.inviteExpiresAt > now);
}

/** A link row with the token columns removed, for any response that echoes a whole link. */
export function withoutInviteSecrets<T extends object>(
  link: T,
): Omit<T, "inviteToken" | "inviteTokenHash"> {
  const {
    inviteToken: _plain,
    inviteTokenHash: _hash,
    ...rest
  } = link as T & {
    inviteToken?: unknown;
    inviteTokenHash?: unknown;
  };
  return rest;
}
