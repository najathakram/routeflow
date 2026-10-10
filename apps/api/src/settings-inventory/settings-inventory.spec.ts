/**
 * WS9 Settings → Inventory & ordering: `GET/PATCH /settings/inventory` over the ONE policy writer.
 * Mocked PolicyService / PrismaService; the RolesGuard is the real one, run against the handler
 * metadata. The stored value is composed with `resolveOversellAllowed` through the real
 * PolicyOversellReader, so "what the admin saved" and "what a buyer order does" cannot drift.
 */
import "reflect-metadata";
import { BadRequestException, ForbiddenException, ValidationPipe } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { RolesGuard } from "../auth/guards/roles.guard";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { PolicyOversellReader } from "../orders/policy-oversell-reader";
import { resolveOversellAllowed } from "../orders/oversell-policy";
import { BUYER_BACKORDER_VISIBILITY_MODES, BUYER_OVERSELL_MODES } from "../policy/policy-registry";
import { SettingsInventoryController } from "./settings-inventory.controller";
import { UpdateInventorySettingsDto } from "./settings-inventory.dto";
import {
  INVENTORY_SETTINGS_DEFAULT_REASON,
  INVENTORY_SETTINGS_INVALID_MESSAGE,
  INVENTORY_VISIBILITY_INVALID_MESSAGE,
  SettingsInventoryService,
} from "./settings-inventory.service";

const admin = { sub: "u1", username: "admin", role: "TENANT_ADMIN", tenantId: "t1" } as JwtPayload;
const operator = { sub: "u2", username: "op", role: "OPERATOR", tenantId: "t1" } as JwtPayload;

/** In-memory stand-in for PolicyService: one TENANT value per tenant, default "off". */
const VISIBILITY_KEY = "orders.buyerBackorderVisibility";
function fakePolicies(
  initial?: string,
  active: Array<{ key: string; scopeType: string }> = [],
  initialVisibility?: string,
) {
  const store = new Map<string, unknown>();
  const visibility = new Map<string, unknown>();
  if (initial !== undefined) store.set("t1", initial);
  if (initialVisibility !== undefined) visibility.set("t1", initialVisibility);
  return {
    store,
    visibility,
    listActive: jest.fn(async () => active),
    resolve: jest.fn(async (tenantId: string, key: string) =>
      key === VISIBILITY_KEY
        ? (visibility.get(tenantId) ?? "show")
        : (store.get(tenantId) ?? "off"),
    ),
    set: jest.fn(async (p: { tenantId: string; key: string; value: unknown; [k: string]: any }) => {
      (p.key === VISIBILITY_KEY ? visibility : store).set(p.tenantId, p.value);
      return { id: "r1" };
    }),
  };
}

function build(
  opts: {
    tenantId?: string | null;
    initial?: string;
    initialVisibility?: string;
    active?: Array<{ key: string; scopeType: string }>;
  } = {},
) {
  const policies = fakePolicies(opts.initial, opts.active, opts.initialVisibility);
  const tenantId = opts.tenantId === undefined ? "t1" : opts.tenantId;
  const prisma = { getTenantId: jest.fn(() => tenantId) };
  const service = new SettingsInventoryService(policies as any, prisma as any);
  const controller = new SettingsInventoryController(service);
  return { policies, prisma, service, controller };
}

function ctxFor(handler: (...a: any[]) => any, user: Partial<JwtPayload>): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => SettingsInventoryController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

async function bodyOf(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return (e as { getResponse: () => unknown }).getResponse();
  }
  throw new Error("expected a rejection");
}

describe("settings/inventory roles (real RolesGuard)", () => {
  const guard = new RolesGuard(new Reflector());
  const can = (h: (...a: any[]) => any, u: JwtPayload) => guard.canActivate(ctxFor(h, u));
  const proto = SettingsInventoryController.prototype;

  it("GET: TENANT_ADMIN and OPERATOR may read", () => {
    expect(can(proto.get, admin)).toBe(true);
    expect(can(proto.get, operator)).toBe(true);
  });

  it("GET: CUSTOMER and DRIVER are refused, and the metadata is pinned to OPERATOR", () => {
    const customer = { sub: "u3", username: "c", role: "CUSTOMER", tenantId: "t1" } as JwtPayload;
    const driver = { sub: "u4", username: "d", role: "DRIVER", tenantId: "t1" } as JwtPayload;
    expect(can(proto.get, customer)).toBe(false);
    expect(can(proto.get, driver)).toBe(false);
    expect(Reflect.getMetadata("roles", proto.get)).toEqual([UserRole.OPERATOR]);
  });

  it("PATCH: TENANT_ADMIN only, OPERATOR is refused", () => {
    expect(can(proto.update, admin)).toBe(true);
    expect(can(proto.update, operator)).toBe(false);
    expect(Reflect.getMetadata("roles", proto.update)).toEqual([UserRole.TENANT_ADMIN]);
  });

  it("the controller route prefix is settings/inventory", () => {
    expect(Reflect.getMetadata("path", SettingsInventoryController)).toBe("settings/inventory");
  });
});

