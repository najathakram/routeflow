/**
 * DB-lane specs that price plans or add-ons need a PUBLISHED plan catalog, and CI's fresh database
 * has none (SA-398). Same pattern as override-activation-ledger.db.spec.ts: reuse a PUBLISHED
 * PlanVersion when one exists (the compose DB after `local:seed`), otherwise create the minimum the
 * spec names. Returns the id of a version THIS call created — pass it to `dropPublishedCatalog` in
 * afterAll — or undefined; a pre-existing catalog is never touched.
 */
export interface CatalogNeed {
  plans: Array<{ planKey: string; name: string; monthlyPrice: number }>;
  addons: Array<{
    sku: string;
    name: string;
    monthlyPrice: number;
    stackable?: boolean;
    /** planKey at/above which the add-on is bundled free (null/absent = never bundled). */
    includedAtPlan?: string;
  }>;
}

export async function ensurePublishedCatalog(
  prisma: any,
  need: CatalogNeed,
  note: string,
): Promise<string | undefined> {
  const published = await prisma.planVersion.findFirst({ where: { status: "PUBLISHED" } });
  if (published) return undefined;
  // int4 column — never derive from Date.now()
  const version =
    ((await prisma.planVersion.aggregate({ _max: { version: true } }))._max.version ?? 0) + 1;
  const created = await prisma.planVersion.create({
    data: {
      version,
      status: "PUBLISHED",
      publishedAt: new Date(),
      notes: `qa fixture — ${note}`,
      definitions: {
        create: need.plans.map((p) => ({ ...p, isCustom: false, featureFlags: [] })),
      },
      addonSkus: { create: need.addons.map((a) => ({ ...a, grantsFlags: [] })) },
    },
  });
  return created.id;
}

/** Deletes exactly the version `ensurePublishedCatalog` created (no-op when it reused one). */
export async function dropPublishedCatalog(prisma: any, createdVersionId: string | undefined) {
  if (!createdVersionId) return;
  await prisma.addonSku.deleteMany({ where: { planVersionId: createdVersionId } });
  await prisma.planDefinition.deleteMany({ where: { planVersionId: createdVersionId } });
  await prisma.planVersion.delete({ where: { id: createdVersionId } });
}
