# Row 748: #3535 open-orders card nits (HOLD until after the 10-26 weekly reset; lead 2026-10-22)

Source: the Opus PASS on #3535 (merged on green), register row 748. Keep it ONE small PR; the budget is tight.

- (a) Total chip: splits `summary.totalQty` at the LIVE pack while rows use each line's snapshot pack. When line packs
  differ from the live pack, show the total in pieces. (web OpenOrdersCard.tsx; API summary in product-open-orders.service.ts)
- (b) DB-backed cross-tenant spec for GET products/:id/open-orders (a foreign product 404s; no foreign lines). DB lane:
  RUN_DB_SPECS=1 + an rf_dbspec_* DB name (memory note).
- (c) Drop the stale JSDoc in packages/types/api/products.ts (it omits PARTIALLY_DELIVERED).
- (d) Remove the `db as never` cast (open-orders service/spec).
- (e) Order numbers wrap at 390: `whitespace-nowrap` on the order-number cell (the captures showed "ORD-" / "00003").

Proof: L-336 captures at 1440/768/390 on an own-port compose stack (template: rf-wt-r3img/local-assets/r3535/,
harness scrolls <main>, hit-tests per line box). Red first for (a) and (b).
Related, also after the reset: row 749 (server guard, ruling A: refuse governed price writes only under
flag.units_prices_v2); the red spec is parked in local-assets/r749.
