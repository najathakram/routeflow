import type { ParsedCustomerName } from "./types";

export function parseCustomerName(raw: string): ParsedCustomerName {
  return { sourceKey: raw, parent: raw, job: null };
}
