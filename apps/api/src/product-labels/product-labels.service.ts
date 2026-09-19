import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { assertAmbientTenant } from "../common/ambient-tenant";
import {
  computeEffectiveCategoryIds,
  type LabelAssignment,
  type LabelChainLink,
} from "./effective-labels";

/**
 * Variants nest one level in practice; the cap only bounds a malformed cycle. It is a per-ROOT hop
 * limit (a product may have at most this many ancestors), applied by `effectiveLabels` when it
 * walks each product's chain — and it also bounds how many batched loader rounds are issued.
 */
const MAX_ANCESTOR_DEPTH = 5;

/**
 * The label columns to read. `parentProductIdAtWrite` (the pin an EXCLUDE needs to count) ships
 * with the write side's migration; until that column is in the generated client it is NOT selected
 * (a select on a column the generated client lacks would fail) and every EXCLUDE reads as unpinned
 * ⇒ inert. It starts being read the moment the column exists — no manual flip. Pure so both
 * branches are testable. NOTE this keys off the GENERATED CLIENT, not the database: the migration
 * adding the column must land (`prisma migrate deploy`) strictly before any image built from the
 * schema that contains it runs, and must not be rolled back under a live image (P2022 otherwise).
 */
export function labelSelect(scalarFields: Readonly<Record<string, string>>): {
  categoryId: true;
  mode: true;
} {
  // Typed as the always-present fields so Prisma infers a usable row type; the pin key, when the
  // column exists, is added at runtime and read defensively (`parentProductIdAtWrite?`).
  return {
    categoryId: true,
    mode: true,
    ...("parentProductIdAtWrite" in scalarFields ? { parentProductIdAtWrite: true } : {}),
  };
}
const LABEL_SELECT = labelSelect(Prisma.ProductCategoryLabelScalarFieldEnum);

export interface EffectiveLabels {
  productId: string;
  /** The product's name, or its id when it could not be resolved. */
  name: string;
  /** true only when the product's OWN row was found (so `name` is a real name, never the raw id). */
  nameKnown: boolean;
  /** Own INCLUDEs ∪ ancestors' INCLUDEs − own EXCLUDEs (see `computeEffectiveCategoryIds`). */
  effectiveCategoryIds: ReadonlySet<string>;
  /** The product's own id plus every ancestor id that was reached (variant → parent → …). */
  lineageIds: ReadonlySet<string>;
  /**
   * false when the product, or any ancestor, could not be resolved in this tenant (missing,
   * another tenant's, a parent cycle, or a chain deeper than the cap). The label set is then
   * incomplete — callers that gate anything on it must fail closed.
   */
  resolvable: boolean;
}

/**
 * READ side of product labels (lane R). Read-only; the WRITE side (category CRUD, assign/opt-out)
 * lives in `product-categories/`. Every query carries an explicit `tenantId` (L-124: cron paths
 * have no ambient tenant, where `forTenant()` silently returns the unscoped client) and a
 * mismatch with an ambient tenant is refused rather than quietly evaluating another tenant.
 */
@Injectable()
export class ProductLabelsService {
  constructor(private readonly prisma: PrismaService) {}

  /** One entry per requested id, in request order (duplicates collapse to the first occurrence). */
  async effectiveLabels(
    tenantId: string,
    productIds: readonly string[],
  ): Promise<Map<string, EffectiveLabels>> {
    assertAmbientTenant(this.prisma, tenantId, "ProductLabelsService");
    const ids = [...new Set(productIds)];
    const out = new Map<string, EffectiveLabels>();
    if (ids.length === 0) return out;

    const db = this.prisma.forTenant();
    type Row = {
      id: string;
      name: string;
      parentProductId: string | null;
      categoryLabels: LabelAssignment[];
    };
    const byId = new Map<string, Row>();
    let frontier = ids;
    for (let depth = 0; depth <= MAX_ANCESTOR_DEPTH && frontier.length > 0; depth++) {
      const rows: Row[] = await db.product.findMany({
        where: { tenantId, id: { in: frontier } },
        select: {
          id: true,
          name: true,
          parentProductId: true,
          categoryLabels: { select: LABEL_SELECT },
        },
      });
      for (const r of rows) byId.set(r.id, r);
      frontier = [
        ...new Set(rows.map((r) => r.parentProductId).filter((id): id is string => !!id)),
      ].filter((id) => !byId.has(id));
    }

    for (const id of ids) {
      const chain: LabelChainLink[] = [];
      const lineage = new Set<string>([id]);
      let resolvable = byId.has(id);
      let cursor = byId.get(id);
      // The depth cap is decided HERE, per root, by counting hops — never by how far the batch
      // loader happened to reach. The loader above shares its rounds across every requested id, so
      // an ancestor that is ALSO a requested line is loaded earlier and its own ancestors land
      // deeper in `byId`; without this counter the same product would flip between resolvable and
      // not depending on what else was in the cart.
      let hops = 0;
      while (cursor) {
        chain.unshift({ productId: cursor.id, assignments: cursor.categoryLabels });
        lineage.add(cursor.id);
        if (!cursor.parentProductId) break;
        hops++;
        const parent = hops > MAX_ANCESTOR_DEPTH ? undefined : byId.get(cursor.parentProductId);
        if (!parent || lineage.has(parent.id)) {
          resolvable = false; // missing / foreign / too-deep ancestor, or a cycle
          lineage.add(cursor.parentProductId);
          break;
        }
        cursor = parent;
      }
      out.set(id, {
        productId: id,
        name: byId.get(id)?.name ?? id,
        nameKnown: byId.has(id),
        effectiveCategoryIds: computeEffectiveCategoryIds(chain),
        lineageIds: lineage,
        resolvable,
      });
    }
    return out;
  }
}
