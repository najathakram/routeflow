ebc237be009b73e56e4f5d15934ed3d7921be02d
# W-694 SearchableProductPicker no Tab/blur close (LIVE)
Evidence: apps/web/components/SearchableProductPicker.tsx:189-201 only a document mousedown outside handler closes; no onBlur/Tab handling in it or apps/web/lib/use-listbox-nav.ts (grep Tab/onBlur empty); onClose at :208.
Signatures: SearchableProductPicker; useListboxNav<T>({items,open,onPick,onClose,resetKey,initial,idPrefix}).
Radius: SearchableProductPicker.tsx (+a11y/family/wedge-scan-race tests), use-listbox-nav.ts, consumers: orders/page.tsx, QuickRestockModal, GroupAsVariantsModal, ProductCreateModal, InlineCreateProductModal, ScanInvoiceModal, BatchItemReviewModal, vendor-bills/[id]/page.tsx.
Lessons: L-305 enumerate surfaces; L-322 repoint pins.
