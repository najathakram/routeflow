/**
 * Security tests for the Returns module.
 *
 * RF-081: DRIVER cannot call findOneForUser; CUSTOMER can only see own return.
 * RF-093: JwtAuthGuard blocks forcePasswordChange tokens on non-change-password routes.
 * RF-160: ThrottlerExceptionFilter sets Retry-After header on 429 responses.
 */

import { Test, TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ReturnsService } from "./returns.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { ExecutionContext, HttpStatus } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { ThrottlerExceptionFilter } from "../common/throttler-exception.filter";
import { ThrottlerException } from "@nestjs/throttler";

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const OPERATOR_JWT = {
  sub: "user-op-1",
  role: "OPERATOR",
  forcePasswordChange: false,
  tenantId: "t1",
  tenantSlug: "acme",
  username: "admin",
  status: "ACTIVE",
};

const CUSTOMER_JWT = {
  sub: "user-cust-1",
  role: "CUSTOMER",
  forcePasswordChange: false,
  tenantId: "t1",
  tenantSlug: "acme",
  username: "harbor_cafe",
  status: "ACTIVE",
};

const OTHER_CUSTOMER_JWT = {
  sub: "user-cust-2",
  role: "CUSTOMER",
  forcePasswordChange: false,
  tenantId: "t1",
  tenantSlug: "acme",
  username: "north_deli",
  status: "ACTIVE",
};

const DRIVER_JWT = {
  sub: "user-driver-1",
  role: "DRIVER",
  forcePasswordChange: false,
  tenantId: "t1",
  tenantSlug: "acme",
  username: "driver_tom",
  status: "ACTIVE",
};

const FORCE_CHANGE_JWT = {
  sub: "user-new-1",
  role: "OPERATOR",
  forcePasswordChange: true,
  tenantId: "t1",
  tenantSlug: "acme",
  username: "newuser",
  status: "ACTIVE",
};

const MOCK_RETURN = {
  id: "ret-1",
  customerId: "cust-1",
  returnNumber: "RET-2026-001",
  status: "PENDING",
  reason: "DAMAGED",
  notes: null,
  photoUrls: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  orderId: "ord-1",
  order: {
    id: "ord-1",
    orderNumber: "ORD-001",
    lineItems: [],
  },
  customer: { id: "cust-1", businessName: "Harbor Cafe" },
  items: [],
};

// ─── RF-081: IDOR tests ───────────────────────────────────────────────────────

describe("RF-081 ReturnsService.findOneForUser – IDOR prevention", () => {
  let service: ReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();

    const gateway = { emitReturnCreated: jest.fn() } as unknown as RouteFlowGateway;
    const ledger = {
      reverseReturnEntries: jest.fn(),
      unreverseReturnEntries: jest.fn(),
    } as unknown as RegulatedLedgerService;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: gateway },
        { provide: RegulatedLedgerService, useValue: ledger },
        { provide: CreditNotesService, useValue: { create: jest.fn() } },
      ],
    }).compile();

    service = module.get(ReturnsService);

    // Default: findOne returns the mock return
    (prisma.forTenant() as any).return.findUnique.mockResolvedValue(MOCK_RETURN);
  });

  it("RF-081-1: CUSTOMER can read their own return (200)", async () => {
    // customer record matches the return's customerId
    (prisma.forTenant() as any).customer.findFirst.mockResolvedValue({ id: "cust-1" });

    const result = await service.findOneForUser("ret-1", CUSTOMER_JWT as any);
    expect(result.id).toBe("ret-1");
  });

  it("RF-081-2: CUSTOMER cannot read another customer's return (403)", async () => {
    // customer record does NOT match the return's customerId
    (prisma.forTenant() as any).customer.findFirst.mockResolvedValue({ id: "cust-OTHER" });

    await expect(service.findOneForUser("ret-1", OTHER_CUSTOMER_JWT as any)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("RF-081-3: OPERATOR can read any return without ownership check", async () => {
    const result = await service.findOneForUser("ret-1", OPERATOR_JWT as any);
    expect(result.id).toBe("ret-1");
    // customer.findFirst should NOT be called for OPERATOR
    expect(prisma.forTenant().customer.findFirst).not.toHaveBeenCalled();
  });

  it("RF-081-4: returns 404 when return does not exist (any role)", async () => {
    (prisma.forTenant() as any).return.findUnique.mockResolvedValue(null);

    await expect(service.findOneForUser("ret-nonexistent", OPERATOR_JWT as any)).rejects.toThrow(
      NotFoundException,
    );
  });
});

// ─── RF-093: forcePasswordChange enforcement ──────────────────────────────────

describe("RF-093 JwtAuthGuard – forcePasswordChange enforcement", () => {
  let guard: JwtAuthGuard;

  beforeEach(() => {
    guard = new JwtAuthGuard();
  });

  function makeContext(path: string, method = "GET"): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ method, path }),
      }),
      getType: () => "http",
    } as unknown as ExecutionContext;
  }

  it("RF-093-1: blocks any protected route when forcePasswordChange=true", () => {
    const ctx = makeContext("/api/v1/orders");
    expect(() => guard.handleRequest(null, FORCE_CHANGE_JWT, null, ctx)).toThrow(
      ForbiddenException,
    );
  });

  it("RF-093-2: allows POST /auth/change-password even with forcePasswordChange=true", () => {
    const ctx = makeContext("/api/v1/auth/change-password", "POST");
    const user = guard.handleRequest(null, FORCE_CHANGE_JWT, null, ctx);
    expect(user).toBe(FORCE_CHANGE_JWT);
  });

  it("RF-093-3: normal token passes through unrestricted", () => {
    const ctx = makeContext("/api/v1/orders");
    const user = guard.handleRequest(null, OPERATOR_JWT, null, ctx);
    expect(user).toBe(OPERATOR_JWT);
  });
});

// ─── RF-160: Retry-After header in throttle responses ────────────────────────

describe("RF-160 ThrottlerExceptionFilter – Retry-After header", () => {
  let filter: ThrottlerExceptionFilter;

  beforeEach(() => {
    filter = new ThrottlerExceptionFilter();
  });

  function makeHost(path: string): any {
    const res = {
      status: jest.fn().mockReturnThis(),
      header: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    return {
      switchToHttp: () => ({
        getResponse: () => res,
        getRequest: () => ({ path, ip: "127.0.0.1" }),
      }),
      res,
    };
  }

  it("RF-160-1: sets Retry-After: 300 for /auth/login throttle", () => {
    const host = makeHost("/api/v1/auth/login");
    filter.catch(new ThrottlerException(), host);
    expect(host.res.status).toHaveBeenCalledWith(HttpStatus.TOO_MANY_REQUESTS);
    expect(host.res.header).toHaveBeenCalledWith("Retry-After", "300");
  });

  it("RF-160-2: sets Retry-After: 60 for other throttled routes", () => {
    const host = makeHost("/api/v1/products");
    filter.catch(new ThrottlerException(), host);
    expect(host.res.header).toHaveBeenCalledWith("Retry-After", "60");
  });

  it("RF-160-3: response body includes retryAfter field and statusCode 429", () => {
    const host = makeHost("/api/v1/auth/login");
    filter.catch(new ThrottlerException(), host);
    const jsonArg = host.res.json.mock.calls[0][0];
    expect(jsonArg.statusCode).toBe(429);
    expect(jsonArg.retryAfter).toBe(300);
  });
});
