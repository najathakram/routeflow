/**
 * SA-1101 §2.5 (RO-9, RO-9b): staff may record a return on a REFUSED order (how the refused goods go back to
 * stock, SA-1098 A-1); a CUSTOMER may not and gets the same 400 as for any undelivered order. The status gate is
 * the first thing after the order read, so a stub transaction that returns only the order proves it; the stock
 * and credit figures are proven against real Postgres in stop-outcome-refused.db.spec.ts (RO-9).
 */
import { BadRequestException } from "@nestjs/common";
import { ReturnsService } from "./returns.service";

const GATE_MESSAGE = "Returns can only be submitted for delivered orders";

function serviceWithOrder(status: string, customerOwnerId = "cust-1") {
  const tx = {
    order: {
      findUnique: jest.fn().mockResolvedValue({
        id: "o1",
        status,
        customerId: customerOwnerId,
        lineItems: [],
        invoices: [],
      }),
    },
    customer: { findFirst: jest.fn().mockResolvedValue({ id: customerOwnerId }) },
  };
  const prisma: any = {
    getTenantId: () => "t1",
    tenantTransaction: (fn: (t: unknown) => unknown) => fn(tx),
  };
  return new ReturnsService(prisma, {} as any, {} as any, {} as any, {} as any);
}
const dto = { orderId: "o1", reason: "DAMAGED", items: [{ orderItemId: "i1", quantity: 1 }] };

describe("returns.create: which order statuses are returnable (SA-1101)", () => {
  it("RO-9b: a CUSTOMER on a REFUSED order gets the 400, as for any undelivered order", async () => {
    await expect(serviceWithOrder("REFUSED").create(dto, "u1", "CUSTOMER")).rejects.toThrow(
      new BadRequestException(GATE_MESSAGE),
    );
  });

  it.each(["OPERATOR", "TENANT_ADMIN", "DRIVER"])(
    "RO-9: %s on a REFUSED order gets past the status gate",
    async (role) => {
      // Past the gate the stub has no lines, so something later refuses: never the status message.
      await expect(serviceWithOrder("REFUSED").create(dto, "u1", role)).rejects.not.toThrow(
        GATE_MESSAGE,
      );
    },
  );

  it("an unknown role (no role at all) is not let through on a REFUSED order", async () => {
    await expect(serviceWithOrder("REFUSED").create(dto, "u1", undefined)).rejects.toThrow(
      GATE_MESSAGE,
    );
  });

  it.each(["CONFIRMED", "OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED", "CANCELLED"])(
    "a %s order is still refused for everyone, staff included",
    async (status) => {
      await expect(serviceWithOrder(status).create(dto, "u1", "OPERATOR")).rejects.toThrow(
        GATE_MESSAGE,
      );
    },
  );

  it("a DELIVERED order is past the gate for staff and customer alike (unchanged)", async () => {
    for (const role of ["OPERATOR", "CUSTOMER"]) {
      await expect(serviceWithOrder("DELIVERED").create(dto, "u1", role)).rejects.not.toThrow(
        GATE_MESSAGE,
      );
    }
  });
});
