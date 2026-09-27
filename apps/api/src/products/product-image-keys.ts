import { BadRequestException } from "@nestjs/common";

/**
 * #2533 (SECURITY): a product's `imageKeys` may only ever name files under THAT product's own
 * storage prefix, `products/<productId>/…`, the only shape `ProductsService.uploadImage` mints.
 * Product ids are tenant-owned, so the prefix is the tenant boundary.
 *
 * Before this, `PATCH /products/:id` stored any key list verbatim, and the server SIGNS whatever
 * is stored (signed URLs bypass UploadsController's owner check), so a tenant could plant another
 * tenant's key (a logo, a payment image, a PDF) and read it; `deleteImage` would even delete it.
 * Now:
 *   - on write, a new list may only REORDER or DROP the keys the product already holds, and every
 *     key must sit under its own prefix (`assertImageKeysReorder`); new images arrive only through
 *     the upload endpoint;
 *   - at sign time (defence in depth), keys outside the product's prefix are never signed
 *     (`signableImageKeys`), so a row poisoned before this fix leaks nothing.
 */
export function isOwnProductImageKey(productId: string, key: unknown): key is string {
  if (typeof key !== "string" || !productId) return false;
  const prefix = `products/${productId}/`;
  if (!key.startsWith(prefix) || key.length === prefix.length) return false;
  // No traversal or nesting tricks: exactly one segment after the product prefix.
  const rest = key.slice(prefix.length);
  return !rest.includes("/") && !rest.includes("\\") && rest !== "." && rest !== "..";
}

/** The subset of `keys` this product may have signed (order kept). */
export function signableImageKeys(productId: string, keys: readonly string[] | null | undefined) {
  return (keys ?? []).filter((k) => isOwnProductImageKey(productId, k));
}

/** The first signable key (thumbnails), or null. */
export function firstSignableImageKey(
  productId: string,
  keys: readonly string[] | null | undefined,
) {
  return signableImageKeys(productId, keys)[0] ?? null;
}

/**
 * A PATCH's `imageKeys` may only reorder or drop the product's CURRENT keys, each under its own
 * prefix, with no duplicates. Anything else is a 400; nothing is written.
 */
export function assertImageKeysReorder(
  productId: string,
  current: readonly string[],
  next: readonly string[],
): void {
  const held = new Set(current);
  const seen = new Set<string>();
  for (const key of next) {
    if (!isOwnProductImageKey(productId, key) || !held.has(key))
      throw new BadRequestException(
        "imageKeys may only reorder or remove this product's own images; upload new images instead",
      );
    if (seen.has(key)) throw new BadRequestException("imageKeys must not repeat a key");
    seen.add(key);
  }
}
