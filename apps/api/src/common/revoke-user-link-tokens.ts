/**
 * Burns an account's outstanding single-use links (set-password / password-reset and the buyer
 * email-verification link) so they stop working the moment the account's standing changes.
 *
 * Every writer of a non-ACTIVE status, a deletion, a role change or an email change calls this in
 * the SAME transaction as that write (guarded by `link-token-revocation.inventory.spec.ts`).
 * Reactivation does not restore a burned link: a fresh one has to be issued.
 *
 * Two entry points, one per account kind:
 *  - `revokeUserLinkTokens(tx, userId)`        staff / customer `User` rows (PasswordResetToken)
 *  - `revokeBuyerLinkTokens(tx, buyerAccountId)` portal `BuyerAccount` rows (both buyer twins)
 *
 * Both run on the caller's client (`tx`), mark rows used instead of deleting them (the rows stay
 * as evidence and a replayed link still resolves to "already used"), only touch rows that are
 * unused and unexpired, are idempotent, and return how many links they burned.
 *
 * WHY RAW SQL: callers hold either a plain `$transaction` client or a `tenantTransaction` proxy,
 * which stamps `tenantId` into every model `where`. These token tables carry no `tenantId`, so a
 * model delegate would be rejected under the proxy. `$executeRaw` passes through the proxy
 * unchanged, and the statement is keyed on the owning account id alone, so it can never reach
 * another account's rows. The parity pins in `revoke-user-link-tokens.spec.ts` keep the table and
 * column names honest against the Prisma schema.
 */

/** The only thing the helper needs from a Prisma client / transaction client. */
export interface LinkTokenExecutor {
  $executeRaw(query: TemplateStringsArray, ...values: any[]): PromiseLike<number>;
}

/** An id that reached a statement must be a real id: an empty one would burn nothing, or worse. */
function requireId(label: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

/** Burns every unused, unexpired set-password / reset link of one User. */
export async function revokeUserLinkTokens(tx: LinkTokenExecutor, userId: string): Promise<number> {
  const id = requireId("userId", userId);
  const burned = await tx.$executeRaw`
    UPDATE "PasswordResetToken"
    SET "usedAt" = (NOW() AT TIME ZONE 'UTC')
    WHERE "userId" = ${id}
      AND "usedAt" IS NULL
      AND "expiresAt" > (NOW() AT TIME ZONE 'UTC')`;
  return Number(burned ?? 0);
}

/** Burns every unused, unexpired reset and email-verification link of one BuyerAccount. */
export async function revokeBuyerLinkTokens(
  tx: LinkTokenExecutor,
  buyerAccountId: string,
): Promise<number> {
  const id = requireId("buyerAccountId", buyerAccountId);
  const reset = await tx.$executeRaw`
    UPDATE "BuyerPasswordResetToken"
    SET "usedAt" = (NOW() AT TIME ZONE 'UTC')
    WHERE "buyerAccountId" = ${id}
      AND "usedAt" IS NULL
      AND "expiresAt" > (NOW() AT TIME ZONE 'UTC')`;
  const verification = await tx.$executeRaw`
    UPDATE "BuyerEmailVerificationToken"
    SET "usedAt" = (NOW() AT TIME ZONE 'UTC')
    WHERE "buyerAccountId" = ${id}
      AND "usedAt" IS NULL
      AND "expiresAt" > (NOW() AT TIME ZONE 'UTC')`;
  return Number(reset ?? 0) + Number(verification ?? 0);
}
