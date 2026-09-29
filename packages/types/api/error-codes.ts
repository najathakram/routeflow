// ─── Machine-readable API error codes clients branch on (#2163) ─────────────────
//
// Web and mobile used to match these as string literals, so a server-side rename
// silently dropped a client back to generic copy. The client side imports the named
// constants below. The API cannot import this package at runtime (its dist runs this
// package's TypeScript source through node), so it keeps its own literal copy in
// `apps/api/src/common/api-error-codes.ts`, pinned here two ways: `satisfies
// ApiErrorCode` at compile time, and set-equality in
// `apps/api/src/common/api-error-codes-parity.spec.ts` (the L-072 pattern for enums).
//
// Where each code travels:
//   MAILBOX_*        — the ForbiddenException MESSAGE (`body.message`), mailbox connect/confirm.
//   ADDON_GATE       — `body.code` of AddonGuard's 403.
//   UNLINKED_ITEMS, PACK_SIZE_UNKNOWN, DUPLICATE_VENDOR_BILL — `body.code` of vendor-bill 409s.
//   CLEANUP_IMPORTED_DISABLED — `body.code` of the customers cleanup-preview / cleanup-imported
//                    409 (#2629, disabled until a real import marker exists).
//   ORDER_LINE_CHANGED — `body.code` of the order-line CAS 409 (invoice-from-order paths:
//                    qty/price/tax/pack changed mid-create; nothing billed, retriable).
//   NSF_LINE_UNTAXED — `body.code` of the 400 when an invoice write gives the NSF fee line a
//                    tax rate (#2656: the NSF line is never taxed; clients lock the field at 0).
//   BARCODE_TAKEN — `body.code` of the 409 a product barcode write answers when another product
//                    of the same tenant already holds the code (#2717 M1, SA-572b Q3); body also
//                    carries `barcode` and the holder's `productId`.
//   RECIPE_IMMUTABLE — `body.code` of the 409 when a recipe that is ACTIVE or RETIRED is edited
//                    in place (#2717 M2, I3); clone it with POST /recipes/:id/versions instead.
//   RECIPE_CATEGORY_LOCKED — `body.code` of the 409 when a product that sits in a non-RETIRED
//                    recipe (as recipe product, family or component) changes its tracked category.
//   RECIPE_FAMILY_LOCKED — `body.code` of the 409 when a product in a DRAFT/ACTIVE recipe is re-parented
//                    (component) or has its unitsPerBox changed (family or recipe product);
//                    `body.reason` is PARENT or UNITS_PER_BOX (#2717 M2, SA-584 B2).
//   RECIPE_ACTIVE_CONFLICT — `body.code` of the 409 when another activation won the race for the
//                    same recipe product; re-read and retry.
//   RECIPE_VERSION_CONFLICT — `body.code` of the 409 when another new version took the number.
//   RECIPE_INVALID — `body.code` of a recipe create/edit rejection; `body.reason` names the rule
//                    (400 for a shape rule, 409 for a product that already has a recipe).
//   FAMILY_PRICE_AUTHORITY — `body.code` of the 409 a variant price write answers while the
//                    tenant's mixed_packs mode is on and the family owns the price; body carries
//                    `familyId`.

export const API_ERROR_CODES = {
  ADDON_GATE: "ADDON_GATE",
  MAILBOX_CONNECT_SECRET_MISMATCH: "mailbox_connect_secret_mismatch",
  MAILBOX_CONFIRM_IDENTITY_MISMATCH: "mailbox_confirm_identity_mismatch",
  UNLINKED_ITEMS: "UNLINKED_ITEMS",
  PACK_SIZE_UNKNOWN: "PACK_SIZE_UNKNOWN",
  DUPLICATE_VENDOR_BILL: "DUPLICATE_VENDOR_BILL",
  CLEANUP_IMPORTED_DISABLED: "CLEANUP_IMPORTED_DISABLED",
  ORDER_LINE_CHANGED: "ORDER_LINE_CHANGED",
  NSF_LINE_UNTAXED: "NSF_LINE_UNTAXED",
  BARCODE_TAKEN: "BARCODE_TAKEN",
  RECIPE_IMMUTABLE: "RECIPE_IMMUTABLE",
  RECIPE_CATEGORY_LOCKED: "RECIPE_CATEGORY_LOCKED",
  RECIPE_FAMILY_LOCKED: "RECIPE_FAMILY_LOCKED",
  RECIPE_ACTIVE_CONFLICT: "RECIPE_ACTIVE_CONFLICT",
  RECIPE_VERSION_CONFLICT: "RECIPE_VERSION_CONFLICT",
  RECIPE_INVALID: "RECIPE_INVALID",
  FAMILY_PRICE_AUTHORITY: "FAMILY_PRICE_AUTHORITY",
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

export const API_ERROR_CODE_VALUES = Object.values(API_ERROR_CODES) as readonly ApiErrorCode[];
