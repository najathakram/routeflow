/**
 * Publish plan catalog v13 — LITE gains `flag.returns` (#2700; owner 2026-09-28, SA-559/559b), and
 * nothing else changes: every other plan definition, every other LITE field and every addon SKU are
 * v12's (see plan-catalog-v13.definitions.ts, pinned by plan-catalog-v13.spec.ts).
 *
 * A line-for-line mirror of publish-plan-catalog-v12.ts's mechanics: it opens a new DRAFT carrying
 * V13_DEFINITIONS/V13_ADDON_SEEDS and PUBLISHES it through the same lifecycle the platform-admin
 * Plans editor uses (PlanCatalogService.createDraft/publish) — the prior published version is
 * marked SUPERSEDED and existing tenants keep whatever planVersionId they were pinned to. No tenant
 * is re-pinned: existing LITE tenants gain flag.returns through "flags gain forward"
 * (`effectivePlanFlags`, plan-catalog.constants.ts), never through a row write.
 *
 * `publishV13(prisma)` is the exported, connection-agnostic entry point; `main()` runs ONLY when
 * this file is executed directly (`require.main === module`), never on import.
 *
 * Idempotent: if the currently PUBLISHED version's LITE already carries flag.returns, this exits
 * without writing anything. A leftover DRAFT is resumed only when it is recognisably THIS script's
 * (LITE carries flag.returns AND its addon SKU set is V13's); any other DRAFT is refused. Never
 * deletes anything — it never touches an existing PlanVersion's rows.
 *
 * OWNER-RUN ONLY on prod (after a fresh backup), from the repo root (SA-559(4)):
 *   railway run --service postgres -- npm --prefix apps/api run db:publish:catalog:v13
 * Local: `npm run local:seed` runs it after v11 and v12.
 */
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import type { AddonSkuCode } from "../src/billing/plan-catalog.constants";
import {
  buildV13Rows,
  diffPublishedAgainstV12,
  liteCarriesV13Flags,
  V13_ADDON_SEEDS,
} from "./plan-catalog-v13.definitions";

const WITH_CATALOG = {
  definitions: { orderBy: { sortOrder: "asc" } },
  addonSkus: { orderBy: { sortOrder: "asc" } },
} satisfies Prisma.PlanVersionInclude;
type CatalogVersion = Prisma.PlanVersionGetPayload<{ include: typeof WITH_CATALOG }>;

/** Strip credentials from a Postgres connection string for safe logging. */
function maskDbUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

export interface PublishV13Result {
  action: "published" | "noop";
  version: number;
}

/**
 * Publish v13 against the given Prisma client. No Pool/PrismaClient is constructed here — the
 * caller (main(), or a DB-backed spec) owns the connection lifecycle.
 */
