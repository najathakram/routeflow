# Landing batch 2026-09-27 — night (after #2517)

Docs-only bookkeeping (Option B) for the code PRs landed on master after `a1ef8e75`, one bullet per
PR, each checked against the merged tree.

- **#2390 operator edit-items.tsx sliced into components/edit-items, `ec1a9503`:** behaviour-neutral prefactor (#2340, epic #2328). `app/(operator)/(tabs)/orders/[id]/edit-items.tsx` drops from ~3,326 to ~1,400 lines (size-ratchet baseline lowered in the same PR). Moved verbatim (plus `export`) to `components/edit-items/`: `DraftItemCard.tsx` (`DraftItemCard` + `StepperRow`), `PriceOverrideModal.tsx`, `UnlistedDraft.tsx` (`UnlistedDraftCard` + `UnlistedItemModal`), `CreateCreditNoteModal.tsx`, `ProductPicker.tsx` (`PickedProduct` + `ProductPicker`), `styles.ts` (the shared StyleSheet); `marginFloorPrice` → `lib/margin-floor-price.ts`. `components/EditItemsStepperRow.tsx` (#2444) is unchanged. Source-pin tests read the moved code through `__tests__/support/edit-items-source.ts`. Also carries a Prettier-only reflow of web `RecordInlineReturnDialog.tsx` (master's copy was unformatted since #2467; the class #2484 gates). Closes #2340.
