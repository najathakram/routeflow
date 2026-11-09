import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  CatchupCorrectionService,
  buildCorrectionRows,
  parseBillingStart,
} from "./catchup-correction.service";

/**
 * SA-1122 (i) / D14 PR-1: the one writer of the catch-up correction markers, with the planner and the database faked.
 * Rows C2-C6 and C9 are acceptance guards for a new surface (master has no route: a 404 is not red). C7 is the
 * discriminating row: the rows master's CLI core (`buildMarkerRows`) produced for one fixture, recorded below as it
 * observed them on master 279c6954a0, equal the service's rows in action and meta keys.
 */

const TENANT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-09T21:00:00.000Z");
const MARKER = "marker-act-1";

const plan = (stubCents: number) => ({
  ok: true as const,
  floor: new Date("2026-10-01T12:00:00Z"),
  paidThrough: new Date("2026-10-01T12:00:00Z"),
  stub: {
    from: new Date("2026-10-01T12:00:00Z"),
    to: new Date("2026-11-01T12:00:00Z"),
    totalCents: stubCents,
  },
  voidInvoiceIds: [] as string[],
});
const report = (over: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  claimState: null as string | null,
  markers: [
    {
      id: MARKER,
      action: "TENANT_MANUAL_ACTIVATION_MARKER",
      periodStart: "2026-10-12T04:08:24.000Z",
      periodEnd: "2026-11-11T04:08:24.000Z",
      state: "counts",
    },
  ],
  billingStartOverride: null,
  plan: plan(6776),
  ...over,
});

