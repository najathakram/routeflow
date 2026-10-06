/**
 * Invoice at SHIPMENT for carrier orders of a shipping tenant (and the DELIVERED path it shares a body with).
 * Boundaries mocked: the feature-config mode and the invoices service.
 */
import { ConflictException, Logger } from "@nestjs/common";
import { FulfillPath, OrderStatus } from "@prisma/client";
import {
  SHIPPING_FULFILMENT_MODES,
  invoicesAtShipment,
  settleOrderInvoice,
} from "./order-status-invoicing";

const cfg = (mode: string) => ({ getEffectiveMode: jest.fn().mockResolvedValue(mode) });
const SHIP = { fulfillPath: FulfillPath.SHIP };
const ROUTE = { fulfillPath: FulfillPath.ROUTE };
const OUT = OrderStatus.OUT_FOR_DELIVERY;

describe("invoicesAtShipment", () => {
  it.each(["ship", "both", "pickup_ship"])(
    "a SHIP order going out for delivery invoices at shipment in %s mode",
    async (mode) => {
      expect(SHIPPING_FULFILMENT_MODES.has(mode)).toBe(true);
      const c = cfg(mode);
      await expect(invoicesAtShipment(c, "t1", SHIP, OUT)).resolves.toBe(true);
      expect(c.getEffectiveMode).toHaveBeenCalledWith("t1", "fulfilment_model");
    },
  );

  it.each(["unset", "pickup", "route", "", "garbage"])(
    "an unset / non-shipping mode (%s) is unchanged: no invoice at shipment",
    async (mode) => {
      await expect(invoicesAtShipment(cfg(mode), "t1", SHIP, OUT)).resolves.toBe(false);
    },
  );

  it("a ROUTE order never invoices at shipment, and the mode is not even read", async () => {
    const c = cfg("ship");
    await expect(invoicesAtShipment(c, "t1", ROUTE, OUT)).resolves.toBe(false);
    expect(c.getEffectiveMode).not.toHaveBeenCalled();
  });

  it.each([OrderStatus.CONFIRMED, OrderStatus.DELIVERED, OrderStatus.PARTIALLY_DELIVERED])(
    "only the OUT_FOR_DELIVERY transition counts as shipped (not %s): no partial ship is invented",
    async (to) => {
      await expect(invoicesAtShipment(cfg("ship"), "t1", SHIP, to)).resolves.toBe(false);
    },
  );

  it("no feature-config service / no tenant / an unreadable mode all read as unset", async () => {
    await expect(invoicesAtShipment(undefined, "t1", SHIP, OUT)).resolves.toBe(false);
    await expect(invoicesAtShipment(cfg("ship"), null, SHIP, OUT)).resolves.toBe(false);
    const broken = { getEffectiveMode: jest.fn().mockRejectedValue(new Error("db down")) };
    await expect(invoicesAtShipment(broken, "t1", SHIP, OUT)).resolves.toBe(false);
  });
});

