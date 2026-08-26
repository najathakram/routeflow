/**
 * REPAIR: decode HTML entities that the pre-#414 StripHtml stored into text
 * columns (&amp; &lt; &gt; &quot; &#39;). The census script
 * (report-escaped-entities.mjs) enumerates affected rows; this script decodes
 * them in place for ONE tenant. Write path is fixed (#414) — this repairs only
 * what was stored before.
 *
 * Decode order matters: &amp; LAST, or "&amp;lt;" would double-decode.
 * Columns covered = exactly the census list.
 *
 * SAFETY (per CLAUDE.md live-tenant policy):
 *   - DRY-RUN by default: prints every before→after, writes nothing.
 *   - Executing requires:  --execute --confirm-tenant=<slug>
 *   - A LIVE (non-test) tenant additionally requires  --live-tenant-override,
 *     the tenant's explicit request, and a fresh validated backup first.
 *
 * Run:
 *   railway run --service postgres node apps/api/scripts/repair-escaped-entities.mjs --tenant=<slug>
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { isTestTenant } from "../../../scripts/lib/test-tenants.cjs";

function resolveDbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const e = process.env;
  const need = [
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DB",
    "RAILWAY_TCP_PROXY_DOMAIN",
    "RAILWAY_TCP_PROXY_PORT",
  ];
  const missing = need.filter((k) => !e[k]);
  if (missing.length) {
    console.error(
      `\nMissing env: ${missing.join(", ")}\n` +
        "Set DATABASE_URL, or run via: railway run --service postgres node apps/api/scripts/repair-escaped-entities.mjs\n",
    );
    process.exit(1);
  }
  return (
    `postgresql://${e.POSTGRES_USER}:${encodeURIComponent(e.POSTGRES_PASSWORD)}` +
    `@${e.RAILWAY_TCP_PROXY_DOMAIN}:${e.RAILWAY_TCP_PROXY_PORT}/${e.POSTGRES_DB}`
  );
}

const args = process.argv.slice(2);
const argVal = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const tenantSlug = argVal("tenant");
const execute = args.includes("--execute");
const confirmSlug = argVal("confirm-tenant");
const liveOverride = args.includes("--live-tenant-override");

if (!tenantSlug) {
  console.error(
    "\nUsage: --tenant=<slug> [--execute --confirm-tenant=<slug> [--live-tenant-override]]\n",
  );
  process.exit(1);
}
if (execute) {
  if (confirmSlug !== tenantSlug) {
    console.error(`\n--execute requires --confirm-tenant=${tenantSlug}. Nothing was written.\n`);
    process.exit(1);
  }
  if (!isTestTenant(tenantSlug) && !liveOverride) {
    console.error(
      `\n"${tenantSlug}" is a LIVE tenant — --live-tenant-override + explicit tenant request + fresh backup required. Nothing was written.\n`,
    );
    process.exit(1);
  }
}

// Same column list as report-escaped-entities.mjs — keep in sync.
const TARGETS = [
  { model: "customer", field: "businessName" },
  { model: "customer", field: "displayName" },
  { model: "customer", field: "notes" },
  { model: "order", field: "notes" },
  { model: "order", field: "shippingCarrier" },
  { model: "order", field: "shippingTrackingNumber" },
  { model: "orderItem", field: "name" },
  { model: "invoice", field: "notes" },
  { model: "invoice", field: "shippingCarrier" },
  { model: "invoice", field: "shippingTrackingNumber" },
  { model: "product", field: "name" },
  { model: "stockCountSession", field: "name" },
  { model: "stockCountSession", field: "notes" },
  { model: "billPayment", field: "notes" },
  { model: "buyerAccount", field: "name" },
];

const ENTITY_RE = /&(?:amp|lt|gt|quot|#39);/;
// &amp; decoded LAST so "&amp;lt;" becomes "&lt;" (one level), never "<".
const decode = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

// Prisma error messages often open with blank lines — report the first non-empty one.
const errorReason = (err) =>
  String(err?.message ?? err)
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ??
  err?.name ??
  "unknown error";

const pool = new Pool({ connectionString: resolveDbUrl() });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

(async () => {
  const tenant = await prisma.tenant.findUnique({
    where: { slug: tenantSlug },
    select: { id: true, slug: true, status: true },
  });
  if (!tenant) {
    console.error(`Tenant "${tenantSlug}" not found. Nothing was written.`);
    process.exit(1);
  }

  console.log(`\n===== ESCAPED-ENTITY REPAIR (${execute ? "EXECUTE" : "DRY-RUN"}) =====`);
  console.log(`Tenant: ${tenant.slug} (${tenant.status})\n`);

  let total = 0;
  for (const { model, field } of TARGETS) {
    // BuyerAccount carries no tenantId — its tenant link is the customerLinks
    // relation (CustomerLink rows hold tenantId). The census counts it globally.
    const where =
      model === "buyerAccount"
        ? { customerLinks: { some: { tenantId: tenant.id } }, [field]: { contains: "&" } }
        : { tenantId: tenant.id, [field]: { contains: "&" } };

    let rows;
    try {
      rows = await prisma[model].findMany({ where, select: { id: true, [field]: true } });
    } catch (err) {
      console.log(`  (skipped ${model}.${field}: ${errorReason(err)})`);
      continue;
    }
    const hits = rows.filter((r) => r[field] && ENTITY_RE.test(r[field]));
    if (hits.length === 0) continue;

    console.log(`-- ${model}.${field}: ${hits.length} row(s)`);
    for (const row of hits) {
      const before = row[field];
      const after = decode(before);
      console.log(`   ${row.id.slice(0, 8)}…  "${before}"  →  "${after}"`);
      if (execute) {
        await prisma[model].update({ where: { id: row.id }, data: { [field]: after } });
      }
      total++;
    }
  }

  console.log(
    `\n${execute ? "✅ Repaired" : "DRY-RUN — would repair"} ${total} row(s).` +
      (execute
        ? ""
        : `\nTo execute: add --execute --confirm-tenant=${tenantSlug}` +
          (isTestTenant(tenantSlug)
            ? ""
            : " --live-tenant-override (LIVE tenant — backup first!)")) +
      "\n",
  );
  process.exit(0);
})().catch((err) => {
  console.error("\nFAILED:", err.message);
  process.exit(1);
});
