import type { ParsedCustomerName } from "./types";

/**
 * Splits "Parent:Job" at the FIRST colon. The full trimmed name is the source key, so each job
 * is bound on its own and never folded into its parent. Job text is kept as written (trimmed).
 */
export function parseCustomerName(raw: string): ParsedCustomerName {
  const sourceKey = raw.trim();
  const cut = sourceKey.indexOf(":");
  if (cut === -1) return { sourceKey, parent: sourceKey, job: null };
  const job = sourceKey.slice(cut + 1).trim();
  return { sourceKey, parent: sourceKey.slice(0, cut).trim(), job: job === "" ? null : job };
}
