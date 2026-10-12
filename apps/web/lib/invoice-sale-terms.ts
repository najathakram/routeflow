/**
 * CQ-26: a counter sale paid at the till is settled the moment it is rung, so its invoice shows no payment terms and no due
 * date. The predicate lives in `@routeflow/pricing` (row 401: the PDF, the e-mail and mobile read the SAME rule); this module
 * keeps the web import path.
 */
export {
  AT_SALE_WINDOW_MS,
  isPaidAtSale,
  isPaymentTermsText,
  termsAndConditionsToShow,
} from "@routeflow/pricing";
export type { PaidAtSaleInvoice } from "@routeflow/pricing";
