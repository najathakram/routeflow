import { BadRequestException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * SA-1161: the buyer edit allowlist. A CUSTOMER's order edit may carry only the shape the buyer screens send; any other
 * field, on the body or on an entry, is refused 400 `BUYER_EDIT_INPUT_NOT_ALLOWED` before any read-for-write or write.
 *
 * The lists mirror `BUYER_EDIT_ENTRY_FIELDS` / `BUYER_EDIT_BODY_FIELDS` in `packages/types/api/buyer-order-edit.ts`
 * (the API keeps its own copy, as it does for the error codes); `buyer-edit-input.parity.spec.ts` holds them equal.
 */
export const BUYER_EDIT_ENTRY_FIELDS: readonly string[] = ["productId", "qty", "orderItemId"];
export const BUYER_EDIT_BODY_FIELDS: readonly string[] = [
  "items",
  "namesLines",
  "expectedRevisionNumber",
];

export const BUYER_EDIT_INPUT_NOT_ALLOWED_MESSAGE =
  "This change can't be made here. Refresh the order and try again.";

const present = (o: unknown): string[] =>
  o && typeof o === "object"
    ? Object.entries(o as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k)
    : [];

/** True when the body or any entry carries a present field outside the two lists. */
export function buyerEditInputRefused(dto: unknown): boolean {
  const body = dto as { items?: unknown } | null | undefined;
  if (present(body).some((k) => !BUYER_EDIT_BODY_FIELDS.includes(k))) return true;
  const items = Array.isArray(body?.items) ? (body.items as unknown[]) : [];
  return items.some((e) => present(e).some((k) => !BUYER_EDIT_ENTRY_FIELDS.includes(k)));
}

export function assertBuyerEditInput(dto: unknown): void {
  if (buyerEditInputRefused(dto)) {
    throw new BadRequestException({
      code: API_ERROR_CODES.BUYER_EDIT_INPUT_NOT_ALLOWED,
      message: BUYER_EDIT_INPUT_NOT_ALLOWED_MESSAGE,
    });
  }
}
