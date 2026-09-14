/**
 * TenantMirrorService — TP-B unit specs (test-plan.md §2: T13-0, T13-1..T13-8b).
 *
 * `@LeaderCron` wraps mirrorSync() in a Postgres advisory lock (common/cron-lock.ts). These
 * specs invoke it directly with no real database, so the lock must be a pure PASS-THROUGH —
 * mirroring billing-cron.service.spec.ts's own guard for the same decorator; a mock that skipped
 * the body would make every mirrorSync() assertion below measure a tick that never ran.
 */
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { Logger } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { PlatformConfigService } from "./platform-config.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * House rule for tests of a NOT-YET-BUILT module (see cron-lock.spec.ts / db-spec.spec.ts):
 * guarded `require` at module scope plus a no-op fallback, so every case below fails on its OWN
 * oracle (an unmade Prisma call, a missing log line, a wrong value) instead of an unresolved
 * import or a TypeError thrown out of Nest's `compile()`.
 *
 * `tenant-mirror.service.ts` is shared with sibling test-authoring packages (T13-9..T13-11
 * exercise the same file from `tenant-mirror.service.db.spec.ts` / `platform-admin.service.spec.ts`)
 * running in parallel this phase, so it may already exist as a PARTIAL signature-only stub — with
 * `upsert` but not yet `mirrorSync`, or vice versa. The fallback is therefore applied per-method
 * (patched onto the real class's prototype when a method is missing), never only when the whole
 * module is absent — the SHAPE assertion below is captured before any patch touches it, so it
 * still reports the module's true, unpatched shape.
 */
let mod: any = {};
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  mod = require("./tenant-mirror.service");
} catch {
  mod = {};
}

interface TenantMirror {
  upsert(tenantId: string): Promise<void>;
  mirrorSync(): Promise<void>;
}

// Used to fill in whichever method(s) tenant-mirror.service.ts does not yet export for real — a
// pure no-op so Nest can still build the testing module, and every assertion below fails on its
// own value (an unmade call, a missing log line) rather than a TypeError.
class NotImplementedTenantMirrorService implements TenantMirror {
  async upsert(_tenantId: string): Promise<void> {
    return undefined;
  }
  async mirrorSync(): Promise<void> {
    return undefined;
  }
}

const RealTenantMirrorServiceCtor: (new (...args: any[]) => Partial<TenantMirror>) | undefined =
  typeof mod.TenantMirrorService === "function" ? mod.TenantMirrorService : undefined;

// Snapshot the module's OWN, unpatched shape now — module-shape assertions (T13-0) read this,
// never the (possibly monkey-patched) live prototype below.
const moduleShape = {
  isClass: typeof mod.TenantMirrorService === "function",
  hasUpsert: typeof RealTenantMirrorServiceCtor?.prototype?.upsert === "function",
  hasMirrorSync: typeof RealTenantMirrorServiceCtor?.prototype?.mirrorSync === "function",
};

if (RealTenantMirrorServiceCtor) {
  if (!moduleShape.hasUpsert) {
    RealTenantMirrorServiceCtor.prototype.upsert =
      NotImplementedTenantMirrorService.prototype.upsert;
  }
  if (!moduleShape.hasMirrorSync) {
    RealTenantMirrorServiceCtor.prototype.mirrorSync =
      NotImplementedTenantMirrorService.prototype.mirrorSync;
  }
}

const TenantMirrorServiceCtor: new (...args: any[]) => TenantMirror =
  (RealTenantMirrorServiceCtor ?? NotImplementedTenantMirrorService) as new (
    ...args: any[]
  ) => TenantMirror;

const HOUSE_ID = "hq-1";

// The tenant being mirrored — name/admin username match the plan's fixture businessName /
// contactName values throughout.
const TENANT_T1 = {
  id: "t-1",
  name: "Acme Wholesale",
  class: "PRODUCTION",
  deletedAt: null,
  users: [{ id: "admin-1", username: "acme_owner", role: "TENANT_ADMIN" }],
};

