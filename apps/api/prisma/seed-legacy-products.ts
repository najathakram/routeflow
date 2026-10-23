import type { PrismaClient } from "@prisma/client";

/** Thrown when a DB seeded before products got UUID ids still holds the seeded SKUs (B745). */
export class LegacySeedProductsError extends Error {
  readonly code = "LEGACY_SEED_PRODUCTS";
  constructor(
    readonly legacyIds: string[],
    message: string,
  ) {
    super(message);
    this.name = "LegacySeedProductsError";
  }
}

/**
 * B745: the upsert would hit P2002 on (tenantId, sku) when the SKUs sit under old `seed-prod-NN`
 * ids. Fail loudly (before any write) instead. Exported so a spec drives the real code path.
 */
export async function assertNoLegacySeedProducts(
  prisma: Pick<PrismaClient, "product">,
  tenantId: string,
  defs: ReadonlyArray<{ id: string; sku: string }>,
): Promise<void> {
  const legacy = await prisma.product.findMany({
    where: {
      tenantId,
      sku: { in: defs.map((p) => p.sku) },
      id: { notIn: defs.map((p) => p.id) },
    },
    select: { id: true, sku: true },
  });
  if (legacy.length > 0) {
    throw new LegacySeedProductsError(
      legacy.map((p) => p.id),
      `seed: ${legacy.length} legacy seed product(s) (e.g. ${legacy[0].id} / ${legacy[0].sku}) ` +
        "already hold the seeded SKUs under pre-UUID ids. Run `npm run local:reset` (wipes the local volumes) and seed again.",
    );
  }
}
