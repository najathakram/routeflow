// apps/api/scripts/bootstrap-house-tenant.mjs
//
// One-time, idempotent creation of the routeflow-hq house tenant, used by Phase 0's
// TenantMirrorService and by every later phase's HQ-based invoicing/messaging. Running
// this twice is a no-op if routeflow-hq already exists — it does not overwrite config.
// Dry run by default; prints the resolved DB host before any write.
//
// Usage:
//   node apps/api/scripts/bootstrap-house-tenant.mjs           # dry run, prints intended action
//   node apps/api/scripts/bootstrap-house-tenant.mjs --apply   # creates/repairs routeflow-hq

import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { resolveDatabaseUrl, redactUrl, scrubSecrets } from "./lib/railway-db-url.mjs";

// Hoisted to module scope so the top-level `.catch` below can scrub a connection string out
// of an error message.
let databaseUrl;

const HOUSE_SLUG = "routeflow-hq";

async function main() {
  const apply = process.argv.includes("--apply");
  try {
    databaseUrl = resolveDatabaseUrl(process.env);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  console.log(`Resolved database host: ${redactUrl(databaseUrl)}`);
  const pool = new Pool({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

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
      if (!configuredId) {
        if (!apply) {
          console.log(
            `${HOUSE_SLUG} already exists (id ${existing.id}) but platform.houseTenantId is unset. ` +
              `Dry run only — pass --apply to set it.`,
          );
          return;
        }
        await prisma.$executeRaw`
          INSERT INTO "PlatformConfig" ("id", "key", "value", "updatedAt")
            VALUES (gen_random_uuid()::text, 'platform.houseTenantId', ${existing.id}, now())
          ON CONFLICT ("key")
            DO UPDATE SET "value" = EXCLUDED.value, "updatedAt" = now()
        `;
        console.log(
          `${HOUSE_SLUG} already exists (id ${existing.id}) — PlatformConfig key was missing, set it to the existing tenant's id.`,
        );
        return;
      }
      console.log(`${HOUSE_SLUG} already exists (id ${existing.id}) — no-op.`);
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

    if (!apply) {
      console.log(
        `${HOUSE_SLUG} does not exist. Dry run only — pass --apply to create it (class INTERNAL).`,
      );
      return;
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
    await pool.end();
  }
}

// Only run the CLI when this file is the process entry point — never on import, so a spec can
// import this module without opening a real Postgres connection as an unawaited side effect.
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    const msg = err?.message ?? String(err);
    console.error(databaseUrl ? scrubSecrets(msg, databaseUrl) : msg);
    process.exit(1);
  });
}
