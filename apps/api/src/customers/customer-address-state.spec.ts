import {
  BadRequestException,
  ConflictException,
  ExecutionContext,
  NotFoundException,
  ValidationPipe,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { RolesGuard } from "../auth/guards/roles.guard";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { geocodeAddress } from "../common/geocode.util";
import { EmailService } from "../email/email.service";
import { PrismaService } from "../prisma/prisma.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { placeUnknownState } from "../restrictions-settings/unknown-state";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { StorageService } from "../storage/storage.service";
import { isReadOnlyAllowedMutation } from "../tenant/read-only-registry";
import { createMockPrisma } from "../testing/prisma-mock";
import { CustomerAddressStateController } from "./customer-address-state.controller";
import {
  AUDIT_ADDRESS_STATE_SET,
  AUDIT_MINIMAL_ADDRESS_CREATED,
  CustomerAddressStateService,
} from "./customer-address-state.service";
import { CustomersService } from "./customers.service";
import { AddressStateDto, MinimalAddressDto } from "./dto/address-state.dto";

jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: jest.fn((_opts: unknown, fn: () => Promise<unknown>) =>
    fn().then((value) => ({ acquired: true, value })),
  ),
  LockTimeoutError: class LockTimeoutError extends Error {},
  LockUnavailableError: class LockUnavailableError extends Error {},
}));

