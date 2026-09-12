import { ConflictException, NotFoundException } from "@nestjs/common";
import { GoHighLevelPollService, type CrmSyncCounts } from "./gohighlevel-poll.service";

// TP3 — poll service (T13-T21, T52, T54). See
// .claude/pipeline/2026-09-11-crm-gohighlevel-handoff/test-plan.md §3 for each oracle.
//
// Construction follows the repo's plain-constructor-injection pattern for cron/poll-style
// services (see apps/api/src/billing/billing-cron.service.spec.ts) rather than Nest's
// TestingModule — no DI container needed for a class with four constructor params.

function zeroCounts(): CrmSyncCounts {
  return { fetched: 0, new: 0, created: 0, linked: 0, needsReview: 0, dryRun: 0, failed: 0 };
}

function makeConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn-1",
    tenantId: "tenant-1",
    enabled: true,
    status: "CONNECTED",
    dryRun: false,
    secretCipher: "cipher-x",
    pipelineId: "p1",
    stageId: "s1",
    startFrom: new Date("2026-09-01T00:00:00Z"),
    attentionNotifiedAt: null,
    nextPollAt: null,
    lastError: null,
    ...overrides,
  };
}

function makeOpportunity(overrides: Record<string, unknown> = {}) {
  return {
    id: "opp-1",
    name: "Big Order",
    pipelineId: "p1",
    pipelineStageId: "s1",
    contactId: "contact-1",
    lastStageChangeAt: "2026-09-05T00:00:00Z",
    ...overrides,
  };
}

function make() {
  const client = {
    searchOpportunities: jest.fn().mockResolvedValue({ opportunities: [], meta: {} }),
  };
  const clientFactory = jest.fn().mockReturnValue(client);

  const prisma = {
    crmConnection: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    crmHandoff: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };

  const handoffService = { handle: jest.fn().mockResolvedValue(undefined) };
  const emailService = { send: jest.fn().mockResolvedValue({ success: true }) };

  const svc = new GoHighLevelPollService(prisma, clientFactory, handoffService, emailService);
  return { svc, prisma, clientFactory, client, handoffService, emailService };
}

