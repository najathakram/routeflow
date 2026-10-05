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
//   CODE_TAKEN     — `body.code` of the 409 when a product sku / unit code (a barcode answers
//                    BARCODE_TAKEN) is held by another ACTIVE product of the tenant (SA-603a); body
//                    carries `field` (sku | unitSku), `value`, the holder's `productId` and `productName`.
//   CATALOG_TOO_LARGE_FOR_CLEAR_ALL — `body.code` of the 409 from DELETE /products/clear-all AND DELETE /products/bulk (both soft-delete through one code-lock set) when that set holds more
//                    than 1,000 distinct codes (one advisory lock per code is held to COMMIT; Opus/SA #2860). Delete in smaller batches.
//   CODES_CHANGED — `body.code` of the 409 when a deactivation finds a live code of the product that was NOT in the
//                    code-lock set the writer took up front (the codes changed under it): retry (Opus #2860 R1).
//   HOLDERS_CHANGED — `body.code` of the 409 when `deactivateHolderIds` was sent on a reactivation but NOTHING blocks it any
//                    more (`holders: []`). A set that is merely stale/wrong answers with the conflict shape instead
//                    (CODE_TAKEN / BARCODE_TAKEN / NAME_TAKEN) carrying the CURRENT `holders[]` (SA-603i).
//   FAMILY_NOT_SELLABLE — `body.code` of the 400 when a FAMILY container (kind FAMILY) is named on an order, invoice,
//                    estimate or PO line; `productIds` names them (WS8: a family is non-stocked and non-sellable).
//   FAMILY_ROWS_CONFLICT — `body.code` of the 409 from POST /products/families and PATCH /products/:id/variants: `rows` lists
//                    EVERY conflicting row (see FamilyRowsConflictError), never just the first.
//   FAMILY_NOT_FOUND — `body.code` of the 404 from PATCH /products/:id/variants when `:id` is not a product of the tenant.
//   NAME_TAKEN     — `body.code` of the 409 when reactivating a product whose name an ACTIVE product of
//                    the same scope now holds (SA-603a/b); body carries the holder's `productId`/`productName`.
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
//   FAMILY_COPY_PRICE_REQUIRED — `body.code` of the 400 a family create answers when copyFamilyPrice is set and the
//                    family price is missing or rounds to <= 0 (nothing is written).
//   FIXED_WHOLE_BOXES / COMPOSED_UNIT_LINE / RECIPE_PACK_MISMATCH / COMPONENT_SUM_MISMATCH —
//                    `body.code` of a mixed-pack (FIXED) line write refusal (#2717 M3): loose pieces
//                    (400), a unit-aware line (400), a recipe pack size that differs from the line's
//                    (409), and component pieces that do not add up to the line's pieces (400, I12).
//   COMPOSITION_CORRUPT — `body.code` of the 500 when a line's stored composition does not divide
//                    into whole boxes; a server tripwire, never a client-fixable input.
//   COMPOSED_LINE_EDIT — `body.code` of the 409 when a DRAFT invoice edit changes a mixed-pack line
//                    by anything other than whole boxes or a price (#2717 M3).
//   INVENTORY_SETTING_INVALID — `body.code` of the 400 when PATCH /settings/inventory gets a
//                    `buyerOversell` that is not exactly "off" or "backorder"; `details.field` names it.
//   TENANT_CONTEXT_REQUIRED — `body.code` of the 403 the messaging delivery-log / health / staff-email-settings
//                    endpoints answer when the caller has no tenant context (SUPER_ADMIN without an
//                    impersonated tenant): their unscoped client would read or write another tenant's rows.
//   STAFF_CC_INVALID — `body.code` of the 400 a PUT /messaging/staff-email-settings answers for a
//                    bad "Also send to" list; `body.details` is `{ index, reason }` (WS4, SA-606).
//   CREDIT_NOTE_*  — `body.code` of the credit-note edit / reissue / void refusals (#2648, #2848; the
//                    SA-608 closed set). The client maps each to FIXED copy and never renders the
//                    server message. 409: VOID_NOT_EDITABLE (the note is void), RETURN_BACKED (edit the
//                    return instead), CREDIT_CONSUMED (credit used where a reversal cannot reach),
//                    OVER_HEADROOM (the new amount exceeds what the source invoice still allows),
//                    SOURCE_GONE (the source invoice is gone or no longer creditable), NO_SOURCE_CAP (a
//                    note with no source invoice can't be increased), CHANGED_CONCURRENTLY (another
//                    change was in progress, or the note changed mid-edit; retry), KEY_REUSED (the
//                    Idempotency-Key was used for a different edit). 400: KEY_REQUIRED (no
//                    Idempotency-Key), EXPIRY_PAST (the expiry is, or already was, in the past),
//                    EXPIRY_NOT_EDITABLE (only an ISSUED note's expiry can change), LINES_REQUIRED (a
//                    line-linked note must restate its lines), LINE_INVALID (a malformed credit line).
//   CUSTOMER_NOT_LINKED — `body.code` of the 403 a CUSTOMER login gets from /orders when no live
//                    Customer record is linked to that user (B917, REG-B131 refusal, status unchanged).
//   TEXT_CELL_FORMULA_LEAD — `body.code` of the 400 a customer / tenant NAME write answers when the name
//                    starts with = + - @ or a tab/line break (B956, SA-629f); `body.field` names the
//                    field (businessName, contactName, displayName). Clients show FIXED copy with a
//                    human field label and never the server message.
//   B982 — codes the API threw as hand-typed literals, now named here. Each is `body.code` of the refusal
//                    its throw site names (value == key, byte-identical to what was sent):
//                    PLAN_GATE / PLAN_GATE_UNAVAILABLE (billing/plan-gate.ts, plan-flag-denial.ts), READ_ONLY
//                    (tenant-status.guard.ts: a blocked write on a READ_ONLY tenant; the same word is also a
//                    tenant STATUS value, which is not an error code), INSUFFICIENT_STOCK (the order-edit
//                    oversell 409), the INLINE_RETURN_* family (returns/inline-returns*.ts, returns.service.ts),
//                    UNIT_AWARE_LINE, MERGE_PACK_MISMATCH, ORDER_CHANGED_DURING_EDIT, CONCURRENT_UPDATE,
//                    MERGE_IN_PROGRESS, LOCK_UNAVAILABLE (order/customer contention), PO_ALREADY_BILLED,
//                    BILL_EXCEEDS_PO (vendor bills), INVOICE_HAS_UNSPENT_CREDIT (credit notes),
//                    HANDOFF_CODE_INVALID (auth handoff).
//   B987-A — orders / routes / products / selling-restrictions refusals, now named here (value == key, byte-identical to what
//                    was sent): the change-request family (CHANGE_REQUEST_*, CHANGE_WINDOW_CLOSED, EDIT_WINDOW_OPEN, INVALID_*),
//                    order line and credit guards (LINE_ALREADY_DELIVERED, ORDER_BELOW_RETURN_CREDIT, CREDIT_LIMIT_EXCEEDED,
//                    MERGE_CHOICE_REQUIRED, SOURCE_LINE_*, UNIT_AWARE_LINE_UNVERIFIABLE, UNIT_NOT_OFFERED), route dispatch
//                    (FEATURE_MODE, RUN_ALREADY_SETTLED, STOP_ALREADY_COMPLETED, STOP_SKIPPED) and the selling-restrictions
//                    409s (SELLING_RESTRICTED, SELLING_RESTRICTIONS_NOT_READY). SELLING_RESTRICTED is also a suspension REASON
//                    value in recurring invoices / order templates, which is data, not an error code.
//   B987-B — vendor-bill / supplier-statement / inventory / invoice refusals, now named here (value == key, byte-identical to what
//                    was sent): PO_LINK_CONFLICT, PO_LINK_BROKEN, SCAN_ALREADY_POSTED (vendor-bill scan and PO link), the AI_* scan
//                    failures (AI_KEY_INVALID, AI_SCAN_REJECTED, AI_UNAVAILABLE, AI_PARSE_FAILED: vendor-bill and statement scans),
//                    INSUFFICIENT_UNASSIGNED, PO_LOT_PARTIALLY_CONSUMED, PO_HAS_LINKED_BILL, INVENTORY_LEDGER_GAP (inventory),
//                    ALLOCATIONS_EXCEED_PAYMENT, INVOICE_CHANGED_DURING_EDIT (invoices) and EMAIL_NOT_CONFIGURED / EMAIL_SEND_FAILED
//                    (invoice send, buyer merge verification email).
//   B987-C — billing / tenants / auth / authorizations / customers / promotions / platform-admin refusals, now named here (value == key,
//                    byte-identical to what was sent): ADDON_DEFAULT_GRANTED, EXPIRES_AT_MUST_BE_FUTURE, FEATURE_KEY_UNKNOWN,
//                    FEATURE_MODE_REQUIRES, FEATURE_REQUIRES_UNMET, PLAN_CHANGED_DURING_SUBSCRIBE (billing), FEATURES_UNAVAILABLE (tenants),
//                    HANDOFF_NOT_CONFIGURED, HANDOFF_ROLE_NOT_ALLOWED (auth handoff), REGULATED_AUTH_REQUIRED (authorizations),
//                    WALLET_LOCK_BUSY (customers), PROMOTION_ZERO_PRICE (promotions), UNEXPLAINED_DIFFS (platform-admin). The AI_* union in
//                    finance.ts is derived from the constants above.
//   B987-C (onboarding) — the onboarding case and intake refusals: INTAKE_ANSWERS_INVALID, INTAKE_ORDER_NOT_READY, INTAKE_SECTION_LOCKED,
//                    INTAKE_SECTION_NOT_REVIEWABLE, ONBOARDING_BOOKING_HAS_CASE, ONBOARDING_CASE_CLOSED, ONBOARDING_CASE_NOT_OPEN,
//                    ONBOARDING_GATE_BLOCKED, ONBOARDING_SIGN_OFF_NOT_AVAILABLE, ONBOARDING_STEP_BEHIND_GATE, ONBOARDING_STEP_NOT_PENDING,
//                    ONBOARDING_STEP_NOT_REACHED, ONBOARDING_STEP_WAIVED (value == key, byte-identical to what was sent).
//   B987-D — regulated / common refusals, now named here (value == key, byte-identical to what was sent): MONEY_INVARIANT (the 400 of
//                    assertMoneyInvariantsOrThrow; the pricing package's MoneyInvariantError keeps its own literal because pricing may not
//                    value-import this package), PARKED_REVERSALS_UNRESOLVED and PARKED_REVERSAL_UNRESOLVABLE (the 409s of the regulated
//                    report and the parked-reversal resolver), REGULATED_POD_REQUIRED (the 400s of the regulated proof-of-delivery guard).
//   B987-E1 — import and statement/payment refusals that now carry a code and structured fields (status and message unchanged):
//                    IMPORT_COLUMN_NEEDS_ENTITLEMENT — `body.code` of the import 403 when a CSV column needs an entitlement the tenant lacks;
//                    body carries `requires` (MSRP | TOBACCO_DEALER | FORECASTING) and `column` (the user's own header, capped at 120).
//                    INSIGHT_WINDOW_INVALID — `body.code` of the products export's 400 when its from/to window is refused; body carries
//                    `reason` (NOT_A_DAY | TO_NOT_A_DAY | FROM_NOT_A_DAY | BAD_GRAIN | TO_BEFORE_FROM | WINDOW_TOO_LONG | TOO_MANY_BUCKETS)
//                    and numeric params (maxMonths, buckets, maxBuckets) or a validated grain; the message is unchanged. Opt-in: other
//                    endpoints that map InsightWindowError keep their code-less body.
//                    STATEMENT_APPLY_* — `body.code` of the 400s of POST /supplier-statements/:id/apply (SA-634; status and message
//                    unchanged; numbers are the same rounded values the message interpolates): DISCARDED, NOT_MATCHED, NOTHING (no
//                    fields); DUPLICATE_BILL {billId: a REQUEST ECHO}; WRONG_SUPPLIER, BILL_VOID, BILL_DRAFT {billId, billNumber,
//                    line: CONFIRMED | IMPLIED_PAID}; NO_BACKING_LINE {billId, billNumber}; OVER_LINE {billId, billNumber, amount,
//                    lineAmount}; OVER_BALANCE {billId, billNumber, amount, remaining}. An unknown or other tenant's bill id stays the
//                    uncoded 404.
//                    SUPPLIER_PAYMENT_* / SUPPLIER_ALLOCATION* — `body.code` of the 400s of recording a supplier payment (SA-634; status and
//                    message unchanged): SUPPLIER_PAYMENT_NOT_POSITIVE {}; SUPPLIER_PAYMENT_FULLY_PAID {billId: a REQUEST ECHO of the path
//                    id}; SUPPLIER_PAYMENT_OVER_BALANCE {remaining}; SUPPLIER_ALLOCATIONS_EXCEED_PAYMENT {allocatedTotal: the rounded
//                    requested sum the message prints, totalAmount: the request's UNROUNDED value}; SUPPLIER_ALLOCATION_WRONG_SUPPLIER and
//                    SUPPLIER_ALLOCATION_BILL_VOID {billId, billNumber}; SUPPLIER_ALLOCATION_OVER_BALANCE {billId, billNumber, amount,
//                    remaining}. An unknown or other tenant's bill id stays the uncoded 404.

