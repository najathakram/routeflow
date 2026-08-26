import { Test } from "@nestjs/testing";
import { NotificationEvent } from "@prisma/client";
import { MessagingService } from "./messaging.service";
import { MESSAGE_PROVIDER } from "./providers/message-provider.interface";
import { PrismaService } from "../prisma/prisma.service";
import { MeterService } from "../billing/meter.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { formatDate, formatMoney } from "./messaging.helpers";

// ─── Pure formatters ────────────────────────────────────────────────────────

describe("formatMoney", () => {
  it("formats a plain number", () => {
    expect(formatMoney(16.47)).toBe("$16.47");
  });

  it("formats a numeric string (Decimal serialized)", () => {
    expect(formatMoney("1234.5")).toBe("$1,234.50");
  });

  it("formats a Decimal-like value coercible via Number()", () => {
    expect(formatMoney(10)).toBe("$10.00");
  });

  it("defaults null to $0.00", () => {
    expect(formatMoney(null)).toBe("$0.00");
  });

  it("defaults a non-numeric value to $0.00", () => {
    expect(formatMoney("not-a-number")).toBe("$0.00");
  });
});

describe("formatDate", () => {
  it("formats a Date as long-style US date", () => {
    expect(formatDate(new Date(2026, 6, 14))).toMatch(/2026/);
  });

  it("returns an empty string for null", () => {
    expect(formatDate(null)).toBe("");
  });

  it("returns an empty string for undefined", () => {
    expect(formatDate(undefined)).toBe("");
  });

  it("returns an empty string for an invalid date string", () => {
    expect(formatDate("not-a-date")).toBe("");
  });
});

// ─── resolveSystemSenderId + notifyEvent ────────────────────────────────────

describe("MessagingService (P6-5 notifyEvent + resolveSystemSenderId)", () => {
  let service: MessagingService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let provider: { send: jest.Mock };
  let meter: { increment: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    provider = { send: jest.fn().mockResolvedValue({ providerMsgId: "stub-1", status: "queued" }) };
    meter = { increment: jest.fn().mockResolvedValue(undefined) };

    const mod = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: PrismaService, useValue: prisma },
        { provide: MeterService, useValue: meter },
        { provide: MESSAGE_PROVIDER, useValue: provider },
      ],
    }).compile();
    service = mod.get(MessagingService);
  });

  describe("resolveSystemSenderId", () => {
    it("returns null without querying when tenantId is null", async () => {
      const result = await service.resolveSystemSenderId(null);
      expect(result).toBeNull();
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
    });

    it("prefers the oldest ACTIVE TENANT_ADMIN", async () => {
      prisma.user.findFirst.mockResolvedValueOnce({ id: "admin-1" });
      const result = await service.resolveSystemSenderId("tenant-1");
      expect(result).toBe("admin-1");
      expect(prisma.user.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: "tenant-1",
            role: "TENANT_ADMIN",
            status: "ACTIVE",
          }),
        }),
      );
    });

    it("falls back to the oldest ACTIVE OPERATOR when no admin exists", async () => {
      prisma.user.findFirst
        .mockResolvedValueOnce(null) // admin lookup
        .mockResolvedValueOnce({ id: "op-1" }); // operator lookup
      const result = await service.resolveSystemSenderId("tenant-1");
      expect(result).toBe("op-1");
      expect(prisma.user.findFirst).toHaveBeenCalledTimes(2);
    });

    it("returns null when neither an admin nor an operator exists", async () => {
      prisma.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      const result = await service.resolveSystemSenderId("tenant-1");
      expect(result).toBeNull();
    });
  });

  describe("notifyEvent", () => {
    it("uses the explicit senderId and auto-fills customerName from Customer.businessName", async () => {
      const notifySpy = jest.spyOn(service, "notify").mockResolvedValue([]);
      prisma.customer.findFirst.mockResolvedValue({ businessName: "Acme Foods" });

      await service.notifyEvent(NotificationEvent.ORDER_CONFIRMED, {
        customerId: "cust-1",
        senderId: "user-op",
        vars: { orderNumber: "SO-1" },
      });

      expect(prisma.customer.findFirst).toHaveBeenCalledWith({
        where: { id: "cust-1" },
        select: { businessName: true },
      });
      expect(notifySpy).toHaveBeenCalledWith(NotificationEvent.ORDER_CONFIRMED, {
        customerId: "cust-1",
        senderId: "user-op",
        vars: { orderNumber: "SO-1", customerName: "Acme Foods" },
      });
    });

    it("does not overwrite a caller-supplied customerName and skips the lookup", async () => {
      const notifySpy = jest.spyOn(service, "notify").mockResolvedValue([]);

      await service.notifyEvent(NotificationEvent.ORDER_CONFIRMED, {
        customerId: "cust-1",
        senderId: "user-op",
        vars: { customerName: "Caller Co" },
      });

      expect(prisma.customer.findFirst).not.toHaveBeenCalled();
      expect(notifySpy).toHaveBeenCalledWith(NotificationEvent.ORDER_CONFIRMED, {
        customerId: "cust-1",
        senderId: "user-op",
        vars: { customerName: "Caller Co" },
      });
    });

    it("resolves the system sender from tenant context when senderId is null", async () => {
      const notifySpy = jest.spyOn(service, "notify").mockResolvedValue([]);
      prisma.user.findFirst.mockResolvedValueOnce({ id: "admin-1" });
      prisma.customer.findFirst.mockResolvedValue({ businessName: "Acme Foods" });

      await service.notifyEvent(NotificationEvent.LICENSE_EXPIRING, {
        customerId: "cust-1",
        senderId: null,
      });

      expect(prisma.getTenantId).toHaveBeenCalled();
      expect(prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ tenantId: "test-tenant" }) }),
      );
      expect(notifySpy).toHaveBeenCalledWith(
        NotificationEvent.LICENSE_EXPIRING,
        expect.objectContaining({ senderId: "admin-1" }),
      );
    });

    it("skips without notifying or throwing when no sender can be resolved", async () => {
      const notifySpy = jest.spyOn(service, "notify").mockResolvedValue([]);
      prisma.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

      await expect(
        service.notifyEvent(NotificationEvent.LICENSE_EXPIRING, {
          customerId: "cust-1",
          senderId: null,
        }),
      ).resolves.toBeUndefined();

      expect(notifySpy).not.toHaveBeenCalled();
    });

    it("never rejects even when notify() throws", async () => {
      jest.spyOn(service, "notify").mockRejectedValue(new Error("boom"));

      await expect(
        service.notifyEvent(NotificationEvent.ORDER_CONFIRMED, {
          customerId: "cust-1",
          senderId: "user-op",
        }),
      ).resolves.toBeUndefined();
    });
  });
});
