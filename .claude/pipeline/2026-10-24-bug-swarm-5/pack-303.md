aceb7686baef4832c824ca29d43d3143f878c497
# row 303 receipt lineDetail parity (FIXED-ON-MASTER)
Evidence: apps/api/src/documents/receipt-model.ts:192-203 lineDetail delegates to pricing receiptLineDetail incl. unit (product.unit); :247 note: clean(l.notes). Shared home exists.
Signatures: function lineDetail(l: ReceiptLineInput): string; export buildReceiptModel(...)
Radius: receipt-model.ts, packages/pricing receiptLineDetail, web receipt print
Lessons: L-322 move-only extraction: repoint source pins.
