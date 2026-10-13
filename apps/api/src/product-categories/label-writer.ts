import { Prisma } from "@prisma/client";

/**
 * THE single writer of product label memberships (`ProductCategoryLabel`). Everything that adds, flips
 * or stamps a membership goes through here: the admin endpoint (`ProductLabelsAdminService.setLabel`),
 * the add-only sync on a product write (`syncCategoryLabel`) and the one-off backfill script
 * (`apps/api/scripts/labels-from-categories.mjs`, through the compiled `dist` copy of this file).
 * `label-pin-single-writer.spec.ts` keeps the opt-out pin's only author in `setLabel`, which hands the row data here.
 *
 * Plain functions over a transaction client (no Nest), so the script can call the same code the API runs.
 */

/** A label's name as text: NFC, trimmed, inner whitespace collapsed. "" = blank (never a label). */
export function labelText(raw: string | null | undefined): string {
  return (raw ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
}

/** The match key: `labelText`, case-folded. Two texts with one key are the SAME label. "" = no label. */
export function labelNameKey(raw: string | null | undefined): string {
  return labelText(raw).toLowerCase();
}

/**
 * How long a label write waits for the per-category advisory lock. Kept well inside Prisma's 5 s
 * interactive-transaction budget: a longer wait would surface contention as an opaque P2028
 * (transaction expired) instead of a clear 409.
 */
const LOCK_WAIT = "2s";

export class LabelLockTimeoutError extends Error {
  constructor() {
    super("Another label change for this category is in progress. Try again in a moment.");
    this.name = "LabelLockTimeoutError";
  }
}

/** Postgres `lock_not_available` (SQLSTATE 55P03), however Prisma wraps it (P2010 raw error / message). */
function isLockTimeout(e: unknown): boolean {
  const err = e as { meta?: { code?: string }; message?: string };
  return err?.meta?.code === "55P03" || /55P03|lock timeout/i.test(err?.message ?? "");
}

/**
 * Serialise label writes per (tenant, category): a transaction-scoped advisory lock with a bounded wait.
 * The caller's own `lock_timeout` is RESTORED afterwards (a script that set one keeps it).
 */
/** The caller's lock_timeout, to restore after a bounded lock wait ('0' = Postgres's default, no limit). */
async function currentLockTimeout(tx: Prisma.TransactionClient): Promise<string> {
  const rows = await tx.$queryRaw<
    { lock_timeout: string }[]
  >`SELECT current_setting('lock_timeout') AS lock_timeout`;
  return rows?.[0]?.lock_timeout ?? "0";
}

export async function lockLabelCategory(
  tx: Prisma.TransactionClient,
  tenantId: string,
  categoryId: string,
): Promise<void> {
  const previous = await currentLockTimeout(tx);
  try {
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_WAIT}'`);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"product-labels"}), hashtext(${`${tenantId}:${categoryId}`}))`;
  } catch (e) {
    if (isLockTimeout(e)) throw new LabelLockTimeoutError();
    throw e;
  }
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${previous}, true)`;
}

export type LabelStamp = { createdById: string | null; createdByName: string | null };

/**
 * Write ONE membership row: update the (product, category) row in place or create it. The caller has
 * taken `lockLabelCategory` and validated mode / reason / pin (`setLabel` does for the admin endpoint).
 */
export async function writeLabelRow<T extends Prisma.ProductCategoryLabelInclude>(
  tx: Prisma.TransactionClient,
  args: {
    tenantId: string;
    productId: string;
    categoryId: string;
    /** mode, reason, stamp and (for an opt-out) the pin: built and validated by `setLabel`, the pin's one author. */
    data: Omit<
      Prisma.ProductCategoryLabelUncheckedCreateInput,
      "tenantId" | "productId" | "categoryId"
    >;
    include: T;
  },
): Promise<Prisma.ProductCategoryLabelGetPayload<{ include: T }>> {
  const { tenantId, productId, categoryId, data, include } = args;
  const existing = await tx.productCategoryLabel.findFirst({
    where: { productId, categoryId },
    select: { id: true },
  });
  return (
    existing
      ? tx.productCategoryLabel.update({ where: { id: existing.id }, data, include })
      : tx.productCategoryLabel.create({
          data: { tenantId, productId, categoryId, ...data },
          include,
        })
  ) as Promise<Prisma.ProductCategoryLabelGetPayload<{ include: T }>>;
}

export type AddIncludeOutcome =
  | "added"
  | "present" // the product already has an INCLUDE of this label
  | "opted-out" // the product has an EXCLUDE of it: an opt-out is never flipped by an automatic add
  | "archived"
  | "missing"; // no such label (or not this tenant's) / no such product

/**
 * ADD-ONLY: give `productId` an INCLUDE of `categoryId` when it has NO membership row for it. Compare-and-set
 * on "membership absent" (`INSERT … ON CONFLICT DO NOTHING`), so a racing writer or a re-run can never
 * duplicate or overwrite a row; an existing row of either mode is left exactly as it is. An INCLUDE carries
 * no pin (the opt-out pin column stays NULL). Never creates, archives or removes a label.
 */
export async function addIncludeIfAbsent(
  tx: Prisma.TransactionClient,
  args: { tenantId: string; productId: string; categoryId: string; stamp: LabelStamp },
): Promise<AddIncludeOutcome> {
  const { tenantId, productId, categoryId, stamp } = args;
  await lockLabelCategory(tx, tenantId, categoryId);
  const category = await tx.productCategory.findFirst({
    where: { id: categoryId, tenantId },
    select: { archivedAt: true },
  });
  if (!category) return "missing";
  if (category.archivedAt) return "archived";
  const product = await tx.product.findFirst({
    where: { id: productId, tenantId },
    select: { id: true },
  });
  if (!product) return "missing";
  const existing = await tx.productCategoryLabel.findFirst({
    where: { productId, categoryId },
    select: { mode: true },
  });
  if (existing) return existing.mode === "EXCLUDE" ? "opted-out" : "present";
  const { count } = await tx.productCategoryLabel.createMany({
    data: [
      // An INCLUDE carries no pin: the column keeps its NULL default.
      { tenantId, productId, categoryId, mode: "INCLUDE", reason: null, ...stamp },
    ],
    skipDuplicates: true,
  });
  return count === 1 ? "added" : "present";
}

/** The audit action a sync writes when it adds a membership from the product's category text. */
export const LABEL_FROM_TEXT_ACTION = "product_label.added_from_category_text";

/**
 * ADD-ONLY sync, called inside EVERY `Product.category` writer's transaction (the census in
 * `product-category-writers.spec.ts` enforces it): when the product's category text names an EXISTING,
 * unarchived label of the tenant (by `labelNameKey`), the product gains that label's INCLUDE, with an audit
 * row "label added from category text". It never creates, renames, archives or removes a label, and never
 * removes a membership (a text change away from a label leaves the old membership in place). Two labels
 * sharing one key (case duplicates that predate the admin key check) are never merged: the OLDEST is used,
 * deterministically, and the audit row reports the ambiguity.
 */
export async function syncCategoryLabel(
  tx: Prisma.TransactionClient,
  args: {
    tenantId: string | null | undefined;
    productId: string;
    text: string | null | undefined;
    actor?: { id: string | null; name: string | null };
  },
): Promise<{ addedCategoryId: string | null }> {
  const match = await matchLabel(tx, args.tenantId, args.text);
  if (!match || !args.tenantId) return { addedCategoryId: null };
  const categoryId = match.id;
  const outcome = await addIncludeIfAbsent(tx, {
    tenantId: args.tenantId,
    productId: args.productId,
    categoryId,
    stamp: stampOf(args.actor),
  });
  if (outcome !== "added") return { addedCategoryId: null };
  await tx.auditLog.create({
    data: auditRow(args.tenantId, args.productId, categoryId, args.actor, match.sameKey),
  });
  return { addedCategoryId: categoryId };
}

/**
 * The unarchived label of the tenant whose name key equals the text's: the OLDEST (createdAt, then id) when
 * case duplicates exist, with `sameKey` = how many share the key (> 1 = ambiguous, reported). Blank/absent = null.
 */
async function matchLabel(
  tx: Prisma.TransactionClient,
  tenantId: string | null | undefined,
  text: string | null | undefined,
): Promise<{ id: string; sameKey: number } | null> {
  const key = labelNameKey(text);
  if (!tenantId || key === "") return null;
  const labels = await tx.productCategory.findMany({
    where: { tenantId, archivedAt: null },
    select: { id: true, name: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const matches = labels.filter((l) => labelNameKey(l.name) === key);
  return matches.length ? { id: matches[0].id, sameKey: matches.length } : null;
}

// ─── label NAMES: one key, one per-tenant lock (admin create/rename + the backfill script) ───────────

/** The per-tenant lock every label-NAME writer takes: admin create / rename and labels-from-categories. */
export const LABEL_NAMES_LOCK = "labels-from-categories";

/**
 * Serialise label-name writes per tenant (bounded wait, the caller's lock_timeout restored), so the key check
 * below cannot race a concurrent create or the backfill script's run.
 */
export async function lockTenantLabelNames(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<void> {
  const previous = await currentLockTimeout(tx);
  try {
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_WAIT}'`);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LABEL_NAMES_LOCK}), hashtext(${tenantId}))`;
  } catch (e) {
    if (isLockTimeout(e)) throw new LabelLockTimeoutError();
    throw e;
  }
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${previous}, true)`;
}

