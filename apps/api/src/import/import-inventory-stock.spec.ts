import { Test } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { ImportService } from "./import.service";
import { PrismaService } from "../prisma/prisma.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { CustomersService } from "../customers/customers.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { NumberingService } from "./numbering.service";
import { ExternalRefService } from "./external-ref.service";
import { ProductsService } from "../products/products.service";
import { AuditService } from "../audit/audit.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

/**
 * B568: the Zoho stock sync (`ImportService.importInventory`), existing-product branch, moves the
 * counter and writes its ADJUSTMENT row in ONE stock transaction, under the Product row lock, from
 * the LOCKED stock (L-301: the guard value is read after the lock, in the tx that writes).
 */
describe("ImportService.importInventory — existing product stock sync is atomic and locked (B568)", () => {
  const D = (v: number | string) => new Prisma.Decimal(v);
  let service: ImportService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let order: string[];
  let tx: {
    $executeRaw: jest.Mock;
    product: { findFirst: jest.Mock; update: jest.Mock };
    stockMovement: { create: jest.Mock };
  };
  let txRejection: unknown;

  const CSV = "Item Name,SKU,Closing Stock\nWidget A,SKU-A,80\n";

  beforeEach(async () => {
    prisma = createMockPrisma();
    order = [];
    txRejection = undefined;
    tx = {
      $executeRaw: jest.fn(async () => {
        order.push("lock");
        return 0;
      }),
      product: {
        // the LOCKED read: another writer committed a sale of 10 after the pre-read saw 100
        findFirst: jest.fn(async () => {
          order.push("read");
          return { id: "prod-1", currentStock: D(90), averageCost: D("2.5") };
        }),
        update: jest.fn(async () => {
          order.push("update");
          return { currentStock: D(80) };
        }),
      },
      stockMovement: {
        create: jest.fn(async () => {
          order.push("movement");
          return { id: "mv-1" };
        }),
      },
    };
    (prisma as any).tenantTransaction = jest.fn(async (fn: any) => {
      try {
        return await fn(tx);
      } catch (e) {
        txRejection = e;
        throw e;
      }
    });
    // the pre-tx read only resolves the id; its stock value (100) is stale on purpose
    prisma.product.findFirst.mockResolvedValue({ id: "prod-1", currentStock: 100 });

    const mod = await Test.createTestingModule({
      providers: [
        ImportService,
        { provide: PrismaService, useValue: prisma },
        { provide: VendorBillsService, useValue: { create: jest.fn(), receive: jest.fn() } },
        {
          provide: CustomersService,
          useValue: {
            assertCustomerCapNotExceeded: jest.fn().mockResolvedValue(undefined),
            maybeStartCustomerGrace: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
        {
          provide: ExternalRefService,
          useValue: { findLocalId: jest.fn().mockResolvedValue(null), record: jest.fn() },
        },
        { provide: ProductsService, useValue: { create: jest.fn(), update: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: SellingRestrictionsService,
          useValue: {
            checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
          },
        },
      ],
    }).compile();
    service = mod.get(ImportService);
  });

  it("U1: the counter update and the ADJUSTMENT both go through the tx, never the ambient client, on the stock tx budget", async () => {
    const res = await service.importInventory(Buffer.from(CSV), "user-1");

    expect(res).toMatchObject({ updated: 1, created: 0, skipped: 0 });
    expect(tx.product.update).toHaveBeenCalledTimes(1);
    expect(tx.stockMovement.create).toHaveBeenCalledTimes(1);
    expect(prisma.product.update).not.toHaveBeenCalled();
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    expect((prisma as any).tenantTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ timeout: 15_000 }),
    );
  });

  it("U1b: a movement rejection propagates out of the tx callback that already ran the update, and the row is booked skipped", async () => {
    tx.stockMovement.create.mockRejectedValueOnce(new Error("movement boom"));

    const res = await service.importInventory(Buffer.from(CSV), "user-1");

    expect(tx.product.update).toHaveBeenCalledTimes(1); // same callback as the failing movement
    expect(txRejection).toEqual(expect.objectContaining({ message: "movement boom" }));
    expect(res.updated).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.errors).toEqual(["Widget A: import failed"]); // pushRowError redacts the cause
  });

  it("U1c: after a rolled-back failure a re-import of the same CSV writes the ADJUSTMENT", async () => {
    tx.stockMovement.create.mockRejectedValueOnce(new Error("movement boom"));
    await service.importInventory(Buffer.from(CSV), "user-1");
    expect(tx.stockMovement.create).toHaveBeenCalledTimes(1);

    const res = await service.importInventory(Buffer.from(CSV), "user-1");

    expect(res.updated).toBe(1);
    expect(tx.stockMovement.create).toHaveBeenCalledTimes(2);
    const data = tx.stockMovement.create.mock.calls[1][0].data;
    expect(data.type).toBe("ADJUSTMENT");
    expect(Number(data.quantity)).toBe(-10);
  });

  it("U2: the call order is lock, then the locked read, then the counter update, then the movement", async () => {
    await service.importInventory(Buffer.from(CSV), "user-1");

    // lockProductsForStock issues several $executeRaw statements; collapse the run
    const collapsed = order.filter((e, i) => i === 0 || e !== order[i - 1]);
    expect(collapsed).toEqual(["lock", "read", "update", "movement"]);
  });

  it("U3: the delta is the CSV closing minus the LOCKED stock (pre-read 100, locked 90, closing 80 -> -10, not -20)", async () => {
    await service.importInventory(Buffer.from(CSV), "user-1");

    const upd = tx.product.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: "prod-1" });
    expect(Number(upd.data.currentStock.increment)).toBe(-10);
    const mv = tx.stockMovement.create.mock.calls[0][0].data;
    expect(Number(mv.quantity)).toBe(-10);
    expect(mv.type).toBe("ADJUSTMENT");
    expect(mv.notes).toBe("Zoho stock sync");
    expect(mv.performedById).toBe("user-1");
  });

  it("U4: stockAfter is the counter the same tx's update returned; avgCostAfter is the locked average", async () => {
    tx.product.update.mockImplementationOnce(async () => {
      order.push("update");
      return { currentStock: D(79) }; // whatever the tx returns is what the row records
    });

    await service.importInventory(Buffer.from(CSV), "user-1");

    const mv = tx.stockMovement.create.mock.calls[0][0].data;
    expect(Number(mv.stockAfter)).toBe(79);
    expect(Number(mv.avgCostAfter)).toBe(2.5);
  });

  it("U5: a closing stock equal to the locked stock writes nothing", async () => {
    tx.product.findFirst.mockImplementationOnce(async () => ({
      id: "prod-1",
      currentStock: D(80),
      averageCost: D("2.5"),
    }));

    const res = await service.importInventory(Buffer.from(CSV), "user-1");

    expect(tx.product.findFirst).toHaveBeenCalledTimes(1); // the locked read did run
    expect(tx.product.update).not.toHaveBeenCalled();
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
    expect(prisma.product.update).not.toHaveBeenCalled();
    expect(res.updated).toBe(1);
    expect(res.skipped).toBe(0);
  });
});
