# Landing batch 2026-09-29 — late (mobile side, through #2756)

Docs-only bookkeeping (Option B) for the mobile PR of the same batch, each grepped in the merged tree
at HEAD (`62c62c6af`). API/web/tooling PRs are in
[../api/landing-2026-09-29-late.md](../api/landing-2026-09-29-late.md); none of them touched
`apps/mobile`.

- **#2760 (B901) scan-tray price modal hidden behind the scan sheet on iOS, `31ee88587`:** iOS cannot present a Modal over a Modal (it queues the second until the first dismisses) and `ScanOrderSheet` is itself a Modal. New `apps/mobile/lib/scan-price-edit.ts` exports `SCAN_CLOSE_FALLBACK_MS` (450) and pure `planScanPriceEdit(scanOpen, platform)` (scan closed -> present `now`; iOS -> close scan, present from `onDismiss`; else present on a `timer`; `resumeScanOnClose` true whenever scan was open). New `lib/use-scan-price-edit.ts` exports `useScanPriceEdit({scanOpen, setScanOpen, setPriceEditId})` returning `onTrayEditPrice`, `handleScanSheetDismiss`, `closePriceEdit` (reopens the scanner via the resume flag; unmount clears the pending timer). `components/NewOrderScreen.tsx` replaces its inline `onTrayEditPrice` with the hook and passes `onDismiss={handleScanSheetDismiss}`; `components/ScanOrderSheet.tsx` gains an optional `onDismiss` prop forwarded to its `Modal`. Gotcha: `Modal` `onDismiss` fires on iOS only, so the timer path must stay Android/web-only; close the price modal with `closePriceEdit`, never a bare `setPriceEditId(null)`. Specs: `__tests__/scan-price-edit.test.ts` (plan cases + hook source pins), `new-order-durability.test.ts`.
