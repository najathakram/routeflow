import "reflect-metadata";
import { BadRequestException } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { AiUsageAdminController } from "./ai-usage-admin.controller";
import { AiUsageAdminService, parseUsageMonth } from "./ai-usage-admin.service";
import { effectiveCapUsd, estimateSpendUsd } from "./platform-config.service";

// AI limits PR-2: the super-admin usage view. Money is estimated by the same helper the cap check uses, and the cap shown
// is the one enforced (`effectiveCapUsd`, shared with `monthlyCapUsdFor`).

const MODEL = "claude-sonnet-5-5";
const usd = (inTok: number, outTok: number) =>
  Math.round(estimateSpendUsd([{ model: MODEL, inTok, outTok }]) * 100) / 100;

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

describe("AiUsageAdminController", () => {
  it("is super admin only (class-level guards) and is one read-only GET at ai-usage/by-business", () => {
    expect(Reflect.getMetadata("__guards__", AiUsageAdminController)).toEqual([
      JwtAuthGuard,
      SuperAdminGuard,
    ]);
    const p = AiUsageAdminController.prototype;
    expect(Reflect.getMetadata("path", p.byBusiness)).toBe("ai-usage/by-business");
    expect(Reflect.getMetadata("method", p.byBusiness)).toBe(0); // RequestMethod.GET
    const svc = { byBusiness: jest.fn().mockResolvedValue({ month: "2026-11" }) };
    void new AiUsageAdminController(svc as any).byBusiness("2026-11");
    expect(svc.byBusiness).toHaveBeenCalledWith("2026-11");
  });
});
