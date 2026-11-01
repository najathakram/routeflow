/**
 * W1 (F10 to F16c, F17, F18, F18b, F20): the first question's service, over mocks at the module boundary. The planner and
 * the apply sequence have their own specs (business-capabilities.first-run.spec.ts, the platform-admin controller specs);
 * this one proves the ORDER and the GATES around them: marker read inside the lock, cache dropped first, fills blanks,
 * marker written last, a refused or failed apply leaves the marker open.
 */
import "reflect-metadata";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { FirstRunService, parseFirstRunAnswer } from "./first-run.service";
import { NO_IMPERSONATION_KEY } from "../auth/guards/no-impersonation.guard";
import { SettingsFulfilmentController } from "./settings-fulfilment.controller";

const TENANT = "tenant-1";
const user = {
  sub: "u-admin",
  tenantId: TENANT,
  tenantSlug: "acme-trial",
  role: "TENANT_ADMIN",
} as JwtPayload;

const blankPlan = {
  billing: [],
  overrides: [{ featureKey: "order_delivery", effect: "GRANT", action: "skip" }],
  comps: [],
  modes: [{ key: "fulfilment_model", from: "unset", to: "ship" }],
};
const changedPlan = {
  ...blankPlan,
  modes: [{ key: "fulfilment_model", from: "ship", to: "delivery" }],
};

function build(
  opts: { marker?: string | null; plan?: unknown; applyFails?: Error; status?: string } = {},
) {
  const calls: string[] = [];
  const marker = { value: opts.marker === undefined ? "pending" : opts.marker };
  const prisma = {
    getTenantId: () => TENANT,
    tenant: {
      findUnique: jest.fn(async () => ({ slug: "acme-trial", status: opts.status ?? "TRIAL" })),
    },
    order: { findFirst: jest.fn(async () => null) },
    systemConfig: {
      findUnique: jest.fn(async () => (marker.value ? { value: marker.value } : null)),
      updateMany: jest.fn(async ({ where, data }: any) => {
        calls.push(`close:${data.value}`);
        if (marker.value !== where.value) return { count: 0 };
        marker.value = data.value;
        return { count: 1 };
      }),
    },
  };
  const featureConfig = { forgetCachedModes: jest.fn(() => calls.push("forget")) };
  const businessProfiles = {
    withConfirmLock: jest.fn(async (_id: string, fn: () => Promise<unknown>) => {
      calls.push("lock");
      return fn();
    }),
    planFirstRun: jest.fn(async () => {
      calls.push("plan");
      return { plan: opts.plan ?? blankPlan };
    }),
    capabilities: jest.fn(async () => ({ delivery: false, shipping: true, counter: false })),
  };
  const applyService = {
    applyResolvedLocked: jest.fn(async (...args: unknown[]) => {
      calls.push("apply");
      if (opts.applyFails) throw opts.applyFails;
      return { plan: opts.plan ?? blankPlan, changed: [], summary: [], args };
    }),
  };
  const audit = { log: jest.fn(async () => undefined) };
  const svc = new FirstRunService(
    prisma as never,
    featureConfig as never,
    businessProfiles as never,
    applyService as never,
    audit as never,
  );
  return { svc, calls, marker, prisma, applyService, audit, featureConfig, businessProfiles };
}

describe("parseFirstRunAnswer (F10, F15)", () => {
  it("accepts the three ticks and fills the rest with false", () => {
    expect(parseFirstRunAnswer({ shipping: true })).toEqual({
      delivery: false,
      shipping: true,
      counter: false,
    });
  });

  it.each([[{}], [{ delivery: false, shipping: false, counter: false }]])(
    "F10: nothing ticked is FIRST_RUN_EMPTY (%j)",
    (body) => {
      expect(() => parseFirstRunAnswer(body)).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: API_ERROR_CODES.FIRST_RUN_EMPTY }),
        }),
      );
    },
  );

  it.each([
    [{ delivery: true, doorPayments: true }],
    [{ delivery: true, opensAs: "counter" }],
    [{ delivery: "yes" }],
    [{ delivery: 1 }],
    [null],
    [[]],
    ["delivery"],
  ])("F15: %j is FIRST_RUN_INVALID, so door payments and opens-as can never ride along", (body) => {
    expect(() => parseFirstRunAnswer(body)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: API_ERROR_CODES.FIRST_RUN_INVALID }),
      }),
    );
  });
});

