import { apiClient } from "./api-client";
import {
  CATEGORY_PAGE_SIZE,
  fetchCategoryPage,
  findCategoryProducts,
  matchCategory,
} from "./counter-category-search";

jest.mock("./api-client", () => ({ apiClient: { get: jest.fn() } }));
const get = apiClient.get as jest.Mock;

// CQ-10: a typed category name lists that category's products through the product list search, paginated.
describe("matchCategory", () => {
  it("matches the typed text to a stored category ignoring case and edge spaces", () => {
    expect(matchCategory("  household ", ["Snacks", "Household"])).toBe("Household");
    expect(matchCategory("SNACKS", ["Snacks"])).toBe("Snacks");
  });
  it("a partial name or an empty entry is no category", () => {
    expect(matchCategory("house", ["Household"])).toBeNull();
    expect(matchCategory("  ", ["Household"])).toBeNull();
    expect(matchCategory("x", [null, 5, {}])).toBeNull();
  });
});

describe("fetchCategoryPage", () => {
  it("asks the product list for ONE page of the category's active products and reports whether there is more", async () => {
    get.mockResolvedValueOnce({
      data: { data: [{ id: "a" }, { id: "b" }], meta: { total: 45, page: 2, limit: 20 } },
    });
    const page = await fetchCategoryPage("Household", 2);
    expect(get).toHaveBeenCalledWith("/products", {
      params: {
        category: "Household",
        isActive: true,
        page: 2,
        limit: CATEGORY_PAGE_SIZE,
        includeVariants: true,
      },
    });
    expect(page).toMatchObject({ category: "Household", page: 2, total: 45, hasMore: true });
    expect(page.products).toHaveLength(2);
  });

  it("a FAMILY row is never offered: its variants are (the family itself is not sellable)", async () => {
    get.mockResolvedValueOnce({
      data: {
        data: [
          {
            id: "fam",
            kind: "FAMILY",
            name: "Bleach",
            variants: [{ id: "v1", name: "Bleach 1L" }],
          },
          { id: "solo", name: "Sponge" },
        ],
        meta: { total: 2, limit: 20 },
      },
    });
    const page = await fetchCategoryPage("Household", 1);
    expect(page.products.map((p: any) => p.id)).toEqual(["v1", "solo"]);
  });

  it("the last page has no more", async () => {
    get.mockResolvedValueOnce({ data: { data: [{ id: "z" }], meta: { total: 41, limit: 20 } } });
    expect((await fetchCategoryPage("Household", 3)).hasMore).toBe(false);
  });
});

describe("findCategoryProducts", () => {
  beforeEach(() => get.mockReset());

  it("a category name opens its first page", async () => {
    get.mockImplementation(async (url: string) =>
      url === "/products/categories"
        ? { data: ["Snacks", "Household"] }
        : { data: { data: [{ id: "p1" }], meta: { total: 1, limit: 20 } } },
    );
    const out = await findCategoryProducts("household");
    expect(out).toMatchObject({ category: "Household", total: 1, hasMore: false });
  });

  it("not a category, an empty category, or a failing list is a miss (null), never an error", async () => {
    get.mockResolvedValueOnce({ data: ["Snacks"] });
    expect(await findCategoryProducts("Cola")).toBeNull();
    get.mockImplementation(async (url: string) =>
      url === "/products/categories"
        ? { data: ["Snacks"] }
        : { data: { data: [], meta: { total: 0 } } },
    );
    expect(await findCategoryProducts("Snacks")).toBeNull();
    get.mockRejectedValue(new Error("down"));
    expect(await findCategoryProducts("Snacks")).toBeNull();
  });
});
