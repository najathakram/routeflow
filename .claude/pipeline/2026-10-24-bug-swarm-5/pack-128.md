aceb7686baef4832c824ca29d43d3143f878c497
# row 128 scan-to-PO router.push (LIVE)
Evidence: apps/web/app/(dashboard)/purchase-orders/ScanPoButton.tsx:50 onDrafted(po.id); purchase-orders/page.tsx:49 passes setHighlightId; no router.push anywhere.
Signatures: export function ScanPoButton({ onDrafted }: { onDrafted: (poId: string) => void })
Radius: ScanPoButton.tsx, ScanPoButton.test.tsx, purchase-orders/page.tsx, scan-po-lock.ts
Lessons: L-200 UI control change: grep other entry points; L-258 stable testids. Web only, keep toast+highlight.