export async function publishV13(prisma: PrismaClient): Promise<PublishV13Result> {
  const published = await prisma.planVersion.findFirst({
    where: { status: "PUBLISHED" },
    orderBy: { version: "desc" },
    include: WITH_CATALOG,
  });

  const alreadyPublished = published ? liteCarriesV13Flags(published.definitions) : false;
  if (alreadyPublished) {
    console.log(
      `already published: v${published!.version}'s LITE already carries flag.returns — nothing to do.`,
    );
    return { action: "noop", version: published!.version };
  }

  // #2700 (lead F4 / SA-559d): v13 is built from the v12 CONSTANTS, so it is only "v12 + LITE ∋
  // flag.returns" if what is actually PUBLISHED here is v12. Any other difference (a post-v12
  // Plans-editor edit, say) would be silently reverted by this publish: print it and refuse.
  if (published) {
    const drift = diffPublishedAgainstV12(published);
    if (drift.length > 0) {
      throw new Error(
        `The PUBLISHED plan version v${published.version} is not v12 (ignoring LITE's flags), so ` +
          "publishing v13 would revert these differences — refusing:\n  " +
          drift.join("\n  "),
      );
    }
  }

  const targetSkus = new Set(V13_ADDON_SEEDS.map((s) => s.sku));

  // Reuse a leftover DRAFT from a previously interrupted run of THIS script — identified by BOTH
  // its LITE carrying flag.returns AND its AddonSku set matching V13_ADDON_SEEDS exactly (the SKU
  // set alone is the prior version's too, so the LITE flag is the marker that THIS script made it).
  // Any other DRAFT may be in-progress admin work: refuse loudly rather than touch it.
  let draft: CatalogVersion | null = await prisma.planVersion.findFirst({
    where: { status: "DRAFT" },
    include: WITH_CATALOG,
  });

  if (draft) {
    const isOurDraft =
      liteCarriesV13Flags(draft.definitions) &&
      draft.addonSkus.length === targetSkus.size &&
      draft.addonSkus.every((s) => targetSkus.has(s.sku as AddonSkuCode));
    if (!isOurDraft) {
      throw new Error(
        `A DRAFT plan version (v${draft.version}) already exists and doesn't match the v13 ` +
          "catalog this script publishes. Resolve or discard it via the platform-admin Plans " +
          "editor first, then re-run.",
      );
    }
    console.log(`resuming existing DRAFT v${draft.version} from an interrupted prior run`);
  } else {
    const { notes, definitionRows, addonSkuRows } = buildV13Rows(published);
    const maxVer = await prisma.planVersion.aggregate({ _max: { version: true } });
    const nextVersion = (maxVer._max.version ?? 0) + 1;

    draft = await prisma.$transaction(async (tx) => {
      const created = await tx.planVersion.create({
        data: { version: nextVersion, status: "DRAFT", notes },
      });
      await tx.planDefinition.createMany({
        data: definitionRows.map((d) => ({ ...d, planVersionId: created.id })),
      });
      await tx.addonSku.createMany({
        data: addonSkuRows.map((s) => ({ ...s, planVersionId: created.id })),
      });
      return tx.planVersion.findUniqueOrThrow({ where: { id: created.id }, include: WITH_CATALOG });
    });
  }

  for (const d of draft.definitions) {
    console.log(
      `  + PlanDefinition ${d.planKey} "${d.name}" ` +
        `${d.monthlyPrice != null ? `$${d.monthlyPrice}/mo` : "custom"} ` +
        `(customersIncluded=${d.customersIncluded ?? "unlimited"})`,
    );
  }
  for (const s of draft.addonSkus) {
    console.log(`  + AddonSku ${s.sku} "${s.name}" $${s.monthlyPrice}/mo`);
  }

  // Publish: a line-for-line mirror of PlanCatalogService.publish()'s writes (see the header).
  // Never re-pins existing tenants — grandfathering is deliberate; they move to v13 only when
  // they next change plan.
  const now = new Date();
  const publishedVersion = await prisma.$transaction(async (tx) => {
    await tx.planVersion.updateMany({
      where: { status: "PUBLISHED" },
      data: { status: "SUPERSEDED" },
    });
    return tx.planVersion.update({
      where: { id: draft!.id },
      data: { status: "PUBLISHED", publishedAt: now, effectiveAt: now },
      include: WITH_CATALOG,
    });
  });

  console.log(
    `published v${publishedVersion.version}: ${publishedVersion.definitions.length} plan ` +
      `definitions, ${publishedVersion.addonSkus.length} addon SKUs. Prior published version ` +
      `(if any) marked SUPERSEDED. Existing tenants keep their pinned planVersionId.`,
  );

  return { action: "published", version: publishedVersion.version };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set — refusing to run.");
  }
  console.log(`publish-plan-catalog-v13 target: ${maskDbUrl(process.env.DATABASE_URL)}`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    await publishV13(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

// Only run main() when this file is executed directly — never on import, so a spec can import
// `publishV13` without triggering a real DB connection at module load.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
