// SA-1042 A-4 G5: READ-ONLY census of old typed credit rows, scoped to lines the ledger can reverse (live, not dead, SALE).
// The logic is `censusOldTypedCredits` in src/regulated/credit-reversal-census.ts, so the dead-SALE rule is the room loader's own
// (`deadSaleIdsOf`), not a copy; this runner only connects. Needs the api built first: `npm run build -w apps/api`.
// Run against the compose DB; the prod run is the owner's. Local databases only.
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const url =
  process.env.CENSUS_DATABASE_URL ?? "postgresql://user:pass@127.0.0.1:5432/routeflow_dev";
if (!/@(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(url))
  throw new Error("census: local database only");
const built = fileURLToPath(
  new URL("../dist/regulated/credit-reversal-census.js", import.meta.url),
);
if (!existsSync(built)) throw new Error("census: build the api first (npm run build -w apps/api)");
const { censusOldTypedCredits } = require(built);
// every session of this pool is read-only: a write through it fails in Postgres
const pool = new Pool({ connectionString: url, options: "-c default_transaction_read_only=on" });
const db = new PrismaClient({ adapter: new PrismaPg(pool) });
try {
  console.log(JSON.stringify(await censusOldTypedCredits(db), null, 2));
} finally {
  await db.$disconnect();
  await pool.end();
}