/**
 * Addendum D, Branch B: fix a customer's state in place. PATCH .../addresses/:addressId/state and
 * POST .../addresses/minimal over a transactional fake (tenant-scoped rows, snapshot rollback), plus
 * "Add full address" making the first billing address the default.
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
}

function setup() {
  const prisma = createMockPrisma();
  const store = {
    customers: [
      { id: "c1", tenantId: T, deletedAt: null, isWalkIn: false, businessName: "Acme Deli" },
      { id: "c2", tenantId: T, deletedAt: null, isWalkIn: false, businessName: "Acme Mart" },
      { id: "walk", tenantId: T, deletedAt: null, isWalkIn: true, businessName: "Walk-in" },
      { id: "x1", tenantId: "other", deletedAt: null, isWalkIn: false, businessName: "Elsewhere" },
    ],
    addresses: [] as Addr[],
    audits: [] as any[],
  };
  let failAudit = false;
  const addr = (over: Partial<Addr>): Addr => ({
    id: "a?",
    tenantId: T,
    customerId: "c1",
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
    createdAt: new Date("2026-01-01"),
    ...over,
  });
  const matchAddr = (w: any) => (a: Addr) =>
    a.tenantId === w.tenantId &&
    (w.id === undefined || (typeof w.id === "string" ? a.id === w.id : w.id.in.includes(a.id))) &&
    (w.customerId === undefined || a.customerId === w.customerId);
  const tx = {
    customer: {
      findFirst: jest.fn(async ({ where }: any) => {
        const c = store.customers.find(
          (x) => x.tenantId === where.tenantId && x.id === where.id && x.deletedAt === null,
        );
        if (!c) return null;
        return {
          id: c.id,
          isWalkIn: c.isWalkIn,
          _count: { addresses: store.addresses.filter((a) => a.customerId === c.id).length },
        };
      }),
    },
    customerAddress: {
      findFirst: jest.fn(async ({ where, select }: any) => {
        const a = store.addresses.find(matchAddr(where));
        if (!a) return null;
        const keys = select ? Object.keys(select) : Object.keys(a);
        return Object.fromEntries(keys.map((k) => [k, (a as any)[k]]));
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = store.addresses.filter(matchAddr(where));
        hit.forEach((a) => Object.assign(a, data));
        return { count: hit.length };
      }),
      createMany: jest.fn(async ({ data }: any) => {
        for (const d of data) store.addresses.push(addr({ ...d, createdAt: new Date() }));
        return { count: data.length };
      }),
    },
    auditLog: {
      create: jest.fn(async ({ data }: any) => {
        if (failAudit) throw new Error("audit insert failed");
        store.audits.push(data);
        return { id: `audit-${store.audits.length}`, ...data };
      }),
    },
  };
  (prisma.tenantTransaction as jest.Mock).mockImplementation(async (fn: any) => {
    const snap = JSON.stringify(store.addresses);
    const audits = store.audits.length;
    try {
      return await fn(tx);
    } catch (e) {
      store.addresses = (JSON.parse(snap) as Addr[]).map((a) => ({
        ...a,
        createdAt: new Date(a.createdAt),
      }));
      store.audits.length = audits;
      throw e;
    }
  });
  const placement = (customerId: string) =>
    placeUnknownState(
      {
        id: customerId,
        businessName: "x",
        addresses: store.addresses.filter((a) => a.customerId === customerId),
      },
      "BILLING_FIRST",
    );
  return {
    store,
    tx,
    addr,
    placement,
    failAuditWrite: () => (failAudit = true),
    service: new CustomerAddressStateService(prisma),
  };
}

describe("POST /customers/:id/addresses/minimal", () => {
  it("creates the default billing address with only the state; the customer leaves noAddress; one audit row", async () => {
    const s = setup();
    expect(s.placement("c1")).toEqual({ noAddress: { address: null, others: [] } });
    const r = await s.service.addMinimal("c1", { state: "texas" }, user);
    expect(r).toEqual({ customerId: "c1", addressId: expect.any(String), state: "TX" });
    expect(s.store.addresses).toEqual([
      expect.objectContaining({
        id: r.addressId,
        tenantId: T,
        customerId: "c1",
        line1: "",
        city: "",
        zip: "",
        state: "TX",
        stateCode: "TX",
        stateNeedsReview: false,
        isDefault: true,
        addressType: "BILLING",
      }),
    ]);
    expect(s.placement("c1")).toEqual({});
    expect(s.store.audits).toEqual([
      expect.objectContaining({
        tenantId: T,
        userId: "u1",
        action: AUDIT_MINIMAL_ADDRESS_CREATED,
        entityType: "CustomerAddress",
        entityId: r.addressId,
        meta: { customerId: "c1", state: "TX", zip: null },
      }),
    ]);
  });

  it("keeps a ZIP that lies in the state; refuses a malformed ZIP or one in another state (400, nothing written)", async () => {
    const s = setup();
    await s.service.addMinimal("c1", { state: "TX", zip: " 75201-1234 " }, user);
    expect(s.store.addresses[0]).toMatchObject({ zip: "75201-1234", stateCode: "TX" });
    for (const zip of ["10001", "7520", "abcde"]) {
      await expect(s.service.addMinimal("c2", { state: "TX", zip }, user)).rejects.toThrow(
        BadRequestException,
      );
    }
    expect(s.store.addresses.filter((a) => a.customerId === "c2")).toEqual([]);
  });

  it("400 on a state that is not a US state; nothing written", async () => {
    const s = setup();
    await expect(s.service.addMinimal("c1", { state: "Tejas" }, user)).rejects.toThrow(
      BadRequestException,
    );
    expect(s.store.addresses).toEqual([]);
    expect(s.store.audits).toEqual([]);
  });

  it("409 when the customer already has any address; the walk-in is refused; another tenant's customer is a 404", async () => {
    const s = setup();
    s.store.addresses.push(s.addr({ id: "a1", state: "Unknown", stateNeedsReview: true }));
    await expect(s.service.addMinimal("c1", { state: "TX" }, user)).rejects.toThrow(
      ConflictException,
    );
    await expect(s.service.addMinimal("walk", { state: "TX" }, user)).rejects.toThrow(
      BadRequestException,
    );
    await expect(s.service.addMinimal("x1", { state: "TX" }, user)).rejects.toThrow(
      NotFoundException,
    );
    expect(s.store.addresses).toHaveLength(1);
    expect(s.store.audits).toEqual([]);
  });

  it("a failed audit write rolls the address back", async () => {
    const s = setup();
    s.failAuditWrite();
    await expect(s.service.addMinimal("c1", { state: "TX" }, user)).rejects.toThrow(
      "audit insert failed",
    );
    expect(s.store.addresses).toEqual([]);
  });
});

describe("PATCH /customers/:id/addresses/:addressId/state", () => {
  it("review-confirm clears needsReview: the code is stored and the flag cleared; audited with the prior state", async () => {
    const s = setup();
    s.store.addresses.push(s.addr({ id: "a1", state: "Washington", stateNeedsReview: true }));
    expect(Object.keys(s.placement("c1"))).toEqual(["needsReview"]);
    const r = await s.service.setState("c1", "a1", { state: "WA", confirmReview: true }, user);
    expect(r).toEqual({ customerId: "c1", addressId: "a1", state: "WA" });
    expect(s.store.addresses[0]).toMatchObject({
      state: "WA",
      stateCode: "WA",
      stateNeedsReview: false,
    });
    expect(s.placement("c1")).toEqual({});
    expect(s.store.audits).toEqual([
      expect.objectContaining({
        action: AUDIT_ADDRESS_STATE_SET,
        entityType: "CustomerAddress",
        entityId: "a1",
        meta: {
          customerId: "c1",
          from: { state: "Washington", stateCode: null, stateNeedsReview: true },
          to: { state: "WA" },
          confirmReview: true,
        },
      }),
    ]);
  });

  it("a stored code flagged for review is confirmed too", async () => {
    const s = setup();
    s.store.addresses.push(
      s.addr({ id: "a1", state: "Texas", stateCode: "TX", stateNeedsReview: true }),
    );
    await s.service.setState("c1", "a1", { state: "TX", confirmReview: true }, user);
    expect(s.store.addresses[0]).toMatchObject({ stateCode: "TX", stateNeedsReview: false });
    expect(s.placement("c1")).toEqual({});
  });

  it("an unusable state is fixed by the person's choice, even where the stored ZIP points elsewhere", async () => {
    const s = setup();
    s.store.addresses.push(
      s.addr({ id: "a1", state: "Unknown", stateNeedsReview: true, zip: "90210" }),
    );
    expect(Object.keys(s.placement("c1"))).toEqual(["unusableState"]);
    await s.service.setState("c1", "a1", { state: "Texas" }, user);
    expect(s.store.addresses[0]).toMatchObject({ state: "TX", stateCode: "TX" });
    expect(s.placement("c1")).toEqual({});
    expect(s.store.audits[0].meta.confirmReview).toBe(false);
  });

  it("400 on a bad state, nothing written", async () => {
    const s = setup();
    s.store.addresses.push(s.addr({ id: "a1", state: "Unknown", stateNeedsReview: true }));
    await expect(s.service.setState("c1", "a1", { state: "Tejas" }, user)).rejects.toThrow(
      BadRequestException,
    );
    expect(s.store.addresses[0].stateCode).toBeNull();
    expect(s.store.audits).toEqual([]);
  });

  it("404 for another customer's address, another tenant's address or customer, and an unknown id", async () => {
    const s = setup();
    s.store.addresses.push(s.addr({ id: "a1", customerId: "c1", state: "Unknown" }));
    s.store.addresses.push(
      s.addr({ id: "ax", tenantId: "other", customerId: "x1", state: "Unknown" }),
    );
    await expect(s.service.setState("c2", "a1", { state: "TX" }, user)).rejects.toThrow(
      NotFoundException,
    );
    await expect(s.service.setState("c1", "ax", { state: "TX" }, user)).rejects.toThrow(
      NotFoundException,
    );
    await expect(s.service.setState("x1", "ax", { state: "TX" }, user)).rejects.toThrow(
      NotFoundException,
    );
    await expect(s.service.setState("c1", "nope", { state: "TX" }, user)).rejects.toThrow(
      NotFoundException,
    );
    expect(s.store.addresses.map((a) => a.stateCode)).toEqual([null, null]);
    expect(s.store.audits).toEqual([]);
  });

  it("the write is tenant-guarded: every updateMany carries the tenant and the address id", async () => {
    const s = setup();
    s.store.addresses.push(s.addr({ id: "a1", state: "Unknown" }));
    await s.service.setState("c1", "a1", { state: "TX" }, user);
    expect(s.tx.customerAddress.updateMany).toHaveBeenCalledWith({
      where: { tenantId: T, id: { in: ["a1"] }, customerId: "c1" },
      data: { state: "TX", stateCode: "TX", stateNeedsReview: false },
    });
  });
});

describe("DTO validation (400)", () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
  const run = (metatype: any, value: Record<string, unknown>) =>
    pipe.transform(value, { type: "body", metatype });

  it("state is required; confirmReview is a boolean; unknown fields are refused", async () => {
    await expect(run(AddressStateDto, {})).rejects.toThrow(BadRequestException);
    await expect(run(AddressStateDto, { state: "TX", confirmReview: "yes" })).rejects.toThrow(
      BadRequestException,
    );
    await expect(run(AddressStateDto, { state: "TX", street: "x" })).rejects.toThrow(
      BadRequestException,
    );
    await expect(run(MinimalAddressDto, { zip: "75201" })).rejects.toThrow(BadRequestException);
    await expect(run(MinimalAddressDto, { state: "TX", zip: 75201 })).rejects.toThrow(
      BadRequestException,
    );
    await expect(run(AddressStateDto, { state: "TX", confirmReview: true })).resolves.toEqual({
      state: "TX",
      confirmReview: true,
    });
  });
});

describe("roles and read-only: OPERATOR and TENANT_ADMIN write; CUSTOMER, DRIVER, buyers 403", () => {
  const proto = CustomerAddressStateController.prototype as unknown as Record<string, object>;
  const guard = new RolesGuard(new Reflector());
  const can = (u: Record<string, unknown>, handler: string) =>
    guard.canActivate({
      getHandler: () => proto[handler],
      getClass: () => CustomerAddressStateController,
      switchToHttp: () => ({ getRequest: () => ({ user: u }) }),
    } as unknown as ExecutionContext);

  it.each(["setState", "addMinimal"])("%s", (handler) => {
    expect(can({ role: UserRole.OPERATOR }, handler)).toBe(true);
    expect(can({ role: UserRole.TENANT_ADMIN }, handler)).toBe(true);
    expect(can({ role: UserRole.CUSTOMER }, handler)).toBe(false);
    expect(can({ role: UserRole.DRIVER }, handler)).toBe(false);
    expect(can({ type: "BUYER" }, handler)).toBe(false);
  });

  it("neither write is on the read-only allow-list (a read-only workspace refuses both)", () => {
    expect(isReadOnlyAllowedMutation("PATCH", "/api/v1/customers/c1/addresses/a1/state")).toBe(
      false,
    );
    expect(isReadOnlyAllowedMutation("POST", "/api/v1/customers/c1/addresses/minimal")).toBe(false);
  });
});

describe('"Add full address": the first billing address becomes the default billing address', () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const ADDRESS = { label: "Main", line1: "1 Congress Ave", city: "Austin", state: "TX" };

  beforeEach(async () => {
    prisma = createMockPrisma();
    (prisma as any).tenantSubscription = {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    };
    const module = await Test.createTestingModule({
      providers: [
        CustomersService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } },
        { provide: StorageService, useValue: {} },
        {
          provide: MeterService,
          useValue: { read: jest.fn().mockResolvedValue({ included: null, used: 0 }) },
        },
        {
          provide: PlanCatalogService,
          useValue: { getPublishedVersion: jest.fn().mockResolvedValue(null) },
        },
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
        { provide: EmailService, useValue: { send: jest.fn().mockResolvedValue({}) } },
        { provide: CommissionEngineService, useValue: {} },
        { provide: RegulatedLedgerService, useValue: {} },
      ],
    }).compile();
    service = module.get(CustomersService);
    prisma.customer.findUnique.mockResolvedValue({ id: "c1", userId: "u", businessName: "Acme" });
    prisma.customerAddress.create.mockResolvedValue({ id: "new" });
  });

  /** The customer's stored addresses; a row has a real street unless it says otherwise. */
  const existing = (
    rows: Array<{
      id?: string;
      isDefault: boolean;
      addressType: string;
      line1?: string;
      city?: string;
    }>,
  ) =>
    prisma.customerAddress.findMany.mockImplementation(async (a: any) =>
      rows
        .map((r, i) => ({ id: `old-${i + 1}`, line1: "9 Elm St", city: "Dallas", ...r }))
        .filter((r) => a?.where?.isDefault !== true || r.isDefault),
    );
  const written = () => prisma.customerAddress.create.mock.calls[0][0].data;

  it("no address yet: the new billing address is the default", async () => {
    existing([]);
    await service.addAddress("c1", { ...ADDRESS, zip: "78701" } as any);
    expect(written()).toMatchObject({ isDefault: true, addressType: "BILLING", stateCode: "TX" });
    expect(prisma.customerAddress.updateMany).not.toHaveBeenCalled();
  });

  it("even when the form sends isDefault: false, while no default billing address exists", async () => {
    existing([]);
    await service.addAddress("c1", { ...ADDRESS, zip: "78701", isDefault: false } as any);
    expect(written().isDefault).toBe(true);
  });

  it("only a default SHIPPING address: the new billing one is NOT default (one default, never two)", async () => {
    existing([{ isDefault: true, addressType: "SHIPPING" }]);
    await service.addAddress("c1", { ...ADDRESS, zip: "78701" } as any);
    expect(written().isDefault).toBe(false);
    expect(prisma.customerAddress.updateMany).not.toHaveBeenCalled();
  });

  it('one default "Main"-typed address: a new billing address leaves exactly that one default', async () => {
    existing([{ isDefault: true, addressType: "Main" }]);
    await service.addAddress("c1", { ...ADDRESS, zip: "78701" } as any);
    expect(written().isDefault).toBe(false);
    expect(prisma.customerAddress.updateMany).not.toHaveBeenCalled();
  });

  it("minimal (blank street) default then a full address: the full one is default, the blank one is demoted", async () => {
    existing([{ id: "min", isDefault: true, addressType: "BILLING", line1: "", city: " " }]);
    await service.addAddress("c1", { ...ADDRESS, zip: "78701" } as any);
    expect(written().isDefault).toBe(true);
    expect(prisma.customerAddress.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.customerAddress.updateMany).toHaveBeenCalledWith({
      where: { customerId: "c1", isDefault: true, id: { in: ["min"] } },
      data: { isDefault: false },
    });
  });

  it("the blank default is demoted even when the form sends isDefault: false", async () => {
    existing([{ id: "min", isDefault: true, addressType: "BILLING", line1: "", city: "" }]);
    await service.addAddress("c1", { ...ADDRESS, zip: "78701", isDefault: false } as any);
    expect(written().isDefault).toBe(true);
    expect(prisma.customerAddress.updateMany).toHaveBeenCalledTimes(1);
  });

  it("a NON-blank default is never demoted (a street, or only a city, is a real address)", async () => {
    existing([{ isDefault: true, addressType: "BILLING", line1: "", city: "Dallas" }]);
    await service.addAddress("c1", { ...ADDRESS, zip: "78701" } as any);
    expect(written().isDefault).toBe(false);
    expect(prisma.customerAddress.updateMany).not.toHaveBeenCalled();
  });

  it("a blank default stays when the new address is blank-street too, or a SHIPPING one", async () => {
    existing([{ id: "min", isDefault: true, addressType: "BILLING", line1: "", city: "" }]);
    await service.addAddress("c1", { ...ADDRESS, line1: " ", city: "", zip: "78701" } as any);
    await service.addAddress("c1", { ...ADDRESS, zip: "78701", addressType: "SHIPPING" } as any);
    expect(prisma.customerAddress.create.mock.calls.map((c: any) => c[0].data.isDefault)).toEqual([
      false,
      false,
    ]);
    expect(prisma.customerAddress.updateMany).not.toHaveBeenCalled();
  });

  it("a default billing address exists: the new one is not default and nothing is demoted", async () => {
    existing([{ isDefault: true, addressType: " billing " }]);
    await service.addAddress("c1", { ...ADDRESS, zip: "78701" } as any);
    expect(written().isDefault).toBe(false);
    expect(prisma.customerAddress.updateMany).not.toHaveBeenCalled();
  });

  it("a new SHIPPING address never becomes the default billing address", async () => {
    existing([]);
    await service.addAddress("c1", { ...ADDRESS, zip: "78701", addressType: "SHIPPING" } as any);
    expect(written()).toMatchObject({ isDefault: false, addressType: "SHIPPING" });
  });

  it("an explicit isDefault: true keeps today's behaviour (the others are demoted)", async () => {
    existing([{ isDefault: true, addressType: "BILLING" }]);
    await service.addAddress("c1", { ...ADDRESS, zip: "78701", isDefault: true } as any);
    expect(written().isDefault).toBe(true);
    expect(prisma.customerAddress.updateMany).toHaveBeenCalledWith({
      where: { customerId: "c1" },
      data: { isDefault: false },
    });
  });
});

