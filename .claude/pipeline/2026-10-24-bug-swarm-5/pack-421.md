aceb7686baef4832c824ca29d43d3143f878c497
# row 421 NIT tighten revision-guard spec to assert 404 (LIVE)
Evidence: apps/api/src/orders/orders.service.revision-guard.spec.ts:146-153 asserts only code not CONCURRENT_UPDATE, never status 404.
Signatures: spec-only; edit() helper in same spec; service under test OrdersService.updateOrderItems (orders.service.ts).
Radius: orders.service.revision-guard.spec.ts, orders.revision-guard.db.spec.ts, orders.service.ts
Lessons: L-301 guard read after lock; L-327 new guard ahead of old code: keep invariant the spec proves.
Fix: assert err.getStatus()===404 (or NotFoundException) in the test at :146.