//   Counter sales (POST /orders/counter-sale) — `body.code` of its refusals, raised BEFORE anything is written: 403
//                    COUNTER_SALES_DISABLED (the tenant's fulfilment capability has no counter); 409 WALK_IN_OPEN_CREDIT (the walk-in
//                    customer holds open credit that send would auto-apply); 400 WALK_IN_NO_ACCOUNT (a walk-in cannot buy on account),
//                    WALK_IN_WITH_CUSTOMER (customerId and walkIn together), COUNTER_CHECK_NUMBER_REQUIRED (a check needs its number),
//                    IDEMPOTENCY_KEY_REQUIRED (the Idempotency-Key header is missing or blank: the till must send one per sale).
//                    COUNTER_TENDER_SHORT (a zero tender), COUNTER_PAYMENT_EXCEEDS_TOTAL (card or check above the balance) and
//                    COUNTER_PAYMENT_NOT_RECORDED are NOT HTTP errors: the balance is server-computed, so these are the
//                    `paymentErrorCode` of a 201 whose sale committed but whose payment did not (`paymentRecorded: false`, the invoice
//                    stays open on account; the same Idempotency-Key retried with a corrected payment finishes it). A tender BELOW
//                    the balance is not an error: it records a PARTIAL payment (`paymentRecorded: true`, `balanceDue` > 0, no change).

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
  CODE_TAKEN: "CODE_TAKEN",
  NAME_TAKEN: "NAME_TAKEN",
  HOLDERS_CHANGED: "HOLDERS_CHANGED",
  FAMILY_NOT_SELLABLE: "FAMILY_NOT_SELLABLE",
  FAMILY_ROWS_CONFLICT: "FAMILY_ROWS_CONFLICT",
  FAMILY_NOT_FOUND: "FAMILY_NOT_FOUND",
  CODES_CHANGED: "CODES_CHANGED",
  CATALOG_TOO_LARGE_FOR_CLEAR_ALL: "CATALOG_TOO_LARGE_FOR_CLEAR_ALL",
  RECIPE_IMMUTABLE: "RECIPE_IMMUTABLE",
  RECIPE_CATEGORY_LOCKED: "RECIPE_CATEGORY_LOCKED",
  RECIPE_FAMILY_LOCKED: "RECIPE_FAMILY_LOCKED",
  RECIPE_ACTIVE_CONFLICT: "RECIPE_ACTIVE_CONFLICT",
  RECIPE_VERSION_CONFLICT: "RECIPE_VERSION_CONFLICT",
  RECIPE_INVALID: "RECIPE_INVALID",
  FAMILY_PRICE_AUTHORITY: "FAMILY_PRICE_AUTHORITY",
  FAMILY_COPY_PRICE_REQUIRED: "FAMILY_COPY_PRICE_REQUIRED",
  FIXED_WHOLE_BOXES: "FIXED_WHOLE_BOXES",
  COMPOSED_UNIT_LINE: "COMPOSED_UNIT_LINE",
  RECIPE_PACK_MISMATCH: "RECIPE_PACK_MISMATCH",
  COMPONENT_SUM_MISMATCH: "COMPONENT_SUM_MISMATCH",
  COMPOSITION_CORRUPT: "COMPOSITION_CORRUPT",
  COMPOSED_LINE_EDIT: "COMPOSED_LINE_EDIT",
  INVENTORY_SETTING_INVALID: "INVENTORY_SETTING_INVALID",
  STAFF_CC_INVALID: "STAFF_CC_INVALID",
  TENANT_CONTEXT_REQUIRED: "TENANT_CONTEXT_REQUIRED",
  CREDIT_NOTE_VOID_NOT_EDITABLE: "CREDIT_NOTE_VOID_NOT_EDITABLE",
  CREDIT_NOTE_RETURN_BACKED: "CREDIT_NOTE_RETURN_BACKED",
  CREDIT_NOTE_CREDIT_CONSUMED: "CREDIT_NOTE_CREDIT_CONSUMED",
  CREDIT_NOTE_OVER_HEADROOM: "CREDIT_NOTE_OVER_HEADROOM",
  RETURN_REFUND_OVER_LINE_HEADROOM: "RETURN_REFUND_OVER_LINE_HEADROOM",
  RETURN_MIXED_UNIT_PRODUCT: "RETURN_MIXED_UNIT_PRODUCT",
  CREDIT_NOTE_SOURCE_GONE: "CREDIT_NOTE_SOURCE_GONE",
  CREDIT_NOTE_NO_SOURCE_CAP: "CREDIT_NOTE_NO_SOURCE_CAP",
  CREDIT_NOTE_CHANGED_CONCURRENTLY: "CREDIT_NOTE_CHANGED_CONCURRENTLY",
  CREDIT_NOTE_KEY_REUSED: "CREDIT_NOTE_KEY_REUSED",
  CREDIT_NOTE_KEY_REQUIRED: "CREDIT_NOTE_KEY_REQUIRED",
  CREDIT_NOTE_EXPIRY_PAST: "CREDIT_NOTE_EXPIRY_PAST",
  CREDIT_NOTE_EXPIRY_NOT_EDITABLE: "CREDIT_NOTE_EXPIRY_NOT_EDITABLE",
  CREDIT_NOTE_LINES_REQUIRED: "CREDIT_NOTE_LINES_REQUIRED",
  CREDIT_NOTE_LINE_INVALID: "CREDIT_NOTE_LINE_INVALID",
  CUSTOMER_NOT_LINKED: "CUSTOMER_NOT_LINKED",
  BILL_STATE_CHANGED: "BILL_STATE_CHANGED",
  BILL_VOID: "BILL_VOID",
  RETURN_NOTHING_BILLED: "RETURN_NOTHING_BILLED",
  INVOICE_CHANGED_CONCURRENTLY: "INVOICE_CHANGED_CONCURRENTLY",
  TEXT_CELL_FORMULA_LEAD: "TEXT_CELL_FORMULA_LEAD",
  PLAN_GATE: "PLAN_GATE",
  PLAN_GATE_UNAVAILABLE: "PLAN_GATE_UNAVAILABLE",
  READ_ONLY: "READ_ONLY",
  INSUFFICIENT_STOCK: "INSUFFICIENT_STOCK",
  INLINE_RETURN_ORDER_NOT_FOUND: "INLINE_RETURN_ORDER_NOT_FOUND",
  INLINE_RETURN_ORDER_CUSTOMER_MISMATCH: "INLINE_RETURN_ORDER_CUSTOMER_MISMATCH",
  INLINE_RETURN_ORDER_CANCELLED: "INLINE_RETURN_ORDER_CANCELLED",
  INLINE_RETURN_KEY_CONFLICT: "INLINE_RETURN_KEY_CONFLICT",
  INLINE_RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS: "INLINE_RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS",
  INLINE_RETURN_KEY_TAKEN: "INLINE_RETURN_KEY_TAKEN",
  INLINE_RETURN_ALREADY_RETURNED_REASON_REQUIRED: "INLINE_RETURN_ALREADY_RETURNED_REASON_REQUIRED",
  INLINE_RETURN_PRIOR_BASIS_UNKNOWN: "INLINE_RETURN_PRIOR_BASIS_UNKNOWN",
  INLINE_RETURN_PACK_CONFLICT: "INLINE_RETURN_PACK_CONFLICT",
  INLINE_RETURN_PACK_UNKNOWN: "INLINE_RETURN_PACK_UNKNOWN",
  INLINE_RETURN_USE_INLINE_ENDPOINTS: "INLINE_RETURN_USE_INLINE_ENDPOINTS",
  UNIT_AWARE_LINE: "UNIT_AWARE_LINE",
  MERGE_PACK_MISMATCH: "MERGE_PACK_MISMATCH",
  ORDER_CHANGED_DURING_EDIT: "ORDER_CHANGED_DURING_EDIT",
  ORDER_WITH_CARRIER_NO_CANCEL: "ORDER_WITH_CARRIER_NO_CANCEL",
  CONCURRENT_UPDATE: "CONCURRENT_UPDATE",
  MERGE_IN_PROGRESS: "MERGE_IN_PROGRESS",
  LOCK_UNAVAILABLE: "LOCK_UNAVAILABLE",
  PO_ALREADY_BILLED: "PO_ALREADY_BILLED",
  BILL_EXCEEDS_PO: "BILL_EXCEEDS_PO",
  INVOICE_HAS_UNSPENT_CREDIT: "INVOICE_HAS_UNSPENT_CREDIT",
  HANDOFF_CODE_INVALID: "HANDOFF_CODE_INVALID",
  CHANGE_REQUEST_ALREADY_RESOLVED: "CHANGE_REQUEST_ALREADY_RESOLVED",
  CHANGE_REQUEST_PACK_CHANGED: "CHANGE_REQUEST_PACK_CHANGED",
  CHANGE_WINDOW_CLOSED: "CHANGE_WINDOW_CLOSED",
  EDIT_WINDOW_OPEN: "EDIT_WINDOW_OPEN",
  INVALID_LINE_SPLIT: "INVALID_LINE_SPLIT",
  INVALID_RESOLUTION_FOR_TYPE: "INVALID_RESOLUTION_FOR_TYPE",
  LINE_PACK_UNDERIVABLE: "LINE_PACK_UNDERIVABLE",
  LINE_ALREADY_DELIVERED: "LINE_ALREADY_DELIVERED",
  ORDER_BELOW_RETURN_CREDIT: "ORDER_BELOW_RETURN_CREDIT",
  CREDIT_LIMIT_EXCEEDED: "CREDIT_LIMIT_EXCEEDED",
  MERGE_CHOICE_REQUIRED: "MERGE_CHOICE_REQUIRED",
  SOURCE_LINE_AMBIGUOUS: "SOURCE_LINE_AMBIGUOUS",
  SOURCE_LINE_INVALID: "SOURCE_LINE_INVALID",
  UNIT_AWARE_LINE_UNVERIFIABLE: "UNIT_AWARE_LINE_UNVERIFIABLE",
  UNIT_NOT_OFFERED: "UNIT_NOT_OFFERED",
  FEATURE_MODE: "FEATURE_MODE",
  RUN_ALREADY_SETTLED: "RUN_ALREADY_SETTLED",
  STOP_ALREADY_COMPLETED: "STOP_ALREADY_COMPLETED",
  STOP_SKIPPED: "STOP_SKIPPED",
  SELLING_RESTRICTED: "SELLING_RESTRICTED",
  SELLING_RESTRICTIONS_NOT_READY: "SELLING_RESTRICTIONS_NOT_READY",
  PO_LINK_CONFLICT: "PO_LINK_CONFLICT",
  SCAN_ALREADY_POSTED: "SCAN_ALREADY_POSTED",
  PO_LINK_BROKEN: "PO_LINK_BROKEN",
  AI_KEY_INVALID: "AI_KEY_INVALID",
  AI_SCAN_REJECTED: "AI_SCAN_REJECTED",
  AI_UNAVAILABLE: "AI_UNAVAILABLE",
  AI_PARSE_FAILED: "AI_PARSE_FAILED",
  INSUFFICIENT_UNASSIGNED: "INSUFFICIENT_UNASSIGNED",
  PO_LOT_PARTIALLY_CONSUMED: "PO_LOT_PARTIALLY_CONSUMED",
  PO_HAS_LINKED_BILL: "PO_HAS_LINKED_BILL",
  INVENTORY_LEDGER_GAP: "INVENTORY_LEDGER_GAP",
  ALLOCATIONS_EXCEED_PAYMENT: "ALLOCATIONS_EXCEED_PAYMENT",
  INVOICE_CHANGED_DURING_EDIT: "INVOICE_CHANGED_DURING_EDIT",
  EMAIL_NOT_CONFIGURED: "EMAIL_NOT_CONFIGURED",
  EMAIL_SEND_FAILED: "EMAIL_SEND_FAILED",
  ADDON_DEFAULT_GRANTED: "ADDON_DEFAULT_GRANTED",
  EXPIRES_AT_MUST_BE_FUTURE: "EXPIRES_AT_MUST_BE_FUTURE",
  FEATURE_KEY_UNKNOWN: "FEATURE_KEY_UNKNOWN",
  FEATURE_MODE_REQUIRES: "FEATURE_MODE_REQUIRES",
  FEATURE_REQUIRES_UNMET: "FEATURE_REQUIRES_UNMET",
  PLAN_CHANGED_DURING_SUBSCRIBE: "PLAN_CHANGED_DURING_SUBSCRIBE",
  FEATURES_UNAVAILABLE: "FEATURES_UNAVAILABLE",
  FULFILMENT_MODE_NEEDS_FLEET: "FULFILMENT_MODE_NEEDS_FLEET",
  HANDOFF_NOT_CONFIGURED: "HANDOFF_NOT_CONFIGURED",
  HANDOFF_ROLE_NOT_ALLOWED: "HANDOFF_ROLE_NOT_ALLOWED",
  REGULATED_AUTH_REQUIRED: "REGULATED_AUTH_REQUIRED",
  WALLET_LOCK_BUSY: "WALLET_LOCK_BUSY",
  PROMOTION_ZERO_PRICE: "PROMOTION_ZERO_PRICE",
  UNEXPLAINED_DIFFS: "UNEXPLAINED_DIFFS",
  INTAKE_ANSWERS_INVALID: "INTAKE_ANSWERS_INVALID",
  INTAKE_ORDER_NOT_READY: "INTAKE_ORDER_NOT_READY",
  INTAKE_SECTION_LOCKED: "INTAKE_SECTION_LOCKED",
  INTAKE_SECTION_NOT_REVIEWABLE: "INTAKE_SECTION_NOT_REVIEWABLE",
  ONBOARDING_BOOKING_HAS_CASE: "ONBOARDING_BOOKING_HAS_CASE",
  ONBOARDING_CASE_CLOSED: "ONBOARDING_CASE_CLOSED",
  ONBOARDING_CASE_NOT_OPEN: "ONBOARDING_CASE_NOT_OPEN",
  ONBOARDING_GATE_BLOCKED: "ONBOARDING_GATE_BLOCKED",
  ONBOARDING_SIGN_OFF_NOT_AVAILABLE: "ONBOARDING_SIGN_OFF_NOT_AVAILABLE",
  ONBOARDING_STEP_BEHIND_GATE: "ONBOARDING_STEP_BEHIND_GATE",
  ONBOARDING_STEP_NOT_PENDING: "ONBOARDING_STEP_NOT_PENDING",
  ONBOARDING_STEP_NOT_REACHED: "ONBOARDING_STEP_NOT_REACHED",
  ONBOARDING_STEP_WAIVED: "ONBOARDING_STEP_WAIVED",
  MONEY_INVARIANT: "MONEY_INVARIANT",
  PARKED_REVERSALS_UNRESOLVED: "PARKED_REVERSALS_UNRESOLVED",
  PARKED_REVERSAL_UNRESOLVABLE: "PARKED_REVERSAL_UNRESOLVABLE",
  REGULATED_POD_REQUIRED: "REGULATED_POD_REQUIRED",
  IMPORT_COLUMN_NEEDS_ENTITLEMENT: "IMPORT_COLUMN_NEEDS_ENTITLEMENT",
  INSIGHT_WINDOW_INVALID: "INSIGHT_WINDOW_INVALID",
  STATEMENT_APPLY_DISCARDED: "STATEMENT_APPLY_DISCARDED",
  STATEMENT_APPLY_NOT_MATCHED: "STATEMENT_APPLY_NOT_MATCHED",
  STATEMENT_APPLY_NOTHING: "STATEMENT_APPLY_NOTHING",
  STATEMENT_APPLY_DUPLICATE_BILL: "STATEMENT_APPLY_DUPLICATE_BILL",
  STATEMENT_APPLY_WRONG_SUPPLIER: "STATEMENT_APPLY_WRONG_SUPPLIER",
  STATEMENT_APPLY_BILL_VOID: "STATEMENT_APPLY_BILL_VOID",
  STATEMENT_APPLY_BILL_DRAFT: "STATEMENT_APPLY_BILL_DRAFT",
  STATEMENT_APPLY_NO_BACKING_LINE: "STATEMENT_APPLY_NO_BACKING_LINE",
  STATEMENT_APPLY_OVER_LINE: "STATEMENT_APPLY_OVER_LINE",
  STATEMENT_APPLY_OVER_BALANCE: "STATEMENT_APPLY_OVER_BALANCE",
  SUPPLIER_PAYMENT_NOT_POSITIVE: "SUPPLIER_PAYMENT_NOT_POSITIVE",
  SUPPLIER_PAYMENT_FULLY_PAID: "SUPPLIER_PAYMENT_FULLY_PAID",
  SUPPLIER_PAYMENT_OVER_BALANCE: "SUPPLIER_PAYMENT_OVER_BALANCE",
  SUPPLIER_ALLOCATIONS_EXCEED_PAYMENT: "SUPPLIER_ALLOCATIONS_EXCEED_PAYMENT",
  SUPPLIER_ALLOCATION_WRONG_SUPPLIER: "SUPPLIER_ALLOCATION_WRONG_SUPPLIER",
  SUPPLIER_ALLOCATION_BILL_VOID: "SUPPLIER_ALLOCATION_BILL_VOID",
  SUPPLIER_ALLOCATION_OVER_BALANCE: "SUPPLIER_ALLOCATION_OVER_BALANCE",
  COUNTER_SALES_DISABLED: "COUNTER_SALES_DISABLED",
  WALK_IN_NO_ACCOUNT: "WALK_IN_NO_ACCOUNT",
  WALK_IN_WITH_CUSTOMER: "WALK_IN_WITH_CUSTOMER",
  WALK_IN_OPEN_CREDIT: "WALK_IN_OPEN_CREDIT",
  COUNTER_TENDER_SHORT: "COUNTER_TENDER_SHORT",
  COUNTER_CHECK_NUMBER_REQUIRED: "COUNTER_CHECK_NUMBER_REQUIRED",
  COUNTER_PAYMENT_EXCEEDS_TOTAL: "COUNTER_PAYMENT_EXCEEDS_TOTAL",
  COUNTER_PAYMENT_NOT_RECORDED: "COUNTER_PAYMENT_NOT_RECORDED",
  /**
   * 409 on a createSale replay whose order was changed (e.g. cancelled) after the first attempt. The sale
   * EXISTS — the client must treat it as an UNKNOWN outcome: never as "nothing was charged", never drop the
   * Idempotency-Key and re-ring (that would double-sell). Open the order from the orders list instead.
   */
  COUNTER_SALE_ORDER_CHANGED: "COUNTER_SALE_ORDER_CHANGED",
  /** 400 on deactivating, deleting or merging the tenant's system walk-in customer (counter sales own it). */
  WALK_IN_PROTECTED: "WALK_IN_PROTECTED",
  /**
   * 404 from GET /orders/counter-sale/by-key/:key: NO sale exists for this Idempotency-Key in this tenant.
   * A definitive answer (unlike a timeout): the clerk may ring the sale again with a new key.
   */
  COUNTER_SALE_NOT_FOUND: "COUNTER_SALE_NOT_FOUND",
  IDEMPOTENCY_KEY_REQUIRED: "IDEMPOTENCY_KEY_REQUIRED",
} as const;

