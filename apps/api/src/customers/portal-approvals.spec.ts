import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CustomersService } from "./customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { createMockPrisma } from "../testing/prisma-mock";

// Buyer-connect approval flow, WP2: decline endpoint + richer pending payloads.
// Covers `declineBuyerRequest`, the 409-on-non-pending tightening of
// `approveBuyerRequest`, and the enriched shapes returned by
// `listPendingPortalApprovals` / `getPortalStatus`.

const TENANT_ID = "tenant-1";
const CUSTOMER_ID = "cust-1";

const PENDING_LINK = {
  id: "link-1",
  customerId: CUSTOMER_ID,
  tenantId: TENANT_ID,
  buyerAccountId: "buyer-1",
  status: "PENDING_SELLER_APPROVAL" as const,
  inviteToken: null,
  inviteExpiresAt: null,
  inviteMethod: null,
  linkedAt: null,
  disconnectedAt: null,
  disconnectedBy: null,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-02T00:00:00.000Z"),
};

const ACTIVE_LINK = {
  ...PENDING_LINK,
  status: "ACTIVE" as const,
  linkedAt: new Date("2026-08-03T00:00:00.000Z"),
};

describe("Portal approvals — decline endpoint + richer pending payloads", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomersService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } },
        {
          provide: StorageService,
          useValue: {
            upload: jest.fn().mockResolvedValue("mock-key"),
            delete: jest.fn().mockResolvedValue(undefined),
            presignedUrl: jest.fn().mockResolvedValue("https://mock-url"),
          },
        },
        // Customer soft-cap collaborators — unused by the approval tests, but
        // CustomersService now depends on them.
        { provide: MeterService, useValue: { read: jest.fn() } },
        { provide: PlanCatalogService, useValue: { getPublishedVersion: jest.fn() } },
        {
          provide: EntitlementsService,
          useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
        },
      ],
    }).compile();

    service = module.get<CustomersService>(CustomersService);
  });

  // ─── declineBuyerRequest ────────────────────────────────────────────────

  describe("declineBuyerRequest", () => {
    it("404s when no link exists for the customer", async () => {
      prisma.customerLink.findFirst.mockResolvedValue(null);

      await expect(service.declineBuyerRequest(CUSTOMER_ID, TENANT_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.customerLink.delete).not.toHaveBeenCalled();
    });

    it("409s when the link exists but is not PENDING_SELLER_APPROVAL", async () => {
      prisma.customerLink.findFirst.mockResolvedValue(ACTIVE_LINK);

      await expect(service.declineBuyerRequest(CUSTOMER_ID, TENANT_ID)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.customerLink.delete).not.toHaveBeenCalled();
    });

    it("deletes the row and returns { declined: true } for a PENDING link", async () => {
      prisma.customerLink.findFirst.mockResolvedValue(PENDING_LINK);

      const result = await service.declineBuyerRequest(CUSTOMER_ID, TENANT_ID);

      expect(prisma.customerLink.delete).toHaveBeenCalledWith({
        where: { id: PENDING_LINK.id },
      });
      // customerId is unique on CustomerLink — the row must be gone, not merely
      // status-flipped, so a future legitimate invite/request can reuse the slot.
      expect(prisma.customerLink.update).not.toHaveBeenCalled();
      expect(result).toEqual({ declined: true });
    });

    it("reverts to INVITED instead of deleting when the row still holds a live invite token", async () => {
      // A request against an INVITED link keeps inviteToken/inviteExpiresAt so the true
      // invitee's emailed link keeps working — declining the requester must not destroy it.
      prisma.customerLink.findFirst.mockResolvedValue({
        ...PENDING_LINK,
        inviteToken: "secret-token",
        inviteExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
      });

      const result = await service.declineBuyerRequest(CUSTOMER_ID, TENANT_ID);

      expect(prisma.customerLink.delete).not.toHaveBeenCalled();
      expect(prisma.customerLink.update).toHaveBeenCalledWith({
        where: { id: PENDING_LINK.id },
        data: { status: "INVITED", buyerAccountId: null },
      });
      expect(result).toEqual({ declined: true });
    });

    it("deletes the row when its invite token has already expired", async () => {
      prisma.customerLink.findFirst.mockResolvedValue({
        ...PENDING_LINK,
        inviteToken: "stale-token",
        inviteExpiresAt: new Date("2020-01-01T00:00:00.000Z"),
      });

      await service.declineBuyerRequest(CUSTOMER_ID, TENANT_ID);

      expect(prisma.customerLink.delete).toHaveBeenCalledWith({
        where: { id: PENDING_LINK.id },
      });
      expect(prisma.customerLink.update).not.toHaveBeenCalled();
    });
  });

  // ─── approveBuyerRequest ────────────────────────────────────────────────

  describe("approveBuyerRequest", () => {
    it("404s when no link exists for the customer", async () => {
      prisma.customerLink.findFirst.mockResolvedValue(null);

      await expect(service.approveBuyerRequest(CUSTOMER_ID, TENANT_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.customerLink.update).not.toHaveBeenCalled();
    });

    it("409s when the link exists but is not PENDING_SELLER_APPROVAL", async () => {
      prisma.customerLink.findFirst.mockResolvedValue(ACTIVE_LINK);

      await expect(service.approveBuyerRequest(CUSTOMER_ID, TENANT_ID)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.customerLink.update).not.toHaveBeenCalled();
    });

    it("flips a PENDING link to ACTIVE with linkedAt set, consuming any inherited invite token", async () => {
      prisma.customerLink.findFirst.mockResolvedValue(PENDING_LINK);
      prisma.customerLink.update.mockResolvedValue({ ...PENDING_LINK, status: "ACTIVE" });

      const result = await service.approveBuyerRequest(CUSTOMER_ID, TENANT_ID);

      expect(prisma.customerLink.update).toHaveBeenCalledWith({
        where: { id: PENDING_LINK.id },
        data: {
          status: "ACTIVE",
          linkedAt: expect.any(Date),
          inviteToken: null,
          inviteExpiresAt: null,
        },
      });
      expect(result).toEqual({ message: "Buyer connection approved" });
    });
  });

  // ─── listPendingPortalApprovals ─────────────────────────────────────────

  describe("listPendingPortalApprovals", () => {
    it("enriches each row with the requesting buyer's identity", async () => {
      const row = {
        ...PENDING_LINK,
        customer: {
          id: CUSTOMER_ID,
          businessName: "Acme Corp",
          contactName: "Jane Buyer",
          email: "seller-facing@acme.test",
        },
        buyerAccount: {
          id: "buyer-1",
          email: "jane@buyer.test",
          name: "Jane Buyer",
        },
      };
      prisma.customerLink.findMany.mockResolvedValue([row]);

      const result = await service.listPendingPortalApprovals(TENANT_ID);

      expect(prisma.customerLink.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: TENANT_ID, status: "PENDING_SELLER_APPROVAL" },
        }),
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        customerId: CUSTOMER_ID,
        customerName: "Acme Corp",
        buyerName: "Jane Buyer",
        buyerEmail: "jane@buyer.test",
        requestedAt: PENDING_LINK.updatedAt,
      });
    });

    it("falls back to contactName then a placeholder when businessName is missing", async () => {
      const rowNoBusinessName = {
        ...PENDING_LINK,
        customer: { id: CUSTOMER_ID, businessName: null, contactName: "Jane Buyer", email: null },
        buyerAccount: { id: "buyer-1", email: "jane@buyer.test", name: null },
      };
      prisma.customerLink.findMany.mockResolvedValue([rowNoBusinessName]);

      const [result] = await service.listPendingPortalApprovals(TENANT_ID);

      expect(result.customerName).toBe("Jane Buyer");
      expect(result.buyerName).toBeNull();
    });
  });

  // ─── getPortalStatus — buyer identity on the pending card ──────────────

  describe("getPortalStatus (pending buyer identity)", () => {
    it("surfaces buyerName/buyerEmail while PENDING_SELLER_APPROVAL", async () => {
      prisma.customerLink.findFirst.mockResolvedValue({
        ...PENDING_LINK,
        buyerAccount: { id: "buyer-1", email: "jane@buyer.test", name: "Jane Buyer" },
      });

      const result = await service.getPortalStatus(CUSTOMER_ID, TENANT_ID);

      expect(result.status).toBe("PENDING_SELLER_APPROVAL");
      expect(result.buyerName).toBe("Jane Buyer");
      expect(result.buyerEmail).toBe("jane@buyer.test");
    });

    it("leaves buyerName/buyerEmail null outside the pending state", async () => {
      prisma.customerLink.findFirst.mockResolvedValue({
        ...ACTIVE_LINK,
        buyerAccount: { id: "buyer-1", email: "jane@buyer.test", name: "Jane Buyer" },
      });

      const result = await service.getPortalStatus(CUSTOMER_ID, TENANT_ID);

      expect(result.status).toBe("ACTIVE");
      expect(result.buyerName).toBeNull();
      expect(result.buyerEmail).toBeNull();
      // ACTIVE keeps its existing full buyerAccount object — additive, not replaced.
      expect(result.buyerAccount).toEqual({
        id: "buyer-1",
        email: "jane@buyer.test",
        name: "Jane Buyer",
      });
    });
  });
});