describe("GET /settings/inventory", () => {
  it.each([
    ["TENANT_ADMIN", admin],
    ["OPERATOR", operator],
  ])("%s gets the resolved TENANT value via the string-literal key", async (_n, user) => {
    const { controller, policies } = build({ initial: "backorder" });
    expect(await controller.get(user)).toEqual({
      buyerOversell: "backorder",
      buyerBackorderVisibility: "show",
      customerOverrides: 0,
    });
    expect(policies.resolve).toHaveBeenCalledWith("t1", "orders.buyerOversell", {});
  });

  it('is "off" when nothing is stored', async () => {
    const { controller } = build();
    expect(await controller.get(admin)).toEqual({
      buyerOversell: "off",
      buyerBackorderVisibility: "show",
      customerOverrides: 0,
    });
  });

  it("N2: customerOverrides counts only active CUSTOMER rows of THIS key", async () => {
    const { controller } = build({
      initial: "off",
      active: [
        { key: "orders.buyerOversell", scopeType: "CUSTOMER" },
        { key: "orders.buyerOversell", scopeType: "CUSTOMER" },
        { key: "orders.buyerOversell", scopeType: "TENANT" },
        { key: "email.staffOrderMode", scopeType: "CUSTOMER" },
      ],
    });
    expect(await controller.get(admin)).toEqual({
      buyerOversell: "off",
      buyerBackorderVisibility: "show",
      customerOverrides: 2,
    });
  });

  it("N2: the PATCH response carries the count too", async () => {
    const { controller } = build({
      active: [{ key: "orders.buyerOversell", scopeType: "CUSTOMER" }],
    });
    expect(await controller.update({ buyerOversell: "backorder" } as never, admin)).toEqual({
      buyerOversell: "backorder",
      buyerBackorderVisibility: "show",
      customerOverrides: 1,
    });
  });

  it('never returns anything but "off" | "backorder" (a corrupt resolved value fails closed)', async () => {
    const { controller, policies } = build();
    policies.resolve.mockResolvedValueOnce("Backorder" as never);
    expect(await controller.get(admin)).toEqual({
      buyerOversell: "off",
      buyerBackorderVisibility: "show",
      customerOverrides: 0,
    });
  });
});

