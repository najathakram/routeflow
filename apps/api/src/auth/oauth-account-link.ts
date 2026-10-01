import { ConflictException, ForbiddenException } from "@nestjs/common";

/**
 * SA-598 P1 / #2495: the ONE resolve-then-link rule for provider sign-in (Google, Apple), derived
 * from the Google fix so a provider cannot fork it. Pure functions over prisma-like delegate
 * callbacks and the provider column.
 *
 * The defect being removed: `findFirst({ OR: [{ sub }, { email }] })` is nondeterministic when two
 * rows match (one bound to this sub, another only sharing the email), and the check-then-update
 * link lets a concurrent request overwrite a sub the winner just bound.
 */

export type OAuthProviderColumn = "googleId" | "appleId";

const MISMATCH_CODE: Record<OAuthProviderColumn, string> = {
  googleId: "google_account_mismatch",
  appleId: "apple_account_mismatch",
};

/**
 * Resolve by the provider sub FIRST (a bound identity is unambiguous); only when no sub match
 * exists fall back to the email, oldest-created row winning (`id` as the final tiebreak). An email
 * row already bound to a DIFFERENT sub is a 409 and the caller must not write. A falsy sub or email
 * is refused before ANY query (an undefined filter would widen `where`).
 */
export async function resolveBySubThenEmail<
  T extends { [K in OAuthProviderColumn]?: unknown },
>(args: {
  findFirst: (args: Record<string, unknown>) => Promise<T | null>;
  baseWhere: Record<string, unknown>;
  column: OAuthProviderColumn;
  sub: string | null | undefined;
  email: string | null | undefined;
  /**
   * Apple only sends the email claim on the FIRST sign-in; later identity tokens omit it. With this
   * set, a missing email is allowed for a sub that is already bound (resolved in one query); with no
   * bound sub and no email there is nothing to match on, so it is refused — an absent email never
   * widens the lookup. Default false keeps Google's "sub and email both required" contract.
   */
  allowSubOnly?: boolean;
}): Promise<T | null> {
  const { findFirst, baseWhere, column, sub, email, allowSubOnly = false } = args;
  if (!sub || (!email && !allowSubOnly)) throw new ForbiddenException("unauthorized");

  const bySub = await findFirst({ where: { ...baseWhere, [column]: sub } });
  if (bySub) return bySub;
  if (!email) throw new ForbiddenException("unauthorized");

  const byEmail = await findFirst({
    where: { ...baseWhere, email },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const bound = byEmail?.[column];
  if (byEmail && bound && bound !== sub) {
    throw new ConflictException(MISMATCH_CODE[column]);
  }
  return byEmail;
}

/**
 * Link by compare-and-set: `updateMany` scoped to `{ id, [column]: null }` (plus `extraWhere`, e.g.
 * the staff `tenantId`), so only the first writer succeeds. `linked` is true only when THIS call
 * performed the write; callers gate session revocation and the "account linked" email on it. A
 * lost race re-reads: the same sub is a harmless duplicate (linked=false), a different sub is 409.
 */
export async function casLinkProviderId<
  T extends { id: string } & { [K in OAuthProviderColumn]?: unknown },
>(args: {
  updateMany: (args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }) => Promise<{ count: number }>;
  findUnique: (id: string) => Promise<T | null>;
  row: T;
  column: OAuthProviderColumn;
  sub: string | null | undefined;
  data?: Record<string, unknown>;
  extraWhere?: Record<string, unknown>;
}): Promise<{ row: T; linked: boolean }> {
  const { updateMany, findUnique, row, column, sub, data = {}, extraWhere = {} } = args;
  if (!sub) throw new ForbiddenException("unauthorized");

  const write = { [column]: sub, ...data };
  const result = await updateMany({
    where: { id: row.id, ...extraWhere, [column]: null },
    data: write,
  });
  if (result.count === 1) return { row: { ...row, ...write } as T, linked: true };

  const fresh = await findUnique(row.id);
  if (!fresh) throw new ForbiddenException("unauthorized");
  const bound = fresh[column];
  if (bound && bound !== sub) throw new ConflictException(MISMATCH_CODE[column]);
  // Lost the CAS but the row still has NO sub: this was not a race (e.g. the row left the scoped
  // `extraWhere`), so nothing was linked. Never report success for a link that did not happen.
  if (!bound) throw new ForbiddenException("unauthorized");
  return { row: fresh, linked: false };
}
