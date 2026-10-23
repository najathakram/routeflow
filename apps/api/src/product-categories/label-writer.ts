import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { assertSafeCategoryName } from "../common/text-cell-guards";
import {
  ancestorChain,
  ancestorsOf,
  productsInheritingLabel,
} from "../product-labels/parent-carries";

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

/**
 * A busy label lock. It IS a coded 409 (LABEL_CHANGE_IN_PROGRESS), so every caller — the admin endpoints and every
 * Product.category writer running the sync — answers a clear, retryable 409, never a 500.
 */
export class LabelLockTimeoutError extends ConflictException {
  constructor() {
    super({
      code: API_ERROR_CODES.LABEL_CHANGE_IN_PROGRESS,
      message: "Another label change is in progress. Try again in a moment.",
    });
    this.name = "LabelLockTimeoutError";
  }
}

/**
 * Postgres `lock_not_available` (SQLSTATE 55P03) OR `deadlock_detected` (40P01), however Prisma wraps it (P2010 raw
 * error / message). A label lock that lost a deadlock (a stock writer holds Product rows and waits here while a label
 * writer holds this lock and waits for those rows) is the same retryable 409 as one that timed out, never a 500.
 */
function isLockTimeout(e: unknown): boolean {
  const err = e as { meta?: { code?: string }; code?: string; message?: string };
  const state = err?.meta?.code ?? err?.code;
  return (
    state === "55P03" ||
    state === "40P01" ||
    /55P03|40P01|lock timeout|deadlock detected/i.test(err?.message ?? "")
  );
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

/**
 * Take the label locks of the categories whose NAME the given texts match (the ones `syncCategoryLabel` would lock),
 * in SORTED id order, for a writer that must hold them BEFORE its Product row locks (house order: label -> Product).
 * `assignToVariants` copies the parent's category text onto a new variant, so it pre-locks that label here, then takes
 * the Product rows; the sync inside the tx re-takes the same lock (re-entrant in one session). Blank texts and texts
 * that match no label take nothing.
 */
export async function lockLabelCategoriesForText(
  tx: Prisma.TransactionClient,
  tenantId: string | null | undefined,
  texts: ReadonlyArray<string | null | undefined>,
): Promise<void> {
  if (!tenantId) return;
  const ids = new Set<string>();
  for (const text of texts) {
    // eslint-disable-next-line no-await-in-loop -- a handful of texts at most (one parent category)
    const match = await matchLabel(tx, tenantId, text);
    if (match) ids.add(match.id);
  }
  for (const id of [...ids].sort()) {
    // eslint-disable-next-line no-await-in-loop -- sorted: one lock at a time is the order
    await lockLabelCategory(tx, tenantId, id);
  }
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
  | "inherited" // its PARENT chain already carries the label: a variant follows its parent (no own row)
  | "parent-removed" // an ancestor had this label REMOVED on purpose: the family stays without it
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
  // Variants FOLLOW the parent: no own row when the parent chain carries it, so removing the parent's label later
  // un-restricts the variant too.
  if ((await productsInheritingLabel(tx, tenantId, categoryId, [productId])).has(productId)) {
    return "inherited";
  }
  if ((await familyRemovedLabel(tx, tenantId, categoryId, [productId])).has(productId)) {
    return "parent-removed";
  }
  const { count } = await tx.productCategoryLabel.createMany({
    data: [
      // An INCLUDE carries no pin: the column keeps its NULL default.
      { tenantId, productId, categoryId, mode: "INCLUDE", reason: null, ...stamp },
    ],
    skipDuplicates: true,
  });
  return count === 1 ? "added" : "present";
}

/** The admin "remove label" audit action (ProductLabelsAdminService.removeLabel). */
export const LABEL_REMOVED_ACTION = "product_label.removed";

/**
 * A deliberate removal covers the family (SA): of `productIds`, the ones with an ANCESTOR whose INCLUDE of
 * `categoryId` an operator removed (a `product_label.removed` audit; a legacy audit with no `mode` counts as an INCLUDE
 * removal, the conservative reading). Automatic adds never give those products their own row.
 */
export async function familyRemovedLabel(
  tx: Prisma.TransactionClient,
  tenantId: string,
  categoryId: string,
  productIds: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (productIds.length === 0) return out;
  const parentOf = await ancestorsOf(tx, tenantId, productIds);
  const chains = new Map(productIds.map((id) => [id, ancestorChain(parentOf, id)]));
  const ancestors = [...new Set([...chains.values()].flat())];
  if (ancestors.length === 0) return out;
  const audits = await tx.auditLog.findMany({
    where: {
      tenantId,
      action: LABEL_REMOVED_ACTION,
      entityType: "Product",
      entityId: { in: ancestors },
    },
    select: { entityId: true, meta: true },
  });
  const removedOn = new Set(
    audits
      .filter((a) => {
        const m = (a.meta ?? {}) as { categoryId?: string; mode?: string };
        return m.categoryId === categoryId && (m.mode ?? "INCLUDE") === "INCLUDE";
      })
      .map((a) => a.entityId as string),
  );
  for (const [id, chain] of chains) if (chain.some((a) => removedOn.has(a))) out.add(id);
  return out;
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
    /**
     * Set by a caller that took its label locks UP FRONT (a reparent: label locks before row locks). The matched label
     * must be one of them; else the retryable 409, never a lock taken after the caller's row locks.
     */
    lockedCategoryIds?: ReadonlySet<string>;
  },
): Promise<{ addedCategoryId: string | null }> {
  const match = await matchLabel(tx, args.tenantId, args.text);
  if (!match || !args.tenantId) return { addedCategoryId: null };
  const categoryId = match.id;
  if (args.lockedCategoryIds && !args.lockedCategoryIds.has(categoryId)) {
    throw new LabelLockTimeoutError();
  }
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

/** READ-ONLY: the id of the label `syncCategoryLabel` would match for `text` (null = none). Takes no lock. */
export async function labelIdForText(
  tx: Prisma.TransactionClient,
  tenantId: string | null | undefined,
  text: string | null | undefined,
): Promise<string | null> {
  return (await matchLabel(tx, tenantId, text))?.id ?? null;
}

/**
 * Take several label locks in ONE deterministic order (sorted, de-duplicated): the order every multi-label writer
 * uses, so two of them can never cycle. Same family and keys as `lockLabelCategory` (and so as `setLabel`).
 */
export async function lockLabelCategories(
  tx: Prisma.TransactionClient,
  tenantId: string,
  categoryIds: Iterable<string>,
): Promise<void> {
  for (const categoryId of [...new Set(categoryIds)].sort()) {
    // Serial by design: one lock at a time, in key order.
    await lockLabelCategory(tx, tenantId, categoryId);
  }
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
 * ADD-ONLY for MANY products and ONE label, under that label's lock, in one `createMany`: the bulk sync (a subcategory
 * rename) and the backfill script both use it. Re-reads under the lock: the label (an archive that landed first wins),
 * the products (this tenant's only), the existing rows of either mode (left exactly as they are) and the parent chains
 * (a product whose parent chain carries the label — including a parent added in this same call — FOLLOWS it and gets
 * no own row). `ON CONFLICT DO NOTHING`; the lock serialises every label writer, so `added` is exact.
 */
export async function addIncludesForProducts(
  tx: Prisma.TransactionClient,
  args: { tenantId: string; categoryId: string; productIds: readonly string[]; stamp: LabelStamp },
): Promise<{
  added: string[];
  /** createMany's own row count: equals `added.length` (callers assert it). */
  count: number;
  present: number;
  inherited: string[];
  parentRemoved: string[];
  archived: boolean;
}> {
  const { tenantId, categoryId, stamp } = args;
  const none = {
    added: [] as string[],
    count: 0,
    present: 0,
    inherited: [] as string[],
    parentRemoved: [] as string[],
    archived: false,
  };
  const ids = [...new Set(args.productIds)];
  if (ids.length === 0) return none;
  await lockLabelCategory(tx, tenantId, categoryId);
  const category = await tx.productCategory.findFirst({
    where: { id: categoryId, tenantId },
    select: { archivedAt: true },
  });
  if (!category) return none;
  if (category.archivedAt) return { ...none, archived: true };
  const products = await tx.product.findMany({
    where: { id: { in: ids }, tenantId },
    select: { id: true },
  });
  const rows = await tx.productCategoryLabel.findMany({
    where: { categoryId, productId: { in: ids } },
    select: { productId: true },
  });
  const has = new Set(rows.map((r) => r.productId));
  const candidates = products.map((p) => p.id).filter((id) => !has.has(id));
  const inherited = await productsInheritingLabel(
    tx,
    tenantId,
    categoryId,
    candidates,
    new Set(candidates),
  );
  const parentRemoved = await familyRemovedLabel(
    tx,
    tenantId,
    categoryId,
    candidates.filter((id) => !inherited.has(id)),
  );
  const toAdd = candidates.filter((id) => !inherited.has(id) && !parentRemoved.has(id)).sort();
  let count = 0;
  if (toAdd.length > 0) {
    ({ count } = await tx.productCategoryLabel.createMany({
      // An INCLUDE carries no pin: the column keeps its NULL default.
      data: toAdd.map((productId) => ({
        tenantId,
        productId,
        categoryId,
        mode: "INCLUDE" as const,
        reason: null,
        ...stamp,
      })),
      skipDuplicates: true,
    }));
  }
  return {
    added: toAdd,
    count,
    present: has.size,
    inherited: [...inherited].sort(),
    parentRemoved: [...parentRemoved].sort(),
    archived: false,
  };
}

/**
 * `syncCategoryLabel` for MANY products that were just given ONE category text (a subcategory rename), through
 * `addIncludesForProducts`: same rules, the same audit row per added product.
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
  if (args.productIds.length === 0 || !tenantId) return { addedProductIds: [] };
  const match = await matchLabel(tx, tenantId, args.text);
  if (!match) return { addedProductIds: [] };
  const { added } = await addIncludesForProducts(tx, {
    tenantId,
    categoryId: match.id,
    productIds: args.productIds,
    stamp: stampOf(actor),
  });
  if (added.length > 0) {
    await tx.auditLog.createMany({
      data: added.map((productId) => auditRow(tenantId, productId, match.id, actor, match.sameKey)),
    });
  }
  return { addedProductIds: added };
}

// ─── label NAME safety (B983) ─────────────────────────────────────────────────

/** The admin DTO's limit on a label name (CreateProductCategoryDto @MaxLength(80)). */
export const LABEL_NAME_MAX = 80;

/**
 * Why `name` can't be a label name, or null when it can: the same rules an admin create runs — the formula-injection
 * guard (B983, assertSafeCategoryName) and the 80-character limit. The backfill lists and skips such texts.
 */
export function labelNameProblem(name: string): "too-long" | "unsafe" | null {
  if (name.length > LABEL_NAME_MAX) return "too-long";
  try {
    assertSafeCategoryName(name);
  } catch {
    return "unsafe";
  }
  return null;
}

/**
 * An inert opt-out a reparent keep REPLACED with an INCLUDE, as its audit row records it. Identifying fields only: the
 * pin column stays the admin service's alone (label-pin-single-writer.spec.ts).
 */
export type ReplacedOptOut = {
  id: string;
  reason: string | null;
  createdById: string | null;
  createdByName: string | null;
  createdAt: string;
};

/** The audit action written when a reparent materialises a label the variant would otherwise have lost. */
export const LABEL_KEPT_ON_REPARENT_ACTION = "product_label.kept_on_reparent";

/**
 * REPARENT KEEP (H2): give `productId` its OWN INCLUDE of each of `categoryIds`, the labels it carried through its old
 * parent and would lose under the new one (a selling ban must never silently stop applying). Unlike the add-only sync it
 * ignores "the parent chain carries it" / "the family removed it": the caller computed that those do NOT help this
 * product. A categories-of-this-tenant check only (an ARCHIVED label still bans, so it is kept); an existing INCLUDE is
 * left as is, an INERT opt-out (an EXCLUDE row that no longer cancels anything) is replaced by the INCLUDE (the audit
 * row names it: `replacedOptOut`). One audit row per kept label, same transaction. Returns the kept labels' ids and
 * names, in id order.
 */
export async function keepLabelsAsOwnIncludes(
  tx: Prisma.TransactionClient,
  args: {
    tenantId: string;
    productId: string;
    categoryIds: readonly string[];
    fromParentId: string | null;
    toParentId: string | null;
    actor?: Actor;
  },
): Promise<Array<{ categoryId: string; name: string; replacedOptOut?: ReplacedOptOut }>> {
  const { tenantId, productId, actor } = args;
  const ids = [...new Set(args.categoryIds)].sort();
  const kept: Array<{ categoryId: string; name: string; replacedOptOut?: ReplacedOptOut }> = [];
  if (ids.length === 0) return kept;
  const product = await tx.product.findFirst({
    where: { id: productId, tenantId },
    select: { id: true },
  });
  if (!product) return kept;
  for (const categoryId of ids) {
    await lockLabelCategory(tx, tenantId, categoryId);
    const category = await tx.productCategory.findFirst({
      where: { id: categoryId, tenantId },
      select: { name: true },
    });
    if (!category) continue;
    const existing = await tx.productCategoryLabel.findFirst({
      where: { tenantId, productId, categoryId },
      select: {
        id: true,
        mode: true,
        reason: true,
        createdById: true,
        createdByName: true,
        createdAt: true,
      },
    });
    if (existing?.mode === "INCLUDE") continue;
    if (existing)
      await tx.productCategoryLabel.deleteMany({ where: { id: existing.id, tenantId } });
    await tx.productCategoryLabel.create({
      // An INCLUDE carries no pin: the column keeps its NULL default.
      data: { tenantId, productId, categoryId, mode: "INCLUDE", reason: null, ...stampOf(actor) },
    });
    kept.push({
      categoryId,
      name: category.name,
      // The deleted opt-out's reason was an approval: keep what identifies it in the audit trail.
      ...(existing
        ? {
            replacedOptOut: {
              id: existing.id,
              reason: existing.reason,
              createdById: existing.createdById,
              createdByName: existing.createdByName,
              createdAt: new Date(existing.createdAt).toISOString(),
            },
          }
        : {}),
    });
  }
  if (kept.length > 0) {
    await tx.auditLog.createMany({
      data: kept.map((k) => ({
        tenantId,
        userId: actor?.id ?? null,
        action: LABEL_KEPT_ON_REPARENT_ACTION,
        entityType: "Product",
        entityId: productId,
        meta: {
          categoryId: k.categoryId,
          source: "reparent",
          fromParentProductId: args.fromParentId,
          toParentProductId: args.toParentId,
          ...(k.replacedOptOut ? { replacedOptOut: k.replacedOptOut } : {}),
        } as Prisma.InputJsonValue,
      })),
    });
  }
  return kept;
}