describe("geocoding skips a blank-street address (no state-centroid pins)", () => {
  const BLANK = { line1: "", city: " ", state: "TX", zip: "" };
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ geometry: { location: { lat: 30.2, lng: -97.7 } } }] }),
    } as any);
  });
  afterEach(() => fetchSpy.mockRestore());

  it("geocodeAddress returns null for blank line1 AND blank city without calling the geocoder", async () => {
    expect(await geocodeAddress(BLANK, "key")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await geocodeAddress({ ...BLANK, city: "Austin" }, "key")).toEqual({
      lat: 30.2,
      lng: -97.7,
    });
  });

  it("geocode-all skips blank-street addresses and counts them as skipped", async () => {
    const prisma = createMockPrisma();
    const module = await Test.createTestingModule({
      providers: [
        CustomersService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue("key") } },
        { provide: StorageService, useValue: {} },
        { provide: MeterService, useValue: {} },
        { provide: PlanCatalogService, useValue: {} },
        { provide: EntitlementAuthority, useValue: {} },
        { provide: EmailService, useValue: {} },
        { provide: CommissionEngineService, useValue: {} },
        { provide: RegulatedLedgerService, useValue: {} },
      ],
    }).compile();
    const service = module.get(CustomersService);
    prisma.customerAddress.findMany.mockResolvedValue([
      { id: "blank", ...BLANK },
      { id: "real", line1: "1 Congress Ave", city: "Austin", state: "TX", zip: "78701" },
    ]);
    prisma.customerAddress.update.mockResolvedValue({});
    const res = await service.geocodeAllAddresses();
    expect(res).toEqual({ total: 2, geocoded: 1, failed: 0, skipped: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(prisma.customerAddress.update).toHaveBeenCalledTimes(1);
    expect(prisma.customerAddress.update.mock.calls[0][0].where).toEqual({ id: "real" });
  });
});