describe("FirstRunService.answer", () => {
  it("applies a blank-filling plan: marker read in the lock, cache dropped first, marker written last (F11, F30)", async () => {
    const t = build();
    const res = await t.svc.answer({ shipping: true }, user);
    expect(res).toEqual({ outcome: "applied", state: "answered" });
    expect(t.calls).toEqual(["lock", "forget", "plan", "apply", "close:answered"]);
    expect(t.marker.value).toBe("answered");
  });

  it("F18: the apply runs as the tenant's own admin under the signup.setup source, with the plan's own fingerprint", async () => {
    const t = build();
    await t.svc.answer({ shipping: true }, user);
    const [id, , dto, actor] = t.applyService.applyResolvedLocked.mock.calls[0] as unknown as [
      string,
      unknown,
      { planFingerprint: string },
      unknown,
    ];
    expect(id).toBe(TENANT);
    expect(dto.planFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(actor).toEqual({ id: "u-admin", kind: "TENANT_USER", source: "signup.setup" });
  });

  it("F18: its audit rows are tenant rows, never flagged platformAdmin", async () => {
    const t = build();
    await t.svc.answer({ shipping: true }, user);
    const io = (t.applyService.applyResolvedLocked.mock.calls[0] as unknown[])[4] as {
      audit: (a: string, d: Record<string, unknown>) => Promise<void>;
    };
    await io.audit("BUSINESS_PROFILE_APPLIED", { summary: [] });
    expect(t.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        userId: "u-admin",
        action: "BUSINESS_PROFILE_APPLIED",
        meta: { summary: [] },
      }),
    );
    expect(JSON.stringify(t.audit.log.mock.calls)).not.toContain("platformAdmin");
  });

  it("the tenant path hands the apply helpers that throw: fills blanks means they are never reached", async () => {
    const t = build();
    await t.svc.answer({ shipping: true }, user);
    const io = (t.applyService.applyResolvedLocked.mock.calls[0] as unknown[])[4] as Record<
      string,
      (...a: unknown[]) => Promise<unknown>
    >;
    await expect(io.disableAddon("order_delivery")).rejects.toThrow(/unreachable/);
    await expect(io.createOverride({})).rejects.toThrow(/unreachable/);
    await expect(io.revokeOverride("x")).rejects.toThrow(/unreachable/);
  });

  it.each([[null], ["answered"], ["closed"]])(
    "F11 / F14: a marker of %s is a 409 FIRST_RUN_CLOSED and nothing is planned or written",
    async (state) => {
      const t = build({ marker: state });
      await expect(t.svc.answer({ shipping: true }, user)).rejects.toMatchObject({
        response: { code: API_ERROR_CODES.FIRST_RUN_CLOSED },
      });
      expect(t.calls).toEqual(["lock"]);
      expect(t.applyService.applyResolvedLocked).not.toHaveBeenCalled();
    },
  );

  it("F16: a plan that is not a blank writes only the marker (closed), tells the audit trail, and applies nothing", async () => {
    const t = build({ plan: changedPlan });
    const res = await t.svc.answer({ delivery: true }, user);
    expect(res).toEqual({ outcome: "kept", state: "closed" });
    expect(t.applyService.applyResolvedLocked).not.toHaveBeenCalled();
    expect(t.marker.value).toBe("closed");
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "FIRST_RUN_KEPT" }));
  });

  it("F16: a plan that stops billing, or changes an override, is not a blank either", async () => {
    for (const plan of [
      {
        ...blankPlan,
        billing: [{ featureKey: "order_delivery", action: "disable", manual: false }],
      },
      {
        ...blankPlan,
        overrides: [{ featureKey: "order_delivery", effect: "DENY", action: "create" }],
      },
    ]) {
      const t = build({ plan });
      expect((await t.svc.answer({ shipping: true }, user)).outcome).toBe("kept");
      expect(t.applyService.applyResolvedLocked).not.toHaveBeenCalled();
    }
  });

  it("F16c / F17: an apply that throws leaves the marker open, and the same answer can be sent again", async () => {
    const t = build({ applyFails: new Error("carrier in transit") });
    await expect(t.svc.answer({ shipping: true }, user)).rejects.toThrow("carrier in transit");
    expect(t.marker.value).toBe("pending");
    expect(t.calls).not.toContain("close:answered");
  });

  it("a user of another tenant is refused before anything is read", async () => {
    const t = build();
    await expect(
      t.svc.answer({ shipping: true }, { ...user, tenantId: "other" } as JwtPayload),
    ).rejects.toMatchObject({ response: { code: API_ERROR_CODES.FULFILMENT_TENANT_MISMATCH } });
    expect(t.calls).toEqual([]);
  });

  it("a malformed body is refused before the lock is taken", async () => {
    const t = build();
    await expect(t.svc.answer({ doorPayments: true }, user)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.FIRST_RUN_INVALID },
    });
    expect(t.calls).toEqual([]);
  });
});

describe("FirstRunService.status", () => {
  it("F14: an account with no marker has no card, and nothing else is read", async () => {
    const t = build({ marker: null });
    expect(await t.svc.status(user)).toMatchObject({ state: null, workspaceId: "acme-trial" });
    expect(t.businessProfiles.capabilities).not.toHaveBeenCalled();
  });

  it("F12: a read-only account has no card", async () => {
    const t = build({ status: "READ_ONLY" });
    expect((await t.svc.status(user)).state).toBeNull();
  });

  it("F12b: an ACTIVE account (it picked a plan first) with a pending marker still gets the card", async () => {
    const t = build({ status: "ACTIVE" });
    expect(await t.svc.status(user)).toMatchObject({
      state: "pending",
      shipping: true,
      hasOrder: false,
    });
  });

  it("carries the Workspace ID and whether a first order exists, for the next steps", async () => {
    const t = build({ marker: "answered" });
    (t.prisma.order.findFirst as jest.Mock).mockResolvedValueOnce({ id: "o1" });
    expect(await t.svc.status(user)).toMatchObject({
      state: "answered",
      workspaceId: "acme-trial",
      hasOrder: true,
    });
  });
});

describe("the routes (F13, F18b)", () => {
  const meta = (key: string, method: string) =>
    Reflect.getMetadata(key, (SettingsFulfilmentController.prototype as any)[method]);

  it("F13: both routes are TENANT_ADMIN only (an operator or driver is a 403)", () => {
    expect(meta("roles", "firstRunStatus")).toEqual(["TENANT_ADMIN"]);
    expect(meta("roles", "firstRunAnswer")).toEqual(["TENANT_ADMIN"]);
  });

  it("F18b: the answer refuses a platform admin impersonating, as the billing routes do", () => {
    expect(meta(NO_IMPERSONATION_KEY, "firstRunAnswer")).toBe("billing");
  });
});