/**
 * The tenant's existing label (archived included) whose name key equals `name`'s, other than `exceptId` (a rename
 * of itself, e.g. a case-only change, is not a collision). Oldest first. Take `lockTenantLabelNames` first.
 */
export async function findLabelNameCollision(
  tx: Prisma.TransactionClient,
  tenantId: string,
  name: string,
  exceptId?: string,
): Promise<{ id: string; name: string } | null> {
  const key = labelNameKey(name);
  if (key === "") return null;
  const labels = await tx.productCategory.findMany({
    where: { tenantId, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true, name: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return labels.find((l) => labelNameKey(l.name) === key) ?? null;
}

type Actor = { id: string | null; name: string | null } | undefined;

const stampOf = (actor: Actor): LabelStamp => ({
  createdById: actor?.id ?? null,
  createdByName: actor?.name ?? null,
});

const auditRow = (
  tenantId: string,
  productId: string,
  categoryId: string,
  actor: Actor,
  sameKey = 1,
) => ({
  tenantId,
  userId: actor?.id ?? null,
  action: LABEL_FROM_TEXT_ACTION,
  entityType: "Product",
  entityId: productId,
  meta: {
    categoryId,
    source: "category_text",
    // > 1: case-duplicate labels share this name; the oldest was used (reported, never merged).
    ...(sameKey > 1 ? { ambiguousLabels: sameKey } : {}),
  } as Prisma.InputJsonValue,
});

/**
 * `syncCategoryLabel` for MANY products that were just given ONE category text (a subcategory rename):
 * the label is matched and its lock taken ONCE, then every product of the tenant that has no membership
 * row yet gets the INCLUDE in one `createMany`. Same rules and the same audit row per added product;
 * an existing row of either mode is left exactly as it is.
 */
export async function syncCategoryLabelForProducts(
  tx: Prisma.TransactionClient,
  args: {
    tenantId: string | null | undefined;
    productIds: readonly string[];
    text: string | null | undefined;
    actor?: { id: string | null; name: string | null };
  },
): Promise<{ addedProductIds: string[] }> {
  const { tenantId, actor } = args;
  const none = { addedProductIds: [] as string[] };
  if (args.productIds.length === 0) return none;
  const match = await matchLabel(tx, tenantId, args.text);
  if (!match || !tenantId) return none;
  const categoryId = match.id;
  await lockLabelCategory(tx, tenantId, categoryId);
  // Re-read under the lock: an archive that landed first wins.
  const category = await tx.productCategory.findFirst({
    where: { id: categoryId, tenantId, archivedAt: null },
    select: { id: true },
  });
  if (!category) return none;
  const ids = [...new Set(args.productIds)];
  const [products, rows] = await Promise.all([
    tx.product.findMany({ where: { id: { in: ids }, tenantId }, select: { id: true } }),
    tx.productCategoryLabel.findMany({
      where: { categoryId, productId: { in: ids } },
      select: { productId: true },
    }),
  ]);
  const has = new Set(rows.map((r) => r.productId));
  const toAdd = products.map((p) => p.id).filter((id) => !has.has(id));
  if (toAdd.length === 0) return none;
  const stamp = stampOf(actor);
  const { count } = await tx.productCategoryLabel.createMany({
    data: toAdd.map((productId) => ({
      tenantId,
      productId,
      categoryId,
      mode: "INCLUDE" as const,
      reason: null,
      ...stamp,
    })),
    skipDuplicates: true,
  });
  // The lock above serialises every label writer, so the existence check cannot go stale: count === toAdd.length.
  if (count === 0) return none;
  await tx.auditLog.createMany({
    data: toAdd.map((productId) => auditRow(tenantId, productId, categoryId, actor, match.sameKey)),
  });
  return { addedProductIds: toAdd };
}
