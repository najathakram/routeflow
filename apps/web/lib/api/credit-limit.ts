import { creditLimitSentence } from "@/lib/credit-limit-copy";

/**
 * The 409 `{ code: "CREDIT_LIMIT_EXCEEDED", limit, exposure, message }` the credit guard throws when
 * an order edit / send-out / delivery would push the customer's exposure over their limit. Returns
 * the server's own numbers and a fixed sentence built from them (B986), or null for any other error.
 * Mirrors apps/mobile/lib/credit-limit-error.ts. There is NO server-side override — the only exits
 * are to collect a payment (reduces exposure) or to cancel the change.
 */
export interface CreditLimitInfo {
  limit: number;
  exposure: number;
  /** A fixed sentence built from the structured numbers (never the server's text). */
  message: string;
}

export function parseCreditLimitError(err: unknown): CreditLimitInfo | null {
  const res = (
    err as {
      response?: {
        status?: number;
        data?: { code?: string; limit?: unknown; exposure?: unknown };
      };
    }
  )?.response;
  if (res?.status !== 409 || res.data?.code !== "CREDIT_LIMIT_EXCEEDED") return null;
  return {
    limit: Number(res.data.limit ?? 0) || 0,
    exposure: Number(res.data.exposure ?? 0) || 0,
    // B986: a FIXED sentence built from the body's structured numbers, never the server's own text.
    message: creditLimitSentence(res.data.limit, res.data.exposure),
  };
}
