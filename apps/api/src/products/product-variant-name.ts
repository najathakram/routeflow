import { BadRequestException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * B1: a family variant stores ONLY its own label ("Classic") in `name` / `variantName`; every read composes
 * "<Parent> - <Variant>" for display (`productDisplayName`). A client that sends the composed display name back
 * ("Acme - Classic") used to be stored verbatim, so each edit re-prefixed it ("Acme - Acme - Classic").
 *
 * THE ONE NORMALISER: every write of a variant's name / variantName goes through `bareVariantLabel` (directly, or via
 * `bareVariantNames` / `bareRowNames`); `variant-name-writers-census.spec.ts` turns a writer that does not into a red build.
 * `bareVariantLabel` is `stripParentPrefix` plus the refusal below; only a read-only comparison may call the pure function.
 *
 * Strips REPEATED leading "<parent full name> - " prefixes. Both sides are compared NFC-normalised, trimmed, with
 * internal whitespace collapsed and case-folded ("ACME  -  acme - Classic" under "Acme" -> "Classic"). Only the parent's
 * FULL name plus the separator counts, never a partial word ("Acmeberry - X" under "Acme" is untouched). The stored
 * remainder keeps its own casing. A value that is nothing but the prefix(es) is left exactly as sent; an untouched value is
 * returned as given. A WRITER never stores that value: `bareVariantLabel` refuses it (R3, below).
 */
export function stripParentPrefix(value: string, parentName: string | null | undefined): string {
  const name = parentPattern(parentName);
  if (!name) return value;
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

/** The parent's name as a regex source (tokens joined by `\s+`, metacharacters escaped), or null with no usable name. */
function parentPattern(parentName: string | null | undefined): string | null {
  const tokens = (parentName ?? "").normalize("NFC").trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
}

/**
 * R3: true when `value` is nothing but the parent's name and the separator, any number of times ("Acme - ", "ACME -",
 * "acme  -  Acme -"): there is no label left to store. The bare family name with no separator is a real name and is not.
 */
export function isPrefixOnly(value: string, parentName: string | null | undefined): boolean {
  const name = parentPattern(parentName);
  if (!name) return false;
  return new RegExp(`^\\s*(?:${name}\\s*-\\s*)+$`, "iu").test(value.normalize("NFC"));
}

/**
 * The ONE write-side normaliser: the bare label to store for `value` under `parentName`. A prefix-only value is a coded
 * 400 (`VARIANT_NAME_PREFIX_ONLY`), never stored and never an empty bare name.
 */
export function bareVariantLabel(value: string, parentName: string | null | undefined): string {
  if (isPrefixOnly(value, parentName)) {
    throw new BadRequestException({
      code: API_ERROR_CODES.VARIANT_NAME_PREFIX_ONLY,
      message:
        "A variant name can't be just the product name. Type what makes it different, such as a flavor or size.",
      field: "name",
    });
  }
  return stripParentPrefix(value, parentName);
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
  // both judged before either is written back, so a refusal leaves the dto as sent
  const name = typeof dto.name === "string" ? bareVariantLabel(dto.name, parent.name) : undefined;
  const variantName =
    typeof dto.variantName === "string"
      ? bareVariantLabel(dto.variantName, parent.name)
      : undefined;
  if (name !== undefined) dto.name = name;
  if (variantName !== undefined) dto.variantName = variantName;
}

/**
 * Writers that hold a batch of rows and already know the parent's name (family create / add / rename, a grid):
 * rewrites each row's `name` in place to its bare label.
 */
export function bareRowNames(
  rows: Array<{ name?: string }>,
  parentName: string | null | undefined,
): void {
  const bare = rows.map((row) =>
    typeof row.name === "string" ? bareVariantLabel(row.name, parentName) : undefined,
  );
  rows.forEach((row, i) => {
    if (bare[i] !== undefined) row.name = bare[i];
  });
}
