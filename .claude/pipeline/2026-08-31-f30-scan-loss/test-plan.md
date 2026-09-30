# F30 — test plan

All T1 (pure-logic jest: `apps/mobile` for the client mechanisms, `apps/api` for the server
half). The diagnosis's mechanism chains are the oracles — each test reproduces a verified chain,
not a guess. **Correction to spec R8's first draft:** the idempotency store is a nullable
`Order.idempotencyKey` column + `@@unique([tenantId, idempotencyKey])` (additive migration slot
`20260910000000_order_idempotency`), not a new table — replay = findFirst by (tenantId, key),
return the existing order.

| T#                         | Given / When / Then                                                                                                                                                                                                  | Red today because                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| T-B190 (REG-B190)          | one label decoding alternately as EAN-13 "0012345678905" and UPC-A "012345678905" across 6 frames / gateScan sequence / exactly ONE accept (normalized-set LRU match)                                                | raw-string single-slot dedupe accepts every flip                   |
| T-B191 (REG-B191)          | same item deliberately re-scanned 5× at 600ms gaps / gate / 5 accepts (cooldown refreshes only on ACCEPT; rejections do not slide the window) — pin the accept-refresh too: 2 scans at 300ms = 1 accept              | rejection refreshes `lastAt`, suppressing all 5 into 1             |
| T-B192 (REG-B192)          | 3 distinct codes arrive while a resolve is in flight / pending buffer / all 3 resolve in order, buffer depth capped at 2 with dedupe, `isResolving` true during flight                                               | busyRef drops all 3 silently                                       |
| T-B193 (REG-B193)          | two wedge bursts 80ms apart / submit handler / field cleared synchronously at first submit; second burst resolves separately; no concatenated lookup ever issued (spy)                                               | clear-on-accept concatenates into one garbage code                 |
| T-B194 (REG-B194)          | line holds plain qty 10 (no boxes/pieces) / incrementLine (+1 box, upb 24) / result = normalizeBoxesPieces over 10 + 24 units — typed qty folded, never discarded                                                    | boxed branch discards prev.qty ⇒ 1 box                             |
| T-B195 (REG-B195)          | inactive product with matching barcode / resolve ladder / outcome `archived` (distinct from notFound), NOT auto-added; draft-resume keeps the line flagged                                                           | barcode rung adds it; search rung says notFound; resume deletes it |
| T-B196a (REG-B196)         | POST /orders times out while NetInfo online / api-client interceptor / NOT enqueued; error surfaces (failure path visible)                                                                                           | ECONNABORTED classified as offline ⇒ enqueue                       |
| T-B196b (REG-B196)         | a queued action's replay times out / drain / the SAME entry increments its retry count; queue length unchanged (spy: no second enqueue)                                                                              | fresh config loses `_offlineQueued` ⇒ self-duplication             |
| T-B196c (REG-B196)         | two POSTs with the same Idempotency-Key (tenant-scoped fake store) / create / one order row; second call returns the first order, no side effects re-run                                                             | no idempotency exists                                              |
| T-B143 (REG-B143 REG-B111) | drain hits a 409 and a retry-exhausted entry / useNetworkSync / both land in persisted `failedActions` with reasons; NOTHING silently dequeued; alert fired                                                          | both silently evaporate                                            |
| T-B151 (REG-B151)          | showToast on iOS (Platform mocked) / toast host present / InlineToast invoked; host absent / Alert fallback                                                                                                          | iOS branch is a bare fallthrough                                   |
| T-B197 (REG-B197)          | diff-add with one unresolvable productId among two good / updateOrderItems / 400 naming the id; NO partial write (fake-store row counts unchanged)                                                                   | `continue` ⇒ 200 with the line missing                             |
| T-B198 (REG-B198)          | id-less add-only PATCH payload, `replaceAll` absent / updateOrderItems / treated as ADD (existing lines survive); `replaceAll:true` still replaces                                                                   | shape-inference wipes the order                                    |
| T-B199 (REG-B199)          | staff create-merge: existing line 2 boxes; incoming 5 pieces, upb 24 / merge / boxes 2 + pieces 5 via normalizeBoxesPieces; unitPrice/notes preserved; two concurrent merges serialized by the tx claim (fake store) | flatten sums 2+5=7 "boxes" — repriced ×24 overcharge               |
| T-B200 (REG-B200)          | CUSTOMER-role token / buyer scan lookup / 200 for a catalog-visible product, 404 for a hidden one, scoped to the buyer's seller                                                                                      | both rungs 403                                                     |
| T-B201 (REG-B201)          | settled search re-fires after a slow refetch with the field already cleared / auto-add guard / no phantom add                                                                                                        | stale settle re-adds                                               |

Red gate: `cd apps/mobile && npx jest --silent -t "REG-B(19[0-6]|143|151|201)"` and
`cd apps/api && npx jest --silent -t "REG-B(19[6-9]|200)"` — expect fail (note REG-B196 spans
both homes: a/b mobile, c api). Every mechanism above is pure-function-extractable; where a fix
requires extracting logic from a component to test it (gate, buffer, wedge submit), the
extraction IS part of the package.

Vacuity: fake stores partition by tenant for the api half (the prisma-mock pass-through cannot
prove R9-R11's scoping); NetInfo/Platform mocked at module boundary per house convention.
