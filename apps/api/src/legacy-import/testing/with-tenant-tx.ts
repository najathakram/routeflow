/**
 * SA-1507 rule 2 (A2): the ONE test helper that sets the session tenant outside `tenantTransaction`. Specs of the
 * history-import guard use it to write as a given test tenant.
 *
 * `assertTestTenant` runs FIRST, on the slug of the tenant row the id names: only a test tenant (`qa-*`, `e2e-*`,
 * `test`, ...) can become the session tenant here, so nothing deployed can aim it at a live client. An unknown id has no
 * slug and is refused the same way.
 *
 * Then one `$transaction` is opened whose FIRST statement is `SELECT set_config('app.current_tenant_id', $1, true)` (the
 * third argument makes it local to the transaction), so the guard sees the tenant on every later write of `fn`.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs") as {
  assertTestTenant: (slug: string, context?: string) => string;
};

/** The one method of the transaction client this helper itself calls (a tagged raw statement). */
interface TenantTx {
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

/** The slice of a Prisma client this helper needs, so a spec passes its own PrismaClient or PrismaService. */
export interface TenantTxClient {
  tenant: {
    findUnique(args: {
      where: { id: string };
      select: { slug: true };
    }): Promise<{ slug: string } | null>;
  };
  $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
}

/** Runs `fn` in one transaction whose session tenant is `tenantId` (a test tenant's id). */
export async function withTenantTx<T>(
  prisma: TenantTxClient,
  tenantId: string,
  fn: (tx: any) => Promise<T>,
): Promise<T> {
  const row = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
  assertTestTenant(row?.slug as string, "withTenantTx");
  return prisma.$transaction(async (tx: TenantTx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}
