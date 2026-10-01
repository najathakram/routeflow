import { buildScanSearchOr } from "./scan-search";
import { StockStatusFilter, type ListProductsDto } from "./dto/list-products.dto";

/**
 * The `Product` where-clause of a list query (search / scanCode / category / isActive / isTobacco /
 * portalVisible / section / stockStatus, plus the internal buyer-catalog exclusions). Extracted verbatim from
 * `ProductsService.findAll` so the CSV export filters EXACTLY as the list does.
 */
export function buildProductListWhere(
  query: ListProductsDto,
  opts?: { excludeTrackedCategoryIds?: string[]; andWhere?: Record<string, unknown>[] },
): any {
  const where: any = {};
  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: "insensitive" } },
      { sku: { contains: query.search, mode: "insensitive" } },
      { barcode: { contains: query.search, mode: "insensitive" } },
      { unitSku: { contains: query.search, mode: "insensitive" } },
    ];
  } else if (query.scanCode) {
    // Scan-fallback rung: same four columns, but contains-matched against
    // EVERY normalizeScanCode candidate instead of the raw decode — the raw
    // string misses whenever this camera's decode differs from the stored
    // shape (iOS 13-digit vs a 12-digit code kept in the product name).
    // OR: [] when the code yields no candidates — matches nothing, correctly.
    where.OR = buildScanSearchOr(query.scanCode);
  }
  if (query.category) where.category = query.category;
  if (query.isActive !== undefined) where.isActive = query.isActive;
  if (query.isTobacco !== undefined) where.isTobacco = query.isTobacco;
  if (query.portalVisible !== undefined) {
    // What the list badge shows: hidden by its OWN flag OR through a hidden parent (Opus #2856 m2).
    const hidden = { OR: [{ portalVisible: false }, { parent: { portalVisible: false } }] };
    where.AND = [...(where.AND ?? []), query.portalVisible ? { NOT: hidden } : hidden];
  }
  // W7 buyer gate: exclude regulated categories the buyer isn't licensed for (set
  // internally by BuyerCatalogService — never from buyer input). In the query so
  // pagination counts stay correct.
  if (opts?.excludeTrackedCategoryIds?.length) {
    // Hide license-gated categories WITHOUT hiding untracked products.
    // Prisma's `notIn` never matches NULL rows, so the previous bare filter
    // (`trackedCategoryId: { notIn: [...] }`) made every product with NO
    // tracked category vanish the moment a tenant had one requiresLicense
    // category — on a live tenant that hid 1,757 of 1,823 products from
    // every unlicensed buyer. NULL must be allowed back in explicitly.
    // AND-pushed (not where.trackedCategoryId) so it can't collide with the
    // regulated fold-in below or a search OR.
    where.AND = [
      ...((where.AND as Record<string, unknown>[] | undefined) ?? []),
      {
        OR: [
          { trackedCategoryId: null },
          { trackedCategoryId: { notIn: opts.excludeTrackedCategoryIds } },
        ],
      },
    ];
  }

  // Regulated-section filter ("any" | "none" | <sectionId>). When the internal
  // buyer-catalog exclusion already occupies where.trackedCategoryId, fold this
  // clause into AND so BOTH apply.
  if (query.section) {
    const clause =
      query.section === "any" ? { not: null } : query.section === "none" ? null : query.section;
    if (where.trackedCategoryId !== undefined) {
      where.AND = [...(where.AND ?? []), { trackedCategoryId: clause }];
    } else {
      where.trackedCategoryId = clause;
    }
  }

  // Server-side stock-status filtering so pagination counts are accurate
  if (query.stockStatus === StockStatusFilter.OUT_OF_STOCK) {
    // "Out" = inactive OR zero/negative stock. Keep it as its own disjunction
    // AND-ed with any search OR — reusing `where.OR` would merge the two into a
    // single OR, so every out-of-stock product would match regardless of the
    // search text (and every search hit would show even if in stock).
    const outOfStock = [{ isActive: false }, { currentStock: { lte: 0 } }];
    if (where.OR) {
      where.AND = [...(where.AND ?? []), { OR: where.OR }, { OR: outOfStock }];
      delete where.OR;
    } else {
      where.OR = outOfStock;
    }
  } else if (query.stockStatus === StockStatusFilter.LOW) {
    where.isActive = true;
    // lte:5 covers 0, negatives, and low stock; null check invalid for Decimal in Prisma 7.7
    where.currentStock = { lte: 5 };
  } else if (query.stockStatus === StockStatusFilter.IN_STOCK) {
    where.isActive = true;
    where.currentStock = { gt: 5 };
  }

  // Internal-only extra AND clauses (buyer catalog v2 smart collections —
  // set by BuyerCatalogService, never from client input). Folded via AND so
  // they compose with the search OR and the stock-status OR.
  if (opts?.andWhere?.length) {
    where.AND = [...(where.AND ?? []), ...opts.andWhere];
  }
  return where;
}
