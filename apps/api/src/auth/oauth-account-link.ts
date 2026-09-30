import { ConflictException, ForbiddenException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

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
}): Promise<T | null> {
  const { findFirst, baseWhere, column, sub, email } = args;
  if (!sub || !email) throw new ForbiddenException("unauthorized");

  const bySub = await findFirst({ where: { ...baseWhere, [column]: sub } });
  if (bySub) return bySub;

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
  return { row: fresh, linked: false };
}

const PROVIDER_ID_INDEXES: Record<OAuthProviderColumn, ReadonlySet<string>> = {
  googleId: new Set(["User_tenantId_googleId_key", "BuyerAccount_googleId_key"]),
  appleId: new Set(["User_tenantId_appleId_key", "BuyerAccount_appleId_key"]),
};

/** adapter-pg keeps the SQL identifier quotes in constraint names/fields (`"googleId"`). */
const unquoteIdent = (name: string): string => name.replace(/^"|"$/g, "");

/**
 * True only for a Prisma P2002 raised by the provider-id unique constraint itself (another row
 * already owns this sub). Prisma 7's pg driver adapter has no `meta.target`: the constraint rides
 * in `meta.driverAdapterError.cause.constraint` as `{ index }` or `{ fields }`. Every other unique
 * violation (email, ...) and every non-P2002 error is false, so callers re-throw it unchanged.
 */
export function isProviderIdUniqueViolation(err: unknown, column: OAuthProviderColumn): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") return false;
  const constraint = (
    err.meta as
      | { driverAdapterError?: { cause?: { constraint?: { index?: unknown; fields?: unknown } } } }
      | undefined
  )?.driverAdapterError?.cause?.constraint;
  if (typeof constraint?.index === "string")
    return PROVIDER_ID_INDEXES[column].has(unquoteIdent(constraint.index));
  if (Array.isArray(constraint?.fields)) {
    const fields = constraint.fields.map((f) => unquoteIdent(String(f))).sort();
    return (
      (fields.length === 1 && fields[0] === column) ||
      (fields.length === 2 && fields[0] === column && fields[1] === "tenantId")
    );
  }
  return false;
}
