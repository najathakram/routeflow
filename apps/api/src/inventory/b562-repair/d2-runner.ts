import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { InventoryService } from "../inventory.service";
import { applyD2InTx, planD2, planHashOf, type D2Applied, type D2Plan } from "./d2-repair";

/**
 * Row 635 PR B: the B562 D2 entry the owner-run wrapper (`scripts/b562-d2-average-repair.mjs`) imports from `dist`.
 * SA-902 MUST 3 leaves the mechanism to the lane: this runs the app's OWN code — the shared fold, the order path's piece
 * conversion and PR-3's `recomputeProductInTx` — on a tenant-scoped PrismaService built the way the DB specs build it, with
 * no Nest application context (which would also start the schedulers). Every gate (plan hash, guard sha, backup, live and
 * protected tenants) is the wrapper's; this takes a resolved tenant id and reads `DATABASE_URL` from the environment the
 * wrapper set.
 *
 * `InventoryService` is built with only its prisma: `recomputeProductInTx` reads nothing else (stock alerts and audit are
 * the write paths' own), and the DB spec runs this same construction.
 */
function open() {
  const tenantCtx = new TenantContextService();
  const prisma = new PrismaService(tenantCtx);
  const inventory = new InventoryService(prisma, {
    fireForProducts: async () => ({ notified: 0 }),
  } as any);
  return { tenantCtx, prisma, inventory };
}

/** Read-only: the wrapper points `DATABASE_URL` at a `default_transaction_read_only` session for the dry run. */
export async function runD2Plan(args: {
  tenantId: string;
  productIds?: string[];
}): Promise<D2Plan & { planHash: string }> {
  const { tenantCtx, prisma } = open();
  try {
    await prisma.$connect();
    const plan = await tenantCtx.run(args.tenantId, () =>
      planD2(prisma.forTenant(), { tenantId: args.tenantId, productIds: args.productIds }),
    );
    return { ...plan, planHash: planHashOf(plan.entries) };
  } finally {
    await prisma.$disconnect();
  }
}

/** One tenant transaction: lock, re-derive and compare the hash, the anchored inputs, PR-3's apply, the asserts, the audit. */
export async function runD2Apply(args: {
  tenantId: string;
  planHash: string;
  productIds: string[];
}): Promise<D2Applied[]> {
  const { tenantCtx, prisma, inventory } = open();
  try {
    await prisma.$connect();
    return await tenantCtx.run(args.tenantId, () =>
      prisma.tenantTransaction(
        (tx) =>
          applyD2InTx(tx, {
            tenantId: args.tenantId,
            planHash: args.planHash,
            productIds: args.productIds,
            recompute: (t, id, o) => inventory.recomputeProductInTx(t, id, o),
          }),
        { timeout: 300_000, maxWait: 10_000 },
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

export { planHashOf };
