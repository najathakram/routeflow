import { apiClient } from "./api-client";
import { sellableFlat } from "./product-search-groups";

/**
 * CQ-10: typing a CATEGORY name in the counter's "Scan or type an item" lists that category's products. This is the
 * same server search the product picker uses (`GET /products?category=`), paginated; no second search engine. The
 * category is matched case-insensitively against the tenant's own category list (`GET /products/categories`), then the
 * server filters by the stored spelling.
 */
export const CATEGORY_PAGE_SIZE = 20;

export interface CategoryPage {
  /** the category as stored (the spelling the server filters by) */
  category: string;
  products: any[];
  page: number;
  /** the server's count of rows in the category (families count once); paging is by these rows */
  total: number;
  hasMore: boolean;
}

/** The stored spelling of `typed` when it names one of the tenant's categories (ignoring case and edge spaces), else null. */
export function matchCategory(typed: string, categories: readonly unknown[]): string | null {
  const want = typed.trim().toLowerCase();
  if (!want) return null;
  for (const c of categories) {
    if (typeof c === "string" && c.trim().toLowerCase() === want) return c;
  }
  return null;
}

/** One page of a category's sellable (active) products through the product list search. */
export async function fetchCategoryPage(category: string, page: number): Promise<CategoryPage> {
  const res = await apiClient.get("/products", {
    params: {
      category,
      isActive: true,
      page,
      limit: CATEGORY_PAGE_SIZE,
      includeVariants: true,
    },
  });
  const body = res?.data ?? {};
  // a FAMILY row is not sellable (assertSellableLines): its variants are what the picker offers
  const products: any[] = sellableFlat<any>(Array.isArray(body) ? body : (body.data ?? []));
  const rows = Array.isArray(body) ? body.length : (body.data ?? []).length;
  const total = Number(body?.meta?.total ?? rows);
  const limit = Number(body?.meta?.limit ?? CATEGORY_PAGE_SIZE) || CATEGORY_PAGE_SIZE;
  return { category, products, page, total, hasMore: page * limit < total };
}

/**
 * The first page of `typed`'s category, or null when it names no category (or the category has nothing sellable).
 * A failure of this OPTIONAL rung is a miss, never a retry banner: the code ladder already answered "not found".
 */
export async function findCategoryProducts(typed: string): Promise<CategoryPage | null> {
  try {
    const res = await apiClient.get("/products/categories");
    const category = matchCategory(typed, Array.isArray(res?.data) ? res.data : []);
    if (!category) return null;
    const first = await fetchCategoryPage(category, 1);
    return first.products.length > 0 ? first : null;
  } catch {
    return null;
  }
}
