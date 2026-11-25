import type { CustomerBindingRow, CustomerBindResult, RfCustomerRow } from "./types";

export function resolveCustomerBinding(
  name: string,
  _customers: RfCustomerRow[],
  _bindings: CustomerBindingRow[],
): CustomerBindResult {
  return {
    status: "BOUND",
    sourceKey: name,
    parent: name,
    job: null,
    boundCustomerId: "wrong",
    canPost: true,
    candidates: [],
    rowError: null,
  };
}
