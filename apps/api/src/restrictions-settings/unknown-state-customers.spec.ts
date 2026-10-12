import { BadRequestException, ExecutionContext, ValidationPipe } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import {
  BULK_STATE_MAX_CUSTOMERS,
  BULK_STATE_UNDO_WINDOW_MINUTES,
  UNKNOWN_STATE_BUCKET_VALUES,
  UNKNOWN_STATE_PAGE_DEFAULT,
  UNKNOWN_STATE_PAGE_MAX,
} from "@routeflow/types";
import { RolesGuard } from "../auth/guards/roles.guard";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { UnknownStateCustomersQueryDto } from "./dto/unknown-state-customers-query.dto";
import { UnknownStateCustomersController } from "./unknown-state-customers.controller";
import { UnknownStateCustomersService } from "./unknown-state-customers.service";
import {
  BULK_STATE_MAX,
  BULK_STATE_UNDO_WINDOW_MIN,
  UNKNOWN_STATE_BUCKETS,
  UNKNOWN_STATE_PAGE_DEFAULT_API,
  UNKNOWN_STATE_PAGE_MAX_API,
  decodeUnknownStateCursor,
} from "./unknown-state";

/**
 * Addendum D, Branch B: GET /settings/restrictions/unknown-state-customers. Buckets, walk-in
 * exclusion, name order, keyset paging, tenant isolation, roles. The fake customer.findMany honours
 * the tenant, deletedAt, the walk-in predicate, the (businessName, id) order and keyset, and the
 * cursor/skip/take paging, so the service's own queries decide what comes back.
 */
const T = "test-tenant";
let seq = 0;
const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n));

function addr(over: Record<string, unknown> = {}) {
  seq++;
  return {
    id: `a${String(seq).padStart(3, "0")}`,
    tenantId: T,
    isDefault: true,
    addressType: "BILLING",
    stateCode: null as string | null,
    stateNeedsReview: false,
    line1: "1 Main St",
    line2: null as string | null,
    city: "Dallas",
    state: "",
    zip: "",
    createdAt: at(seq),
    ...over,
  };
}

interface FakeCustomer {
  id: string;
  tenantId: string;
  businessName: string;
  deletedAt: Date | null;
  isWalkIn: boolean | null;
  addresses: ReturnType<typeof addr>[];
}

const cust = (id: string, businessName: string, addresses: ReturnType<typeof addr>[], over = {}) =>
  ({
    id,
    tenantId: T,
    businessName,
    deletedAt: null,
    isWalkIn: false,
    addresses,
    ...over,
  }) as FakeCustomer;

/** A JS twin of the service's SQL candidate filter (it must never drop a bucket member). */
const CODES = new Set(["TX", "WA", "NY", "CA"]);
const candidate = (c: FakeCustomer) =>
  c.addresses.length === 0 ||
  c.addresses.some(
    (a) => a.stateNeedsReview || a.stateCode === null || !CODES.has(a.stateCode as string),
  );

