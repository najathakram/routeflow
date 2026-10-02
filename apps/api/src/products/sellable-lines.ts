import { BadRequestException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * WS8 (SA-606): a FAMILY (kind FAMILY) is a non-stocked, NON-SELLABLE container. Every writer of an order / invoice /
 * estimate / PO line calls this with the products it is about to put on a line: a FAMILY is a 400 FAMILY_NOT_SELLABLE
 * (server refusal, never just a hidden picker row). The writers are listed in `family-writers-tripwire.spec.ts`.
 */
export function assertSellableLines(
  products: ReadonlyArray<{ id: string; name?: string | null; kind?: string | null }>,
): void {
  const families = products.filter((p) => p.kind === "FAMILY");
  if (families.length === 0) return;
  const names = families.slice(0, 3).map((p) => `"${p.name ?? p.id}"`);
  throw new BadRequestException({
    code: API_ERROR_CODES.FAMILY_NOT_SELLABLE,
    message:
      families.length === 1
        ? `${names[0]} is a product family, not a sellable item. Add one of its variants instead.`
        : `${families.length} product families can't be sold as lines (${names.join(", ")}${
            families.length > 3 ? ", …" : ""
          }). Add their variants instead.`,
    productIds: families.map((p) => p.id),
  });
}
