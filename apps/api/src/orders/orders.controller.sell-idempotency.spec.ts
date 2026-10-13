jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { OrdersController } from "./orders.controller";
import { OrderBatchShipService } from "./order-batch-ship";
import { PackingSlipService } from "./packing-slip.service";
import { OrdersService } from "./orders.service";
import { ChangeRequestsService } from "./change-requests.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";

/**
 * Row 485: POST /orders/sell takes an optional `Idempotency-Key` header and hands it to createSale as the
 * internal dto.idempotencyKey (a body-sent key is still refused by the DTO whitelist), so a retried New
 * sale resumes the stored order instead of writing a second one.
 */
const operator: JwtPayload = {
  sub: "user-op",
  username: "operator",
  role: "OPERATOR",
  status: "ACTIVE",
  forcePasswordChange: false,
  tenantId: null,
  tenantSlug: null,
};

describe("OrdersController.sell — Idempotency-Key header (row 485)", () => {
  let controller: OrdersController;
  const createSale = jest.fn();

  beforeEach(async () => {
    createSale.mockReset().mockResolvedValue({ id: "inv-1" });
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrdersController],
      providers: [
        { provide: OrdersService, useValue: { createSale } },
        { provide: ChangeRequestsService, useValue: {} },
        { provide: OrderBatchShipService, useValue: {} },
        { provide: PackingSlipService, useValue: {} },
      ],
    }).compile();
    controller = module.get(OrdersController);
  });

  const dto = () => ({ customerId: "c1", items: [{ productId: "p1", qty: 1 }] }) as never;

  it("threads the header onto the dto as idempotencyKey", async () => {
    await controller.sell(dto(), operator, "key-123");
    expect(createSale.mock.calls[0][0]).toMatchObject({
      customerId: "c1",
      idempotencyKey: "key-123",
    });
  });

  it("trims it, and a blank or absent header means no key", async () => {
    await controller.sell(dto(), operator, "  key-9  ");
    expect(createSale.mock.calls[0][0].idempotencyKey).toBe("key-9");
    await controller.sell(dto(), operator, "   ");
    await controller.sell(dto(), operator);
    expect(createSale.mock.calls[1][0]).not.toHaveProperty("idempotencyKey");
    expect(createSale.mock.calls[2][0]).not.toHaveProperty("idempotencyKey");
  });

  it("refuses an oversized or spaced key before it reaches the service", () => {
    expect(() => controller.sell(dto(), operator, "x".repeat(129))).toThrow(BadRequestException);
    expect(() => controller.sell(dto(), operator, "a b")).toThrow(BadRequestException);
    expect(createSale).not.toHaveBeenCalled();
  });
});
