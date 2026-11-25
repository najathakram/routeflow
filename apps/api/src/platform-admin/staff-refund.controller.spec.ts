import "reflect-metadata";
import { BadRequestException, ExecutionContext, RequestMethod } from "@nestjs/common";
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from "@nestjs/common/constants";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { buildGlobalValidationPipe } from "../common/global-validation-pipe";
import { PLATFORM_SCOPED_KEY } from "../tenant/platform-scoped.decorator";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { StaffRefundDto } from "./dto/staff-refund.dto";
import { StaffRefundController } from "./staff-refund.controller";

/**
 * R-2 (SA-1297 ruling 10, tests 6-8): the controller's wiring and the DTO's refusals. The service rules are in
 * staff-refund.service.spec.ts. DTO cases go through the SAME global pipe main.ts installs (whitelist + forbidNonWhitelisted),
 * so an `amount` in the body is a 400, not ignored.
 */
const ID = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
const ADMIN = { sub: "qa-admin-1" } as never;
const proto = StaffRefundController.prototype;

const VALID = {
  refundedInFull: true,
  cancelledImmediately: true,
  providerRef: "re_acme_001",
  refundDate: "2026-11-15",
};

const pipe = buildGlobalValidationPipe();
const run = (b: Record<string, unknown>) =>
  pipe.transform(b, { type: "body", metatype: StaffRefundDto }) as Promise<StaffRefundDto>;
const refused = async (b: Record<string, unknown>) => {
  try {
    await run(b);
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return JSON.stringify((e as BadRequestException).getResponse());
  }
  throw new Error("expected the pipe to refuse the body");
};

describe("R-2 test 8: guards and routes", () => {
  it("every route sits behind the class-level JwtAuthGuard + SuperAdminGuard, with no method-level override, and is platform-scoped", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, StaffRefundController)).toEqual([
      JwtAuthGuard,
      SuperAdminGuard,
    ]);
    expect(Reflect.getMetadata(PLATFORM_SCOPED_KEY, StaffRefundController)).toBe(true);
    expect(Reflect.getMetadata(PATH_METADATA, StaffRefundController)).toBe("platform-admin");
    for (const handler of [proto.refundable, proto.record, proto.billingEvents]) {
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toBeUndefined();
    }
  });

  it("paths, verbs and the POST's 201 are pinned", () => {
    expect(Reflect.getMetadata(PATH_METADATA, proto.refundable)).toBe(
      "tenants/:id/staff-refunds/refundable",
    );
    expect(Reflect.getMetadata(METHOD_METADATA, proto.refundable)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, proto.record)).toBe("tenants/:id/staff-refunds");
    expect(Reflect.getMetadata(METHOD_METADATA, proto.record)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.record)).toBe(201);
    expect(Reflect.getMetadata(PATH_METADATA, proto.billingEvents)).toBe(
      "tenants/:id/billing-events",
    );
    expect(Reflect.getMetadata(METHOD_METADATA, proto.billingEvents)).toBe(RequestMethod.GET);
  });

  it("`:id` goes through ParseUUIDPipe on all three routes (a non-uuid id never reaches the service)", () => {
    for (const handler of ["refundable", "record", "billingEvents"] as const) {
      const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, StaffRefundController, handler);
      const idArg = Object.values(args as Record<string, { data?: string; pipes: unknown[] }>).find(
        (a) => a.data === "id",
      );
      expect(idArg?.pipes).toHaveLength(1);
      expect((idArg?.pipes[0] as { name?: string }).name).toBe("ParseUUIDPipe");
    }
  });

  it("the guard lets a super admin through and refuses a tenant-admin JWT (and every other tenant role, and no user) on these routes", () => {
    const guard = new SuperAdminGuard();
    const ctx = (user: unknown) =>
      ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as unknown as ExecutionContext;
    expect(guard.canActivate(ctx({ role: UserRole.SUPER_ADMIN }))).toBe(true);
    for (const role of [
      UserRole.TENANT_ADMIN,
      UserRole.OPERATOR,
      UserRole.DRIVER,
      UserRole.CUSTOMER,
    ]) {
      expect(guard.canActivate(ctx({ role }))).toBe(false);
    }
    expect(guard.canActivate(ctx(undefined))).toBe(false);
  });

  it("delegates: refundable and billing-events by id; record with the body and the acting admin's id", async () => {
    const svc = {
      resolveRefundable: jest.fn().mockResolvedValue({ payment: null }),
      listBillingEvents: jest.fn().mockResolvedValue([]),
      record: jest.fn().mockResolvedValue({ id: "ev-1" }),
    };
    const c = new StaffRefundController(svc as never);
    await c.refundable(ID);
    await c.billingEvents(ID);
    const dto = await run(VALID);
    await expect(c.record(ID, dto, ADMIN)).resolves.toEqual({ id: "ev-1" });
    expect(svc.resolveRefundable).toHaveBeenCalledWith(ID);
    expect(svc.listBillingEvents).toHaveBeenCalledWith(ID);
    expect(svc.record).toHaveBeenCalledWith(ID, dto, "qa-admin-1");
  });
});

