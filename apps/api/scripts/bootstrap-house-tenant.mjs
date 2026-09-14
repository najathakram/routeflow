// apps/api/scripts/bootstrap-house-tenant.mjs
//
// One-time, idempotent creation of the routeflow-hq house tenant, used by Phase 0's
// TenantMirrorService and by every later phase's HQ-based invoicing/messaging. Running
// this twice is a no-op if routeflow-hq already exists — it does not overwrite config.
//
// Usage: node apps/api/scripts/bootstrap-house-tenant.mjs

import { PrismaClient } from "@prisma/client";

const HOUSE_SLUG = "routeflow-hq";

async function main() {
  const prisma = new PrismaClient();
  try {
    const existing = await prisma.tenant.findUnique({ where: { slug: HOUSE_SLUG } });
    const configured = await prisma.$queryRaw`
      SELECT value FROM "PlatformConfig" WHERE key = 'platform.houseTenantId' LIMIT 1
    `;
    const configuredId = configured[0]?.value ?? null;

    if (existing) {
      // R4: never overwrite an existing key. A key that names a DIFFERENT tenant would send
      // every TenantMirrorService write into a foreign tenant, so abort loudly instead of
      // reporting a no-op the operator would trust.
      if (configuredId && configuredId !== existing.id) {
        throw new Error(
          `platform.houseTenantId is ${configuredId} but ${HOUSE_SLUG} is ${existing.id}. ` +
            `Refusing to overwrite it — resolve the mismatch by hand before mirroring runs.`,
        );
      }
      console.log(`${HOUSE_SLUG} already exists (id ${existing.id}) — no-op.`);
      if (!configuredId) {
        await prisma.$executeRaw`
          INSERT INTO "PlatformConfig" ("id", "key", "value", "updatedAt")
            VALUES (gen_random_uuid()::text, 'platform.houseTenantId', ${existing.id}, now())
          ON CONFLICT ("key")
            DO UPDATE SET "value" = EXCLUDED.value, "updatedAt" = now()
        `;
        console.log("PlatformConfig key was missing — set it to the existing tenant's id.");
      }
      return;
    }

    // Key present but no house tenant: creating one would commit the tenant and then fail on the
    // unique key, leaving a tenant the config does not name. Refuse before writing anything.
    if (configuredId) {
      throw new Error(
        `platform.houseTenantId already names ${configuredId} but no ${HOUSE_SLUG} tenant exists. ` +
          `Refusing to create a second house tenant — resolve the key by hand first.`,
      );
    }

    const tenant = await prisma.$transaction(async (tx) => {
      const t = await tx.tenant.create({
        data: {
          slug: HOUSE_SLUG,
          name: "RouteFlow HQ",
          status: "ACTIVE",
          plan: "ENTERPRISE",
          class: "INTERNAL",
        },
      });
      await tx.tenantConfig.create({
        data: {
          tenantId: t.id,
          // Placeholder legal identity — the owner must supply the real entity name/address
          // before Phase 1 issues the first invoice off this tenant (see parent spec's
          // owner-decision list, item 3).
          businessName: "RouteFlow HQ",
        },
      });
      return t;
    });

    await prisma.$executeRaw`
      INSERT INTO "PlatformConfig" ("id", "key", "value", "updatedAt")
        VALUES (gen_random_uuid()::text, 'platform.houseTenantId', ${tenant.id}, now())
      ON CONFLICT ("key")
        DO UPDATE SET "value" = EXCLUDED.value, "updatedAt" = now()
    `;

    console.log(`Created ${HOUSE_SLUG} (id ${tenant.id}) and set platform.houseTenantId.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
