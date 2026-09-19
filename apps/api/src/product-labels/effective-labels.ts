/**
 * Effective product-label set — the PURE rule (no Prisma, no Nest). The one implementation:
 * `ProductLabelsService.effectiveLabels` (read side) and the selling-restrictions engine both
 * use it, so a label opt-out means the same thing everywhere. Never snapshotted: computed from
 * the live assignments at read time, so a parent's later label change reaches its variants.
 */

/**
 * One `ProductCategoryLabel` assignment. EXCLUDE = a variant's opt-out of a label its parent
 * carries. `parentProductIdAtWrite` is the variant's parent AT THE TIME the opt-out was written
 * (pinned by the write side): an opt-out was approved against THAT parent only.
 */
export interface LabelAssignment {
  categoryId: string;
  mode: "INCLUDE" | "EXCLUDE";
  /** Absent/null on legacy rows and until the column exists ⇒ the EXCLUDE is INERT (fail closed). */
  parentProductIdAtWrite?: string | null;
}

/** One product in an ancestor chain: its id and its own assignments. */
export interface LabelChainLink {
  productId: string;
  assignments: LabelAssignment[];
}

/**
 * Effective label set of a product given its ancestor chain, ROOT FIRST (`[root, …, product]`): a
 * product carries what its ancestors carry, plus its own INCLUDEs, minus its own EFFECTIVE
 * EXCLUDEs. An EXCLUDE is effective ONLY when its `parentProductIdAtWrite` equals the product's
 * CURRENT parent (the previous link's `productId`): a null, absent or mismatched pin is INERT —
 * the label stays and the restriction applies (fail closed). So reparenting a variant can never
 * carry an opt-out approved against a different parent along with it. An EXCLUDE on the chain's
 * root is ignored — a standalone product has nothing to opt out of. Within ONE level an EXCLUDE
 * beats an INCLUDE of the same category; that cannot happen today (`@@unique([productId,
 * categoryId])` on `ProductCategoryLabel` — one row per pair), so revisit this if that key widens.
 *
 * OPT-OUT CONTRACT (engine ⇄ write side). Labels are inherited through up to five ancestors, but an
 * opt-out is honoured ONLY through the pin rule above: it takes effect solely when the EXCLUDE's
 * `parentProductIdAtWrite` is the product's IMMEDIATE parent. On a chain [grandparent GP carries a;
 * parent P; grandchild G], G's EXCLUDE of `a` removes the label G inherits through P only when it is
 * pinned to P — pinned to GP (a non-immediate ancestor), unpinned, or pinned to a parent G no longer
 * has, it is INERT (fail closed). The engine only honours what the pin says; it never validates an
 * opt-out. So the WRITE side (`product-categories/`, owned by another lane) must:
 *   1. validate a new opt-out against the EFFECTIVE labels of the IMMEDIATE parent (the label must
 *      actually reach the variant through that parent) and pin it to that parent's id; and
 *   2. when an ancestor's INCLUDE is deleted (or otherwise stops reaching a subtree), clean up the
 *      opt-outs of the descendant subtree that only existed to cancel it — the engine will neither
 *      notice nor clear a dead opt-out.
 */
export function computeEffectiveCategoryIds(chain: LabelChainLink[]): Set<string> {
  const effective = new Set<string>();
  chain.forEach((link, depth) => {
    for (const a of link.assignments) if (a.mode === "INCLUDE") effective.add(a.categoryId);
    if (depth === 0) return;
    const currentParentId = chain[depth - 1].productId;
    for (const a of link.assignments) {
      if (a.mode === "EXCLUDE" && a.parentProductIdAtWrite === currentParentId) {
        effective.delete(a.categoryId);
      }
    }
  });
  return effective;
}
