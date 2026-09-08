import { exampleOrder, exampleRoutes, nextChapter } from "./operation-model";

// R-MKT T8a — the pure operation-model functions backing the interactive
// delivery-story demo (ported from the redesign's lib/operation-model.mjs).
describe("operation-model — R-MKT T8a", () => {
  it("prices an unpaid, undelivered order as cases*18 + 42, balance = total (R-MKT T8a)", () => {
    const order = exampleOrder(4, { delivered: false, paid: false });
    expect(order.total).toBe(114);
    expect(order.balance).toBe(114);
    expect(order.delivered).toBe(false);
  });

  it("zeroes the balance once the order is both delivered and paid (R-MKT T8a)", () => {
    const order = exampleOrder(4, { delivered: true, paid: true });
    expect(order.balance).toBe(0);
  });

  it("still owes the full balance when paid but not yet delivered (R-MKT T8a)", () => {
    const paidUndelivered = exampleOrder(4, { delivered: false, paid: true });
    const unpaidUndelivered = exampleOrder(4, { delivered: false, paid: false });
    expect(paidUndelivered.paid).toBe(false);
    expect(paidUndelivered.balance).toBe(unpaidUndelivered.balance);
  });

  it("clamps cases to [1, 12] and falls back to 4 for a non-finite quantity (R-MKT T8a)", () => {
    expect(exampleOrder(0).cases).toBe(1);
    expect(exampleOrder(99).cases).toBe(12);
    expect(exampleOrder(NaN).cases).toBe(4);
  });

  it("caps the chapter at the final chapter and otherwise advances by one (R-MKT T8a)", () => {
    expect(nextChapter(5)).toBe(5);
    expect(nextChapter(2)).toBe(3);
  });

  it("ships exactly two sample routes with distinct names (R-MKT T8a)", () => {
    expect(exampleRoutes).toHaveLength(2);
    const names = new Set(exampleRoutes.map((route) => route.name));
    expect(names.size).toBe(2);
  });
});