describe("R-2 test 6: there is no amount field", () => {
  it("a valid body plus amount: 1 is a 400 from the global pipe (rejected, never ignored)", async () => {
    expect(await refused({ ...VALID, amount: 1 })).toContain("amount");
  });
  it("the invoice is not a field either: the route tenant's latest yearly payment is always the one", async () => {
    expect(await refused({ ...VALID, invoiceId: "in_other" })).toContain("invoiceId");
  });
  it("the valid body alone passes the pipe and keeps exactly its five fields", async () => {
    const dto = await run({ ...VALID, note: "called the customer" });
    expect(Object.keys(dto).sort()).toEqual([
      "cancelledImmediately",
      "note",
      "providerRef",
      "refundDate",
      "refundedInFull",
    ]);
  });
});

describe("R-2 test 7: the DTO rules", () => {
  it("refundedInFull: false is refused", async () => {
    expect(await refused({ ...VALID, refundedInFull: false })).toContain("refundedInFull");
  });
  it("cancelledImmediately missing is refused", async () => {
    const { cancelledImmediately: _omit, ...rest } = VALID;
    expect(await refused(rest)).toContain("cancelledImmediately");
  });
  it("refundedInFull as the string 'true' is refused (a real boolean only)", async () => {
    expect(await refused({ ...VALID, refundedInFull: "true" })).toContain("refundedInFull");
  });
  it("providerRef of spaces is refused (trimmed to empty)", async () => {
    expect(await refused({ ...VALID, providerRef: "   " })).toContain("providerRef");
  });
  it("providerRef is required", async () => {
    const { providerRef: _omit, ...rest } = VALID;
    expect(await refused(rest)).toContain("providerRef");
  });
  it("providerRef: 128 characters pass, 129 are refused; the text is stored trimmed", async () => {
    expect((await run({ ...VALID, providerRef: "r".repeat(128) })).providerRef).toHaveLength(128);
    expect(await refused({ ...VALID, providerRef: "r".repeat(129) })).toContain("providerRef");
    expect((await run({ ...VALID, providerRef: "  re_acme_9  " })).providerRef).toBe("re_acme_9");
  });
  it("note: 500 characters pass, 501 are refused; it is optional and trimmed", async () => {
    expect((await run({ ...VALID, note: "n".repeat(500) })).note).toHaveLength(500);
    expect(await refused({ ...VALID, note: "n".repeat(501) })).toContain("note");
    expect((await run(VALID)).note).toBeUndefined();
    expect((await run({ ...VALID, note: "  hi  " })).note).toBe("hi");
  });
  it("refundDate: a date-time is refused; only YYYY-MM-DD passes", async () => {
    expect(await refused({ ...VALID, refundDate: "2026-11-15T10:00:00Z" })).toContain("refundDate");
    expect(await refused({ ...VALID, refundDate: "15/11/2026" })).toContain("refundDate");
    expect(await refused({ ...VALID, refundDate: "2026-02-30" })).toContain("refundDate");
    expect((await run({ ...VALID, refundDate: "2026-11-15" })).refundDate).toBe("2026-11-15");
  });
});
