/**
 * SA-1299 P4 (B1396, B1385): the one implementation lives in `@routeflow/types` (`payment-refusal-copy.ts` there), so
 * web and mobile cannot drift (same pattern as `lib/read-only-copy.ts`). The SUBPATH import matters: jest stubs the types
 * package ROOT and resolves this subpath to source (jest.config.js).
 */
export {
  ADVANCE_NOT_AVAILABLE_COPY,
  DRAFT_PAYMENT_HAS_EXCESS_COPY,
  INVOICE_NOT_PAYABLE_COPY,
  INVOICE_NOT_PAYABLE_DEFAULT_COPY,
  paymentRefusalCopy,
} from "@routeflow/types/payment-refusal-copy";
