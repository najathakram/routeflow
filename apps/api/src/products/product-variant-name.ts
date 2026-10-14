/**
 * B1: a family variant stores ONLY its own label ("Classic") in `name` / `variantName`; every read composes
 * "<Parent> - <Variant>" for display (`productDisplayName`). A client that sends the composed display name back
 * ("Acme - Classic") used to be stored verbatim, so each edit re-prefixed it ("Acme - Acme - Classic").
 *
 * THE ONE NORMALISER: every write of a variant's name / variantName goes through `stripParentPrefix` (directly, or via
 * `bareVariantNames` / `bareRowNames`); `variant-name-writers-census.spec.ts` turns a writer that does not into a red build.
 *
 * Strips REPEATED leading "<parent full name> - " prefixes. Both sides are compared NFC-normalised, trimmed, with
 * internal whitespace collapsed and case-folded ("ACME  -  acme - Classic" under "Acme" -> "Classic"). Only the parent's
 * FULL name plus the separator counts, never a partial word ("Acmeberry - X" under "Acme" is untouched). The stored
 * remainder keeps its own casing. A value that is nothing but the prefix(es) is left exactly as sent, so the name-rules
 * guard still sees what the caller typed rather than an empty label; an untouched value is returned as given.
 */
export function stripParentPrefix(value: string, parentName: string | null | undefined): string {
  const tokens = (parentName ?? "").normalize("NFC").trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return value;
  const name = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  const leading = new RegExp(`^\\s*${name}\\s+-\\s+`, "iu");
  const prefixOnly = new RegExp(`^\\s*${name}\\s+-\\s*$`, "iu");
  let bare = value.normalize("NFC");
  let stripped = false;
  for (;;) {
    const m = leading.exec(bare);
    if (!m) break;
    const rest = bare.slice(m[0].length);
    if (rest.trim().length === 0) break;
    bare = rest;
    stripped = true;
  }
  if (!stripped || prefixOnly.test(bare.trim())) return value;
  return bare.trim();
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

/**
 * Writers that hold a batch of rows and already know the parent's name (family create / add / rename, a grid):
 * rewrites each row's `name` in place to its bare label.
 */
export function bareRowNames(
  rows: Array<{ name?: string }>,
  parentName: string | null | undefined,
): void {
  for (const row of rows) {
    if (typeof row.name === "string") row.name = stripParentPrefix(row.name, parentName);
  }
}
