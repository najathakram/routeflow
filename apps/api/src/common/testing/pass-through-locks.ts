/**
 * A `jest.mock("../common/db-locks", ...)` factory for unit specs with no database: every advisory lock is taken at
 * once and runs its critical section. The real locks are covered by the DB lane (db-locks.db.spec.ts and the
 * writers' own *.db.spec.ts). Use: `jest.mock("../common/db-locks", () => require("../common/testing/pass-through-locks").locks());`
 */
export function locks(): Record<string, unknown> {
  const actual = jest.requireActual("../db-locks") as Record<string, unknown>;
  return {
    ...actual,
    withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => unknown) => ({
      acquired: true,
      value: await fn(),
    })),
  };
}
