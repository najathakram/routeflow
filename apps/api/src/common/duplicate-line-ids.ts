import { BadRequestException } from "@nestjs/common";
import { API_ERROR_CODES } from "./api-error-codes";

/**
 * F3: an edit array that names the same stored line twice is ambiguous (which quantity wins?) and used
 * to plan, then write, one line against two entries. Payload-only and pure: call it at the top of an
 * edit method, before any read, lock or write. An entry names a line with `id` (staff/invoice) or
 * `orderItemId` (buyer); entries naming none are NEW lines and never collide with each other.
 */
export function assertNoDuplicateLineIds(
  entries: ReadonlyArray<{ id?: string | null; orderItemId?: string | null }> | null | undefined,
): void {
  const seen = new Set<string>();
  for (const entry of entries ?? []) {
    // One entry naming the same line by both fields is still one mention.
    const named = new Set([entry?.id, entry?.orderItemId].filter((v): v is string => !!v));
    for (const lineId of named) {
      if (seen.has(lineId)) {
        throw new BadRequestException({
          code: API_ERROR_CODES.DUPLICATE_LINE_ID,
          message: "A line appears twice in this edit. Refresh the page and try again.",
        });
      }
      seen.add(lineId);
    }
  }
}