describe("settleOrderInvoice", () => {
  const logger = { error: jest.fn() } as unknown as Logger;
  const harness = () => {
    const invoicesService = {
      findOpenOrderDraft: jest.fn().mockResolvedValue(null),
      reconcileOrderDraftInvoice: jest.fn().mockResolvedValue({ id: "d1" }),
      createInvoiceFromOrderWithTenant: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
    };
    const self = { invoicesService, prisma: { getTenantId: () => "t1" } } as any;
    return { self, invoicesService };
  };

  it("no open draft: creates the invoice once, for the captured tenant", async () => {
    const { self, invoicesService } = harness();
    await expect(settleOrderInvoice(self, "ord-1", logger, "shipped")).resolves.toBeUndefined();
    expect(invoicesService.createInvoiceFromOrderWithTenant).toHaveBeenCalledTimes(1);
    expect(invoicesService.createInvoiceFromOrderWithTenant).toHaveBeenCalledWith("ord-1", "t1");
    expect(invoicesService.reconcileOrderDraftInvoice).not.toHaveBeenCalled();
  });

  it("an open mirror draft is reconciled at basis 'order' and nothing is created (an order NOT settled at shipment: ROUTE, unset mode, or never shipped)", async () => {
    const { self, invoicesService } = harness();
    invoicesService.findOpenOrderDraft.mockResolvedValue({ id: "d1" });
    await settleOrderInvoice(self, "ord-1", logger, "delivered");
    expect(invoicesService.reconcileOrderDraftInvoice).toHaveBeenCalledWith("ord-1", {
      basis: "order",
    });
    expect(invoicesService.createInvoiceFromOrderWithTenant).not.toHaveBeenCalled();
  });

  it("M1: DELIVERED after a shipment-time settle does NOT reconcile the draft (staff edits since shipment survive)", async () => {
    const { self, invoicesService } = harness();
    invoicesService.findOpenOrderDraft.mockResolvedValue({ id: "d1" }); // the shipment invoice, edited since
    await settleOrderInvoice(self, "ord-1", logger, "delivered", true);
    expect(invoicesService.reconcileOrderDraftInvoice).not.toHaveBeenCalled();
    // the un-invoiced-remainder create still runs (it returns the existing invoice when nothing is left)
    expect(invoicesService.createInvoiceFromOrderWithTenant).toHaveBeenCalledTimes(1);
  });

  it("S3: a reconcile that throws at shipment is returned, never thrown (the transition and the email go on)", async () => {
    const { self, invoicesService } = harness();
    invoicesService.findOpenOrderDraft.mockResolvedValue({ id: "d1" });
    invoicesService.reconcileOrderDraftInvoice.mockRejectedValue(new Error("tx conflict"));
    const out = await settleOrderInvoice(self, "ord-1", logger, "shipped");
    expect(out).toBeInstanceOf(ConflictException);
    expect(out?.message).toContain("marked shipped");
    expect(out?.message).toContain("tx conflict");
  });

  it("shipped then delivered: the second pass reuses the one invoice and never creates another", async () => {
    // The real service bills only each line's un-invoiced remainder, so with nothing left it returns the
    // existing invoice(s) instead of a new one. Model that contract and drive both moments.
    const { self, invoicesService } = harness();
    const invoices: { id: string }[] = [];
    invoicesService.createInvoiceFromOrderWithTenant.mockImplementation(async () => {
      if (invoices.length === 0) invoices.push({ id: "inv-1" });
      return invoices;
    });
    await settleOrderInvoice(self, "ord-1", logger, "shipped");
    await settleOrderInvoice(self, "ord-1", logger, "delivered");
    expect(invoices).toHaveLength(1);
  });

  it("retries ONLY a ConflictException (order-number race), up to 3 attempts, then succeeds", async () => {
    const { self, invoicesService } = harness();
    invoicesService.createInvoiceFromOrderWithTenant
      .mockRejectedValueOnce(new ConflictException("race"))
      .mockRejectedValueOnce(new ConflictException("race"))
      .mockResolvedValueOnce([{ id: "inv-1" }]);
    await expect(settleOrderInvoice(self, "ord-1", logger, "shipped")).resolves.toBeUndefined();
    expect(invoicesService.createInvoiceFromOrderWithTenant).toHaveBeenCalledTimes(3);
  });

  it("a non-Conflict error stops at once and is returned (not thrown), with the moment in the message", async () => {
    const { self, invoicesService } = harness();
    invoicesService.createInvoiceFromOrderWithTenant.mockRejectedValue(new Error("boom"));
    const shipped = await settleOrderInvoice(self, "ord-1", logger, "shipped");
    expect(invoicesService.createInvoiceFromOrderWithTenant).toHaveBeenCalledTimes(1);
    expect(shipped).toBeInstanceOf(ConflictException);
    expect(shipped?.message).toContain("marked shipped");
    expect(shipped?.message).toContain("the order stays shipped and nothing has been billed yet");
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("after 1 attempt(s): boom"));

    const delivered = await settleOrderInvoice(self, "ord-1", logger, "delivered");
    expect(delivered?.message).toContain("marked delivered");
    expect(delivered?.message).toContain("the order stays delivered");
  });

  it("three Conflict failures give up after exactly 3 attempts", async () => {
    const { self, invoicesService } = harness();
    invoicesService.createInvoiceFromOrderWithTenant.mockRejectedValue(new ConflictException("x"));
    await expect(settleOrderInvoice(self, "ord-1", logger, "delivered")).resolves.toBeInstanceOf(
      ConflictException,
    );
    expect(invoicesService.createInvoiceFromOrderWithTenant).toHaveBeenCalledTimes(3);
  });
});
