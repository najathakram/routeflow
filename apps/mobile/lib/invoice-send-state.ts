/**
 * #2088: the one implementation lives in `@routeflow/types` (`invoice-send-state.ts` there); this re-export keeps
 * mobile and web from drifting (same pattern as `lib/read-only-copy.ts`). The SUBPATH import matters: jest stubs the
 * types package ROOT and resolves this subpath to source (jest.config.js).
 */
export {
  EMAIL_AGAIN_STATUSES,
  sendsAfterLabel,
  canEmailAgain,
  invoiceResendCopy,
  invoiceSendStateLine,
  type InvoiceResendCopy,
  type InvoiceSendLock,
  type InvoiceSendState,
  type InvoiceSendStateName,
} from "@routeflow/types/invoice-send-state";
