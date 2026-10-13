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
export async function lockLabelCategory(
  tx: Prisma.TransactionClient,
  tenantId: string,
  categoryId: string,
): Promise<void> {
  const [{ lock_timeout: previous }] = await tx.$queryRaw<
    { lock_timeout: string }[]
  >`SELECT current_setting('lock_timeout') AS lock_timeout`;
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
 * sharing one key are ambiguous: nothing is added.
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
  const key = labelNameKey(args.text);
  if (!args.tenantId || key === "") return { addedCategoryId: null };
  const labels = await tx.productCategory.findMany({
    where: { tenantId: args.tenantId, archivedAt: null },
    select: { id: true, name: true },
  });
  const matches = labels.filter((l) => labelNameKey(l.name) === key);
  if (matches.length !== 1) return { addedCategoryId: null };
  const categoryId = matches[0].id;
  const stamp: LabelStamp = {
    createdById: args.actor?.id ?? null,
    createdByName: args.actor?.name ?? null,
  };
  const outcome = await addIncludeIfAbsent(tx, {
    tenantId: args.tenantId,
    productId: args.productId,
    categoryId,
    stamp,
  });
  if (outcome !== "added") return { addedCategoryId: null };
  await tx.auditLog.create({
    data: {
      tenantId: args.tenantId,
      userId: args.actor?.id ?? null,
      action: LABEL_FROM_TEXT_ACTION,
      entityType: "Product",
      entityId: args.productId,
      meta: { categoryId, source: "category_text" } as Prisma.InputJsonValue,
    },
  });
  return { addedCategoryId: categoryId };
}
