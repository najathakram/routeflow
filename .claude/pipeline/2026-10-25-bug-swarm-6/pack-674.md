ebc237be009b73e56e4f5d15934ed3d7921be02d
# Row 674 View in Supplier Bills 404 (FIXED-ON-MASTER)
Evidence: apps/web/app/(dashboard)/vendor-bills/page.tsx:2016 title 'View in supplier bills'; finance/statements/page.tsx:374 href /vendor-bills/${billId}; vendor-bills/linked-bill-href-404.test.ts pins no /finance/vendor-bills route.
Real route: vendor-bills/[id]/page.tsx exists; finance/vendor-bills does not.
Radius: vendor-bills/page.tsx, finance/statements/page.tsx, linked-bill-href-404.test.ts.
Lessons: L-305 enumerate link surfaces by search.
