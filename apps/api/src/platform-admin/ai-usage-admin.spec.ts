import "reflect-metadata";
import { BadRequestException, type INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule, JwtService } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { Test } from "@nestjs/testing";
import { roundMoney } from "@routeflow/pricing";
import { JwtStrategy } from "../auth/strategies/jwt.strategy";
import { listenOnLoopback } from "../common/testing/listen-loopback";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { AiUsageAdminController } from "./ai-usage-admin.controller";
import { AiUsageAdminService, parseUsageMonth } from "./ai-usage-admin.service";
import { effectiveCapUsd, estimateSpendUsd } from "./platform-config.service";

// AI limits PR-2: the super-admin usage view. Money is estimated by the same helper the cap check uses, and the cap shown
// is the one enforced (`effectiveCapUsd`, shared with `monthlyCapUsdFor`).

// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require("supertest");

const MODEL = "claude-sonnet-5-5";
const rawUsd = (inTok: number, outTok: number) =>
  estimateSpendUsd([{ model: MODEL, inTok, outTok }]);
const usd = (inTok: number, outTok: number) => roundMoney(rawUsd(inTok, outTok));

function make(platformCap: number, spendRows: object[], tenants: object[]) {
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue(spendRows),
    tenant: { findMany: jest.fn().mockResolvedValue(tenants) },
  };
  const config = { platformMonthlyCapUsd: jest.fn().mockResolvedValue(platformCap) };
  return { svc: new AiUsageAdminService(prisma as any, config as any), prisma };
}

describe("effectiveCapUsd", () => {
  it("platform 0 is the kill switch and beats any override; else a usable override; else the platform value", () => {
    expect(effectiveCapUsd(0, 50)).toBe(0);
    expect(effectiveCapUsd(10, 50)).toBe(50);
    expect(effectiveCapUsd(10, 0)).toBe(0);
    for (const bad of [null, undefined, -1, 2.5, Number.NaN])
      expect(effectiveCapUsd(10, bad)).toBe(10);
  });
});