function setup(customers: FakeCustomer[], opts: { businessStateMissing?: boolean } = {}) {
  const prisma = createMockPrisma();
  const models = prisma.forTenant() as any;
  const calls: any[] = [];
  models.customer.findMany.mockImplementation(async (args: any) => {
    calls.push(args);
    const w = args.where;
    const ands: any[] = w.AND ?? [];
    const keyset = ands.find((x) => x?.OR?.[0]?.businessName?.gt !== undefined);
    let rows = customers
      .filter((c) => c.tenantId === w.tenantId && c.deletedAt === null && c.isWalkIn !== true)
      .filter(candidate)
      .sort((a, b) =>
        a.businessName < b.businessName
          ? -1
          : a.businessName > b.businessName
            ? 1
            : a.id < b.id
              ? -1
              : 1,
      );
    if (keyset) {
      const name = keyset.OR[0].businessName.gt;
      const id = keyset.OR[1].id.gt;
      rows = rows.filter((c) => c.businessName > name || (c.businessName === name && c.id > id));
    }
    if (args.cursor) rows = rows.slice(rows.findIndex((c) => c.id === args.cursor.id) + 1);
    return rows.slice(0, args.take).map((c) => ({
      id: c.id,
      businessName: c.businessName,
      addresses: c.addresses,
    }));
  });
  const engine = {
    getPolicy: jest.fn().mockResolvedValue({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
    businessStateMissing: jest.fn().mockResolvedValue(opts.businessStateMissing ?? false),
  };
  return {
    calls,
    engine,
    service: new UnknownStateCustomersService(
      prisma,
      engine as unknown as SellingRestrictionsService,
    ),
  };
}

function world(): FakeCustomer[] {
  seq = 0;
  return [
    cust("c-a", "Alpha Market", []),
    cust("c-b", "Bravo Deli", [addr({ state: "Unknown", stateNeedsReview: true, zip: "75201" })]),
    cust("c-c", "Charlie Grocer", [addr({ state: "Washington", stateNeedsReview: true })]),
    cust("c-d", "Delta Foods", [addr({ state: "Texas", stateCode: "TX", stateNeedsReview: true })]),
    cust("c-e", "Echo Mart", [addr({ state: "TX", zip: "75201" })]), // never backfilled
    cust("c-f", "Foxtrot Store", [addr({ state: "TX", stateCode: "TX" })]), // resolved
    cust("c-g", "Golf Shop", [
      addr({ isDefault: false, state: "TX", stateCode: "TX" }),
      addr({ isDefault: false, state: "TX", stateCode: "TX" }),
    ]), // unresolved, but no address problem: in no bucket
    cust("c-h", "Hotel Walk-in", [], { isWalkIn: true }),
    cust("c-i", "India Closed", [], { deletedAt: new Date() }),
    cust("c-j", "Juliet Elsewhere", [], { tenantId: "other-tenant" }),
    cust("c-k", "Kilo Wholesale", [
      addr({ state: "??", stateNeedsReview: true, zip: "10001" }),
      addr({ state: "Washington", stateNeedsReview: true }),
    ]), // two defaults: one unusable, one readable
    cust("c-l", "Lima Liquor", [
      addr({ state: "TX", stateCode: "TX" }),
      addr({ isDefault: false, addressType: "SHIPPING", state: "Unknown", stateNeedsReview: true }),
    ]), // governing address is fine; a non-governing problem does not count
  ];
}

const names = (rows: { name: string }[]) => rows.map((r) => r.name);

describe("GET /settings/restrictions/unknown-state-customers: buckets", () => {
  it("puts each unresolved customer in the right bucket(s) with the row the card shows", async () => {
    const { service } = setup(world());
    const r = await service.list({});
    expect(r.noAddress).toEqual({
      total: 1,
      nextCursor: null,
      rows: [
        {
          customerId: "c-a",
          name: "Alpha Market",
          addressId: null,
          addressText: null,
          suggestedState: null,
        },
      ],
    });
    expect(names(r.unusableState.rows)).toEqual(["Bravo Deli", "Kilo Wholesale"]);
    expect(r.unusableState.total).toBe(2);
    expect(r.unusableState.rows[0]).toEqual({
      customerId: "c-b",
      name: "Bravo Deli",
      addressId: "a001",
      addressText: "1 Main St, Dallas, Unknown, 75201",
      suggestedState: "TX", // from the ZIP prefix
    });
    expect(r.unusableState.rows[1].suggestedState).toBe("NY");
    expect(names(r.needsReview.rows)).toEqual([
      "Charlie Grocer",
      "Delta Foods",
      "Echo Mart",
      "Kilo Wholesale",
    ]);
    expect(r.needsReview.rows.map((x) => x.suggestedState)).toEqual(["WA", "TX", "TX", "WA"]);
    expect(r.needsReview.total).toBe(4);
    // Kilo sits in two buckets and counts once; Golf (no address problem) and Lima (resolved) count 0.
    expect(r.customersTotal).toBe(6);
    expect(r.businessStateMissing).toBe(false);
  });

  it("excludes the walk-in, deleted customers and other tenants; every read carries the tenant and the walk-in predicate", async () => {
    const { service, calls } = setup(world());
    const r = await service.list({});
    const all = [...r.noAddress.rows, ...r.unusableState.rows, ...r.needsReview.rows];
    for (const id of ["c-h", "c-i", "c-j"])
      expect(all.some((x) => x.customerId === id)).toBe(false);
    for (const c of calls) {
      expect(c.where.tenantId).toBe(T);
      expect(c.where.deletedAt).toBeNull();
      expect(c.where.AND).toEqual(
        expect.arrayContaining([{ OR: [{ isWalkIn: null }, { isWalkIn: false }] }]),
      );
      expect(c.orderBy).toEqual([{ businessName: "asc" }, { id: "asc" }]);
    }
  });

  it("a confirmed address (code stored, not flagged) leaves needsReview; a usable governing state leaves every bucket", async () => {
    const customers = world();
    const delta = customers.find((c) => c.id === "c-d") as FakeCustomer;
    delta.addresses[0].stateNeedsReview = false;
    const alpha = customers.find((c) => c.id === "c-a") as FakeCustomer;
    alpha.addresses.push(addr({ state: "NY", stateCode: "NY" }));
    const r = await setup(customers).service.list({});
    expect(r.noAddress.total).toBe(0);
    expect(names(r.needsReview.rows)).not.toContain("Delta Foods");
    expect(r.customersTotal).toBe(4);
  });

  it("sorts by name, then id", async () => {
    seq = 0;
    const r = await setup([
      cust("c-2", "Same Name", []),
      cust("c-1", "Same Name", []),
      cust("c-0", "Another", []),
    ]).service.list({});
    expect(r.noAddress.rows.map((x) => x.customerId)).toEqual(["c-0", "c-1", "c-2"]);
  });

  it("businessStateMissing is the engine's own answer (the shared stateRuleInPlay predicate), asked for this tenant", async () => {
    const s = setup([], { businessStateMissing: true });
    const r = await s.service.list({});
    expect(r.businessStateMissing).toBe(true);
    expect(s.engine.businessStateMissing).toHaveBeenCalledWith(T);
    expect(r.customersTotal).toBe(0);
    expect(r.noAddress).toEqual({ total: 0, rows: [], nextCursor: null });
  });
});

describe("paging: limit, keyset cursor per bucket", () => {
  const many = () => {
    seq = 0;
    return Array.from({ length: 5 }, (_, i) =>
      cust(`n${i}`, `Name ${i}`, [addr({ state: "TX" })]),
    ).concat([cust("z1", "Zed", [])]);
  };

  it("with a bucket: that bucket is paged from the cursor; the others come back empty with their real totals", async () => {
    const { service } = setup(many());
    const p1 = await service.list({ bucket: "needsReview", limit: 2 });
    expect(names(p1.needsReview.rows)).toEqual(["Name 0", "Name 1"]);
    expect(p1.needsReview.total).toBe(5);
    expect(p1.needsReview.nextCursor).toEqual(expect.any(String));
    expect(p1.noAddress).toEqual({ total: 1, rows: [], nextCursor: null });
    expect(p1.unusableState).toEqual({ total: 0, rows: [], nextCursor: null });

    const p2 = await service.list({
      bucket: "needsReview",
      limit: 2,
      cursor: p1.needsReview.nextCursor as string,
    });
    expect(names(p2.needsReview.rows)).toEqual(["Name 2", "Name 3"]);
    expect(p2.noAddress).toEqual({ total: 1, rows: [], nextCursor: null });
    const p3 = await service.list({
      bucket: "needsReview",
      limit: 2,
      cursor: p2.needsReview.nextCursor as string,
    });
    expect(names(p3.needsReview.rows)).toEqual(["Name 4"]);
    expect(p3.needsReview.nextCursor).toBeNull();
    expect(p3.needsReview.total).toBe(5);
  });

  it("without a bucket: the first page of every bucket; limit defaults to 20", async () => {
    seq = 0;
    const lots = Array.from({ length: 25 }, (_, i) =>
      cust(`m${String(i).padStart(2, "0")}`, `M ${String(i).padStart(2, "0")}`, []),
    );
    const r = await setup(lots).service.list({});
    expect(r.noAddress.rows).toHaveLength(20);
    expect(r.noAddress.total).toBe(25);
    expect(decodeUnknownStateCursor(r.noAddress.nextCursor as string)).toEqual({
      name: "M 19",
      id: "m19",
    });
  });

  it("a cursor survives the row it names being fixed (keyset on name + id, not on position)", async () => {
    const customers = many();
    const { service } = setup(customers);
    const p1 = await service.list({ bucket: "needsReview", limit: 2 });
    customers[1].addresses[0].stateCode = "TX"; // "Name 1" fixed meanwhile
    const p2 = await service.list({
      bucket: "needsReview",
      limit: 2,
      cursor: p1.needsReview.nextCursor as string,
    });
    expect(names(p2.needsReview.rows)).toEqual(["Name 2", "Name 3"]);
    expect(p2.needsReview.total).toBe(4);
  });

  it("400 on a malformed cursor, and on a cursor without its bucket", async () => {
    const { service } = setup(many());
    await expect(service.list({ bucket: "noAddress", cursor: "not-a-cursor" })).rejects.toThrow(
      BadRequestException,
    );
    const p1 = await service.list({ bucket: "needsReview", limit: 1 });
    await expect(service.list({ cursor: p1.needsReview.nextCursor as string })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("400 on a bad bucket or limit (validation pipe); 50 is accepted", async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    });
    const run = (value: Record<string, unknown>) =>
      pipe.transform(value, { type: "query", metatype: UnknownStateCustomersQueryDto });
    await expect(run({ bucket: "everyone" })).rejects.toThrow(BadRequestException);
    await expect(run({ limit: "0" })).rejects.toThrow(BadRequestException);
    await expect(run({ limit: "51" })).rejects.toThrow(BadRequestException);
    await expect(run({ limit: "ten" })).rejects.toThrow(BadRequestException);
    await expect(run({ limit: "2.5" })).rejects.toThrow(BadRequestException);
    await expect(run({ take: "5" })).rejects.toThrow(BadRequestException);
    await expect(run({ bucket: "needsReview", limit: "50" })).resolves.toEqual({
      bucket: "needsReview",
      limit: 50,
    });
  });
});

describe("engine.businessStateMissing: an active ALL (legal-ban) STATE rule and no business state", () => {
  const rule = (over: Record<string, unknown> = {}) => ({
    id: "r1",
    categoryId: "cat",
    productId: null,
    jurisdiction: "STATE",
    states: ["TX"],
    surface: "ALL",
    effectiveFrom: new Date("2026-01-01"),
    effectiveTo: null,
    liftedAt: null,
    reason: "x",
    ...over,
  });
  const engineWith = (rules: unknown[], businessState: string | null) => {
    const prisma = createMockPrisma();
    const m = prisma.forTenant() as any;
    m.sellingRestriction = { findMany: jest.fn().mockResolvedValue(rules) };
    m.tenantConfig.findUnique.mockResolvedValue({ state: businessState });
    return new SellingRestrictionsService(prisma, {} as never);
  };

  it("true only with an ALL STATE rule in force and no usable business state", async () => {
    expect(await engineWith([rule()], null).businessStateMissing(T)).toBe(true);
    expect(await engineWith([rule()], "Texas").businessStateMissing(T)).toBe(false);
    expect(
      await engineWith([rule({ surface: "BUYER_PORTAL" })], null).businessStateMissing(T),
    ).toBe(false);
    expect(
      await engineWith([rule({ liftedAt: new Date("2026-02-01") })], null).businessStateMissing(T),
    ).toBe(false);
    expect(await engineWith([], null).businessStateMissing(T)).toBe(false);
  });
});

describe("roles: OPERATOR and TENANT_ADMIN read; CUSTOMER, DRIVER and buyers get 403", () => {
  const proto = UnknownStateCustomersController.prototype as unknown as Record<string, object>;
  const guard = new RolesGuard(new Reflector());
  const can = (user: Record<string, unknown>) =>
    guard.canActivate({
      getHandler: () => proto.list,
      getClass: () => UnknownStateCustomersController,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext);

  it("list", () => {
    expect(can({ role: UserRole.OPERATOR })).toBe(true);
    expect(can({ role: UserRole.TENANT_ADMIN })).toBe(true);
    expect(can({ role: UserRole.CUSTOMER })).toBe(false);
    expect(can({ role: UserRole.DRIVER })).toBe(false);
    expect(can({ type: "BUYER" })).toBe(false);
  });
});

describe("API copies of the shared constants", () => {
  it("equal the shared values", () => {
    expect([...UNKNOWN_STATE_BUCKETS]).toEqual([...UNKNOWN_STATE_BUCKET_VALUES]);
    expect(UNKNOWN_STATE_PAGE_DEFAULT_API).toBe(UNKNOWN_STATE_PAGE_DEFAULT);
    expect(UNKNOWN_STATE_PAGE_MAX_API).toBe(UNKNOWN_STATE_PAGE_MAX);
    expect(BULK_STATE_MAX).toBe(BULK_STATE_MAX_CUSTOMERS);
    expect(BULK_STATE_UNDO_WINDOW_MIN).toBe(BULK_STATE_UNDO_WINDOW_MINUTES);
  });
});
