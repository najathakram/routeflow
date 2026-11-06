ebc237be009b73e56e4f5d15934ed3d7921be02d
# W-879 SKU drops first letter (UNCLEAR)
Evidence: products.service.ts:847-861 and inventory.service.ts:493-505 build prefix from name.replace(/[^a-zA-Z]/g,'').slice(0,3) + '-' + 4 hex; correct first letter, format LLL-XXXX. Reported 'OTTLED504' (no dash, 3 digits) matches no generator on master. No source found by grep across apps/packages.
Needs: reproduce in a UI path (ProductCreateModal.tsx:413 sends form.sku||undefined) or a mobile/import path.
Signatures: ProductsService.create(dto); InventoryService.generateVariantSku(name).
Lessons: none direct; L-167 one shared builder for duplicated logic.
