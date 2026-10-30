/**
 * Row 257 (#3367 follow-up): the refund slip's "Refunded by" comes from the STORED refund actor, the user on the awaited
 * audit row every refund path writes in the refund's own transaction (inline cash/card/check, inline store credit,
 * standard external refund). `GET /returns/:id` names that user for staff and never for a buyer; a refund with no audit
 * row, a system actor or a removed user reads null.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ForbiddenException } from "@nestjs/common";
import { ReturnsService } from "./returns.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import {
  INLINE_REFUND_AUDIT_ACTION,
  INLINE_STORE_CREDIT_AUDIT_ACTION,
} from "./inline-return-refund";

describe("ReturnsService.findOne: refundedBy (row 257)", () => {
  let service: ReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const refunded = (over: Record<string, unknown> = {}) => ({
    id: "ret-1",
    kind: "INLINE",
    status: "REFUNDED",
    customerId: "cust-1",
    refundMethod: "EXTERNAL_REFUND",
    refundAmount: 12,
    refundedAt: new Date("2026-10-20T10:00:00Z"),
    items: [],
    order: null,
    creditNoteId: null,
    ...over,
  });

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        ReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitReturnCreated: jest.fn() } },
        { provide: RegulatedLedgerService, useValue: {} },
        { provide: CreditNotesService, useValue: {} },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    service = mod.get(ReturnsService);
  });

  it("names the user on the refund's audit row", async () => {
    prisma.return.findUnique.mockResolvedValue(refunded());
    prisma.auditLog.findFirst.mockResolvedValue({ userId: "u-casey" });
    prisma.user.findFirst.mockResolvedValue({ username: "casey", deletedAt: null });
    const out = await service.findOne("ret-1");
    expect(out.refundedBy).toBe("casey");
    // the user read names the tenant too
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { id: "u-casey", tenantId: "test-tenant" },
      select: { username: true, deletedAt: true },
    });
    expect(prisma.auditLog.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: "test-tenant",
        entityType: "Return",
        entityId: "ret-1",
        action: {
          in: [
            INLINE_REFUND_AUDIT_ACTION,
            INLINE_STORE_CREDIT_AUDIT_ACTION,
            AUDIT_ACTIONS.STANDARD_REFUND_RECORDED,
          ],
        },
      },
      orderBy: { createdAt: "desc" },
      select: { userId: true },
    });
  });

  it("a return that is not refunded reads null and asks nothing", async () => {
    prisma.return.findUnique.mockResolvedValue(
      refunded({ status: "RECEIVED", refundedAt: null, refundAmount: null }),
    );
    const out = await service.findOne("ret-1");
    expect(out.refundedBy).toBeNull();
    expect(prisma.auditLog.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ["no audit row", null, null],
    ["a system actor (no user id)", { userId: null }, null],
    ["a removed user", { userId: "u-gone" }, { username: "gone", deletedAt: new Date() }],
    ["a user that no longer exists", { userId: "u-none" }, null],
  ])("%s reads null", async (_n, audit, user) => {
    prisma.return.findUnique.mockResolvedValue(refunded());
    prisma.auditLog.findFirst.mockResolvedValue(audit);
    prisma.user.findFirst.mockResolvedValue(user);
    expect((await service.findOne("ret-1")).refundedBy).toBeNull();
  });

  it("a buyer reading their own return never gets the staff member's name", async () => {
    prisma.return.findUnique.mockResolvedValue(refunded());
    prisma.auditLog.findFirst.mockResolvedValue({ userId: "u-casey" });
    prisma.user.findFirst.mockResolvedValue({ username: "casey", deletedAt: null });
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    const out = await service.findOneForUser("ret-1", {
      sub: "buyer-1",
      role: "CUSTOMER",
    } as never);
    expect(out).not.toHaveProperty("refundedBy");
    // and a buyer's read resolves nobody: zero queries for the refunder
    expect(prisma.auditLog.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    // staff still get it
    expect(
      (await service.findOneForUser("ret-1", { sub: "op-1", role: "OPERATOR" } as never))
        .refundedBy,
    ).toBe("casey");
  });

  it("the return's own tenant scopes both reads, ahead of the request's tenant", async () => {
    prisma.return.findUnique.mockResolvedValue(refunded({ tenantId: "t-own" }));
    prisma.auditLog.findFirst.mockResolvedValue({ userId: "u-casey" });
    prisma.user.findFirst.mockResolvedValue({ username: "casey", deletedAt: null });
    await service.findOne("ret-1");
    expect(prisma.auditLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: "t-own" }) }),
    );
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u-casey", tenantId: "t-own" } }),
    );
  });

  it("with no tenant to scope by, nobody is named and nothing is read", async () => {
    prisma.return.findUnique.mockResolvedValue(refunded({ tenantId: null }));
    (prisma.getTenantId as jest.Mock).mockReturnValue(null);
    expect((await service.findOne("ret-1")).refundedBy).toBeNull();
    expect(prisma.auditLog.findFirst).not.toHaveBeenCalled();
  });

  it("a buyer asking for someone else's return is still refused", async () => {
    prisma.return.findUnique.mockResolvedValue(refunded());
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-other" });
    await expect(
      service.findOneForUser("ret-1", { sub: "buyer-1", role: "CUSTOMER" } as never),
    ).rejects.toThrow(ForbiddenException);
  });
});
