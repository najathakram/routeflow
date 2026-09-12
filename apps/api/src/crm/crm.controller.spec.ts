/**
 * TP6: controller guard contract + CrmConnectionService (T39-T44, T50, T53) plus the
 * fix-round oracles for F1/F3/F4/F6/F9/F11, M2, M5, M12, M13 and the R22 envelope.
 * Test-plan: .claude/pipeline/2026-09-11-crm-gohighlevel-handoff/test-plan.md
 */
import "reflect-metadata";
import { Prisma } from "@prisma/client";
import { CrmController } from "./crm.controller";
import { CrmConnectionService } from "./crm-connection.service";
import { REQUIRE_ADDON_KEY } from "../billing/require-addon.decorator";
import { CrmAuthError } from "./gohighlevel/gohighlevel.client";
import type { PrismaService } from "../prisma/prisma.service";
import type { EncryptionService } from "../common/encryption.service";
import type { AuditService } from "../audit/audit.service";
import type { GoHighLevelClient } from "./gohighlevel/gohighlevel.client";
import type { GhlClientFactory } from "./crm.types";
import type { GoHighLevelPollService } from "./gohighlevel/gohighlevel-poll.service";

describe("CrmController — access control (T39, R6)", () => {
  it("sits behind JwtAuthGuard + RolesGuard at the class level", () => {
    const guards = (Reflect.getMetadata("__guards__", CrmController) ?? []) as Array<{
      name: string;
    }>;
    const guardNames = guards.map((g) => g.name);
    expect(guardNames).toEqual(expect.arrayContaining(["JwtAuthGuard", "RolesGuard"]));
  });

  // F1 + F6: all TWELVE routes exist and carry the literal add-on key.
  it.each([
    "getStatus",
    "saveConnection",
    "testConnection",
    "disconnect",
    "updateConfig",
    "listPipelines",
    "listHandoffs",
    "sync",
    "retryHandoff",
    "dismissHandoff",
    "previewImportExisting",
    "importExisting",
  ])('handler %s carries AddonGuard + @RequireAddon("crm_gohighlevel")', (handlerName) => {
    const handler = (CrmController.prototype as Record<string, unknown>)[handlerName];
    expect(typeof handler).toBe("function");
    const handlerGuards = (Reflect.getMetadata("__guards__", handler) ?? []) as Array<{
      name: string;
    }>;
    expect(handlerGuards.map((g) => g.name)).toContain("AddonGuard");
    expect(Reflect.getMetadata(REQUIRE_ADDON_KEY, handler as object)).toEqual(["crm_gohighlevel"]);
  });
});

describe("CrmController — poll delegation (F1, F8)", () => {
  let poll: {
    pollTenant: jest.Mock;
    retryHandoff: jest.Mock;
    dismissHandoff: jest.Mock;
    previewImportExisting: jest.Mock;
    importExisting: jest.Mock;
  };
  let controller: CrmController;
  const user = { sub: "user-1", tenantId: "t1" } as never;

  beforeEach(() => {
    poll = {
      pollTenant: jest.fn().mockResolvedValue({ fetched: 0 }),
      retryHandoff: jest.fn().mockResolvedValue({ status: "PENDING" }),
      dismissHandoff: jest.fn().mockResolvedValue({ status: "SKIPPED" }),
      previewImportExisting: jest.fn().mockResolvedValue({ count: 0, sample: [] }),
      importExisting: jest.fn().mockResolvedValue({ fetched: 0 }),
    };
    controller = new CrmController(
      {} as unknown as CrmConnectionService,
      poll as unknown as GoHighLevelPollService,
    );
  });

  it("sync delegates pollTenant for the caller's tenant", async () => {
    await controller.sync(user);
    expect(poll.pollTenant).toHaveBeenCalledWith("t1");
  });

  // F8: the caller's tenant is always the FIRST argument — a handoff id alone must never
  // be enough to reach another tenant's row.
  it("retry/dismiss pass the caller's tenantId before the handoff id", async () => {
    await controller.retryHandoff(user, "h1");
    await controller.dismissHandoff(user, "h1");
    expect(poll.retryHandoff).toHaveBeenCalledWith("t1", "h1");
    expect(poll.dismissHandoff).toHaveBeenCalledWith("t1", "h1");
  });

  it("import-existing preview/run delegate for the caller's tenant", async () => {
    await controller.previewImportExisting(user);
    await controller.importExisting(user);
    expect(poll.previewImportExisting).toHaveBeenCalledWith("t1");
    expect(poll.importExisting).toHaveBeenCalledWith("t1");
  });
});