describe("GoHighLevelPollService", () => {
  // T13 / R8 — one tenant's failure never stops the others
  it("pollAll isolates a per-tenant failure: tenant B still polls and A's connection records the error", async () => {
    const { svc, prisma } = make();
    const connA = makeConnection({ id: "conn-A", tenantId: "tenant-A" });
    const connB = makeConnection({ id: "conn-B", tenantId: "tenant-B" });
    prisma.crmConnection.findMany.mockResolvedValue([connA, connB]);

    const pollTenantSpy = jest
      .spyOn(svc, "pollTenant")
      .mockImplementation(async (tenantId: string) => {
        if (tenantId === "tenant-A") throw new Error("boom");
        return zeroCounts();
      });

    await expect(svc.pollAll()).resolves.not.toThrow();

    expect(pollTenantSpy).toHaveBeenCalledWith("tenant-A");
    expect(pollTenantSpy).toHaveBeenCalledWith("tenant-B");
    const updateCallForA = prisma.crmConnection.update.mock.calls.find(
      (c: any[]) => c[0]?.where?.id === "conn-A",
    );
    expect(updateCallForA?.[0]?.data?.lastError).toBeTruthy();
  });

  // M7 — pollAll must not select a tenant still inside its 429 cooldown window
  it("pollAll selects only connections whose nextPollAt is null or already due", async () => {
    const { svc, prisma } = make();
    jest.spyOn(svc, "pollTenant").mockResolvedValue(zeroCounts());

    await svc.pollAll();

    const where = prisma.crmConnection.findMany.mock.calls[0][0]?.where;
    expect(where).toMatchObject({ enabled: true, status: "CONNECTED" });
    expect(where.OR).toEqual([{ nextPollAt: null }, { nextPollAt: { lte: expect.any(Date) } }]);
  });

  // T14 / R9 — pagination: called twice with page 1 then page 2
  it("pollTenant pages through searchOpportunities using meta.nextPage", async () => {
    const { svc, prisma, client } = make();
    const connection = makeConnection();
    prisma.crmConnection.findFirst.mockResolvedValue(connection);
    client.searchOpportunities
      .mockResolvedValueOnce({ opportunities: [], meta: { nextPage: 2 } })
      .mockResolvedValueOnce({ opportunities: [], meta: {} });

    await svc.pollTenant("tenant-1");

    expect(client.searchOpportunities).toHaveBeenCalledTimes(2);
    expect(client.searchOpportunities.mock.calls[0][0]).toMatchObject({ page: 1 });
    expect(client.searchOpportunities.mock.calls[1][0]).toMatchObject({ page: 2 });
  });

  // T15 / R10 — stale opportunity (before connection.startFrom) is NOT handed off; a fresh
  // sibling opportunity from the same poll IS, so a no-op pollTenant (0 calls either way) and
  // a cutoff-blind implementation (which would also skip the fresh one) both fail this.
  it("skips an opportunity whose lastStageChangeAt is before the connection's startFrom cutoff", async () => {
    const { svc, prisma, client, handoffService } = make();
    const connection = makeConnection({ startFrom: new Date("2026-09-05T00:00:00Z") });
    prisma.crmConnection.findFirst.mockResolvedValue(connection);
    const staleOpp = makeOpportunity({ lastStageChangeAt: "2026-09-04T23:00:00Z" });
    const freshOpp = makeOpportunity({
      id: "opp-fresh",
      lastStageChangeAt: "2026-09-06T00:00:00Z",
    });
    client.searchOpportunities.mockResolvedValue({
      opportunities: [staleOpp, freshOpp],
      meta: {},
    });

    await svc.pollTenant("tenant-1");

    expect(client.searchOpportunities).toHaveBeenCalledTimes(1);
    expect(handoffService.handle).toHaveBeenCalledTimes(1);
    expect(handoffService.handle.mock.calls[0][1]).toMatchObject({ id: "opp-fresh" });
    expect(prisma.crmHandoff.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ opportunityId: staleOpp.id }),
      }),
    );
  });

  // T16 / R10 — ignoreCutoff=true hands the same stale opportunity off anyway
  it("hands off the stale opportunity from T15 when pollTenant is called with ignoreCutoff:true", async () => {
    const { svc, prisma, client, handoffService } = make();
    const connection = makeConnection({ startFrom: new Date("2026-09-05T00:00:00Z") });
    prisma.crmConnection.findFirst.mockResolvedValue(connection);
    const staleOpp = makeOpportunity({ lastStageChangeAt: "2026-09-04T23:00:00Z" });
    client.searchOpportunities.mockResolvedValue({ opportunities: [staleOpp], meta: {} });

    await svc.pollTenant("tenant-1", { ignoreCutoff: true });

    expect(handoffService.handle).toHaveBeenCalledTimes(1);
    expect(handoffService.handle.mock.calls[0][1]).toMatchObject({ id: staleOpp.id });
  });

  // T17 / R11 — a terminal (CREATED) row already exists: never retried, but a sibling
  // opportunity with no crmHandoff row still gets handed off in the same poll.
  it("never calls the handoff service again for an opportunity with a terminal crmHandoff row", async () => {
    const { svc, prisma, client, handoffService } = make();
    const connection = makeConnection();
    prisma.crmConnection.findFirst.mockResolvedValue(connection);
    const handledOpp = makeOpportunity({ id: "opp-1" });
    const newOpp = makeOpportunity({ id: "opp-2" });
    client.searchOpportunities.mockResolvedValue({
      opportunities: [handledOpp, newOpp],
      meta: {},
    });
    prisma.crmHandoff.findFirst.mockImplementation((args: unknown) => {
      const isHandled = JSON.stringify(args ?? {}).includes("opp-1");
      return Promise.resolve(
        isHandled ? { id: "h-existing", opportunityId: "opp-1", status: "CREATED" } : null,
      );
    });

    await svc.pollTenant("tenant-1");

    expect(handoffService.handle).toHaveBeenCalledTimes(1);
    expect(handoffService.handle.mock.calls[0][1]).toMatchObject({ id: "opp-2" });
  });

  // T18 / R11 — a P2002 unique violation on insert is swallowed, not thrown, and the poll
  // keeps going: a second, non-colliding opportunity in the same batch still gets handed off.
  it("treats a P2002 unique-violation on crmHandoff.create as already-handled and does not throw", async () => {
    const { svc, prisma, client, handoffService } = make();
    const connection = makeConnection();
    prisma.crmConnection.findFirst.mockResolvedValue(connection);
    const collidingOpp = makeOpportunity({ id: "opp-1" });
    const otherOpp = makeOpportunity({ id: "opp-2" });
    client.searchOpportunities.mockResolvedValue({
      opportunities: [collidingOpp, otherOpp],
      meta: {},
    });
    prisma.crmHandoff.create.mockImplementation((args: unknown) => {
      const isColliding = JSON.stringify(args ?? {}).includes("opp-1");
      return isColliding ? Promise.reject({ code: "P2002" }) : Promise.resolve({});
    });

    await expect(svc.pollTenant("tenant-1")).resolves.not.toThrow();

    expect(prisma.crmHandoff.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ opportunityId: "opp-1" }),
      }),
    );
    expect(handoffService.handle).toHaveBeenCalledTimes(1);
    expect(handoffService.handle.mock.calls[0][1]).toMatchObject({ id: "opp-2" });
  });

  // T19 / R12 — auth failure notifies active OPERATOR/TENANT_ADMIN users exactly once
  it("emails active OPERATOR/TENANT_ADMIN users exactly once across two auth-failing polls", async () => {
    const { svc, prisma, client, emailService } = make();
    const connection = makeConnection({ attentionNotifiedAt: null });
    prisma.crmConnection.findFirst.mockResolvedValue(connection);
    prisma.user.findMany.mockResolvedValue([
      { id: "u1", email: "operator1@acme.test", role: "OPERATOR", isActive: true },
      { id: "u2", email: "operator2@acme.test", role: "TENANT_ADMIN", isActive: true },
    ]);
    const authError = Object.assign(new Error("unauthorized"), { name: "CrmAuthError" });
    client.searchOpportunities.mockRejectedValue(authError);

    await svc.pollTenant("tenant-1");
    await svc.pollTenant("tenant-1");

    expect(emailService.send).toHaveBeenCalledTimes(1);
    const sentTo = emailService.send.mock.calls[0][0]?.to;
    const recipients = Array.isArray(sentTo) ? sentTo : [sentTo];
    expect(recipients).toEqual(
      expect.arrayContaining(["operator1@acme.test", "operator2@acme.test"]),
    );
  });

  // T20 / R13 — a transient 429 leaves status untouched, records "rate limit" in lastError
  it("records a 'rate limit' lastError on 429 without changing connection status", async () => {
    const { svc, prisma, client } = make();
    const connection = makeConnection({ status: "CONNECTED" });
    prisma.crmConnection.findFirst.mockResolvedValue(connection);
    const rateLimitError = Object.assign(new Error("rate limited"), {
      name: "CrmRateLimitError",
      retryAfterSec: 30,
    });
    client.searchOpportunities.mockRejectedValue(rateLimitError);

    await svc.pollTenant("tenant-1");

    const updateCall = prisma.crmConnection.update.mock.calls.find(
      (c: any[]) => c[0]?.where?.id === connection.id,
    );
    expect(updateCall?.[0]?.data?.lastError).toEqual(expect.stringContaining("rate limit"));
    expect(updateCall?.[0]?.data?.status).toBeUndefined();
  });

  // M7 — the 429 branch also persists a cooldown derived from Retry-After, and a tenant still
  // inside that window is skipped even by a manual sync.
  it("sets a nextPollAt cooldown from retryAfterSec on 429 and skips a tenant still in cooldown", async () => {
    const { svc, prisma, client } = make();
    const connection = makeConnection();
    prisma.crmConnection.findFirst.mockResolvedValue(connection);
    const before = Date.now();
    client.searchOpportunities.mockRejectedValue(
      Object.assign(new Error("rate limited"), { name: "CrmRateLimitError", retryAfterSec: 30 }),
    );

    await svc.pollTenant("tenant-1");

    const cooldownWrite = prisma.crmConnection.update.mock.calls.find(
      (c: any[]) => c[0]?.data?.nextPollAt,
    );
    const nextPollAt = cooldownWrite?.[0]?.data?.nextPollAt as Date;
    expect(nextPollAt).toBeInstanceOf(Date);
    expect(nextPollAt.getTime()).toBeGreaterThanOrEqual(before + 29_000);

    // A second poll inside the window does no work at all and says why.
    client.searchOpportunities.mockClear();
    prisma.crmConnection.findFirst.mockResolvedValue(
      makeConnection({ nextPollAt: new Date(Date.now() + 60_000) }),
    );

    const counts = await svc.pollTenant("tenant-1");

    expect(counts).toMatchObject({ fetched: 0, skipped: "cooldown" });
    expect(client.searchOpportunities).not.toHaveBeenCalled();
  });

  // M1 — the sync counters are fed by handle()'s result, not left at zero
  it("counts created/linked/needsReview/dryRun from the handoff service's returned status", async () => {
    const { svc, prisma, client, handoffService } = make();
    prisma.crmConnection.findFirst.mockResolvedValue(makeConnection());
    client.searchOpportunities.mockResolvedValue({
      opportunities: [
        makeOpportunity({ id: "opp-1" }),
        makeOpportunity({ id: "opp-2" }),
        makeOpportunity({ id: "opp-3" }),
        makeOpportunity({ id: "opp-4" }),
      ],
      meta: {},
    });
    handoffService.handle
      .mockResolvedValueOnce({ status: "CREATED" })
      .mockResolvedValueOnce({ status: "LINKED" })
      .mockResolvedValueOnce({ status: "NEEDS_REVIEW" })
      .mockResolvedValueOnce({ status: "DRY_RUN" });

    const counts = await svc.pollTenant("tenant-1");

    expect(counts).toMatchObject({
      fetched: 4,
      new: 4,
      created: 1,
      linked: 1,
      needsReview: 1,
      dryRun: 1,
    });
  });

  // M11 — one bad opportunity is counted as failed and never aborts the rest of the tick
  it("counts a throwing opportunity as failed and keeps processing the rest of the page", async () => {
    const { svc, prisma, client, handoffService } = make();
    prisma.crmConnection.findFirst.mockResolvedValue(makeConnection());
    client.searchOpportunities.mockResolvedValue({
      opportunities: [makeOpportunity({ id: "opp-bad" }), makeOpportunity({ id: "opp-good" })],
      meta: {},
    });
    handoffService.handle.mockImplementation(async (_c: unknown, opp: { id: string }) => {
      if (opp.id === "opp-bad") throw new Error("handoff exploded");
      return { status: "CREATED" };
    });

    const counts = await svc.pollTenant("tenant-1");

    expect(counts).toMatchObject({ fetched: 2, failed: 1, created: 1 });
    expect(handoffService.handle).toHaveBeenCalledTimes(2);
  });

  // M17 — listTags is fetched at most once per tick: the same tag cache reaches every handle()
  it("passes one shared tagCache to every handle() call in a tick", async () => {
    const { svc, prisma, client, handoffService } = make();
    prisma.crmConnection.findFirst.mockResolvedValue(makeConnection());
    client.searchOpportunities.mockResolvedValue({
      opportunities: [makeOpportunity({ id: "opp-1" }), makeOpportunity({ id: "opp-2" })],
      meta: {},
    });

    await svc.pollTenant("tenant-1");

    const firstCache = handoffService.handle.mock.calls[0][2]?.tagCache;
    const secondCache = handoffService.handle.mock.calls[1][2]?.tagCache;
    expect(firstCache).toBeInstanceOf(Map);
    expect(secondCache).toBe(firstCache);
  });

  // m1 — the budget stop writes operator-readable copy, not the internal "budget" token
  it("writes a human-readable lastError when the wall-clock budget is exhausted", async () => {
    const { svc, prisma } = make();
    prisma.crmConnection.findFirst.mockResolvedValue(makeConnection());

    await svc.pollTenant("tenant-1", { budgetMs: -1 });

    const budgetWrite = prisma.crmConnection.update.mock.calls.find(
      (c: any[]) => typeof c[0]?.data?.lastError === "string",
    );
    expect(budgetWrite?.[0]?.data?.lastError).toBe(
      "Stopped after 0 s; will continue on the next check",
    );
  });

  // L-100 tenant scoping — every handoff read/write in a tick carries the tenant explicitly
  it("scopes every crmHandoff query in a tick to the polled tenant", async () => {
    const { svc, prisma, client } = make();
    prisma.crmConnection.findFirst.mockResolvedValue(makeConnection({ tenantId: "t1" }));
    client.searchOpportunities.mockResolvedValue({
      opportunities: [makeOpportunity({ id: "opp-1" })],
      meta: {},
    });

    await svc.pollTenant("t1");

    expect(prisma.crmConnection.findFirst.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
    expect(prisma.crmHandoff.findFirst.mock.calls[0][0].where.tenantId).toBe("t1");
    expect(prisma.crmHandoff.create.mock.calls[0][0].data.tenantId).toBe("t1");
  });

  // F12 — "Import existing" runs before ongoing sync is enabled
  it("pollTenant polls a disabled connection when ignoreEnabledGate is set, and not otherwise", async () => {
    const { svc, prisma, client } = make();
    prisma.crmConnection.findFirst.mockResolvedValue(makeConnection({ enabled: false }));

    await svc.pollTenant("tenant-1");
    expect(client.searchOpportunities).not.toHaveBeenCalled();

    await svc.pollTenant("tenant-1", { ignoreEnabledGate: true });
    expect(client.searchOpportunities).toHaveBeenCalledTimes(1);
  });

  // F12/F13 — a connection with no stored token is never polled or previewed
  it("never builds a client for a connection without a secretCipher", async () => {
    const { svc, prisma, clientFactory } = make();
    prisma.crmConnection.findFirst.mockResolvedValue(
      makeConnection({ secretCipher: null, enabled: true }),
    );

    const counts = await svc.pollTenant("tenant-1", { ignoreEnabledGate: true });
    const preview = await svc.previewImportExisting("tenant-1");

    expect(counts).toMatchObject({ fetched: 0 });
    expect(preview).toEqual({ count: 0, sample: [] });
    expect(clientFactory).not.toHaveBeenCalled();
  });

  // T52(a) / R22 — retryHandoff on a NEEDS_REVIEW row resets it to PENDING and re-runs handle
  it("retryHandoff resets a NEEDS_REVIEW row to PENDING and re-invokes the handoff service once", async () => {
    const { svc, prisma, handoffService } = make();
    const connection = makeConnection();
    const opportunity = makeOpportunity();
    prisma.crmHandoff.findFirst.mockResolvedValue({
      id: "h1",
      tenantId: "tenant-1",
      status: "NEEDS_REVIEW",
      opportunityId: opportunity.id,
      contactId: opportunity.contactId,
      payload: { opportunity },
    });
    prisma.crmConnection.findFirst.mockResolvedValue(connection);
    handoffService.handle.mockResolvedValue({ status: "CREATED" });

    const result = await svc.retryHandoff("tenant-1", "h1");

    const updateCall = prisma.crmHandoff.update.mock.calls.find(
      (c: any[]) => c[0]?.where?.id === "h1",
    );
    expect(updateCall?.[0]?.data).toMatchObject({ status: "PENDING", attempts: 0 });
    expect(updateCall?.[0]?.data?.nextAttemptAt).toBeTruthy();
    expect(handoffService.handle).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: "CREATED" });
  });

  // F5 — the connection is resolved by tenantId (CrmHandoff has no connectionId column) and
  // is resolved BEFORE the row is mutated, so a missing connection cannot strand the row.
  it("retryHandoff resolves the connection by tenantId and never mutates the row first", async () => {
    const { svc, prisma, handoffService } = make();
    prisma.crmHandoff.findFirst.mockResolvedValue({
      id: "h1",
      tenantId: "tenant-1",
      status: "FAILED",
      opportunityId: "opp-1",
      contactId: "contact-1",
      payload: null,
    });
    prisma.crmConnection.findFirst.mockResolvedValue(null);

    await expect(svc.retryHandoff("tenant-1", "h1")).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.crmConnection.findFirst).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1" },
    });
    expect(prisma.crmConnection.findUnique).not.toHaveBeenCalled();
    expect(prisma.crmHandoff.update).not.toHaveBeenCalled();
    expect(handoffService.handle).not.toHaveBeenCalled();
  });

  // M8 — a retried DRY_RUN row replays the stored opportunity, keeping deal name/value/source
  it("retryHandoff replays the opportunity stored on the dry-run payload", async () => {
    const { svc, prisma, handoffService } = make();
    prisma.crmConnection.findFirst.mockResolvedValue(makeConnection());
    prisma.crmHandoff.findFirst.mockResolvedValue({
      id: "h1",
      tenantId: "tenant-1",
      status: "DRY_RUN",
      opportunityId: "opp-1",
      contactId: "contact-1",
      payload: {
        opportunity: {
          id: "opp-1",
          name: "Big Order",
          monetaryValue: 1200,
          contactId: "contact-1",
        },
      },
    });

    await svc.retryHandoff("tenant-1", "h1");

    expect(handoffService.handle.mock.calls[0][1]).toMatchObject({
      id: "opp-1",
      name: "Big Order",
      monetaryValue: 1200,
    });
  });

  // T52(b) / R22 — retryHandoff on a CREATED (terminal) row throws ConflictException
  it("retryHandoff throws ConflictException for a terminal CREATED row", async () => {
    const { svc, prisma } = make();
    prisma.crmHandoff.findFirst.mockResolvedValue({
      id: "h1",
      tenantId: "tenant-1",
      status: "CREATED",
    });

    await expect(svc.retryHandoff("tenant-1", "h1")).rejects.toBeInstanceOf(ConflictException);
  });

  // T52(c) / R22 — dismissHandoff on a FAILED row marks it SKIPPED with reason "dismissed"
  it("dismissHandoff marks a FAILED row SKIPPED with reason dismissed", async () => {
    const { svc, prisma } = make();
    prisma.crmHandoff.findFirst.mockResolvedValue({
      id: "h2",
      tenantId: "tenant-1",
      status: "FAILED",
    });

    await svc.dismissHandoff("tenant-1", "h2");

    const updateCall = prisma.crmHandoff.update.mock.calls.find(
      (c: any[]) => c[0]?.where?.id === "h2",
    );
    expect(updateCall?.[0]?.data).toMatchObject({ status: "SKIPPED", reason: "dismissed" });
  });

  // T52(d) / R22 — dismissHandoff on a LINKED (terminal) row throws ConflictException
  it("dismissHandoff throws ConflictException for a terminal LINKED row", async () => {
    const { svc, prisma } = make();
    prisma.crmHandoff.findFirst.mockResolvedValue({
      id: "h3",
      tenantId: "tenant-1",
      status: "LINKED",
    });

    await expect(svc.dismissHandoff("tenant-1", "h3")).rejects.toBeInstanceOf(ConflictException);
  });

  // F8 (IDOR) — a handoff belonging to tenant B is simply not found for tenant A
  it("retry/dismiss scope the lookup by tenantId and 404 on another tenant's handoff id", async () => {
    const { svc, prisma } = make();
    // The mock behaves like Prisma: the row exists, but only for tenant-B.
    prisma.crmHandoff.findFirst.mockImplementation((args: any) =>
      Promise.resolve(
        args?.where?.tenantId === "tenant-B"
          ? { id: "h-b", tenantId: "tenant-B", status: "FAILED" }
          : null,
      ),
    );

    await expect(svc.retryHandoff("tenant-A", "h-b")).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.dismissHandoff("tenant-A", "h-b")).rejects.toBeInstanceOf(NotFoundException);

    for (const call of prisma.crmHandoff.findFirst.mock.calls) {
      expect(call[0].where).toMatchObject({ id: "h-b", tenantId: "tenant-A" });
    }
    expect(prisma.crmHandoff.update).not.toHaveBeenCalled();
  });

  // T54 / R23 — previewImportExisting is read-only; importExisting delegates to pollTenant
  it("previewImportExisting returns a count/sample and writes nothing", async () => {
    const { svc, prisma, client } = make();
    const connection = makeConnection();
    prisma.crmConnection.findFirst.mockResolvedValue(connection);
    const opp1 = makeOpportunity({ id: "opp-1", name: "Deal One", contactId: "c1" });
    const opp2 = makeOpportunity({ id: "opp-2", name: "Deal Two", contactId: "c2" });
    client.searchOpportunities.mockResolvedValue({ opportunities: [opp1, opp2], meta: {} });

    const result = await svc.previewImportExisting("tenant-1");

    expect(result).toMatchObject({ count: 2 });
    expect(result.sample).toHaveLength(2);
    expect(prisma.crmHandoff.create).not.toHaveBeenCalled();
  });

  // m2 — the existing-row lookup is ONE batched, tenant-scoped query per page, not one per row
  it("previewImportExisting batches the existing-row lookup per page and excludes handled ids", async () => {
    const { svc, prisma, client } = make();
    prisma.crmConnection.findFirst.mockResolvedValue(makeConnection({ tenantId: "t1" }));
    client.searchOpportunities.mockResolvedValue({
      opportunities: [
        makeOpportunity({ id: "opp-1" }),
        makeOpportunity({ id: "opp-2" }),
        makeOpportunity({ id: "opp-3" }),
      ],
      meta: {},
    });
    prisma.crmHandoff.findMany.mockResolvedValue([{ opportunityId: "opp-2" }]);

    const result = await svc.previewImportExisting("t1");

    expect(prisma.crmHandoff.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.crmHandoff.findFirst).not.toHaveBeenCalled();
    const where = prisma.crmHandoff.findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe("t1");
    expect(where.opportunityId).toEqual({ in: ["opp-1", "opp-2", "opp-3"] });
    expect(result.count).toBe(2);
  });

  it("importExisting runs pollTenant with ignoreCutoff and ignoreEnabledGate", async () => {
    const { svc } = make();
    const pollTenantSpy = jest.spyOn(svc, "pollTenant").mockResolvedValue(zeroCounts());

    await svc.importExisting("tenant-1");

    expect(pollTenantSpy).toHaveBeenCalledWith("tenant-1", {
      ignoreCutoff: true,
      ignoreEnabledGate: true,
    });
  });
});
