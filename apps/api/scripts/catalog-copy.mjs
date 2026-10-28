// SA-1027 — copy one tenant's catalog (products, units, prices, photos, barcodes) into another tenant.
//
//   node apps/api/scripts/catalog-copy.mjs --source <slug> --target <slug>                      DRY RUN (the default)
//   node apps/api/scripts/catalog-copy.mjs --source <slug> --target <test-slug> --apply          apply to a test tenant
//   node apps/api/scripts/catalog-copy.mjs --source <slug> --target <slug> --apply \
//     --live-tenant-override=<same target slug> --confirm "COPY <n> PRODUCTS" --backup-taken     apply to any other tenant
//   node apps/api/scripts/catalog-copy.mjs --source <slug> --target <slug> --apply --resume <manifest>   finish photos only
//
// Source and target are ARGUMENTS ONLY: no slug appears in this script or anywhere else in the repo. The source is only
// ever read. Every write goes through the app's own services (ProductsService.create, the families and units services,
// uploadImage), booted as a script-only Nest module (`dist/catalog-copy`): never AppModule, never ScheduleModule. A
// column `create` does not carry is NEVER written here; the target keeps its default and the dry run lists the difference.
//
// Needs `npm run build -w apps/api` first (the module runs from `dist`) and a database: run it under
// `railway run --service postgres`, or add `--local` for a docker-compose database (+ the storage env of the API
// service for photos). A PROTECTED target (paying, Stripe-linked, env-listed; lib/live-target-guard.cjs) also needs
// `--allow-protected <tenantId>` and the typed "ALLOW PROTECTED <tenantId>" at a real terminal.
// Exit: 0 ok · 1 refused (nothing written) · 2 environment error · 3 finished with error rows (see the report and manifest).
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import pg from "pg";
import { redactUrl, resolveDatabaseUrl } from "./lib/railway-db-url.mjs";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(here, "../dist/catalog-copy");
const TAG = "catalog-copy";

const { isTestTenant } = require("../../../scripts/lib/test-tenants.cjs");
const guard = require("./lib/live-target-guard.cjs");
const { loadProtectedSlugs } = require("./lib/protected-slugs.cjs");

/** Flags the guard helpers read straight from argv; the argument parser must not see them. */
function stripGuardFlags(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--allow-protected") i += 1;
    else if (argv[i] !== "--backup-taken" && argv[i] !== "--local") out.push(argv[i]);
  }
  return out;
}

async function main() {
  if (!existsSync(resolve(DIST, "catalog-copy.runner.js"))) {
    console.error(`${TAG}: dist is missing -- run \`npm run build -w apps/api\` first`);
    return 2;
  }
  // A writer: the Railway proxy variables win and it never falls back (requireProxy), unless the operator says --local
  // (a docker-compose run). The resolved target is handed to the compiled module's PrismaService, which reads nothing else.
  let dbUrl;
  try {
    dbUrl = resolveDatabaseUrl(process.env, { requireProxy: !process.argv.includes("--local") });
  } catch (e) {
    console.error(`${TAG}: ${e.message}`);
    return 2;
  }
  process.env.DATABASE_URL = dbUrl;
  console.error(`${TAG}: target ${redactUrl(dbUrl)}`);
  const { parseCopyArgs, assertApplyAllowed, CopyRefusal } = await import(
    pathToFileURL(resolve(DIST, "catalog-copy.guard.js")).href
  );
  const { runCatalogCopy, exitCodeFor } = await import(
    pathToFileURL(resolve(DIST, "catalog-copy.runner.js")).href
  );

  let args;
  try {
    args = parseCopyArgs(stripGuardFlags(process.argv.slice(2)));
    assertApplyAllowed(args); // refused before the database is opened
    if (args.apply && !isTestTenant(args.target) && !guard.hasBackupAttestation(process.argv)) {
      throw new CopyRefusal(
        "refused: --apply on a non-test target needs --backup-taken (a fresh backup first)",
      );
    }
  } catch (e) {
    console.error(`${TAG}: ${e.message}`);
    return 1;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const manifestPath = resolve(
    here,
    "../../../local-assets/catalog-copy",
    `manifest-${stamp}.json`,
  );

  // Row 195 / SA-756r: a PROTECTED target is written only when the operator names its id with --allow-protected and types
  // the confirmation at a real terminal. Runs after the plan and the --confirm check, before the first write.
  const beforeWrite = async ({ targetTenantId }) => {
    if (isTestTenant(args.target)) return;
    const client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    try {
      const protectedIds = new Set(
        await guard.protectedTenantIds(client, loadProtectedSlugs(process.env, dbUrl)),
      );
      if (protectedIds.has(targetTenantId)) {
        await guard.confirmProtectedOverride({ tenantId: targetTenantId, argv: process.argv });
      }
    } finally {
      await client.end();
    }
  };

  try {
    const result = await runCatalogCopy(args, manifestPath, { beforeWrite });
    return exitCodeFor(result);
  } catch (e) {
    console.error(`${TAG}: ${e.message}`);
    return e?.name === "CopyRefusal" || e?.name === "ProtectedTenantError" ? 1 : 2;
  }
}

main().then((code) => process.exit(code));
