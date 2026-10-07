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

/**
 * B1216 (server half): a FAMILY is a container, never sold, so it never carries a customer price override or a
 * promotion (the variants do). Same refusal style as `assertSellableLines`: 400 FAMILY_NOT_PRICEABLE naming every
 * family. `subject` only shapes the sentence ("customer price" / "promotion").
 */
export function assertNoFamilyProducts(
  products: ReadonlyArray<{ id: string; name?: string | null; kind?: string | null }>,
  subject: "customer price" | "promotion",
): void {
  const families = products.filter((p) => p.kind === "FAMILY");
  if (families.length === 0) return;
  const names = families.slice(0, 3).map((p) => `"${p.name ?? p.id}"`);
  const list = `${names.join(", ")}${families.length > 3 ? ", …" : ""}`;
  throw new BadRequestException({
    code: API_ERROR_CODES.FAMILY_NOT_PRICEABLE,
    message:
      families.length === 1
        ? `${names[0]} is a product family, not a sellable item, so it cannot have a ${subject}. Use one of its variants instead.`
        : `${families.length} product families cannot have a ${subject} (${list}). Use their variants instead.`,
    productIds: families.map((p) => p.id),
  });
}
