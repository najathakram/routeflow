import type { CustomerCandidate, RfCustomerRow } from "./types";

export const NEAR_CUSTOMER_THRESHOLD = 0.6;

export function normalizeCustomerName(raw: string): string {
  return raw;
}

export function customerNameScore(_a: string, _b: string): number {
  return 1;
}

export function suggestCustomers(
  _name: string,
  _customers: RfCustomerRow[],
  _limit = 5,
): CustomerCandidate[] {
  return [];
}