describe("parseUsageMonth", () => {
  const now = new Date("2026-11-30T23:59:59.999Z");

  it("defaults to the UTC month `now` falls in, and reads YYYY-MM as UTC month bounds", () => {
    expect(parseUsageMonth(undefined, now)).toMatchObject({ label: "2026-11" });
    const m = parseUsageMonth("2026-02", now);
    expect(m.start.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(m.end.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(parseUsageMonth("2026-12", now).end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("anything else is a 400", () => {
    for (const bad of ["2026-13", "2026-00", "11-2026", "2026-1", "latest"])
      expect(() => parseUsageMonth(bad, now)).toThrow(BadRequestException);
  });
});

describe("AiUsageAdminService.byBusiness", () => {
  const tenants = [
    { id: "t-default", name: "Default Co", aiMonthlyCapUsd: null },
    { id: "t-big", name: "Big Co", aiMonthlyCapUsd: 50 },
    { id: "t-off", name: "Off Co", aiMonthlyCapUsd: 0 },
    { id: "t-quiet", name: "Quiet Co", aiMonthlyCapUsd: null },
  ];
  const rows = [
    { tenantId: "t-default", model: MODEL, calls: 3, inTok: 1_000_000, outTok: 100_000 },
    { tenantId: "t-default", model: MODEL, calls: 1, inTok: 500_000, outTok: 0 },
    { tenantId: "t-big", model: MODEL, calls: 2, inTok: 2_000_000, outTok: 0 },
    { tenantId: "t-gone", model: MODEL, calls: 9, inTok: 9_000_000, outTok: 0 },
  ];

  it("lists every live business with spend, the cap that applies and the percent, largest spend first; a quiet business is $0", async () => {
    const { svc } = make(10, rows, tenants);
    const out = await svc.byBusiness("2026-11");
    expect(out).toMatchObject({ month: "2026-11", platformCapUsd: 10 });
    const by = Object.fromEntries(out.businesses.map((b) => [b.tenantId, b]));
    expect(by["t-default"]).toMatchObject({
      calls: 4,
      spendUsd: usd(1_500_000, 100_000),
      capUsd: 10,
      aiOff: false,
    });
    expect(by["t-default"].percentUsed).toBe(Math.round((usd(1_500_000, 100_000) / 10) * 100));
    expect(by["t-big"]).toMatchObject({ capUsd: 50, spendUsd: usd(2_000_000, 0) });
    expect(by["t-off"]).toMatchObject({ capUsd: 0, aiOff: true, percentUsed: null, spendUsd: 0 });
    expect(by["t-quiet"]).toMatchObject({ calls: 0, spendUsd: 0, percentUsed: 0 });
    expect(by["t-gone"]).toBeUndefined(); // a row for a business that no longer exists is not listed
    expect(out.businesses.map((b) => b.tenantId)).toEqual([
      "t-big",
      "t-default",
      "t-off",
      "t-quiet",
    ]);
  });

  it("the platform kill switch shows every business as AI off, whatever its override", async () => {
    const { svc } = make(0, rows, tenants);
    const out = await svc.byBusiness();
    expect(out.businesses.every((b) => b.capUsd === 0 && b.aiOff && b.percentUsed === null)).toBe(
      true,
    );
  });

  it("sums the asked UTC month only: the query is bounded on both ends", async () => {
    const { svc, prisma } = make(10, [], tenants);
    await svc.byBusiness("2026-02");
    const values = prisma.$queryRaw.mock.calls[0].slice(1) as Date[];
    expect(values.map((d) => d.toISOString())).toEqual([
      "2026-02-01T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
    ]);
  });
});

describe("AiUsageAdminService.byBusiness: every figure and filter is pinned", () => {
  // 123_457 Sonnet output tokens = $1.23457: more than two decimals, so rounding and the percent are both observable
  const RESIDUE = { inTok: 0, outTok: 123_457 };

  it("spendUsd is rounded to cents once (roundMoney); the percent is a whole number from the unrounded spend", async () => {
    expect(rawUsd(0, RESIDUE.outTok)).not.toBe(usd(0, RESIDUE.outTok)); // the fixture really has residue
    expect(usd(0, RESIDUE.outTok)).toBe(1.23);
    const { svc } = make(
      10,
      [{ tenantId: "t-a", model: MODEL, calls: 1, ...RESIDUE }],
      [{ id: "t-a", name: "A", aiMonthlyCapUsd: null }],
    );
    const [a] = (await svc.byBusiness("2026-11")).businesses;
    expect(a.spendUsd).toBe(1.23);
    expect(a.percentUsed).toBe(12); // 12.3457 %
  });

  it("the percent rounds to the nearest whole number, not down: 8.9 of 50 is 18", async () => {
    const { svc } = make(
      10,
      [{ tenantId: "t-a", model: MODEL, calls: 1, inTok: 0, outTok: 890_000 }],
      [{ id: "t-a", name: "A", aiMonthlyCapUsd: 50 }],
    );
    expect((await svc.byBusiness("2026-11")).businesses[0].percentUsed).toBe(18); // 17.8 %
  });

  it("a business over its limit shows its real percent, not a cap at 100", async () => {
    const { svc } = make(
      10,
      [{ tenantId: "t-a", model: MODEL, calls: 1, inTok: 0, outTok: 2_000_000 }],
      [{ id: "t-a", name: "A", aiMonthlyCapUsd: null }],
    );
    expect((await svc.byBusiness("2026-11")).businesses[0].percentUsed).toBe(200);
  });

  it("spend and calls add up across the models one business used", async () => {
    const { svc } = make(
      100,
      [
        { tenantId: "t-a", model: MODEL, calls: 2, inTok: 0, outTok: 1_000_000 },
        { tenantId: "t-a", model: "claude-haiku-5-5", calls: 5, inTok: 1_000_000, outTok: 0 },
      ],
      [{ id: "t-a", name: "A", aiMonthlyCapUsd: null }],
    );
    const expected = roundMoney(
      estimateSpendUsd([{ model: MODEL, inTok: 0, outTok: 1_000_000 }]) +
        estimateSpendUsd([{ model: "claude-haiku-5-5", inTok: 1_000_000, outTok: 0 }]),
    );
    const [a] = (await svc.byBusiness("2026-11")).businesses;
    expect(a.calls).toBe(7);
    expect(a.spendUsd).toBe(expected);
    expect(expected).toBeGreaterThan(usd(0, 1_000_000)); // the second model really adds
  });

  it("only live businesses are asked for (deletedAt: null); a usage row of any other business is dropped", async () => {
    const { svc, prisma } = make(
      10,
      [{ tenantId: "t-gone", model: MODEL, calls: 9, inTok: 9_000_000, outTok: 0 }],
      [{ id: "t-live", name: "Live", aiMonthlyCapUsd: null }],
    );
    const out = await svc.byBusiness("2026-11");
    expect(prisma.tenant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null } }),
    );
    expect(out.businesses.map((b) => b.tenantId)).toEqual(["t-live"]);
    expect(out.businesses[0]).toMatchObject({ calls: 0, spendUsd: 0 });
  });

  it("the larger spend comes first whatever the tenant order, and equal spend sorts by name", async () => {
    const { svc } = make(
      10,
      [{ tenantId: "t-m", model: MODEL, calls: 1, inTok: 0, outTok: 500_000 }],
      [
        { id: "t-z", name: "Zed", aiMonthlyCapUsd: null },
        { id: "t-a", name: "Alpha", aiMonthlyCapUsd: null },
        { id: "t-m", name: "Mid", aiMonthlyCapUsd: null },
      ],
    );
    expect((await svc.byBusiness("2026-11")).businesses.map((b) => b.name)).toEqual([
      "Mid",
      "Alpha",
      "Zed",
    ]);
  });
});

describe("AiUsageAdminController", () => {
  it("is one read-only GET at platform-admin/ai-usage/by-business with the platform-admin guards", () => {
    expect(Reflect.getMetadata("__guards__", AiUsageAdminController)).toEqual([
      JwtAuthGuard,
      SuperAdminGuard,
    ]);
    const p = AiUsageAdminController.prototype;
    expect(Reflect.getMetadata("path", p.byBusiness)).toBe("ai-usage/by-business");
    expect(Reflect.getMetadata("method", p.byBusiness)).toBe(0); // RequestMethod.GET
  });

  describe("over HTTP, with the real JwtStrategy, JwtAuthGuard and SuperAdminGuard", () => {
    const SECRET = "ai-usage-admin-spec-secret";
    let app: INestApplication;
    const svc = { byBusiness: jest.fn() };
    const token = (role: string, secret = SECRET) =>
      new JwtService({ secret }).sign({
        sub: "u-1",
        username: "u",
        role,
        status: "ACTIVE",
        tenantId: role === "SUPER_ADMIN" ? null : "t-1",
      });

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [PassportModule, JwtModule.register({ secret: SECRET })],
        controllers: [AiUsageAdminController],
        providers: [
          JwtStrategy,
          { provide: AiUsageAdminService, useValue: svc },
          {
            provide: ConfigService,
            useValue: { get: (k: string) => (k === "jwt" ? { secret: SECRET } : undefined) },
          },
        ],
      }).compile();
      moduleRef.get(JwtStrategy); // registers the strategy with passport
      app = moduleRef.createNestApplication({ logger: false });
      await listenOnLoopback(app);
    });
    afterAll(async () => {
      await app.close();
    });
    beforeEach(() => {
      svc.byBusiness.mockReset();
      svc.byBusiness.mockResolvedValue({ month: "2026-11", platformCapUsd: 10, businesses: [] });
    });

    const get = (auth?: string) => {
      const req = request(app.getHttpServer()).get(
        "/platform-admin/ai-usage/by-business?month=2026-11",
      );
      return auth ? req.set("Authorization", `Bearer ${auth}`) : req;
    };

    it("no token is 401 and the service is never called", async () => {
      expect((await get()).status).toBe(401);
      expect(svc.byBusiness).not.toHaveBeenCalled();
    });

    it("a token signed with another secret is 401", async () => {
      expect((await get(token("SUPER_ADMIN", "some-other-secret"))).status).toBe(401);
      expect(svc.byBusiness).not.toHaveBeenCalled();
    });

    it.each(["TENANT_ADMIN", "OPERATOR", "DRIVER"])("a signed %s token is 403", async (role) => {
      expect((await get(token(role))).status).toBe(403);
      expect(svc.byBusiness).not.toHaveBeenCalled();
    });

    it("a signed SUPER_ADMIN token reads the view and the month is passed through", async () => {
      const res = await get(token("SUPER_ADMIN"));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ month: "2026-11", platformCapUsd: 10 });
      expect(svc.byBusiness).toHaveBeenCalledWith("2026-11");
    });
  });
});
