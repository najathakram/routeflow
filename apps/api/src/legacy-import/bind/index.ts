export * from "./types";
export { parseCustomerName } from "./parse-customer-name";
export {
  customerNameScore,
  normalizeCustomerName,
  suggestCustomers,
  NEAR_CUSTOMER_THRESHOLD,
} from "./customer-score";
export { resolveCustomerBinding } from "./resolve-customer";
