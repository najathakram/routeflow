const { Client } = require("pg");
const url = process.env.DATABASE_URL || "postgresql://user:pass@localhost:5432/routeflow_dev";
const c = new Client({ connectionString: url });
(async () => {
  await c.connect();
  await c.query(
    'ALTER TABLE "TenantConfig" ADD COLUMN IF NOT EXISTS "invoiceNotes" TEXT, ADD COLUMN IF NOT EXISTS "invoiceTerms" TEXT',
  );
  console.log("OK");
  await c.end();
})().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
