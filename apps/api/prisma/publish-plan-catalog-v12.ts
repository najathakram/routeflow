/**
 * Publish plan catalog v12 — adds LITE (invite-only, $99/mo) below STARTER and enforces five
 * new plan-flag keys (flag.estimates, flag.recurring_invoices, flag.credit_notes,
 * flag.suppliers, flag.messaging) across every existing plan definition (WP4, lite-L2 —
 * R1.5/R1.6/R1.9/R3b.6/R7.2/R7.4).
 *
 * Production already has PlanVersion v11 PUBLISHED (retires five unenforced add-on SKUs — see
 * publish-plan-catalog-v11.ts). This script does NOT touch v11's AddonSku set: it opens a new
 * DRAFT version carrying v11's four definitions plus LITE, and PUBLISHES it through the same
 * lifecycle the platform-admin Plans editor uses (PlanCatalogService.createDraft/publish) — so
 * the prior published version is marked SUPERSEDED and existing tenants keep whatever
 * planVersionId they were already pinned to (grandfathering; see plan-catalog.service.ts
 * `publish()`). No tenant is re-pinned.
 *
 * The v12-specific target catalog (LITE_DEFINITION, V12_DEFINITIONS, V12_ADDON_SEEDS,
 * buildV12Rows) lives in plan-catalog-v12.definitions.ts — a pure, DB-import-free module —
 * so it's directly unit-testable without a database; see plan-catalog-v12.spec.ts. This file
 * mirrors publish-plan-catalog-v11.ts's connection setup and DRAFT/PUBLISH mechanics (raw
 * PrismaClient over the pg adapter, driven by DATABASE_URL, rather than booting a Nest
 * application context — the same tradeoff every prisma/publish-plan-catalog-v*.ts script
 * makes). The writes are a deliberate line-for-line mirror of
 * PlanCatalogService.createDraft()/publish(); keep them in lock-step if those methods' field
 * writes ever change.
 *
 * `publishV12(prisma)` is the exported, connection-agnostic entry point — it never constructs
 * a Pool/PrismaClient itself, so importing this file (e.g. from a spec) never opens a real DB
 * connection. `main()` builds the real connection and runs ONLY when this file is executed
 * directly (`require.main === module`), never on import.
 *
 * Idempotent: if the currently PUBLISHED version already has a LITE PlanDefinition, this
 * exits without writing anything. Safe to re-run (including after a partial failure — see the
 * DRAFT-resume note below). Never deletes anything — it never touches an existing
 * PlanVersion's rows; SUPERSEDED versions and their rows are left in place for history.
 *
 * Local:   ts-node -r tsconfig-paths/register prisma/publish-plan-catalog-v12.ts (from apps/api)
 * Railway: railway run --service postgres ts-node -r tsconfig-paths/register prisma/publish-plan-catalog-v12.ts
 * (Wired up as `npm run db:publish:catalog:v12` in apps/api/package.json.)
 */
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import type { AddonSkuCode } from "../src/billing/plan-catalog.constants";
import { V12_ADDON_SEEDS, buildV12Rows } from "./plan-catalog-v12.definitions";

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

export interface PublishV12Result {
  action: "published" | "noop";
  version: number;
}

/**
 * Publish v12 against the given Prisma client. No Pool/PrismaClient is constructed here — the
 * caller (main(), or a DB-backed spec) owns the connection lifecycle.
 */
export async function publishV12(prisma: PrismaClient): Promise<PublishV12Result> {
  const published = await prisma.planVersion.findFirst({
    where: { status: "PUBLISHED" },
    orderBy: { version: "desc" },
    include: WITH_CATALOG,
  });

  const alreadyPublished = published
    ? published.definitions.some((d) => d.planKey === "LITE")
    : false;
  if (alreadyPublished) {
    console.log(
      `already published: v${published!.version} already has a LITE definition — nothing to do.`,
    );
    return { action: "noop", version: published!.version };
  }

  const targetSkus = new Set(V12_ADDON_SEEDS.map((s) => s.sku));

  // Reuse a leftover DRAFT from a previously interrupted run of THIS script — identified by
  // BOTH having a LITE definition AND its AddonSku set matching V12_ADDON_SEEDS exactly.
  // Checking addonSkus alone would not distinguish our DRAFT from a leftover v11 DRAFT: v12
  // carries forward v11's AddonSku set unchanged (V12_ADDON_SEEDS === V11_ADDON_SEEDS), so the
  // LITE definition is the only reliable marker that THIS script created the draft. A DRAFT
  // that does NOT match is left alone (may be in-progress admin work) — the script fails
  // loudly rather than touching it, mirroring v11's own DRAFT-resume rule.
  let draft: CatalogVersion | null = await prisma.planVersion.findFirst({
    where: { status: "DRAFT" },
    include: WITH_CATALOG,
  });

  if (draft) {
    const hasLite = draft.definitions.some((d) => d.planKey === "LITE");
    const isOurDraft =
      hasLite &&
      draft.addonSkus.length === targetSkus.size &&
      draft.addonSkus.every((s) => targetSkus.has(s.sku as AddonSkuCode));
    if (!isOurDraft) {
      throw new Error(
        `A DRAFT plan version (v${draft.version}) already exists and doesn't match the v12 ` +
          "catalog this script publishes. Resolve or discard it via the platform-admin Plans " +
          "editor first, then re-run.",
      );
    }
    console.log(`resuming existing DRAFT v${draft.version} from an interrupted prior run`);
  } else {
    const { notes, definitionRows, addonSkuRows } = buildV12Rows(published);
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
  // Never re-pins existing tenants — grandfathering is deliberate; they move to v12 only when
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
  console.log(`publish-plan-catalog-v12 target: ${maskDbUrl(process.env.DATABASE_URL)}`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    await publishV12(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

// Only run main() when this file is executed directly — never on import, so a spec can import
// `publishV12` without triggering a real DB connection at module load.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
