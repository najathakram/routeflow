import {
  BadRequestException,
  ConflictException,
  ExecutionContext,
  NotFoundException,
  ValidationPipe,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { RolesGuard } from "../auth/guards/roles.guard";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { isReadOnlyAllowedMutation } from "../tenant/read-only-registry";
import { createMockPrisma } from "../testing/prisma-mock";
import { BulkStateDto, BulkStateUndoDto } from "./dto/bulk-state.dto";
import {
  AUDIT_BULK_STATE_SET,
  AUDIT_BULK_STATE_UNDONE,
  UnknownStateBulkService,
  bulkStateEntries,
} from "./unknown-state-bulk.service";
import { UnknownStateCustomersController } from "./unknown-state-customers.controller";
import { BULK_STATE_MAX, placeUnknownState } from "./unknown-state";

/**
 * Addendum D, Branch B: POST .../bulk-state and .../bulk-state/undo over a transactional fake that
 * keeps tenant-scoped rows, moves `updatedAt` on every write (like @updatedAt) and restores a snapshot
 * when the callback throws (like a Postgres rollback). The real-Postgres twin is
 * unknown-state-bulk.db.spec.ts.
 */
const T = "test-tenant";
const user = { sub: "u1", username: "op", role: UserRole.OPERATOR } as JwtPayload;

interface Addr {
  id: string;
  tenantId: string | null;
  customerId: string;
  label: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  zip: string;
  isDefault: boolean;
  addressType: string;
  stateCode: string | null;
  stateNeedsReview: boolean;
  createdAt: Date;
  updatedAt: Date;
}
interface Cust {
  id: string;
  tenantId: string;
  businessName: string;
  deletedAt: Date | null;
  isWalkIn: boolean | null;
}

function setup() {
  let clock = Date.UTC(2026, 9, 12, 12, 0, 0);
  const tick = () => new Date((clock += 1000));
  const store = {
    customers: [] as Cust[],
    addresses: [] as Addr[],
    audits: [] as any[],
  };
  let failAudit = false;
  let dropUpdate = false;
  const addr = (customerId: string, over: Partial<Addr> = {}): Addr => {
    const a: Addr = {
      id: `a-${customerId}-${store.addresses.length + 1}`,
      tenantId: T,
      customerId,
      label: "default",
      line1: "1 Main St",
      line2: null,
      city: "Dallas",
      state: "",
      zip: "",
      isDefault: true,
      addressType: "BILLING",
      stateCode: null,
      stateNeedsReview: false,
      createdAt: tick(),
      updatedAt: new Date(clock),
      ...over,
    };
    store.addresses.push(a);
    return a;
  };
  const cust = (id: string, over: Partial<Cust> = {}) =>
    store.customers.push({
      id,
      tenantId: T,
      businessName: `Acme ${id}`,
      deletedAt: null,
      isWalkIn: false,
      ...over,
    });
  const matchAddr = (w: any) => (a: Addr) =>
    a.tenantId === w.tenantId &&
    (typeof w.id === "string" ? a.id === w.id : w.id.in.includes(a.id)) &&
    (w.customerId === undefined || a.customerId === w.customerId) &&
    (w.updatedAt === undefined || a.updatedAt.getTime() === w.updatedAt.getTime());
  const tx = {
    customer: {
      findMany: jest.fn(async ({ where }: any) => {
        const walkInOk = (c: Cust) => c.isWalkIn !== true;
        expect(where.AND).toEqual(
          expect.arrayContaining([{ OR: [{ isWalkIn: null }, { isWalkIn: false }] }]),
        );
        return store.customers
          .filter(
            (c) =>
              c.tenantId === where.tenantId &&
              c.deletedAt === null &&
              walkInOk(c) &&
              where.id.in.includes(c.id),
          )
          .map((c) => ({
            id: c.id,
            businessName: c.businessName,
            addresses: store.addresses.filter((a) => a.customerId === c.id).map((a) => ({ ...a })),
          }));
      }),
    },
    customerAddress: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!where.tenantId) throw new Error("unguarded updateMany");
        const hit = store.addresses.filter(matchAddr(where));
        if (dropUpdate) hit.pop();
        const at = tick();
        hit.forEach((a) => Object.assign(a, data, { updatedAt: at }));
        return { count: hit.length };
      }),
      createMany: jest.fn(async ({ data }: any) => {
        for (const d of data) addr(d.customerId, { ...d });
        return { count: data.length };
      }),
      findMany: jest.fn(async ({ where }: any) =>
        store.addresses.filter(matchAddr(where)).map((a) => ({ id: a.id, updatedAt: a.updatedAt })),
      ),
      deleteMany: jest.fn(async ({ where }: any) => {
        if (!where.tenantId) throw new Error("unguarded deleteMany");
        expect(where.routeStops).toEqual({ none: {} });
        const before = store.addresses.length;
        store.addresses = store.addresses.filter((a) => !matchAddr(where)(a));
        return { count: before - store.addresses.length };
      }),
    },
    auditLog: {
      create: jest.fn(async ({ data }: any) => {
        if (failAudit) throw new Error("audit insert failed");
        const row = { id: `audit-${store.audits.length + 1}`, createdAt: new Date(clock), ...data };
        store.audits.push(row);
        return row;
      }),
      findMany: jest.fn(async ({ where, take }: any) =>
        store.audits
          .filter((r) => r.tenantId === where.tenantId && r.action === where.action)
          .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())
          .slice(0, take),
      ),
    },
  };
  const prisma = createMockPrisma();
  (prisma.tenantTransaction as jest.Mock).mockImplementation(async (fn: any) => {
    // restore IN PLACE, so a test's reference to an address row sees the rollback
    const snap = store.addresses.map((a) => [a, { ...a }] as const);
    const audits = store.audits.length;
    try {
      return await fn(tx);
    } catch (e) {
      store.addresses = snap.map(([row, copy]) => Object.assign(row, copy));
      store.audits.length = audits;
      throw e;
    }
  });
  const engine = {
    getPolicy: jest.fn().mockResolvedValue({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
  } as unknown as SellingRestrictionsService;
  const bucketsOf = (customerId: string) =>
    Object.keys(
      placeUnknownState(
        {
          id: customerId,
          businessName: "x",
          addresses: store.addresses.filter((a) => a.customerId === customerId),
        },
        "BILLING_FIRST",
      ),
    );
  return {
    store,
    tx,
    cust,
    addr,
    bucketsOf,
    advanceMinutes: (m: number) => (clock += m * 60_000),
    // the service reads Date.now() for the window; keep it on the fake clock
    syncNow: () => jest.spyOn(Date, "now").mockImplementation(() => clock),
    failAuditWrite: () => (failAudit = true),
    dropOneUpdate: () => (dropUpdate = true),
    service: new UnknownStateBulkService(prisma, engine),
  };
}

afterEach(() => jest.restoreAllMocks());

describe("POST .../bulk-state", () => {
  it("noAddress: creates a minimal default billing address per customer; stale, foreign, deleted and walk-in ids are skipped; ONE audit row records created addresses", async () => {
    const s = setup();
    s.cust("n1");
    s.cust("n2");
    s.cust("stale"); // fixed meanwhile: has an address now
    s.addr("stale", { state: "TX", stateCode: "TX" });
    s.cust("gone", { deletedAt: new Date() });
    s.cust("walk", { isWalkIn: true });
    s.cust("foreign", { tenantId: "other" });
    const r = await s.service.bulkSet(
      {
        bucket: "noAddress",
        customerIds: ["n1", "n2", "stale", "gone", "walk", "foreign", "n1"],
        state: "Texas",
      },
      user,
    );
    expect(r.changed).toBe(2);
    expect(r.changedAddressIds).toHaveLength(2);
    for (const id of ["n1", "n2"]) {
      expect(s.store.addresses.filter((a) => a.customerId === id)).toEqual([
        expect.objectContaining({
          tenantId: T,
          state: "TX",
          stateCode: "TX",
          stateNeedsReview: false,
          isDefault: true,
          addressType: "BILLING",
          line1: "",
        }),
      ]);
      expect(s.bucketsOf(id)).toEqual([]);
    }
    for (const id of ["gone", "walk", "foreign"]) {
      expect(s.store.addresses.filter((a) => a.customerId === id)).toEqual([]);
    }
    expect(s.store.audits).toHaveLength(1);
    const audit = s.store.audits[0];
    expect(audit).toMatchObject({
      tenantId: T,
      userId: "u1",
      action: AUDIT_BULK_STATE_SET,
      entityType: "CustomerAddress",
      entityId: null,
    });
    expect(audit.meta).toMatchObject({
      bucket: "noAddress",
      state: "TX",
      customerIds: ["n1", "n2"],
      skippedCustomerIds: ["stale", "gone", "walk", "foreign"],
      addressIds: r.changedAddressIds,
    });
    expect(bulkStateEntries(audit.meta)).toEqual(
      r.changedAddressIds.map((id) =>
        expect.objectContaining({ addressId: id, created: true, prior: null }),
      ),
    );
  });

  it("unusableState / needsReview: sets the state on the bucket's address and records its PRIOR state; the other bucket's address is untouched", async () => {
    const s = setup();
    s.cust("u1");
    const bad = s.addr("u1", { state: "Unknown", stateNeedsReview: true, zip: "75201" });
    s.cust("k1"); // two defaults: one unusable, one readable (needs review)
    const kBad = s.addr("k1", { state: "??", stateNeedsReview: true });
    const kReview = s.addr("k1", { state: "Washington", stateNeedsReview: true });
    const r = await s.service.bulkSet(
      { bucket: "unusableState", customerIds: ["u1", "k1"], state: "TX" },
      user,
    );
    expect(r).toEqual({ changed: 2, changedAddressIds: [bad.id, kBad.id] });
    expect(bad).toMatchObject({ state: "TX", stateCode: "TX", stateNeedsReview: false });
    expect(kReview).toMatchObject({ state: "Washington", stateCode: null });
    expect(s.bucketsOf("u1")).toEqual([]);
    expect(s.bucketsOf("k1")).toEqual(["needsReview"]);
    expect(bulkStateEntries(s.store.audits[0].meta)).toEqual([
      expect.objectContaining({
        addressId: bad.id,
        customerId: "u1",
        created: false,
        prior: { state: "Unknown", stateCode: null, stateNeedsReview: true },
      }),
      expect.objectContaining({
        addressId: kBad.id,
        created: false,
        prior: { state: "??", stateCode: null, stateNeedsReview: true },
      }),
    ]);
    // the guarded write: tenant + exact ids, never a widened where
    expect(s.tx.customerAddress.updateMany).toHaveBeenCalledWith({
      where: { tenantId: T, id: { in: [bad.id, kBad.id] } },
      data: { state: "TX", stateCode: "TX", stateNeedsReview: false },
    });
  });

  it("a customer not in the named bucket is skipped, and nothing at all is written when every id is stale", async () => {
    const s = setup();
    s.cust("r1");
    s.addr("r1", { state: "Washington", stateNeedsReview: true }); // needsReview, not unusable
    const r = await s.service.bulkSet(
      { bucket: "unusableState", customerIds: ["r1"], state: "WA" },
      user,
    );
    expect(r).toEqual({ changed: 0, changedAddressIds: [] });
    expect(s.tx.customerAddress.updateMany).not.toHaveBeenCalled();
    expect(s.store.audits).toEqual([]);
  });

  it("rolls the whole batch back when the audit write fails, and on a short guarded write (409)", async () => {
    const s = setup();
    s.cust("u1");
    const a = s.addr("u1", { state: "Unknown", stateNeedsReview: true });
    s.cust("n1");
    s.failAuditWrite();
    await expect(
      s.service.bulkSet({ bucket: "unusableState", customerIds: ["u1"], state: "TX" }, user),
    ).rejects.toThrow("audit insert failed");
    expect(a.stateCode).toBeNull();
    await expect(
      s.service.bulkSet({ bucket: "noAddress", customerIds: ["n1"], state: "TX" }, user),
    ).rejects.toThrow("audit insert failed");
    expect(s.store.addresses.filter((x) => x.customerId === "n1")).toEqual([]);

    const s2 = setup();
    s2.cust("u1");
    s2.cust("u2");
    s2.addr("u1", { state: "Unknown", stateNeedsReview: true });
    s2.addr("u2", { state: "Unknown", stateNeedsReview: true });
    s2.dropOneUpdate();
    await expect(
      s2.service.bulkSet({ bucket: "unusableState", customerIds: ["u1", "u2"], state: "TX" }, user),
    ).rejects.toThrow(ConflictException);
    expect(s2.store.addresses.map((x) => x.stateCode)).toEqual([null, null]);
    expect(s2.store.audits).toEqual([]);
  });

  it(`cap: ${BULK_STATE_MAX} ids pass validation, ${BULK_STATE_MAX + 1} are a 400; empty ids, a bad bucket and a bad state are 400s`, async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    });
    const run = (value: Record<string, unknown>) =>
      pipe.transform(value, { type: "body", metatype: BulkStateDto });
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`);
    await expect(
      run({ bucket: "noAddress", customerIds: ids(BULK_STATE_MAX), state: "TX" }),
    ).resolves.toBeDefined();
    await expect(
      run({ bucket: "noAddress", customerIds: ids(BULK_STATE_MAX + 1), state: "TX" }),
    ).rejects.toThrow(BadRequestException);
    await expect(run({ bucket: "noAddress", customerIds: [], state: "TX" })).rejects.toThrow(
      BadRequestException,
    );
    await expect(run({ bucket: "everyone", customerIds: ["c1"], state: "TX" })).rejects.toThrow(
      BadRequestException,
    );
    // needsDefault is fixed by choosing a default, never by one bulk state
    await expect(run({ bucket: "needsDefault", customerIds: ["c1"], state: "TX" })).rejects.toThrow(
      BadRequestException,
    );
    // the service refuses an over-cap list and a bad state too (defence in depth), writing nothing
    const s = setup();
    await expect(
      s.service.bulkSet(
        { bucket: "noAddress", customerIds: ids(BULK_STATE_MAX + 1), state: "TX" },
        user,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      s.service.bulkSet({ bucket: "noAddress", customerIds: ["c1"], state: "Tejas" }, user),
    ).rejects.toThrow(BadRequestException);
    expect(s.tx.customer.findMany).not.toHaveBeenCalled();
  });
});

describe("POST .../bulk-state/undo", () => {
  async function bulkThenUndoSetup() {
    const s = setup();
    s.syncNow();
    s.cust("u1");
    const updated = s.addr("u1", { state: "Unknown", stateNeedsReview: true, zip: "75201" });
    s.cust("n1");
    const unusable = await s.service.bulkSet(
      { bucket: "unusableState", customerIds: ["u1"], state: "TX" },
      user,
    );
    const noAddr = await s.service.bulkSet(
      { bucket: "noAddress", customerIds: ["n1"], state: "TX" },
      user,
    );
    return { s, updated, unusable, noAddr };
  }

  it("restores the prior state verbatim and removes only the addresses that action created; ONE audit row", async () => {
    const { s, updated, unusable, noAddr } = await bulkThenUndoSetup();
    s.advanceMinutes(5);
    expect(await s.service.undo({ changedAddressIds: unusable.changedAddressIds }, user)).toEqual({
      restored: 1,
    });
    expect(updated).toMatchObject({ state: "Unknown", stateCode: null, stateNeedsReview: true });
    expect(s.bucketsOf("u1")).toEqual(["unusableState"]);
    // the other action's created address is untouched by this undo
    expect(s.store.addresses.some((a) => a.id === noAddr.changedAddressIds[0])).toBe(true);

    expect(await s.service.undo({ changedAddressIds: noAddr.changedAddressIds }, user)).toEqual({
      restored: 1,
    });
    expect(s.store.addresses.filter((a) => a.customerId === "n1")).toEqual([]);
    expect(s.bucketsOf("n1")).toEqual(["noAddress"]);
    const undos = s.store.audits.filter((a) => a.action === AUDIT_BULK_STATE_UNDONE);
    expect(undos).toHaveLength(2);
    expect(undos[0].meta).toEqual({
      bulkAuditId: "audit-1",
      restoredAddressIds: unusable.changedAddressIds,
      skippedAddressIds: [],
    });
  });

  it("is idempotent: a second call restores 0, never errors and writes no second audit row", async () => {
    const { s, updated, noAddr, unusable } = await bulkThenUndoSetup();
    await s.service.undo({ changedAddressIds: unusable.changedAddressIds }, user);
    await s.service.undo({ changedAddressIds: noAddr.changedAddressIds }, user);
    const audits = s.store.audits.length;
    const snapshot = { ...updated };
    expect(await s.service.undo({ changedAddressIds: unusable.changedAddressIds }, user)).toEqual({
      restored: 0,
    });
    expect(await s.service.undo({ changedAddressIds: noAddr.changedAddressIds }, user)).toEqual({
      restored: 0,
    });
    expect(updated).toEqual(snapshot);
    expect(s.store.audits).toHaveLength(audits);
  });

  it("an address edited since the bulk write is left alone (not restored, not removed)", async () => {
    const { s, updated, unusable, noAddr } = await bulkThenUndoSetup();
    // someone edits both addresses after the bulk write
    await s.tx.customerAddress.updateMany({
      where: { tenantId: T, id: { in: [updated.id, noAddr.changedAddressIds[0]] } },
      data: { line1: "2 Elm St" },
    });
    expect(
      await s.service.undo(
        { changedAddressIds: [...unusable.changedAddressIds, ...noAddr.changedAddressIds] },
        user,
      ),
    ).toEqual({ restored: 0 });
    expect(updated).toMatchObject({ stateCode: "TX", line1: "2 Elm St" });
    expect(s.store.addresses.some((a) => a.id === noAddr.changedAddressIds[0])).toBe(true);
  });

  it("a retried undo of an EARLIER action never reverts a later action that shares an id", async () => {
    const s = setup();
    s.syncNow();
    s.cust("u1");
    s.cust("u2");
    const a = s.addr("u1", { state: "Unknown", stateNeedsReview: true, zip: "75201" });
    const b = s.addr("u2", { state: "Unknown", stateNeedsReview: true, zip: "75201" });
    const bulk1 = await s.service.bulkSet(
      { bucket: "unusableState", customerIds: ["u1", "u2"], state: "TX" },
      user,
    );
    expect(bulk1.changedAddressIds).toEqual([a.id, b.id]);
    expect(await s.service.undo({ changedAddressIds: bulk1.changedAddressIds }, user)).toEqual({
      restored: 2,
    });
    // bulk2 sets A again (it is back in the bucket after the undo)
    const bulk2 = await s.service.bulkSet(
      { bucket: "unusableState", customerIds: ["u1"], state: "OK" },
      user,
    );
    expect(bulk2.changedAddressIds).toEqual([a.id]);
    const audits = s.store.audits.length;
    // a client retry of bulk1's undo: matches bulk1 (it names ALL the ids), not bulk2
    expect(await s.service.undo({ changedAddressIds: bulk1.changedAddressIds }, user)).toEqual({
      restored: 0,
    });
    expect(a).toMatchObject({ stateCode: "OK", stateNeedsReview: false });
    expect(b).toMatchObject({ state: "Unknown", stateCode: null, stateNeedsReview: true });
    expect(s.store.audits).toHaveLength(audits);
    // bulk2's own undo still works
    expect(await s.service.undo({ changedAddressIds: bulk2.changedAddressIds }, user)).toEqual({
      restored: 1,
    });
    expect(a).toMatchObject({ state: "Unknown", stateCode: null, stateNeedsReview: true });
  });

  it("409 after the undo window, with nothing changed", async () => {
    const { s, updated, unusable } = await bulkThenUndoSetup();
    s.advanceMinutes(11);
    await expect(
      s.service.undo({ changedAddressIds: unusable.changedAddressIds }, user),
    ).rejects.toThrow(ConflictException);
    expect(updated.stateCode).toBe("TX");
  });

  it("404 for ids no bulk action of THIS tenant made (another tenant's, or unknown)", async () => {
    const { s, unusable } = await bulkThenUndoSetup();
    for (const row of s.store.audits) row.tenantId = "other"; // the actions belong to another tenant
    await expect(
      s.service.undo({ changedAddressIds: unusable.changedAddressIds }, user),
    ).rejects.toThrow(NotFoundException);
    await expect(s.service.undo({ changedAddressIds: ["nope"] }, user)).rejects.toThrow(
      NotFoundException,
    );
  });

  it("empty or over-long id lists are 400s", async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    });
    const run = (value: Record<string, unknown>) =>
      pipe.transform(value, { type: "body", metatype: BulkStateUndoDto });
    await expect(run({ changedAddressIds: [] })).rejects.toThrow(BadRequestException);
    await expect(run({ changedAddressIds: "a1" })).rejects.toThrow(BadRequestException);
    await expect(run({ changedAddressIds: ["a1"] })).resolves.toEqual({
      changedAddressIds: ["a1"],
    });
  });
});

describe("roles and read-only: OPERATOR and TENANT_ADMIN; CUSTOMER, DRIVER, buyers 403", () => {
  const proto = UnknownStateCustomersController.prototype as unknown as Record<string, object>;
  const guard = new RolesGuard(new Reflector());
  const can = (u: Record<string, unknown>, handler: string) =>
    guard.canActivate({
      getHandler: () => proto[handler],
      getClass: () => UnknownStateCustomersController,
      switchToHttp: () => ({ getRequest: () => ({ user: u }) }),
    } as unknown as ExecutionContext);

  it.each(["bulkSet", "undo"])("%s", (handler) => {
    expect(can({ role: UserRole.OPERATOR }, handler)).toBe(true);
    expect(can({ role: UserRole.TENANT_ADMIN }, handler)).toBe(true);
    expect(can({ role: UserRole.CUSTOMER }, handler)).toBe(false);
    expect(can({ role: UserRole.DRIVER }, handler)).toBe(false);
    expect(can({ type: "BUYER" }, handler)).toBe(false);
  });

  it("neither bulk write is on the read-only allow-list", () => {
    for (const path of [
      "/api/v1/settings/restrictions/unknown-state-customers/bulk-state",
      "/api/v1/settings/restrictions/unknown-state-customers/bulk-state/undo",
    ])
      expect(isReadOnlyAllowedMutation("POST", path)).toBe(false);
  });
});
