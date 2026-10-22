import {
  fetchCurrentTierPrices,
  PRICE_FETCH_CONCURRENCY,
  productsToRefresh,
  withFreshTierPrices,
} from "./fresh-prices";
import { repriceResumedLines } from "./resume";
import type { ResumeLine } from "./resume";

// SA-817a / A5: a resumed order is re-priced from each product's CURRENT tier columns (GET /products/:id), at most 8 reads at a
// time. A read that fails never blocks the resume.

const line = (id: string, over: Partial<ResumeLine> = {}): ResumeLine => ({
  tempId: `t-${id}`,
  productId: id,
  unitPrice: 10,
  priceType: "STANDARD",
  tierPrices: { pricePerUnit: 10 }, // the snapshot parked with the line
  ...over,
});

describe("fresh prices on resume (SA-817a)", () => {
  it("A5: the concurrency cap is 8", () => {
    expect(PRICE_FETCH_CONCURRENCY).toBe(8);
  });

  it("A5 changed-tier: the tier column moved after the line was added - the snapshot says $10, the product now says $12, and $12 is shown", async () => {
    const lines = [line("p1")];
    const fresh = await fetchCurrentTierPrices(productsToRefresh(lines), async () => ({
      pricePerUnit: 12,
    }));
    expect(fresh.failed).toBe(false);
    const r = repriceResumedLines(withFreshTierPrices(lines, fresh.byProduct), () => 1);
    expect(r.lines[0]).toMatchObject({ unitPrice: 12, priceChangedFrom: 10 });
  });

  it("A5 changed-tier: a tier-2 customer follows the product's tier-2 column", async () => {
    const lines = [line("p1")];
    const fresh = await fetchCurrentTierPrices(["p1"], async () => ({
      pricePerUnit: 12,
      priceTier2: 11,
    }));
    const r = repriceResumedLines(withFreshTierPrices(lines, fresh.byProduct), () => 2);
    expect(r.lines[0]).toMatchObject({ unitPrice: 11 });
  });

  it("A5 offline: every read fails - resume still works, lines are untouched, and the caller is told prices were not refreshed", async () => {
    const lines = [line("p1"), line("p2")];
    const fresh = await fetchCurrentTierPrices(["p1", "p2"], async () => {
      throw new Error("Network Error");
    });
    expect(fresh.failed).toBe(true);
    expect(fresh.byProduct.size).toBe(0);
    expect(withFreshTierPrices(lines, fresh.byProduct)).toEqual(lines);
  });

  it("A5 offline: one read fails, the others still refresh", async () => {
    const fresh = await fetchCurrentTierPrices(["p1", "p2"], async (id) => {
      if (id === "p2") throw new Error("404");
      return { pricePerUnit: 12 };
    });
    expect(fresh.failed).toBe(true);
    expect([...fresh.byProduct.keys()]).toEqual(["p1"]);
  });

  it("reads run in parallel but never more than 8 at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const ids = Array.from({ length: 30 }, (_, i) => `p${i}`);
    const fresh = await fetchCurrentTierPrices(ids, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { pricePerUnit: 1 };
    });
    expect(fresh.byProduct.size).toBe(30);
    expect(peak).toBe(8);
  });

  it("each product is read once even when it is on several lines; overrides, unlisted and unit lines are not read", () => {
    const lines = [
      line("p1"),
      line("p1", { tempId: "again" }),
      line("p2", { priceType: "DISCOUNTED", discountedPrice: 8 }),
      line("", { isUnlisted: true }),
      line("p3", { unitLabel: "Each" }),
    ];
    expect(productsToRefresh(lines)).toEqual(["p1"]);
  });
});