function build(opts: { claim?: string | null; before?: number | null; name?: string } = {}) {
  const calls: string[] = [];
  const created: any[] = [];
  const tx = {
    $queryRaw: jest.fn(async () => {
      calls.push("lock");
      return [];
    }),
    tenantSubscription: {
      findUnique: jest.fn(async () => {
        calls.push("claim");
        return { catchupState: opts.claim ?? null };
      }),
    },
    auditLog: {
      create: jest.fn(async (a: any) => {
        calls.push("insert");
        created.push(a.data);
        return { id: `row-${created.length}` };
      }),
    },
  };
  const prisma: any = {
    tenant: { findUnique: jest.fn(async () => ({ name: opts.name ?? "Acme Test Co" })) },
    auditLog: { findFirst: jest.fn(async () => ({ createdAt: new Date("2026-10-13T08:00:00Z") })) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const planFn = jest.fn(async (_id: string, _now: Date, o?: any) =>
    o?.extraMarkerRows
      ? report({ plan: plan(10000) })
      : report({
          plan:
            opts.before === null ? { ok: false, reason: "no_floor" } : plan(opts.before ?? 6776),
        }),
  );
  const svc = new CatchupCorrectionService(prisma, { plan: planFn } as any);
  return { svc, prisma, tx, calls, created, planFn };
}

const apply = (over: Record<string, unknown> = {}) => ({
  voidCoverage: [MARKER],
  reason: "owner states nothing was paid",
  expectedBefore: 6776,
  confirmTenantName: "Acme Test Co",
  ...over,
});
const code = async (p: Promise<unknown>) => {
  const e: any = await p.then(
    () => null,
    (x) => x,
  );
  return { status: e?.getStatus?.(), body: e?.getResponse?.() };
};

describe("CatchupCorrectionService.apply", () => {
  it("writes one VOID row, under the Tenant lock: lock, claim read, then the insert (C1 guard)", async () => {
    const { svc, calls, created } = build();
    const out = await svc.apply(TENANT, apply() as any, "admin-1", NOW);
    expect(out).toEqual({ tenantId: TENANT, appended: ["row-1"] });
    expect(calls).toEqual(["lock", "claim", "insert"]);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      tenantId: TENANT,
      userId: "admin-1",
      action: "TENANT_MANUAL_ACTIVATION_COVERAGE_VOID",
      entityType: "tenant",
      entityId: TENANT,
      meta: {
        platformAdmin: true,
        voidsMarkerId: MARKER,
        reason: "owner states nothing was paid",
        actor: "admin-1",
        ownerApprovedAt: NOW.toISOString(),
      },
    });
  });

  it("C2: a held claim is 409 CATCHUP_CLAIM_HELD and writes nothing", async () => {
    for (const state of ["SESSION_OPEN", "AWAITING_FIRST_PAYMENT", "RELEASING"]) {
      const { svc, calls, tx } = build({ claim: state });
      const r = await code(svc.apply(TENANT, apply() as any, "admin-1", NOW));
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ code: API_ERROR_CODES.CATCHUP_CLAIM_HELD, claimState: state });
      expect(tx.auditLog.create).not.toHaveBeenCalled();
      expect(calls).toEqual(["lock", "claim"]);
    }
  });

  it("C3: a void and a restore of one marker is 400 CATCHUP_CORRECTION_CONFLICT and writes nothing", async () => {
    const { svc, prisma } = build();
    const r = await code(svc.apply(TENANT, apply({ restoreCoverage: [MARKER] }) as any, "a", NOW));
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: API_ERROR_CODES.CATCHUP_CORRECTION_CONFLICT });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("C4: a marker id that is not this tenant's activation marker is 404 and writes nothing", async () => {
    const { svc, prisma } = build();
    await expect(
      svc.apply(TENANT, apply({ voidCoverage: ["another-tenants-marker"] }) as any, "a", NOW),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("C5: expectedBefore off by one cent is 409 CATCHUP_PREVIEW_STALE and writes nothing", async () => {
    for (const expectedBefore of [6775, 6777]) {
      const { svc, tx } = build();
      const r = await code(svc.apply(TENANT, apply({ expectedBefore }) as any, "a", NOW));
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ code: API_ERROR_CODES.CATCHUP_PREVIEW_STALE, current: 6776 });
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    }
  });

  it("C5: a plan that cannot be planned has BEFORE null; the screen's null matches it, a number does not", async () => {
    const ok = build({ before: null });
    await expect(
      ok.svc.apply(TENANT, apply({ expectedBefore: null }) as any, "a", NOW),
    ).resolves.toBeDefined();
    const stale = build({ before: null });
    expect(
      (await code(stale.svc.apply(TENANT, apply({ expectedBefore: 6776 }) as any, "a", NOW)))
        .status,
    ).toBe(409);
  });

  it("C9: a wrong tenant name is 400 and writes nothing (trimmed, otherwise exact)", async () => {
    const { svc, prisma } = build();
    for (const confirmTenantName of ["acme test co", "Acme Test", "", "  "]) {
      const r = await code(svc.apply(TENANT, apply({ confirmTenantName }) as any, "a", NOW));
      expect(r.status).toBe(400);
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
    await expect(
      svc.apply(TENANT, apply({ confirmTenantName: "  Acme Test Co  " }) as any, "a", NOW),
    ).resolves.toBeDefined();
  });

  it("the reason is required, trimmed, 10 to 500 characters", async () => {
    for (const reason of ["", "         x", "too short", "x".repeat(501)]) {
      const { svc, prisma } = build();
      const r = await code(svc.apply(TENANT, apply({ reason }) as any, "a", NOW));
      expect(r.status).toBe(400);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    }
    const { svc, created } = build();
    await svc.apply(TENANT, apply({ reason: "  ten chars!  " }) as any, "a", NOW);
    expect(created[0].meta.reason).toBe("ten chars!");
  });

  it("an empty body is 400", async () => {
    const { svc } = build();
    await expect(
      svc.apply(
        TENANT,
        { reason: "a good reason", expectedBefore: 1, confirmTenantName: "Acme Test Co" } as any,
        "a",
        NOW,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("void + restore + billing start write three rows in that order, one stamp", async () => {
    const { svc, created } = build();
    const r = report({
      markers: [
        {
          id: "m1",
          action: "TENANT_MANUAL_ACTIVATION_MARKER",
          periodStart: null,
          periodEnd: null,
          state: "counts",
        },
        {
          id: "m2",
          action: "TENANT_MANUAL_ACTIVATION_MARKER",
          periodStart: null,
          periodEnd: null,
          state: "voided",
        },
      ],
    });
    (svc as any).catchup.plan = jest.fn(async () => r);
    await svc.apply(
      TENANT,
      apply({ voidCoverage: ["m1"], restoreCoverage: ["m2"], billingStart: "2026-10-01" }) as any,
      "admin-1",
      NOW,
    );
    expect(created.map((c) => c.action)).toEqual([
      "TENANT_MANUAL_ACTIVATION_COVERAGE_VOID",
      "TENANT_MANUAL_ACTIVATION_COVERAGE_RESTORE",
      "TENANT_BILLING_START_OVERRIDE",
    ]);
    expect(created[2].meta.billingStart).toBe("2026-10-01T12:00:00.000Z");
  });
});

describe("C6: the billing start is the 1st at 12:00Z, not before go-live", () => {
  it.each([
    ["the 2nd", "2026-10-02"],
    ["00:00Z", "2026-10-01T00:00:00.000Z"],
    ["before go-live", "2026-09-01"],
    ["not a date", "soon"],
    ["empty after trim", "   "],
    ["12:00:01Z", "2026-10-01T12:00:01.000Z"],
  ])("%s => 400 CATCHUP_BILLING_START_INVALID", (_n, input) => {
    try {
      parseBillingStart(input);
      throw new Error("accepted");
    } catch (e: any) {
      expect(e.getStatus()).toBe(400);
      expect(e.getResponse()).toMatchObject({
        code: API_ERROR_CODES.CATCHUP_BILLING_START_INVALID,
      });
    }
  });

  it.each(["2026-10-01", "2026-12-01", "2026-10-01T12:00:00.000Z"])("%s is accepted", (input) => {
    expect(parseBillingStart(input).getUTCHours()).toBe(12);
  });

  it("a bad billing start writes nothing", async () => {
    const { svc, prisma } = build();
    const r = await code(svc.apply(TENANT, apply({ billingStart: "2026-10-02" }) as any, "a", NOW));
    expect(r.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("C7 (parity): the rows master's CLI core built, equal the service's rows", () => {
  // OBSERVED on master 279c6954a0: node -e 'require("./scripts/lib/billing-correct-activation-core.cjs").buildMarkerRows(...)'
  // with args { reason: "r r r r r r", voidCoverage: ["m1"], restoreCoverage: ["m2"], billingStart: "2026-10-01T12:00:00.000Z" },
  // actor "actor-1", ownerApprovedAt "2026-11-09T21:00:00.000Z". The CLI added { platformAdmin: true } at insert.
  const MASTER_ROWS = [
    {
      action: "TENANT_MANUAL_ACTIVATION_COVERAGE_VOID",
      meta: {
        voidsMarkerId: "m1",
        reason: "r r r r r r",
        actor: "actor-1",
        ownerApprovedAt: "2026-11-09T21:00:00.000Z",
      },
    },
    {
      action: "TENANT_MANUAL_ACTIVATION_COVERAGE_RESTORE",
      meta: {
        restoresMarkerId: "m2",
        reason: "r r r r r r",
        actor: "actor-1",
        ownerApprovedAt: "2026-11-09T21:00:00.000Z",
      },
    },
    {
      action: "TENANT_BILLING_START_OVERRIDE",
      meta: {
        billingStart: "2026-10-01T12:00:00.000Z",
        reason: "r r r r r r",
        actor: "actor-1",
        ownerApprovedAt: "2026-11-09T21:00:00.000Z",
      },
    },
  ];

  it("the same fixture gives the same rows, action and meta, in the same order", () => {
    const rows = buildCorrectionRows(
      {
        voidCoverage: ["m1"],
        restoreCoverage: ["m2"],
        billingStart: new Date("2026-10-01T12:00:00.000Z"),
      },
      { reason: "r r r r r r", actor: "actor-1", ownerApprovedAt: "2026-11-09T21:00:00.000Z" },
    );
    expect(rows).toEqual(MASTER_ROWS);
  });

  it("the stored meta keys are the CLI's plus platformAdmin (what the CLI inserted)", async () => {
    const { svc, created } = build();
    await svc.apply(TENANT, apply({ voidCoverage: [MARKER] }) as any, "actor-1", NOW);
    expect(Object.keys(created[0].meta).sort()).toEqual(
      ["platformAdmin", ...Object.keys(MASTER_ROWS[0].meta)].sort(),
    );
  });
});

describe("preview and view", () => {
  it("preview writes nothing, plans AFTER with in-memory rows later than every stored marker, and reports both", async () => {
    const { svc, prisma, planFn, tx } = build();
    const out = await svc.preview(
      TENANT,
      { voidCoverage: [MARKER], billingStart: "2026-10-01" },
      NOW,
    );
    expect(out.before?.stubCents).toBe(6776);
    expect(out.after?.stubCents).toBe(10000);
    expect(out.markers[0]).toMatchObject({ id: MARKER, stateBefore: "counts", state: "voided" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    const extra = planFn.mock.calls.find((c) => c[2]?.extraMarkerRows)![2].extraMarkerRows;
    expect(extra.map((r: any) => r.action)).toEqual([
      "TENANT_MANUAL_ACTIVATION_COVERAGE_VOID",
      "TENANT_BILLING_START_OVERRIDE",
    ]);
    for (const r of extra) {
      expect(r.createdAt.getTime()).toBeGreaterThan(new Date("2026-10-13T08:00:00Z").getTime());
      expect(String(r.id)).toMatch(/^~preview-/);
    }
  });

  it("a preview of a marker from another tenant is 404; the same refusals as apply", async () => {
    const { svc } = build();
    await expect(svc.preview(TENANT, { voidCoverage: ["nope"] }, NOW)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.preview(TENANT, {}, NOW)).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.preview(TENANT, { voidCoverage: [MARKER], restoreCoverage: [MARKER] }, NOW),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.preview(TENANT, { billingStart: "2026-10-02" }, NOW)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("view lists the markers, the claim and the summary, and carries the marker version", async () => {
    const { svc } = build({ claim: null });
    const v = await svc.view(TENANT, NOW);
    expect(v).toMatchObject({
      tenantId: TENANT,
      markersVersion: 1,
      claimState: null,
      summary: { stubCents: 6776 },
      note: null,
    });
    expect(v.markers).toHaveLength(1);
  });

  it("a plan that cannot be planned reports a null summary and a note, not an error", async () => {
    const { svc } = build({ before: null });
    const v = await svc.view(TENANT, NOW);
    expect(v.summary).toBeNull();
    expect(v.note).toMatch(/cannot plan/);
  });

  it("a held claim is reported by preview (the screen disables the actions) and never throws there", async () => {
    const { svc, planFn } = build();
    planFn.mockImplementation(async () => report({ claimState: "SESSION_OPEN" }) as any);
    await expect(svc.preview(TENANT, { voidCoverage: [MARKER] }, NOW)).resolves.toMatchObject({
      claimState: "SESSION_OPEN",
    });
  });

  it("ConflictException is what a stale or held refusal throws (the HTTP 409)", async () => {
    const { svc } = build({ claim: "RELEASING" });
    await expect(svc.apply(TENANT, apply() as any, "a", NOW)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
