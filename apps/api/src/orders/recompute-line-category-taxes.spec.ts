import { recomputeLineCategoryTaxes } from "./recompute-line-category-taxes";

/**
 * B297 PR3 (SA-734r2 B3 / L1 / A3): the order-side recompute reads each line's OWN rate snapshot, fetches
 * the live category only for a NULL-trio line, stamps that trio once with a warn, and never zeroes a
 * stored excise on a line with no category. The four updateOrderItems-family callers (merge,
 * forceConsolidate, updateOrderItems, approve-at-stop) all go through this one function; the DB pin
 * `b297-recompute-snapshot.db.spec.ts` drives them against real Postgres.
 */
const RAISED = { id: "cat-1", taxType: "EXCISE_PER_UNIT", rate: "0.0700", priceIncludesTax: false };

function line(over: Record<string, unknown> = {}) {
  return {
    id: "li-1",
    orderId: "ord-1",
    productId: "prod-1",
    trackedCategoryId: "cat-1",
    qty: 12,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    unitLabel: null,
    subtotal: 100,
    categoryTaxAmount: 0.6,
    categoryTaxType: "EXCISE_PER_UNIT",
    categoryTaxRate: "0.0500",
    categoryPriceIncludesTax: false,
    ...over,
  };
}

function fakeTx(categories: unknown[] = [RAISED]) {
  return {
    trackedCategory: { findMany: jest.fn().mockResolvedValue(categories) },
    product: { findMany: jest.fn().mockResolvedValue([{ id: "prod-1", unitsPerBox: null }]) },
    orderItem: { update: jest.fn().mockResolvedValue({}) },
  };
}

describe("recomputeLineCategoryTaxes (order side)", () => {
  it("leaves a snapshot line unchanged after the category rate is raised, and never reads the category", async () => {
    const tx = fakeTx();
    const logger = { warn: jest.fn() };
    const sum = await recomputeLineCategoryTaxes(tx, [line()], logger);
    expect(sum).toBe(0.6);
    expect(tx.trackedCategory.findMany).not.toHaveBeenCalled();
    expect(tx.orderItem.update).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("recomputes a changed quantity at the SNAPSHOT rate, writing only the amount", async () => {
    const tx = fakeTx();
    const sum = await recomputeLineCategoryTaxes(tx, [line({ qty: 6, subtotal: 50 })], {
      warn: jest.fn(),
    });
    expect(sum).toBe(0.3);
    expect(tx.orderItem.update).toHaveBeenCalledTimes(1);
    expect(tx.orderItem.update).toHaveBeenCalledWith({
      where: { id: "li-1" },
      data: { categoryTaxAmount: 0.3 },
    });
  });

  it("prices a NULL-trio line at the live category once, stamps the trio and warns naming the line", async () => {
    const tx = fakeTx();
    const logger = { warn: jest.fn() };
    const sum = await recomputeLineCategoryTaxes(
      tx,
      [line({ categoryTaxType: null, categoryTaxRate: null, categoryPriceIncludesTax: null })],
      logger,
    );
    expect(sum).toBe(0.84);
    expect(tx.trackedCategory.findMany).toHaveBeenCalledWith({ where: { id: { in: ["cat-1"] } } });
    expect(tx.orderItem.update).toHaveBeenCalledWith({
      where: { id: "li-1" },
      data: {
        categoryTaxAmount: 0.84,
        categoryTaxType: "EXCISE_PER_UNIT",
        categoryTaxRate: 0.07,
        categoryPriceIncludesTax: false,
      },
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain("li-1");
  });

  it("stamps a NULL trio even when the amount is already right (so the snapshot exists from now on)", async () => {
    const tx = fakeTx();
    await recomputeLineCategoryTaxes(
      tx,
      [
        line({
          categoryTaxType: null,
          categoryTaxRate: null,
          categoryPriceIncludesTax: null,
          categoryTaxAmount: 0.84,
        }),
      ],
      { warn: jest.fn() },
    );
    expect(tx.orderItem.update).toHaveBeenCalledWith({
      where: { id: "li-1" },
      data: {
        categoryTaxAmount: 0.84,
        categoryTaxType: "EXCISE_PER_UNIT",
        categoryTaxRate: 0.07,
        categoryPriceIncludesTax: false,
      },
    });
  });

  it("treats a partly NULL trio as NULL", async () => {
    const tx = fakeTx();
    await recomputeLineCategoryTaxes(tx, [line({ categoryPriceIncludesTax: null })], {
      warn: jest.fn(),
    });
    expect(tx.trackedCategory.findMany).toHaveBeenCalled();
    expect(tx.orderItem.update.mock.calls[0][0].data.categoryTaxRate).toBe(0.07);
  });

  it("fetches categories only for the NULL-trio lines", async () => {
    const tx = fakeTx([{ ...RAISED, id: "cat-2" }]);
    await recomputeLineCategoryTaxes(
      tx,
      [
        line({ id: "li-snap", trackedCategoryId: "cat-1" }),
        line({
          id: "li-null",
          trackedCategoryId: "cat-2",
          categoryTaxType: null,
          categoryTaxRate: null,
          categoryPriceIncludesTax: null,
        }),
      ],
      { warn: jest.fn() },
    );
    expect(tx.trackedCategory.findMany).toHaveBeenCalledWith({ where: { id: { in: ["cat-2"] } } });
  });

  it("KEEPS the stored excise of a line with no category (the B767 shape), warns, and counts it in the sum [L1]", async () => {
    const tx = fakeTx();
    const logger = { warn: jest.fn() };
    const sum = await recomputeLineCategoryTaxes(
      tx,
      [
        line({
          trackedCategoryId: null,
          categoryTaxType: null,
          categoryTaxRate: null,
          categoryPriceIncludesTax: null,
          categoryTaxAmount: 4.2,
        }),
      ],
      logger,
    );
    expect(sum).toBe(4.2);
    expect(tx.orderItem.update).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain("li-1");
  });

  it("leaves a no-category line with a zero amount at 0, silently", async () => {
    const tx = fakeTx();
    const logger = { warn: jest.fn() };
    const sum = await recomputeLineCategoryTaxes(
      tx,
      [line({ trackedCategoryId: null, categoryTaxAmount: 0 })],
      logger,
    );
    expect(sum).toBe(0);
    expect(tx.orderItem.update).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("keeps the stored amount of a NULL-trio line whose category cannot be read, and stamps nothing", async () => {
    const tx = fakeTx([]);
    const logger = { warn: jest.fn() };
    const sum = await recomputeLineCategoryTaxes(
      tx,
      [line({ categoryTaxType: null, categoryTaxRate: null, categoryPriceIncludesTax: null })],
      logger,
    );
    expect(sum).toBe(0.6);
    expect(tx.orderItem.update).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("sums every line to cents and expands a box-unaware line by the product's pack", async () => {
    const tx = fakeTx();
    tx.product.findMany.mockResolvedValue([{ id: "prod-1", unitsPerBox: 6 }]);
    const sum = await recomputeLineCategoryTaxes(
      tx,
      [
        // 2 selling units x 6 = 12 pieces at the snapshot rate 0.05
        line({ id: "a", qty: 2, categoryTaxAmount: 0.6 }),
        line({ id: "b", qty: 2, categoryTaxAmount: 0.6 }),
      ],
      { warn: jest.fn() },
    );
    expect(sum).toBe(1.2);
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it("works without a logger", async () => {
    const tx = fakeTx();
    await expect(
      recomputeLineCategoryTaxes(tx, [line({ trackedCategoryId: null, categoryTaxAmount: 4.2 })]),
    ).resolves.toBe(4.2);
  });
});
