# Api landing 2026-10-25, train 2 (#3764 `6970f9d73`, #3783 `d25cf5e64`, #3793 `f382e28c7`, #3796 `c30eb4a0f`; merge `be47146b3`)

Paths under `apps/api/src/`. Window = `6395541ab..be47146b3`. Tests not indexed. Web part: `web/landing-2026-10-25-train2.md`.

## #3764 `6970f9d73` neutral coded 409s for product write races (row 519)
- `common/api-error-codes.ts` gains `PRODUCT_CHANGED_CONCURRENTLY` (mirrored in `packages/types/api/error-codes.ts`; parity spec pins both).
- `products/products.service.ts`: a reparent that loses a product-row race (40P01 / 40001 / P2034, `txConflictState`) now throws a coded `ConflictException` (`PRODUCT_CHANGED_CONCURRENTLY`, "This product changed while you were saving it"). It no longer throws `LabelLockTimeoutError`: a label-lock conflict already surfaces as that `HttpException`, so the catch only ever sees a product-row conflict.
- `products/recipe-update-guard.ts`: the "moved while you were editing" `ConflictException` carries the same code; message unchanged.
- Specs: `products.reparent-lock-order.spec.ts` expects the neutral code; `product-labels/keep-labels-on-reparent.spec.ts` gains control 4d-ii (P1 carrying WA keeps it on the move; the keep reads rows, not audits); `products/recipe-update-guard.moved.spec.ts` is new.
