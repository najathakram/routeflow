import * as fs from "fs";
import * as path from "path";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { planDisplayName } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { assertSelfServePlanDef, repinForSelfCheckoutTx } from "./self-checkout-plan-pin";

/**
 * SA-1547 PR-5: the plan pin a card-first checkout takes before it opens a session. R7 (only a self-serve key in the
 * PUBLISHED catalog), R12 (a quoted fee never moves), and R9 (it writes the plan and the pin and nothing else).
 */
const def = (planKey: string, monthlyPrice: number, extra: Record<string, unknown> = {}) => ({
  planKey,
  name: planKey,
  monthlyPrice,
  isCustom: false,
  ...extra,
});
const VERSION = {
  id: "v14",
  definitions: [
    def("LITE", 49),
    def("STARTER", 99),
    def("CORE", 199),
    def("ENTERPRISE", 0, { isCustom: true }),
    def("PLUS", 149), // published, but not on the ladder
  ],
  addonSkus: [],
} as any;

/** A transaction that holds ONLY the tables the pin may touch: any other write is a TypeError. */
function make(
  o: {
    sub?: Record<string, unknown> | null;
    tenantPlan?: string;
  } = {},
) {
  const ops: string[] = [];
  const sub = o.sub === undefined ? { planKey: "STARTER", priceOverrideMonthly: null } : o.sub;
  const tx = {
    $queryRaw: jest.fn(async () => {
      ops.push("lock");
      return [];
    }),
    tenant: {
      findUnique: jest.fn(async () => ({ plan: o.tenantPlan ?? "STARTER" })),
      updateMany: jest.fn(async () => {
        ops.push("tenant.pin");
        return { count: 1 };
      }),
    },
    tenantSubscription: {
      findUnique: jest.fn(async () => sub),
      upsert: jest.fn(async () => {
        ops.push("sub.upsert");
        return {};
      }),
      updateMany: jest.fn(async () => {
        ops.push("sub.pin");
        return { count: 1 };
      }),
    },
  };
  const prisma = { $transaction: jest.fn(async (fn: any) => fn(tx)) } as any;
  const catalog = { getPublishedCatalog: jest.fn(async () => VERSION) } as any;
  return { d: { prisma, catalog }, tx, prisma, ops };
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
    ["", "empty"],
  ])("%s (%s) is a 400 with the coded refusal", (planKey) => {
    let err: any;
    try {
      assertSelfServePlanDef(VERSION, planKey, API_ERROR_CODES.SELF_SERVE_PLAN_NOT_ALLOWED);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.SELF_SERVE_PLAN_NOT_ALLOWED });
  });

  it("a self-serve key returns its published definition", () => {
    expect(assertSelfServePlanDef(VERSION, "CORE").monthlyPrice).toBe(199);
  });

  it("with no code it throws the plain-message 400s subscribe has always thrown", () => {
    const msg = (k: string) => {
      try {
        assertSelfServePlanDef(VERSION, k);
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
  });
});

describe("R7: subscribe and the checkout pick share ONE copy of the rule", () => {
  const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");

  it("subscribeLocked calls assertSelfServePlanDef and holds no copy of its checks", () => {
    const src = read("subscription-mutation.service.ts");
    const i = src.indexOf("private async subscribeLocked(");
    const body = src.slice(i, i + 1500);
    expect(body).toContain("assertSelfServePlanDef(version, input.planKey)");
    expect(body).not.toMatch(/Unknown plan|isCustom|isInviteOnlyPlanKey|OFF_LADDER/);
  });

  it("the re-pin calls the same check, with the coded refusal", () => {
    expect(read("self-checkout-plan-pin.ts")).toMatch(
      /assertSelfServePlanDef\([^)]*API_ERROR_CODES\.SELF_SERVE_PLAN_NOT_ALLOWED/,
    );
  });
});

describe("R7: repinForSelfCheckoutTx refuses a bad key before any transaction", () => {
  it.each(["LITE", "ENTERPRISE", "PLUS", "NOPE"])("%s opens no transaction", async (planKey) => {
    const h = make();
    const err = await rejection(repinForSelfCheckoutTx(h.d, "t1", planKey));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.SELF_SERVE_PLAN_NOT_ALLOWED });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("R8 / R9: the re-pin writes the plan, the snapshot and the pin, and nothing else", () => {
  it("moves STARTER to CORE: key, enum, CORE's catalog price, then both pins, under the tenant row lock", async () => {
    const h = make();
    const out = await repinForSelfCheckoutTx(h.d, "t1", "CORE");
    expect(out).toEqual({ planKey: "CORE", planName: planDisplayName("CORE"), changed: true });
    expect(h.tx.tenantSubscription.upsert).toHaveBeenCalledTimes(1);
    expect((h.tx.tenantSubscription.upsert.mock.calls[0] as any[])[0].update).toEqual({
      planKey: "CORE",
      currentPlan: "CORE",
      basePriceSnapshot: 199,
    });
    expect(h.tx.tenantSubscription.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "t1" },
      data: { planVersionId: "v14" },
    });
    expect(h.tx.tenant.updateMany).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { planVersionId: "v14" },
    });
    // the Tenant row lock first, the plan write before the pin
    expect(h.ops).toEqual(["lock", "sub.upsert", "sub.pin", "tenant.pin"]);
  });

  it("takes no advisory lock, makes no Stripe call and touches no add-on, event or status", () => {
    const src = fs.readFileSync(path.join(__dirname, "self-checkout-plan-pin.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const banned of [
      "withAdvisoryLock",
      "underSlotLock",
      "underTenantPriceLock",
      "transitionToActiveTx",
      "trialConvertedAt",
      "TRIAL_CONVERTED",
      "PLAN_CHANGED",
      "planChangeNoCard",
      "tenantAddon",
      "billingEvent",
      "emit(",
      "stripe",
      "status:",
    ]) {
      expect(code).not.toContain(banned);
    }
  });

  it("the same plan as now is a no-op: no write, no pin", async () => {
    const h = make({ sub: { planKey: "STARTER", priceOverrideMonthly: null } });
    const out = await repinForSelfCheckoutTx(h.d, "t1", "STARTER");
    expect(out).toMatchObject({ planKey: "STARTER", changed: false });
    expect(h.ops).toEqual(["lock"]);
  });

  it("a row with no plan key reads the tenant's plan as the current one", async () => {
    const h = make({ sub: { planKey: null, priceOverrideMonthly: null }, tenantPlan: "CORE" });
    expect((await repinForSelfCheckoutTx(h.d, "t1", "CORE")).changed).toBe(false);
    expect(h.ops).toEqual(["lock"]);
  });
});

describe("R12: a quoted fee is never moved by a plan pick", () => {
  const quoted = { planKey: "STARTER", priceOverrideMonthly: "150.00" };

  it("another plan is a coded 409 and nothing is written", async () => {
    const h = make({ sub: quoted });
    const err = await rejection(repinForSelfCheckoutTx(h.d, "t1", "CORE"));
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: API_ERROR_CODES.CUSTOM_FEE_PLAN_PICK_REFUSED,
      message: "Your plan has a quoted price. Ask us to change it.",
    });
    expect(h.ops).toEqual(["lock"]);
  });

  it("the plan it is on now proceeds as a no-op", async () => {
    const h = make({ sub: quoted });
    expect(await repinForSelfCheckoutTx(h.d, "t1", "STARTER")).toMatchObject({ changed: false });
    expect(h.ops).toEqual(["lock"]);
  });
});
