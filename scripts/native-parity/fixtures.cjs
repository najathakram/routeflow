/**
 * #2338 (T0.10): the native-parity proof harness's buyer fixtures on the LOCAL compose `test`
 * tenant. One source for three readers: the `test` seed (apps/api/prisma/seed-parity-buyer.ts)
 * creates them, the web capture logs in with them, and the harness writes them into the gitignored
 * apps/mobile/.env.parity for the dev-only parity login. Never a real account: the seed creates
 * them only on a provably local database (lib/local-db-target.cjs), like the e2e buyer fixture.
 *
 * Keep exports static (plain module.exports) so the TS seed and the ESM scripts can both import it.
 */
const PARITY_TENANT_SLUG = "test";

/** Linked to the seed's first customer (Lone Star Café, which has orders): the LOADED state. */
const PARITY_BUYER = {
  email: "parity_buyer@test.routeflow.test",
  password: "ParityBuyer1!",
  name: "Parity Buyer",
};

/** Linked to a dedicated customer with no orders or invoices: the EMPTY state. */
const PARITY_BUYER_EMPTY = {
  email: "parity_buyer_empty@test.routeflow.test",
  password: "ParityBuyer1!",
  name: "Parity Buyer (empty)",
  customer: { username: "parity_empty_cust", businessName: "Parity Empty Cafe" },
};

module.exports = { PARITY_TENANT_SLUG, PARITY_BUYER, PARITY_BUYER_EMPTY };
