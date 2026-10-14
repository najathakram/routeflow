/**
 * #2088: the one implementation lives in `@routeflow/types` (`invoice-send-state.ts` there); this re-export keeps web
 * and mobile from drifting (same pattern as `lib/read-only-copy.ts`). The SUBPATH import matters for mobile's jest,
 * which stubs the types package root.
 */
export {
  EMAIL_AGAIN_STATUSES,
  SENDS_AFTER_DELIVERY_COPY,
  SENDS_AFTER_DELIVERY_SHORT,
  canEmailAgain,
  invoiceResendCopy,
  type InvoiceResendCopy,
  type InvoiceSendLock,
  type InvoiceSendState,
  type InvoiceSendStateName,
} from "@routeflow/types/invoice-send-state";