describe("PATCH /settings/inventory", () => {
  it("off → backorder: one set(), TENANT scope, the registry key, the value, a reason, the actor", async () => {
    const { controller, policies } = build();
    const res = await controller.update({ buyerOversell: "backorder" }, {
      ...admin,
      impersonatedBy: "sa1",
    } as JwtPayload);
    expect(policies.set).toHaveBeenCalledTimes(1);
    expect(policies.set).toHaveBeenCalledWith({
      tenantId: "t1",
      key: "orders.buyerOversell",
      scopeType: "TENANT",
      scopeId: null,
      value: "backorder",
      reason: INVENTORY_SETTINGS_DEFAULT_REASON,
      actor: { id: "u1", name: "admin", impersonatedBy: "sa1" },
    });
    expect(res).toEqual({
      buyerOversell: "backorder",
      buyerBackorderVisibility: "show",
      customerOverrides: 0,
    });
  });

  it("a client reason is trimmed and used; blank falls back to the fixed reason", async () => {
    const { controller, policies } = build();
    await controller.update({ buyerOversell: "off", reason: "  pilot ends  " }, admin);
    expect(policies.set.mock.calls[0][0].reason).toBe("pilot ends");
    await controller.update({ buyerOversell: "off", reason: "   " }, admin);
    expect(policies.set.mock.calls[1][0].reason).toBe(INVENTORY_SETTINGS_DEFAULT_REASON);
  });

  it("a reason over 500 characters is a 400, nothing written", async () => {
    const { controller, policies } = build();
    const body = await bodyOf(
      controller.update({ buyerOversell: "off", reason: "x".repeat(501) }, admin),
    );
    expect(body.code).toBe(API_ERROR_CODES.INVENTORY_SETTING_INVALID);
    expect(body.details).toEqual({ field: "reason" });
    expect(policies.set).not.toHaveBeenCalled();
  });

  it.each([["yes"], ["BACKORDER"], ["Off"], [null], [1], [true], [undefined], [["off"]]])(
    "garbage buyerOversell %p is a 400 INVENTORY_SETTING_INVALID, set() never called",
    async (v) => {
      const { controller, policies } = build();
      const err = await controller.update({ buyerOversell: v } as never, admin).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual({
        statusCode: 400,
        code: "INVENTORY_SETTING_INVALID",
        message: INVENTORY_SETTINGS_INVALID_MESSAGE,
        details: { field: "buyerOversell" },
      });
      expect(policies.set).not.toHaveBeenCalled();
    },
  );

  it.each([[undefined], [null], ["backorder"], [[]]])(
    "body %p is a 400, set() never called",
    async (b) => {
      const { controller, policies } = build();
      const err = await controller.update(b as never, admin).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse().code).toBe(API_ERROR_CODES.INVENTORY_SETTING_INVALID);
      expect(policies.set).not.toHaveBeenCalled();
    },
  );

  it("a non-string reason is a 400 on field reason, set() never called", async () => {
    const { controller, policies } = build();
    const err = await controller
      .update({ buyerOversell: "backorder", reason: 123 } as never, admin)
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().details).toEqual({ field: "reason" });
    expect(policies.set).not.toHaveBeenCalled();
  });

  it("extra body fields are ignored (a body tenantId never picks the tenant)", async () => {
    const { controller, policies } = build();
    await controller.update(
      {
        buyerOversell: "backorder",
        scopeType: "CUSTOMER",
        value: "off",
        key: "x",
        tenantId: "t2",
      } as never,
      admin,
    );
    const arg = policies.set.mock.calls[0][0];
    expect(arg.scopeType).toBe("TENANT");
    expect(arg.key).toBe("orders.buyerOversell");
    expect(arg.value).toBe("backorder");
    expect(arg.tenantId).toBe("t1");
  });

  it("a set() rejection propagates as-is", async () => {
    const { controller, policies } = build();
    const boom = new Error("db down");
    policies.set.mockRejectedValueOnce(boom);
    await expect(controller.update({ buyerOversell: "backorder" }, admin)).rejects.toBe(boom);
  });
});

describe("no tenant context", () => {
  it("GET and PATCH are a coded 403 and never touch PolicyService", async () => {
    const { controller, policies } = build({ tenantId: null });
    for (const call of [
      () => controller.get(admin),
      () => controller.update({ buyerOversell: "backorder" }, admin),
    ]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        code: API_ERROR_CODES.TENANT_CONTEXT_REQUIRED,
      });
    }
    expect(policies.resolve).not.toHaveBeenCalled();
    expect(policies.set).not.toHaveBeenCalled();
  });

  it("the tenant check wins over body validation", async () => {
    const { controller } = build({ tenantId: null });
    const body = await bodyOf(controller.update({ buyerOversell: "nope" } as never, admin));
    expect(body.code).toBe(API_ERROR_CODES.TENANT_CONTEXT_REQUIRED);
  });
});

describe("saved value → what a buyer order does (PolicyOversellReader + resolveOversellAllowed)", () => {
  it("backorder lets a CUSTOMER oversell; off does not", async () => {
    const { controller, policies } = build();
    const reader = new PolicyOversellReader(policies as any);
    const allowed = () =>
      resolveOversellAllowed(reader, {
        tenantId: "t1",
        role: "CUSTOMER",
        source: "buyer",
        customerId: "c1",
      });
    expect(await allowed()).toBe(false);
    await controller.update({ buyerOversell: "backorder" }, admin);
    expect(await allowed()).toBe(true);
    await controller.update({ buyerOversell: "off" }, admin);
    expect(await allowed()).toBe(false);
  });
});

