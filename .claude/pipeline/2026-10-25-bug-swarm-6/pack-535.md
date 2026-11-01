ebc237be009b73e56e4f5d15934ed3d7921be02d
# Row 535 Variant modal flips during fade-out (LIVE)
Evidence: apps/web/app/(dashboard)/products/[id]/page.tsx:811-813 closeVariantModal sets editingVariant null immediately; :2580 title and :2590 button label ('Save Changes'/'Create Variant') derive from editingVariant, so label flips while Modal fades.
Fix shape: keep last editingVariant until onExitComplete or derive label from a ref.
Signatures: closeVariantModal(); variantModalTitle(isEdit) in ./LegacyVariantsActions.
Radius: products/[id]/page.tsx, LegacyVariantsActions.tsx.
Lessons: L-322 repoint static pins.
