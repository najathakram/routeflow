// @ts-nocheck
"use strict";

// RETIRED (#2421, lead ruling 2026-09-27). This refusal is the first executable line, before any
// database driver is loaded.
//
// import-zoho.js was a pre-multi-tenancy, one-off Zoho CSV importer: it ran ~30 UNSCOPED bulk
// deletes (invoice.deleteMany({}), payments, orders, routes, customers, CUSTOMER users...) and then
// created rows with no tenantId, against whatever DATABASE_URL was set, behind only `--execute`.
// On today's multi-tenant database one run would wipe every tenant's data. A tenant-scoped rewrite
// was judged not worth it for a one-off; the original lives in git history
// (`git log -- apps/api/scripts/import-zoho.js`). Onboarding imports go through the in-app import
// flow (apps/api/src/import) instead.
//
// scripts-unscoped-delete.spec.ts pins that this file stays a refusal.
console.error(
  "import-zoho.js is RETIRED (#2421): a pre-multi-tenancy importer that ran unscoped deletes " +
    "across every tenant. Use the in-app import flow; the original is in git history.",
);
process.exit(1);
