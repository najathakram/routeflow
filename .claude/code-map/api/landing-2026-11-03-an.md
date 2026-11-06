# Api landing 2026-11-03, train am (merge commit `06813470de`, range `1f6f32a341..06813470de`; train PR #4171, head `d57a308b89`)

Paths under `apps/api/` unless they start with `apps/web/` or `packages/`. Three members: #4166 `d68ce0f740` (api + web + types, T1), #4169 `4de22404b4` (`packages/pricing` + one web test), #4157 `081b8fcc3e` (web only). **No migration**, no cron, no plan flag or addon gate, no new env var, no route. Web side: `web/landing-2026-11-03-an.md`. Tests are named from the diff and the PR text and were not run for this note.

## #4166 `d68ce0f740` editing a stored box-split line reads the pack the line was sold in (SA-1097 A-2/A-3/A-4/A-6)

Rule: a stored box-split line with no pack snapshot is re-split at its own pack, never today's product pack. On master the edit read the live product, so a delivered line re-priced at the new pack and the sent invoice followed in the same call.

- `orders/live-pack-map.ts` (`packForLineEdit`): the pack comes from the line's own evidence (snapshot, then its own split, then the stored money vouching for the live candidate); a line none of that can read is refused with `STORED_LINE_PACK_UNREADABLE` and nothing is written; a payload whose qty and split disagree at the line's own pack is refused with `QTY_SPLIT_MISMATCH` (`common/api-error-codes.ts`, `packages/types/api/error-codes.ts`). Gated on `boxes != null OR pieces != null`, the census predicate.
- `orders/orders.service.ts`: the two write sites take the one helper, `updateOrderItems` and the at-door CHANGE_QTY (`wasBoxSplit`); the edit-path add stamps `unitsPerBox` when either of boxes or pieces is set and the product has a pack. `orders/order-edit-restrictions.ts` follows.
- Tests: `orders/unit-line-split.spec.ts`; `orders/a2-delivered-line-live-pack.db.spec.ts` and `orders/a2-at-stop-change-qty-stored-pack.db.spec.ts` (DB lane); the class pin `common/no-bare-line-math.spec.ts` (PINNED_B gains `orders/live-pack-map.ts`, an edit site) and `products/line-units-callsites.spec.ts`.

## #4169 `4de22404b4` a unit labelled "each" stays "each" in the plural

- `packages/pricing/src/unit-words.ts`: `INVARIANT` gains "each" (it read "eaches"); `unit-words.spec.ts` rows; `pricing.ts`/`pricing.spec.ts` follow for #4166's pack helper. Every importer (api, web, mobile, control) gets it.

## #4157

- No api source; see `web/landing-2026-11-03-an.md`.
