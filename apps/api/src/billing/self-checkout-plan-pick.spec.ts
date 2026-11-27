import * as fs from "fs";
import * as path from "path";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { planDisplayName } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { assertSelfServePlanDef, pickSessionTerms, readPickTerms } from "./self-checkout-plan-pick";

/**
 * SA-1547 PR-5 (SA-1319 R1 / R1a): the READS a card-first pick makes. R7 (only a self-serve key in the PUBLISHED catalog),
 * R12 (a quoted fee), LITE (takes no planKey), and the terms the offer is built from. Nothing here can write: the fake
 * Prisma holds one read.
 */
const def = (planKey: string, monthlyPrice: number, extra: Record<string, unknown> = {}) => ({
  planKey,
  name: planKey,
  monthlyPrice,
  isCustom: false,
  ...extra,
});
const PUBLISHED = {
  id: "v14",
  definitions: [
    def("LITE", 49),
    def("STARTER", 99),
    def("CORE", 199),
    def("GROWTH", 299),
    def("ENTERPRISE", 0, { isCustom: true }),
    def("PLUS", 149), // published, but not on the ladder
  ],
  addonSkus: [],
} as any;

function make(
  o: { tenant?: Record<string, unknown> | null; sub?: Record<string, unknown> | null } = {},
) {
  const sub =
    o.sub === undefined
      ? { planKey: "STARTER", planVersionId: "v13", priceOverrideMonthly: null }
      : o.sub;
  const prisma = {
    tenant: {
      findUnique: jest.fn(async () =>
        o.tenant === null
          ? null
          : { plan: "STARTER", planVersionId: null, subscription: sub, ...o.tenant },
      ),
    },
  } as any;
  const catalog = {
    getPublishedCatalog: jest.fn(async () => PUBLISHED),
    getVersionForTenant: jest.fn(async (id: string | null) => ({
      ...PUBLISHED,
      id: id ?? PUBLISHED.id,
    })),
  } as any;
  return { d: { prisma, catalog }, prisma, catalog };
}
const rejection = (p: Promise<unknown>): Promise<any> =>
  p.then(
    () => undefined,
    (e) => e,
  );

describe("R7: assertSelfServePlanDef is the ONE published-catalog check", () => {
  it.each([
    ["LITE", "invite-only"],
    ["ENTERPRISE", "custom"],
    ["PLUS", "off the ladder"],
    ["NOPE", "unknown"],
  ])("%s (%s) is a 400 with the coded refusal", (planKey) => {
    let err: any;
    try {
      assertSelfServePlanDef(PUBLISHED, planKey, API_ERROR_CODES.SELF_SERVE_PLAN_NOT_ALLOWED);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.SELF_SERVE_PLAN_NOT_ALLOWED });
  });

  it("with no code it throws the plain-message 400s subscribe has always thrown", () => {
    const msg = (k: string) => {
      try {
        assertSelfServePlanDef(PUBLISHED, k);
      } catch (e) {
        expect((e as BadRequestException).getResponse()).not.toHaveProperty("code");
        return (e as BadRequestException).message;
      }
    };
    expect(msg("NOPE")).toBe('Unknown plan "NOPE"');
    expect(msg("ENTERPRISE")).toBe("Enterprise is a custom plan — contact sales.");
    expect(msg("LITE")).toBe(
      `The ${planDisplayName("LITE")} plan is available by invitation only — contact us.`,
    );
    expect(msg("PLUS")).toBe("This plan can't be chosen here — contact support.");
    expect(assertSelfServePlanDef(PUBLISHED, "CORE").monthlyPrice).toBe(199);
  });

  it("subscribe and the pick share ONE copy: subscribeLocked calls it and holds no copy", () => {
    const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");
    const src = read("subscription-mutation.service.ts");
    const body = src
      .slice(src.indexOf("private async subscribeLocked("), src.length)
      .slice(0, 1500);
    expect(body).toContain("assertSelfServePlanDef(version, input.planKey)");
    expect(body).not.toMatch(/Unknown plan|isCustom|isInviteOnlyPlanKey|OFF_LADDER/);
    expect(read("self-checkout-plan-pick.ts")).toMatch(
      /assertSelfServePlanDef\(\s*published,\s*planKey,\s*API_ERROR_CODES\.SELF_SERVE_PLAN_NOT_ALLOWED/,
    );
  });
});

