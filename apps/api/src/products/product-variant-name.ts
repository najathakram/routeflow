import { PRODUCT_NAME_SEPARATOR } from "./product-display-name";

/**
 * B1: a family variant stores ONLY its own label ("Classic") in `name` / `variantName`; every read composes
 * "<Parent> - <Variant>" for display (`productDisplayName`). A client that sends the composed display name back
 * ("Acme - Classic") used to be stored verbatim, so each edit re-prefixed it ("Acme - Acme - Classic").
 *
 * Strips one OR MORE leading "<parentName> - " prefixes (case-sensitive, the exact string the composers build) so
 * only the bare label is stored. A value that is nothing but the prefix(es) is left as sent, so the name-rules
 * guard still sees what the caller typed rather than an empty label.
 */
export function stripParentPrefix(value: string, parentName: string | null | undefined): string {
  if (!parentName) return value;
  const prefix = `${parentName}${PRODUCT_NAME_SEPARATOR}`;
  let bare = value;
  while (bare.startsWith(prefix) && bare.slice(prefix.length).trim().length > 0) {
    bare = bare.slice(prefix.length);
  }
  return bare;
}

type NameDto = { name?: string; variantName?: string | null };
type ParentLookup = {
  product: {
    findFirst: (args: { where: { id: string }; select: { name: true } }) => Promise<unknown>;
  };
};

/**
 * update(): rewrites `dto.name` / `dto.variantName` in place to their bare labels when the product's effective
 * parent is `parentId`. One tenant-scoped read of the parent's name, and only when a name field is present on a
 * product that has a parent; a standalone product (or an unreadable / foreign parent) is left untouched.
 */
export async function bareVariantNames(
  db: ParentLookup,
  dto: NameDto,
  parentId: string | null | undefined,
): Promise<void> {
  if (!parentId || (dto.name === undefined && dto.variantName == null)) return;
  const parent = (await db.product.findFirst({
    where: { id: parentId },
    select: { name: true },
  })) as {
    name: string;
  } | null;
  if (!parent) return;
  if (typeof dto.name === "string") dto.name = stripParentPrefix(dto.name, parent.name);
  if (typeof dto.variantName === "string") {
    dto.variantName = stripParentPrefix(dto.variantName, parent.name);
  }
}
