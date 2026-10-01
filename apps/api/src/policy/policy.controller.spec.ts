/**
 * PolicyController (SA-138 §3.4): role metadata (reflection only, no DI) and the list shape.
 */
import "reflect-metadata";
import { ForbiddenException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { PolicyController } from "./policy.controller";

const rolesOf = (method: keyof PolicyController) =>
  Reflect.getMetadata(ROLES_KEY, PolicyController.prototype[method]);

describe("PolicyController roles", () => {
  it("GET /policies is OPERATOR+ (TENANT_ADMIN satisfies OPERATOR)", () => {
    expect(rolesOf("list")).toEqual([UserRole.OPERATOR]);
  });

  it.each(["set", "clear", "history"] as const)("%s is TENANT_ADMIN only", (m) => {
    expect(rolesOf(m)).toEqual([UserRole.TENANT_ADMIN]);
  });

  it("carries no addon/plan-flag gate — a policy is not a feature", () => {
    for (const m of ["list", "set", "clear", "history"] as const) {
      const keys = Reflect.getMetadataKeys(PolicyController.prototype[m]).map(String);
      expect(keys.filter((k) => /addon|plan.?flag/i.test(k))).toEqual([]);
    }
  });
});

describe("PolicyController behaviour", () => {
  const user = { sub: "u1", username: "admin", tenantId: "t1" } as unknown as JwtPayload;

  it("GET lists every registry key with its JSON-schema and only this key's active rows", async () => {
    const svc = {
      listActive: jest.fn().mockResolvedValue([
        {
          id: "r1",
          key: "credit.approvalThreshold",
          scopeType: "TENANT",
          scopeId: null,
          value: 250,
          reason: "r",
          setById: "u1",
          setByName: "admin",
          createdAt: new Date("2026-09-24T00:00:00Z"),
          supersededAt: null,
          supersededById: null,
        },
      ]),
    } as any;
    const res = await new PolicyController(svc).list(user);
    expect(svc.listActive).toHaveBeenCalledWith("t1");
    expect(res.policies.map((p) => p.key)).toEqual([
      "orders.driverAtDoorEdit",
      "credit.approvalThreshold",
      "invoicing.priceDisclosure",
      "orders.buyerOversell",
    ]);
    const credit = res.policies.find((p) => p.key === "credit.approvalThreshold")!;
    expect(credit.default).toBeNull();
    expect(credit.pilotPending).toBe(true);
    expect(credit.schema).toMatchObject({ anyOf: expect.any(Array) });
    expect(credit.active.map((r) => [r.id, r.value, r.createdAt])).toEqual([
      ["r1", 250, "2026-09-24T00:00:00.000Z"],
    ]);
    expect(res.policies.find((p) => p.key === "orders.driverAtDoorEdit")!.active).toEqual([]);
  });

  it("PUT passes the caller's tenant, identity and impersonator to the service", async () => {
    const svc = {
      set: jest.fn().mockResolvedValue({
        id: "r2",
        key: "orders.driverAtDoorEdit",
        scopeType: "TENANT",
        scopeId: null,
        value: "replace",
        reason: "why",
        setById: "u1",
        setByName: "admin",
        createdAt: new Date("2026-09-24T00:00:00Z"),
        supersededAt: null,
        supersededById: null,
      }),
    } as any;
    await new PolicyController(svc).set(
      { ...user, impersonatedBy: "sa-1" } as JwtPayload,
      "orders.driverAtDoorEdit",
      { scopeType: "TENANT", value: "replace", reason: "why" } as any,
    );
    expect(svc.set).toHaveBeenCalledWith({
      tenantId: "t1",
      key: "orders.driverAtDoorEdit",
      scopeType: "TENANT",
      scopeId: null,
      value: "replace",
      reason: "why",
      actor: { id: "u1", name: "admin", impersonatedBy: "sa-1" },
    });
  });

  it("a token with no tenant context is refused, never resolved against a null tenant", async () => {
    const svc = { listActive: jest.fn() } as any;
    await expect(
      new PolicyController(svc).list({ sub: "sa", tenantId: null } as unknown as JwtPayload),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(svc.listActive).not.toHaveBeenCalled();
  });
});
