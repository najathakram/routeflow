import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { MrrService } from "../billing/mrr.service";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { listenOnLoopback } from "../common/testing/listen-loopback";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { PlatformAdminController } from "./platform-admin.controller";
import { PlatformAdminService } from "./platform-admin.service";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require("supertest");

/**
 * SA-1535 / W-1462 PR-1 (OP-14): the keys are asserted on the HTTP response of the real controller over the REAL service
 * (only Prisma and the collaborators are faked), never on a service local. A list row and the detail row both carry
 * class, bucket, attention and trialDaysLeft; the list meta carries per-tab counts; a bad bucket and an oversized limit
 * are 400 at the route.
 */
// `then` must be undefined: Nest awaits a provider, and a proxy answering `then` is an un-resolving thenable
const stub = () => new Proxy({}, { get: (_t, p) => (p === "then" ? undefined : jest.fn()) });

const sub = (o: Record<string, unknown> = {}) => ({
  planKey: "GROWTH",
  currentPlan: "GROWTH",
  periodEnd: null,
  cancelAtPeriodEnd: false,
  couponFull: false,
  pastDueSince: null,
  stripeSubId: null,
  stripeCustomerId: null,
  catchupState: null,
  basePriceSnapshot: 149,
  discount: 0,
  needsReconcile: false,
  ...o,
});
const ROWS = [
  {
    id: "t-paying",
    slug: "acme-paying",
    name: "Acme Paying",
    class: "PRODUCTION",
    status: "ACTIVE",
    plan: "GROWTH",
    deletedAt: null,
    trialEndsAt: null,
    readOnlyReason: null,
    subscription: sub(),
  },
  {
    id: "t-test",
    slug: "qa-acme",
    name: "QA Acme",
    class: "TEST",
    status: "ACTIVE",
    plan: "STARTER",
    deletedAt: null,
    trialEndsAt: null,
    readOnlyReason: null,
    subscription: null,
  },
];

describe("GET platform-admin/tenants and tenants/:id: the wire (SA-1535)", () => {
  let app: INestApplication;
  const findMany = jest.fn();

  beforeAll(async () => {
    const prisma = {
      tenant: {
        findMany,
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn(async () => ({ ...ROWS[0], _count: {} })),
      },
      order: { count: jest.fn().mockResolvedValue(0) },
    };
    const mrr = new MrrService({
      tenantAddon: { findMany: jest.fn().mockResolvedValue([]) },
    } as any);
    (mrr as any).priceTenant = jest.fn().mockResolvedValue(0);
    // PlatformAdminService has 19 positional collaborators; only prisma (0) and mrr (13) are read by these routes.
    const deps = Array.from({ length: 19 }, () => stub());
    deps[0] = prisma;
    deps[13] = mrr;
    const svc = new (PlatformAdminService as any)(...deps);
    const moduleRef = await Test.createTestingModule({
      controllers: [PlatformAdminController],
      providers: [{ provide: PlatformAdminService, useValue: svc }],
    })
      .useMocker(() => stub())
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(SuperAdminGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    await listenOnLoopback(app);
  }, 120_000);
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    findMany.mockReset();
    findMany.mockImplementation(async (args: any) => {
      if (args.select) return ROWS;
      // the page fetch honours its include.subscription.select, as Postgres would
      const project = (r: any) => {
        const keys = Object.keys(args.include?.subscription?.select ?? {});
        if (!r.subscription || keys.length === 0) return r;
        return { ...r, subscription: Object.fromEntries(keys.map((k) => [k, r.subscription[k]])) };
      };
      if (args.where?.id?.in)
        return ROWS.filter((r) => args.where.id.in.includes(r.id)).map(project);
      return ROWS.map(project);
    });
  });

  it("the list response carries class, bucket, attention and trialDaysLeft per row, and per-tab counts in meta (red on master: no class key, no counts)", async () => {
    const res = await request(app.getHttpServer()).get("/platform-admin/tenants").expect(200);
    const byId = Object.fromEntries(res.body.data.map((r: any) => [r.id, r]));
    expect(byId["t-paying"]).toMatchObject({
      class: "PRODUCTION",
      bucket: "paying",
      attention: [],
      trialDaysLeft: null,
    });
    expect(byId["t-test"]).toMatchObject({ class: "TEST", bucket: "test_demo", attention: [] });
    expect(res.body.meta.bucketCounts).toMatchObject({ paying: 1, test_demo: 1, trial: 0 });
    expect(res.body.meta.attentionCount).toBe(0);
  });

  it("?bucket=paying returns only the paying row (red on master: the param was ignored)", async () => {
    const res = await request(app.getHttpServer())
      .get("/platform-admin/tenants?bucket=paying")
      .expect(200);
    expect(res.body.data.map((r: any) => r.id)).toEqual(["t-paying"]);
    expect(res.body.meta.total).toBe(1);
  });

  it("?bucket=nope is a 400 and reads nothing", async () => {
    await request(app.getHttpServer()).get("/platform-admin/tenants?bucket=nope").expect(400);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("limit 200 is fine; 201 is a 400 and reads nothing", async () => {
    await request(app.getHttpServer()).get("/platform-admin/tenants?limit=200").expect(200);
    findMany.mockClear();
    await request(app.getHttpServer()).get("/platform-admin/tenants?limit=201").expect(400);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("?attention=1 filters to the businesses with a reason", async () => {
    const res = await request(app.getHttpServer())
      .get("/platform-admin/tenants?attention=1")
      .expect(200);
    expect(res.body.data).toEqual([]);
  });

  it("the list row's subscription has exactly today's four keys (the classifier columns never ride on the wire)", async () => {
    const res = await request(app.getHttpServer()).get("/platform-admin/tenants").expect(200);
    for (const r of res.body.data.filter((x: any) => x.subscription)) {
      expect(Object.keys(r.subscription).sort()).toEqual(
        ["cancelAtPeriodEnd", "currentPlan", "periodEnd", "planKey"].sort(),
      );
    }
  });

  it("the detail response carries the same four fields", async () => {
    const res = await request(app.getHttpServer())
      .get("/platform-admin/tenants/t-paying")
      .expect(200);
    expect(res.body).toMatchObject({
      id: "t-paying",
      class: "PRODUCTION",
      bucket: "paying",
      attention: [],
      trialDaysLeft: null,
    });
  });
});
