/**
 * An in-memory order store for the delivered-stamp specs (SA-763r): orders, their lines and the
 * DeliveryMutation evidence rows, behind the few delegates the stamp, the status write and cancel-impact
 * read. `tenantTransaction` is real in the one way that matters: it works on a COPY and keeps it only when
 * the callback resolves, so a throw rolls the status and the stamp back together.
 *
 * Test support only (excluded from the build with `**\/testing/**`).
 */
export type FakeLine = {
  id: string;
  orderId?: string;
  productId?: string | null;
  qty: number;
  deliveredQty: number;
  status?: string;
};
export type FakeMutation = {
  orderId?: string;
  orderItemId: string | null;
  type: string;
  quantityDelivered: number | null;
  /** Set on a route-stop row; null/absent on an office-recorded one (R5 part 2, row 587). */
  routeRunStopId?: string | null;
  driverId?: string | null;
  note?: string | null;
};
export type FakeOrder = {
  id: string;
  status: string;
  routeRunStopId: string | null;
  deliveredAt: Date | null;
};
export type FakeAudit = Record<string, any>;
export type FakeState = {
  order: FakeOrder;
  lines: FakeLine[];
  mutations: FakeMutation[];
  audits: FakeAudit[];
};

export function makeStampDb(seed: {
  status?: string;
  routeRunStopId?: string | null;
  lines: FakeLine[];
  mutations?: FakeMutation[];
  failAfterStatusWrite?: boolean;
}) {
  const committed: FakeState = {
    order: {
      id: "o1",
      status: seed.status ?? "CONFIRMED",
      routeRunStopId: seed.routeRunStopId ?? null,
      deliveredAt: null,
    },
    lines: seed.lines.map((l) => ({ status: "PENDING", orderId: "o1", ...l })),
    mutations: (seed.mutations ?? []).map((m) => ({ orderId: "o1", ...m })),
    audits: [],
  };
  const calls = { txCount: 0, lineWrites: 0 };
  const clone = (s: FakeState): FakeState => ({
    order: { ...s.order },
    lines: s.lines.map((l) => ({ ...l })),
    mutations: s.mutations.map((m) => ({ ...m })),
    audits: s.audits.map((a) => ({ ...a })),
  });
  const delegates = (state: FakeState, inTx: boolean) => ({
    order: {
      findFirst: async () => ({ ...state.order }),
      findUnique: async () => ({ ...state.order }),
      update: async ({ where, data }: any) => {
        // B1095: the status write is a compare-and-set; no row matching is Prisma's P2025
        if (where.status !== undefined && where.status !== state.order.status) {
          throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
        }
        Object.assign(state.order, data);
        if (inTx && seed.failAfterStatusWrite) throw new Error("boom after the status write");
        return { ...state.order };
      },
    },
    orderItem: {
      findMany: async ({ where }: any) =>
        state.lines
          .filter((l) => where?.status?.not === undefined || l.status !== where.status.not)
          .map((l) => ({ ...l })),
      update: async ({ where, data }: any) => {
        const line = state.lines.find((l) => l.id === where.id);
        if (!line) throw new Error(`no line ${where.id}`);
        calls.lineWrites += 1;
        Object.assign(line, data);
        return { ...line };
      },
    },
    deliveryMutation: {
      findMany: async () => state.mutations.map((m) => ({ ...m })),
      // B692: an office PARTIALLY_DELIVERED writes its per-line evidence rows from the status transaction
      create: async ({ data }: any) => {
        state.mutations.push({ ...data });
        return { ...data };
      },
    },
    // row 587 (SA-833 a): the office-completion audit rows
    auditLog: {
      create: async ({ data }: any) => {
        state.audits.push({ ...data });
        return { ...data };
      },
    },
    invoice: { findMany: async () => [] },
  });
  const prisma: any = {
    getTenantId: () => "t1",
    forTenant: () => delegates(committed, false),
    tenantTransaction: async (fn: (tx: any) => Promise<unknown>) => {
      calls.txCount += 1;
      const draft = clone(committed);
      const result = await fn(delegates(draft, true));
      committed.order = draft.order; // commit only when the callback resolved
      committed.lines = draft.lines;
      committed.mutations = draft.mutations;
      committed.audits = draft.audits;
      return result;
    },
  };
  return {
    committed,
    prisma,
    calls,
    line: (id: string) => committed.lines.find((l) => l.id === id)!,
  };
}
