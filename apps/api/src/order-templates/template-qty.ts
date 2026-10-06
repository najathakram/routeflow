import { BadRequestException } from "@nestjs/common";

/**
 * A standing-order line quantity must be a positive number. The route DTOs already say so (a whole number
 * >= 1), but a DTO only guards a route that uses one; this is the service-level backstop for every entry
 * (create, update, add-item) and for every run (manual reorder and the daily cron), so a non-positive,
 * fractional-NaN or non-finite quantity can never reach an order or the stock decrement.
 */
export function assertPositiveTemplateQty(
  items: ReadonlyArray<{ qty: unknown }> | null | undefined,
): void {
  for (const item of items ?? []) {
    const q = Number(item.qty);
    if (!Number.isFinite(q) || q <= 0) {
      throw new BadRequestException("A template line quantity must be greater than zero.");
    }
  }
}