describe("TenantMirrorService (TP-B)", () => {
  let service: TenantMirror;
  let prisma: ReturnType<typeof createMockPrisma>;
  let platformConfigService: { getHouseTenantId: jest.Mock };
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(async () => {
    prisma = createMockPrisma();
    platformConfigService = { getHouseTenantId: jest.fn().mockResolvedValue(HOUSE_ID) };
    warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantMirrorServiceCtor,
        { provide: PrismaService, useValue: prisma },
        { provide: PlatformConfigService, useValue: platformConfigService },
      ],
    }).compile();

    service = module.get(TenantMirrorServiceCtor);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  /** R6/R7/R8's shared negative shape: nothing the mirror ever writes was touched. */
  function expectNoMirrorWrites() {
    expect(prisma.customer.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.customer.create).not.toHaveBeenCalled();
    expect(prisma.customer.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  }

  describe("module shape (T13-0, R16 Delta 1 naming)", () => {
    it("exports TenantMirrorService as a class with upsert(tenantId) and mirrorSync() methods", () => {
      // A malformed @LeaderCron job name throws at class-definition time (cron-lock.ts's
      // NAME_RE) — the guarded require above would then leave `mod` empty just as it does
      // today, so this fails identically whether the file is missing or the name is malformed,
      // and only passes once TenantMirrorService exports a real mirrorSync with a well-formed
      // job name. Reads the pre-patch snapshot (`moduleShape`), not the live prototype, which
      // this file may have monkey-patched above to keep OTHER tests from throwing a TypeError.
      expect(moduleShape.isClass).toBe(true);
      expect(moduleShape.hasUpsert).toBe(true);
      expect(moduleShape.hasMirrorSync).toBe(true);
    });
  });

  describe("upsert(tenantId) — create then update (T13-1: R9, R10, R11, R21)", () => {
    it("creates a placeholder User + Customer in one $transaction, then only refreshes businessName on the second call", async () => {
      prisma.tenant.findUnique.mockResolvedValue(TENANT_T1 as any);
      (prisma.customer.findUnique as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: "cust-1", tenantId: HOUSE_ID });
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: "u-1" } as any);
      prisma.customer.create.mockResolvedValue({ id: "cust-1" } as any);
      prisma.customer.update.mockResolvedValue({ id: "cust-1" } as any);

      await service.upsert("t-1");
      await service.upsert("t-1");

      // R11: placeholder identity, keyed by the tenant's immutable id, never its slug — every
      // field the plan names, plus a hashed random password (never disclosed).
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: {
          tenantId: HOUSE_ID,
          email: "mirror+t-1@placeholder.local",
          username: "mirror_t-1",
          role: "CUSTOMER",
          password: expect.any(String),
          forcePasswordChange: true,
        },
      });

      // R9/R21: the Customer mirrors the represented tenant, but lives in the HOUSE tenant —
      // tenantId is HOUSE_ID, never "t-1" (the represented tenant's own id).
      expect(prisma.customer.create).toHaveBeenCalledWith({
        data: {
          tenantId: HOUSE_ID,
          userId: "u-1",
          businessName: "Acme Wholesale",
          contactName: "acme_owner",
          representsTenantId: "t-1",
        },
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);

      // R10: the second call updates ONLY businessName on the existing mirror — no new
      // User/Customer, and contactName is never refreshed (HQ staff may hand-edit it).
      expect(prisma.user.create).toHaveBeenCalledTimes(1);
      expect(prisma.customer.create).toHaveBeenCalledTimes(1);
      expect(prisma.customer.update).toHaveBeenCalledTimes(1);
      expect(prisma.customer.update).toHaveBeenCalledWith({
        where: { id: "cust-1" },
        data: { businessName: "Acme Wholesale" },
      });
    });
  });

  describe("upsert(tenantId) — no-ops (T13-2: R6, T13-3: R7)", () => {
    it("T13-2: with no house tenant configured, warns once and makes zero Prisma calls", async () => {
      platformConfigService.getHouseTenantId.mockResolvedValue(null);

      await expect(service.upsert("t-1")).resolves.toBeUndefined();

      expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
      expectNoMirrorWrites();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toMatch(/no house tenant/i);
    });

    it("T13-3: mirroring the house tenant into itself is a no-op — zero Prisma calls", async () => {
      await expect(service.upsert(HOUSE_ID)).resolves.toBeUndefined();

      // Positive control: the no-op fallback used while this module is a partial stub never
      // calls getHouseTenantId() at all, so a same-tenant short-circuit that skips the house-tenant
      // lookup entirely (rather than fetching it and comparing) cannot pass this assertion —
      // guards against the negative-only assertions below being satisfiable by deleting the feature.
      expect(platformConfigService.getHouseTenantId).toHaveBeenCalledTimes(1);
      expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
      expectNoMirrorWrites();
    });
  });

  describe("upsert(tenantId) — class eligibility (T13-4: R8)", () => {
    it("skips a tenant whose class is not PRODUCTION/DEMO before ever reading the mirror", async () => {
      prisma.tenant.findUnique.mockResolvedValue({
        id: "t-2",
        name: "Internal Co",
        class: "INTERNAL",
        users: [],
      } as any);

      await service.upsert("t-2");

      // Positive control: the tenant record must actually be read (and its class inspected)
      // before being skipped — otherwise this "skip" assertion is satisfiable by a no-op that
      // never looks at the tenant at all, which is exactly what the current stub does.
      expect(prisma.tenant.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "t-2" } }),
      );
      expect(prisma.customer.findUnique).not.toHaveBeenCalled();
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.customer.create).not.toHaveBeenCalled();
      expect(prisma.customer.update).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe("upsert(tenantId) — orphan placeholder reuse (T13-5: R12)", () => {
    it("reuses an orphaned placeholder User instead of creating a second one (avoids a P2002 loop)", async () => {
      prisma.tenant.findUnique.mockResolvedValue(TENANT_T1 as any);
      prisma.customer.findUnique.mockResolvedValue(null);
      prisma.user.findFirst.mockResolvedValue({ id: "u-old" } as any);
      prisma.customer.create.mockResolvedValue({ id: "cust-1" } as any);

      await service.upsert("t-1");

      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.customer.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ userId: "u-old" }) }),
      );
    });
  });

  describe("upsert(tenantId) — foreign-tenant guard (T13-6: R13)", () => {
    it("logs an error and never updates a mirror Customer that already lives in a foreign tenant", async () => {
      prisma.tenant.findUnique.mockResolvedValue(TENANT_T1 as any);
      prisma.customer.findUnique.mockResolvedValue({ id: "cust-9", tenantId: "other" } as any);

      await expect(service.upsert("t-1")).resolves.toBeUndefined();

      expect(prisma.customer.update).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0][0])).toMatch(/not the house tenant/i);
    });
  });

  describe("upsert(tenantId) — no-admin tenant (T13-7: R15)", () => {
    it("falls contactName back to tenant.name and never throws when the tenant has zero TENANT_ADMIN users", async () => {
      prisma.tenant.findUnique.mockResolvedValue({ ...TENANT_T1, users: [] } as any);
      prisma.customer.findUnique.mockResolvedValue(null);
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: "u-2" } as any);
      prisma.customer.create.mockResolvedValue({ id: "cust-2" } as any);

      await expect(service.upsert("t-1")).resolves.toBeUndefined();

      expect(prisma.customer.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ contactName: "Acme Wholesale" }),
        }),
      );
      expect((prisma as any).contactPerson.create).not.toHaveBeenCalled();
    });
  });

  describe("upsert(tenantId) — ContactPerson sync (T13-7b: R14)", () => {
    it("creates one ContactPerson for each TENANT_ADMIN missing from the mirror, keyed idempotently by email", async () => {
      // R14's positive path: the DB lane (T13-9) deliberately dropped its ContactPerson
      // cardinality assertion, so the creation loop is proven here instead — on the UPDATE
      // path, which also pins the contact to the EXISTING mirror's customerId.
      prisma.tenant.findUnique.mockResolvedValue({
        ...TENANT_T1,
        users: [
          { username: "acme_owner", email: "owner@acme.test" },
          { username: "acme_ops", email: "ops@acme.test" },
        ],
      } as any);
      prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", tenantId: HOUSE_ID } as any);
      prisma.customer.update.mockResolvedValue({ id: "cust-1" } as any);
      // The first admin already has a contact on the mirror; the second does not.
      ((prisma as any).contactPerson.findFirst as jest.Mock)
        .mockResolvedValueOnce({ id: "cp-1" })
        .mockResolvedValueOnce(null);

      await service.upsert("t-1");

      // Idempotency key: the lookup is (mirror customer, admin email) — never the username.
      expect((prisma as any).contactPerson.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { customerId: "cust-1", email: "owner@acme.test" } }),
      );
      // Exactly one create — the already-present admin is not duplicated.
      expect((prisma as any).contactPerson.create).toHaveBeenCalledTimes(1);
      expect((prisma as any).contactPerson.create).toHaveBeenCalledWith({
        data: {
          customerId: "cust-1",
          tenantId: HOUSE_ID,
          firstName: "acme_ops",
          lastName: "",
          email: "ops@acme.test",
        },
      });
    });
  });

  describe("mirrorSync() — nightly sweep isolation (T13-8: R16, T13-8b: R16)", () => {
    it("T13-8: one tenant's failure never stops another's, and the summary names the failure count + tenant", async () => {
      prisma.tenant.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }] as any);
      const upsertSpy = jest
        .spyOn(service, "upsert")
        .mockImplementation((tenantId: string) =>
          tenantId === "a" ? Promise.reject(new Error("boom")) : Promise.resolve(undefined),
        );

      await service.mirrorSync();

      // Positive control: the sweep's own tenant selection must apply the PRODUCTION/DEMO +
      // not-deleted eligibility filter (build-plan.md WP-B) — asserting only on the `upsert` spy
      // (installed by this test over the unit under test) would pass even if the sweep queried
      // every tenant unfiltered.
      expect(prisma.tenant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            deletedAt: null,
            class: expect.objectContaining({
              in: expect.arrayContaining(["PRODUCTION", "DEMO"]),
            }),
          }),
        }),
      );
      expect(upsertSpy).toHaveBeenCalledWith("b");
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const errorText = errorSpy.mock.calls[0].map(String).join(" ");
      expect(errorText).toMatch(/\ba\b/); // names the failing tenant "a"
      expect(errorText).toMatch(/boom/); // and its error
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain("1 failure(s): a");
    });

    it("T13-8b: with no house tenant, warns once and never enumerates tenants", async () => {
      platformConfigService.getHouseTenantId.mockResolvedValue(null);

      await service.mirrorSync();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(prisma.tenant.findMany).not.toHaveBeenCalled();
    });
  });
});
