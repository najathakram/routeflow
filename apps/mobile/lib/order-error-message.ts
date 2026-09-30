import {
  insufficientStockSentence,
  parseInsufficientStock,
} from "@routeflow/types/api/insufficient-stock";

/** Text for a failed order create / add / edit: a stock shortfall reads as a sentence ("Only 4
 *  Mango left."), never the server's raw text; anything else keeps the server message, then the
 *  error's own message, then `fallback`. Pure — unit-testable without RN. */
export function orderErrorMessage(err: unknown, fallback: string): string {
  const short = parseInsufficientStock(err);
  if (short) return insufficientStockSentence(short.lines);
  const e = err as { response?: { data?: { message?: string } }; message?: string } | null;
  return e?.response?.data?.message ?? e?.message ?? fallback;
}
