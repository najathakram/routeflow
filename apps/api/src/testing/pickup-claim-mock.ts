/**
 * Unit-spec double of `orders/counter-sale/pickup-complete-claim.ts` (the claim row's atomic jsonb writes are raw SQL, so
 * mocked Prisma cannot run them). It works on the spec's own in-memory claim rows (`mockClaimStore.rows`, the array the
 * spec's auditLog mocks already use) with the same semantics: merge own keys, reserve once per completion, finish / release.
 * The real statements are pinned on Postgres by pickup-complete.complete-at-counter.db.spec.ts.
 *
 *   jest.mock("./pickup-complete-claim", () => require("../../testing/pickup-claim-mock").pickupClaimMock);
 *   beforeEach: mockClaimStore.rows = claims;
 */
export const mockClaimStore: {
  rows: Array<{ id?: string; meta?: Record<string, any> | null }>;
  recorded: boolean;
} = {
  rows: [],
  recorded: false,
};

const rowOf = (id: string) =>
  mockClaimStore.rows.find((r) => r.id === id) ?? mockClaimStore.rows[0];

export const pickupClaimMock = {
  COMPLETION_EMAIL_LEASE_MINUTES: 10,
  mergeClaimMeta: async (
    _db: unknown,
    _tenantId: string,
    id: string,
    patch: Record<string, unknown>,
  ) => {
    const row = rowOf(id);
    if (row) row.meta = { ...(row.meta ?? {}), ...patch };
  },
  reserveCompletionEmail: async (
    _db: unknown,
    _tenantId: string,
    id: string,
    completionFor: string,
  ) => {
    const row = rowOf(id);
    if (!row) return null;
    const meta = row.meta ?? {};
    if (meta.completionEmailedFor === completionFor) return null;
    if (meta.completionEmailClaim?.for === completionFor) return null; // a live claim (no clock in unit specs)
    const at = new Date().toISOString();
    row.meta = { ...meta, completionEmailClaim: { for: completionFor, at } };
    return at;
  },
  finishCompletionEmail: async (
    _db: unknown,
    _tenantId: string,
    id: string,
    completionFor: string,
  ) => {
    const row = rowOf(id);
    if (!row) return;
    const { completionEmailClaim: _drop, ...rest } = row.meta ?? {};
    row.meta = { ...rest, completionEmailedFor: completionFor };
  },
  releaseCompletionEmail: async (
    _db: unknown,
    _tenantId: string,
    id: string,
    completionFor: string,
    at: string,
  ) => {
    const row = rowOf(id);
    const claim = row?.meta?.completionEmailClaim;
    if (row && claim?.for === completionFor && claim?.at === at) {
      const { completionEmailClaim: _drop, ...rest } = row.meta ?? {};
      row.meta = rest;
    }
  },
  completionAlreadyRecorded: async () => mockClaimStore.recorded,
  // SA-919: the completion stamp is the unit specs' own hand-over moment (their T_DELIVERED, 1000), not a clock
  stampCompletion: async (_db: unknown, _tenantId: string, id: string) => {
    const row = rowOf(id);
    const at = new Date(1000);
    if (row) row.meta = { ...(row.meta ?? {}), completionAt: at.toISOString() };
    return at;
  },
  completionAtOf: (meta: unknown) => {
    const at = (meta as { completionAt?: unknown } | null)?.completionAt;
    return typeof at === "string" ? new Date(at) : null;
  },
};
