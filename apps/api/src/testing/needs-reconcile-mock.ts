/**
 * A module-boundary double for `billing/needs-reconcile` (SA-733r3 N4), for the specs that exercise a plan-change /
 * price flow rather than the flag itself: `arm` / `clear` are spies (assert the ORDER against the Stripe mock),
 * and `mark` keeps the real ERROR-level alert line but never touches a database. The real module has its own
 * spec (needs-reconcile.spec.ts) and a DB spec.
 *
 *   jest.mock("./needs-reconcile", () => require("../testing/needs-reconcile-mock").needsReconcileMock());
 */
export function needsReconcileMock(): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const actual = jest.requireActual("../billing/needs-reconcile");
  return {
    ...actual,
    armNeedsReconcile: jest.fn(async () => ({ owned: true })),
    clearNeedsReconcile: jest.fn(async () => undefined),
    markNeedsReconcile: jest.fn(async (deps: any, info: any) =>
      actual.markNeedsReconcile({ logger: deps.logger }, info),
    ),
  };
}