describe("CrmConnectionService (T40-T44, T50, T53 + fix round)", () => {
  let prisma: {
    crmConnection: {
      findUnique: jest.Mock;
      update: jest.Mock;
      create: jest.Mock;
      upsert: jest.Mock;
    };
    crmHandoff: { findMany: jest.Mock; count: jest.Mock; groupBy: jest.Mock };
  };
  let encryption: { encrypt: jest.Mock; decrypt: jest.Mock };
  let audit: { log: jest.Mock };
  let client: {
    getLocation: jest.Mock;
    listPipelines: jest.Mock;
  };
  let tenantClient: { listPipelines: jest.Mock };
  let clientFactory: { forConnection: jest.Mock };
  let service: CrmConnectionService;

  beforeEach(() => {
    prisma = {
      crmConnection: {
        findUnique: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
        upsert: jest.fn(),
      },
      crmHandoff: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };
    encryption = { encrypt: jest.fn(), decrypt: jest.fn() };
    audit = { log: jest.fn() };
    client = { getLocation: jest.fn(), listPipelines: jest.fn() };
    tenantClient = { listPipelines: jest.fn() };
    clientFactory = { forConnection: jest.fn().mockReturnValue(tenantClient) };
    service = new CrmConnectionService(
      prisma as unknown as PrismaService,
      encryption as unknown as EncryptionService,
      audit as unknown as AuditService,
      client as unknown as GoHighLevelClient,
      clientFactory as unknown as GhlClientFactory,
    );
  });

  // T40 — R1: encrypted storage, raw token never persisted or logged, audited.
  it("saveConnection stores the encrypted cipher, never the raw token, and audits the save", async () => {
    encryption.encrypt.mockReturnValue("cipher-x");
    prisma.crmConnection.upsert.mockResolvedValue({ id: "conn-1", secretCipher: "cipher-x" });

    await service.saveConnection("tenant-1", { token: "pit-secret", locationId: "loc1" }, "user-1");

    expect(prisma.crmConnection.upsert).toHaveBeenCalled();
    const upsertCall = prisma.crmConnection.upsert.mock.calls[0]?.[0];
    expect(upsertCall?.update?.secretCipher).toBe("cipher-x");
    expect(upsertCall?.create?.secretCipher).toBe("cipher-x");

    // The raw token must appear nowhere in any mock call recorded across the collaborators.
    const allCallArgs = JSON.stringify([
      ...prisma.crmConnection.upsert.mock.calls,
      ...prisma.crmConnection.update.mock.calls,
      ...prisma.crmConnection.create.mock.calls,
      ...audit.log.mock.calls,
    ]);
    expect(allCallArgs).not.toContain("pit-secret");

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "crm.connection.saved" }),
    );
  });

  // F11 — one atomic upsert; `connectedById` survives a SECOND save on an existing row.
  it("saveConnection upserts and sets connectedById on both branches", async () => {
    encryption.encrypt.mockReturnValue("cipher-x");
    prisma.crmConnection.upsert.mockResolvedValue({ id: "conn-1" });

    await service.saveConnection("tenant-1", { token: "pit-secret", locationId: "loc1" }, "user-9");

    expect(prisma.crmConnection.update).not.toHaveBeenCalled();
    expect(prisma.crmConnection.create).not.toHaveBeenCalled();
    expect(prisma.crmConnection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: "tenant-1" },
        create: expect.objectContaining({ tenantId: "tenant-1", connectedById: "user-9" }),
        update: expect.objectContaining({ connectedById: "user-9" }),
      }),
    );
  });

  // F3 — no mutating handler may return the raw Prisma row (it carries `secretCipher`).
  it("saveConnection/updateConfig/disconnect/testConnection return the safe status view only", async () => {
    const rawRow = {
      id: "conn-1",
      tenantId: "tenant-1",
      status: "CONNECTED",
      locationId: "loc1",
      tokenLast4: "cret",
      secretCipher: "cipher-x",
    };
    encryption.encrypt.mockReturnValue("cipher-x");
    encryption.decrypt.mockReturnValue("pit-secret-abcret");
    prisma.crmConnection.upsert.mockResolvedValue(rawRow);
    prisma.crmConnection.update.mockResolvedValue(rawRow);
    prisma.crmConnection.findUnique.mockResolvedValue(rawRow);
    client.getLocation.mockResolvedValue({ location: { name: "HQ" } });

    const results = [
      await service.saveConnection("tenant-1", { token: "pit-secret", locationId: "loc1" }, "u1"),
      await service.updateConfig("tenant-1", { dryRun: false }, "u1"),
      await service.disconnect("tenant-1", "u1"),
      await service.testConnection("tenant-1"),
    ];

    for (const result of results) {
      expect(result).not.toHaveProperty("secretCipher");
      const json = JSON.stringify(result);
      expect(json).not.toContain("cipher-x");
      expect(json).not.toContain("pit-secret");
    }
  });

  // T41 — R1 + R7: status never leaks secretCipher/token, exposes only tokenLast4.
  it("getStatus returns tokenLast4 and never the cipher or raw token", async () => {
    prisma.crmConnection.findUnique.mockResolvedValue({
      id: "conn-1",
      secretCipher: "cipher-x",
      token: "pit-secret-abcret",
    });

    const status = await service.getStatus("tenant-1");
    const connection = status.connection as Record<string, unknown>;

    expect(connection).toBeDefined();
    expect(connection.tokenLast4).toBe("cret");
    expect(connection).not.toHaveProperty("secretCipher");
    expect(connection).not.toHaveProperty("token");
  });

  // M13 — counts come from a grouped aggregate, not from loading every handoff row.
  it("getStatus counts handoffs with a tenant-scoped groupBy, never findMany", async () => {
    prisma.crmConnection.findUnique.mockResolvedValue(null);
    prisma.crmHandoff.groupBy.mockResolvedValue([
      { status: "PENDING", _count: { _all: 2 } },
      { status: "WRITEBACK_PENDING", _count: { _all: 3 } },
      { status: "NEEDS_REVIEW", _count: { _all: 1 } },
      { status: "CREATED", _count: { _all: 4 } },
    ]);

    const status = await service.getStatus("tenant-1");

    expect(prisma.crmHandoff.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ by: ["status"], where: { tenantId: "tenant-1" } }),
    );
    expect(prisma.crmHandoff.findMany).not.toHaveBeenCalled();
    expect(status.counts).toEqual({
      pending: 5,
      needsReview: 1,
      created: 4,
      linked: 0,
      dryRun: 0,
      failed: 0,
    });
  });

  // T42 — R4: STAGE trigger mode with no pipelineId/stageId on enable -> 400.
  it("updateConfig throws BadRequestException when enabling STAGE mode without pipelineId/stageId", async () => {
    prisma.crmConnection.findUnique.mockResolvedValue({
      id: "conn-1",
      pipelineId: null,
      stageId: null,
    });

    await expect(
      service.updateConfig("tenant-1", { enabled: true, triggerMode: "STAGE" }, "user-1"),
    ).rejects.toThrow(/BadRequestException|Bad Request/);
  });

  // F9 — the first config change on a brand-new tenant used to hit `update` and 500 (P2025).
  it("updateConfig creates the row with the R4 defaults when the tenant has none", async () => {
    prisma.crmConnection.findUnique.mockResolvedValue(null);
    prisma.crmConnection.upsert.mockResolvedValue({ id: "conn-1" });

    await service.updateConfig("tenant-1", { dryRun: false }, "user-1");

    expect(prisma.crmConnection.update).not.toHaveBeenCalled();
    const upsertCall = prisma.crmConnection.upsert.mock.calls[0]?.[0];
    expect(upsertCall?.where).toEqual({ tenantId: "tenant-1" });
    expect(upsertCall?.create).toEqual(
      expect.objectContaining({
        tenantId: "tenant-1",
        enabled: false,
        dryRun: false, // the patch wins over the default
        triggerMode: "STAGE",
        defaultRegion: "US",
        writeBackFields: true,
        writeBackTag: true,
        writeBackNote: true,
        markWon: false,
        connectedById: "user-1",
      }),
    );
    expect(upsertCall?.create?.startFrom).toBeInstanceOf(Date);
    // Untouched config keys must NOT be reset on an existing row.
    expect(upsertCall?.update).toEqual({ dryRun: false, connectedById: "user-1" });
  });

  // T43 + M2 — R5: disconnect wipes every trace of the key/location; audits the removal.
  it("disconnect wipes the secret and all key/location metadata, and audits the removal", async () => {
    prisma.crmConnection.update.mockResolvedValue({ id: "conn-1" });

    await service.disconnect("tenant-1", "user-1");

    const updateCall = prisma.crmConnection.update.mock.calls[0]?.[0];
    const patch = (updateCall?.data ?? updateCall) as Record<string, unknown>;
    expect(patch).toMatchObject({
      secretCipher: null,
      status: "DISCONNECTED",
      enabled: false,
      tokenLast4: null,
      locationName: null,
      lastError: null,
      attentionNotifiedAt: null,
      // Nullable Json column: Prisma writes SQL NULL only for `Prisma.DbNull`.
      customFieldIds: Prisma.DbNull,
    });

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "crm.connection.removed" }),
    );
  });

  // T44 — R2: 401 branch on a CONNECTED row — NEEDS_ATTENTION + {ok:false}.
  it("testConnection marks NEEDS_ATTENTION and returns ok:false on CrmAuthError", async () => {
    prisma.crmConnection.findUnique.mockResolvedValue({
      id: "conn-1",
      locationId: "loc1",
      secretCipher: "cipher-x",
      status: "CONNECTED",
    });
    encryption.decrypt.mockReturnValue("pit-secret");
    prisma.crmConnection.update.mockResolvedValue({ id: "conn-1", status: "NEEDS_ATTENTION" });
    client.getLocation.mockRejectedValue(new CrmAuthError("GoHighLevel rejected the token"));

    const result = await service.testConnection("tenant-1");

    expect(result).toEqual(expect.objectContaining({ ok: false }));
    expect(prisma.crmConnection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "NEEDS_ATTENTION" }),
      }),
    );
  });

  // M5 — retesting a deliberately DISCONNECTED row must not claim "lost access".
  it("testConnection leaves a non-CONNECTED status untouched on CrmAuthError", async () => {
    prisma.crmConnection.findUnique.mockResolvedValue({
      id: "conn-1",
      locationId: "loc1",
      secretCipher: "cipher-x",
      status: "DISCONNECTED",
    });
    encryption.decrypt.mockReturnValue("pit-secret");
    client.getLocation.mockRejectedValue(new CrmAuthError("GoHighLevel rejected the token"));

    const result = await service.testConnection("tenant-1");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("GoHighLevel rejected the token");
    expect(prisma.crmConnection.update).not.toHaveBeenCalled();
  });

  // M12 — a non-ISO-3166 country silently breaks phone matching; never write it.
  it("testConnection writes defaultRegion only for an ISO-3166 alpha-2 country", async () => {
    prisma.crmConnection.findUnique.mockResolvedValue({
      id: "conn-1",
      locationId: "loc1",
      secretCipher: "cipher-x",
      status: "CONNECTED",
    });
    encryption.decrypt.mockReturnValue("pit-secret");
    prisma.crmConnection.update.mockResolvedValue({ id: "conn-1" });
    client.getLocation.mockResolvedValue({
      location: { name: "HQ", country: "United States" },
    });

    await service.testConnection("tenant-1");
    expect(prisma.crmConnection.update.mock.calls[0]?.[0]?.data).not.toHaveProperty(
      "defaultRegion",
    );

    prisma.crmConnection.update.mockClear();
    client.getLocation.mockResolvedValue({ location: { name: "HQ", country: "US" } });
    await service.testConnection("tenant-1");
    expect(prisma.crmConnection.update.mock.calls[0]?.[0]?.data).toMatchObject({
      defaultRegion: "US",
    });
  });

  // T50 + F4 — R3: per-tenant client, and stages missing id/name are dropped.
  it("listPipelines builds the client from the TENANT's connection and drops broken stages", async () => {
    prisma.crmConnection.findUnique.mockResolvedValue({
      id: "conn-1",
      locationId: "loc1",
      secretCipher: "cipher-x",
    });
    tenantClient.listPipelines.mockResolvedValue([
      {
        id: "p1",
        name: "Sales",
        stages: [{ id: "s1", name: "Won", position: 2 }, { name: "broken" }],
      },
    ]);

    const pipelines = await service.listPipelines("tenant-1");

    expect(prisma.crmConnection.findUnique).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1" },
    });
    expect(clientFactory.forConnection).toHaveBeenCalledWith(
      expect.objectContaining({ secretCipher: "cipher-x", locationId: "loc1" }),
    );
    // The shared, empty-creds singleton must never serve a tenant pipeline call.
    expect(client.listPipelines).not.toHaveBeenCalled();
    expect(pipelines).toEqual([
      { id: "p1", name: "Sales", stages: [{ id: "s1", name: "Won", position: 2 }] },
    ]);
  });

  it("listPipelines 404s when the tenant has no connection or no saved token", async () => {
    prisma.crmConnection.findUnique.mockResolvedValue(null);
    await expect(service.listPipelines("tenant-1")).rejects.toThrow(
      /Not Found|Connect GoHighLevel/,
    );

    prisma.crmConnection.findUnique.mockResolvedValue({ id: "c1", locationId: "loc1" });
    await expect(service.listPipelines("tenant-1")).rejects.toThrow(
      /Not Found|Connect GoHighLevel/,
    );
    expect(clientFactory.forConnection).not.toHaveBeenCalled();
  });

  // T53 — R22: limit <=100, newest first, correct pagination + status filter, tenant-scoped.
  it("listHandoffs filters by status, paginates newest-first, and clamps limit to 100", async () => {
    prisma.crmHandoff.findMany.mockResolvedValue([]);

    await service.listHandoffs("tenant-1", { status: "NEEDS_REVIEW", page: 2, limit: 25 });

    expect(prisma.crmHandoff.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: "tenant-1", status: "NEEDS_REVIEW" }),
        orderBy: { createdAt: "desc" },
        take: 25,
        skip: 25,
      }),
    );

    prisma.crmHandoff.findMany.mockClear();
    await service.listHandoffs("tenant-1", { limit: 500 });

    expect(prisma.crmHandoff.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
  });

  // #7 (R22): the Activity table never receives `payload` — it holds the raw GHL
  // contact/opportunity snapshot, which has no business leaving the API.
  it("listHandoffs selects only the R22 columns and never payload", async () => {
    prisma.crmHandoff.findMany.mockResolvedValue([]);

    await service.listHandoffs("tenant-1", { page: 1, limit: 25 });

    const select = (prisma.crmHandoff.findMany.mock.calls[0][0] as { select: Record<string, true> })
      .select;
    expect(select).toBeDefined();
    expect(select).not.toHaveProperty("payload");
    expect(Object.keys(select).sort()).toEqual(
      [
        "attempts",
        "contactId",
        "contactName",
        "createdAt",
        "customerId",
        "id",
        "matchedBy",
        "opportunityId",
        "opportunityName",
        "processedAt",
        "reason",
        "status",
      ].sort(),
    );
  });

  // Shared contract — the web reads `.data`; a bare array leaves the table empty forever.
  it("listHandoffs returns the {data,total,page,limit} envelope", async () => {
    prisma.crmHandoff.findMany.mockResolvedValue([{ id: "h1" }]);
    prisma.crmHandoff.count.mockResolvedValue(7);

    const result = await service.listHandoffs("tenant-1", { page: 2, limit: 25 });

    expect(result).toEqual({ data: [{ id: "h1" }], total: 7, page: 2, limit: 25 });
    expect(prisma.crmHandoff.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ tenantId: "tenant-1" }),
    });
  });
});