/** The `flag` of a PLAN_GATE body that gates a count (a meter), not a feature flag. Not an error code. */
export const PLAN_GATE_FLAG_KEYS = {
  METER_CUSTOMERS: "meter.customers",
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

export const API_ERROR_CODE_VALUES = Object.values(API_ERROR_CODES) as readonly ApiErrorCode[];

/** The closed set of credit-note refusal codes (#2648/#2848): the UI maps each to fixed copy. */
export const CREDIT_NOTE_ERROR_CODES = [
  API_ERROR_CODES.CREDIT_NOTE_VOID_NOT_EDITABLE,
  API_ERROR_CODES.CREDIT_NOTE_RETURN_BACKED,
  API_ERROR_CODES.CREDIT_NOTE_CREDIT_CONSUMED,
  API_ERROR_CODES.CREDIT_NOTE_OVER_HEADROOM,
  API_ERROR_CODES.CREDIT_NOTE_SOURCE_GONE,
  API_ERROR_CODES.CREDIT_NOTE_NO_SOURCE_CAP,
  API_ERROR_CODES.CREDIT_NOTE_CHANGED_CONCURRENTLY,
  API_ERROR_CODES.CREDIT_NOTE_KEY_REUSED,
  API_ERROR_CODES.CREDIT_NOTE_KEY_REQUIRED,
  API_ERROR_CODES.CREDIT_NOTE_EXPIRY_PAST,
  API_ERROR_CODES.CREDIT_NOTE_EXPIRY_NOT_EDITABLE,
  API_ERROR_CODES.CREDIT_NOTE_LINES_REQUIRED,
  API_ERROR_CODES.CREDIT_NOTE_LINE_INVALID,
] as const;

export type CreditNoteErrorCode = (typeof CREDIT_NOTE_ERROR_CODES)[number];