describe("buyerBackorderVisibility (OOS PR2)", () => {
  it("GET resolves the TENANT value through the string-literal key; a stored hide reads as hide", async () => {
    const { controller, policies } = build({ initial: "backorder", initialVisibility: "hide" });
    expect(await controller.get(admin)).toEqual({
      buyerOversell: "backorder",
      buyerBackorderVisibility: "hide",
      customerOverrides: 0,
    });
    expect(policies.resolve).toHaveBeenCalledWith("t1", "orders.buyerBackorderVisibility", {});
  });

  it('a corrupt stored value fails closed to "show" (today\'s truthful behaviour)', async () => {
    const { controller } = build({ initialVisibility: "HIDE" });
    expect((await controller.get(admin)).buyerBackorderVisibility).toBe("show");
  });

  it("PATCH with ONLY the visibility: one set(), TENANT scope, the visibility key; buyerOversell is not rewritten", async () => {
    const { controller, policies } = build({ initial: "backorder" });
    const res = await controller.update({ buyerBackorderVisibility: "hide" }, {
      ...admin,
      impersonatedBy: "sa1",
    } as JwtPayload);
    expect(policies.set).toHaveBeenCalledTimes(1);
    expect(policies.set).toHaveBeenCalledWith({
      tenantId: "t1",
      key: "orders.buyerBackorderVisibility",
      scopeType: "TENANT",
      scopeId: null,
      value: "hide",
      reason: INVENTORY_SETTINGS_DEFAULT_REASON,
      actor: { id: "u1", name: "admin", impersonatedBy: "sa1" },
    });
    expect(res).toEqual({
      buyerOversell: "backorder",
      buyerBackorderVisibility: "hide",
      customerOverrides: 0,
    });
  });

  it("PATCH with both: two audited set() calls, one per key", async () => {
    const { controller, policies } = build();
    await controller.update(
      { buyerOversell: "backorder", buyerBackorderVisibility: "hide" },
      admin,
    );
    expect(policies.set.mock.calls.map((c) => [c[0].key, c[0].value])).toEqual([
      ["orders.buyerOversell", "backorder"],
      ["orders.buyerBackorderVisibility", "hide"],
    ]);
  });

  it.each([["Hide"], ["yes"], [null], [1], [true], [["hide"]]])(
    "garbage buyerBackorderVisibility %p is a 400 on that field, nothing written",
    async (v) => {
      const { controller, policies } = build();
      const err = await controller
        .update({ buyerOversell: "backorder", buyerBackorderVisibility: v } as never, admin)
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual({
        statusCode: 400,
        code: "INVENTORY_SETTING_INVALID",
        message: INVENTORY_VISIBILITY_INVALID_MESSAGE,
        details: { field: "buyerBackorderVisibility" },
      });
      expect(policies.set).not.toHaveBeenCalled(); // validated before ANY write
    },
  );

  it("the shared visibility list equals the registry's", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const shared = require("@routeflow/types") as {
      INVENTORY_BACKORDER_VISIBILITY_MODES: string[];
    };
    expect([...shared.INVENTORY_BACKORDER_VISIBILITY_MODES]).toEqual([
      ...BUYER_BACKORDER_VISIBILITY_MODES,
    ]);
  });
});

describe("contract parity", () => {
  it("the shared mode list equals the registry's BUYER_OVERSELL_MODES", () => {
    // The API never value-imports @routeflow/types in source; a spec may read it (same as
    // common/api-error-codes-parity.spec.ts).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const shared = require("@routeflow/types") as { INVENTORY_BUYER_OVERSELL_MODES: string[] };
    expect([...shared.INVENTORY_BUYER_OVERSELL_MODES]).toEqual([...BUYER_OVERSELL_MODES]);
  });
});

describe("PATCH body is a validated DTO (N1)", () => {
  // The global pipe in main.ts: whitelist + forbidNonWhitelisted + transform.
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
  const meta = { type: "body", metatype: UpdateInventorySettingsDto } as const;

  it("an unknown field is a 400 from the pipe", async () => {
    await expect(
      pipe.transform({ buyerOversell: "backorder", tenantId: "t2" }, meta),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("the known fields pass through untouched (values are the service's coded 400)", async () => {
    await expect(
      pipe.transform({ buyerOversell: "backorder", reason: "r" }, meta),
    ).resolves.toMatchObject({ buyerOversell: "backorder", reason: "r" });
    await expect(pipe.transform({ buyerOversell: "bogus" }, meta)).resolves.toMatchObject({
      buyerOversell: "bogus",
    });
  });

  it("the controller binds the DTO and Swagger lists both properties", () => {
    const types = Reflect.getMetadata(
      "design:paramtypes",
      SettingsInventoryController.prototype,
      "update",
    );
    expect(types[0]).toBe(UpdateInventorySettingsDto);
    const props = Reflect.getMetadata(
      "swagger/apiModelPropertiesArray",
      UpdateInventorySettingsDto.prototype,
    );
    expect(props).toEqual([":buyerOversell", ":buyerBackorderVisibility", ":reason"]);
  });
});