describe("readPickTerms: what the offer is built from (reads only)", () => {
  it("a different plan is offered at its PUBLISHED version and price", async () => {
    const h = make();
    expect(await readPickTerms(h.d, "t1", "CORE")).toEqual({
      planKey: "CORE",
      planName: planDisplayName("CORE"),
      planVersionId: "v14",
      sameAsPinned: false,
      monthly: 199,
    });
  });

  it("the plan the business is on stays on its PINNED version (a price lock is honoured)", async () => {
    const h = make({ sub: { planKey: "CORE", planVersionId: "v13", priceOverrideMonthly: null } });
    const out = await readPickTerms(h.d, "t1", "CORE");
    expect(out).toMatchObject({ sameAsPinned: true, planVersionId: "v13", monthly: null });
    expect(h.catalog.getVersionForTenant).toHaveBeenCalledWith("v13");
  });

  it("a row with no plan key reads the tenant's plan as the current one", async () => {
    const h = make({
      sub: { planKey: null, planVersionId: null, priceOverrideMonthly: null },
      tenant: { plan: "CORE" },
    });
    expect((await readPickTerms(h.d, "t1", "CORE")).sameAsPinned).toBe(true);
  });

  it.each(["LITE", "ENTERPRISE", "NOPE"])(
    "%s is refused before the tenant is even read",
    async (k) => {
      const h = make();
      const err = await rejection(readPickTerms(h.d, "t1", k));
      expect(err.getResponse()).toMatchObject({
        code: API_ERROR_CODES.SELF_SERVE_PLAN_NOT_ALLOWED,
      });
      expect(h.prisma.tenant.findUnique).not.toHaveBeenCalled();
    },
  );

  it("an invited LITE business takes no planKey at all: a coded 400", async () => {
    const h = make({
      sub: { planKey: "LITE", planVersionId: "v13", priceOverrideMonthly: null },
      tenant: { plan: "LITE" },
    });
    const err = await rejection(readPickTerms(h.d, "t1", "STARTER"));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.SELF_SERVE_PLAN_NOT_ALLOWED });
  });

  it("R12: a quoted fee may pick only the plan it is on; another plan is a coded 409", async () => {
    const quoted = { planKey: "STARTER", planVersionId: "v13", priceOverrideMonthly: "150.00" };
    const err = await rejection(readPickTerms(make({ sub: quoted }).d, "t1", "CORE"));
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: API_ERROR_CODES.CUSTOM_FEE_PLAN_PICK_REFUSED,
    });
    expect(await readPickTerms(make({ sub: quoted }).d, "t1", "STARTER")).toMatchObject({
      sameAsPinned: true,
    });
  });

  it("a missing business is a 404", async () => {
    expect(await rejection(readPickTerms(make({ tenant: null }).d, "t1", "CORE"))).toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("pickSessionTerms: what completion reads off a session", () => {
  const meta = { planKey: "CORE", selfPick: "1", planVersionId: "v14", quotedMonthly: "199" };
  it("a pick session yields its paid terms", () => {
    expect(pickSessionTerms(meta)).toEqual({ planKey: "CORE", planVersionId: "v14", monthly: 199 });
  });
  it.each([
    ["a bodyless session", { planKey: "CORE" }],
    ["no version", { ...meta, planVersionId: undefined }],
    ["no price", { ...meta, quotedMonthly: undefined }],
    ["a bad price", { ...meta, quotedMonthly: "abc" }],
  ])("%s is not a pick", (_n, m) => {
    expect(pickSessionTerms(m as any)).toBeNull();
  });
});
