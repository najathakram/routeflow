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
import { wireStockHelper } from "../inventory/testing/stock-helper-mock";

let stock!: ReturnType<typeof wireStockHelper>;

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
    product: { update: jest.Mock };
    stockMovement: { create: jest.Mock };
  };
  let txRejection: unknown;
  // SA-927: the locked read is the stock helper's own tenant-scoped read (a $queryRaw), served by this spy
  let lockedRead: jest.Mock;

  const CSV = "Item Name,SKU,Closing Stock\nWidget A,SKU-A,80\n";

  beforeEach(async () => {
    prisma = createMockPrisma();
    stock = wireStockHelper(prisma, { ample: true });
    order = [];
    txRejection = undefined;
    tx = {
      $executeRaw: jest.fn(async () => {
        order.push("lock");
        return 0;
      }),
      product: {
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
    // the LOCKED read: another writer committed a sale of 10 after the pre-read saw 100
    lockedRead = jest.fn(async () => {
      order.push("read");
      return [{ id: "prod-1", currentStock: D(90), averageCost: D("2.5") }];
    });
    stock.setState(lockedRead);
    (prisma as any).tenantTransaction = jest.fn(async (fn: any) => {
      try {
        return await fn(stock.wrapTx(tx));
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

    // SA-927: the helper inserts the rows before it writes the counter, so the rejected movement leaves
    // no counter write behind at all
    expect(tx.product.update).not.toHaveBeenCalled();
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

  it("U2: the call order is lock, then the locked read, then the movement, then the counter write (SA-927: rows first)", async () => {
    await service.importInventory(Buffer.from(CSV), "user-1");

    // lockProductsForStock issues several $executeRaw statements; collapse the run
    const collapsed = order.filter((e, i) => i === 0 || e !== order[i - 1]);
    expect(collapsed).toEqual(["lock", "read", "movement", "update"]);
  });

  it("U3: the delta is the CSV closing minus the LOCKED stock (pre-read 100, locked 90, closing 80 -> -10, not -20)", async () => {
    await service.importInventory(Buffer.from(CSV), "user-1");

    const upd = tx.product.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: "prod-1" });
    expect(Number(upd.data.currentStock)).toBe(80); // locked 90 + delta -10, written absolute
    const mv = tx.stockMovement.create.mock.calls[0][0].data;
    expect(Number(mv.quantity)).toBe(-10);
    expect(mv.type).toBe("ADJUSTMENT");
    expect(mv.notes).toBe("Zoho stock sync");
    expect(mv.performedById).toBe("user-1");
  });

  it("U4: stockAfter is the locked counter plus the delta; avgCostAfter is the locked average", async () => {
    await service.importInventory(Buffer.from(CSV), "user-1");

    const mv = tx.stockMovement.create.mock.calls[0][0].data;
    expect(Number(mv.stockAfter)).toBe(80);
    expect(Number(mv.avgCostAfter)).toBe(2.5);
  });

  it("U5: a closing stock equal to the locked stock writes nothing", async () => {
    lockedRead.mockImplementationOnce(async () => {
      order.push("read");
      return [{ id: "prod-1", currentStock: D(80), averageCost: D("2.5") }];
    });

    const res = await service.importInventory(Buffer.from(CSV), "user-1");

    expect(lockedRead).toHaveBeenCalledTimes(1); // the locked read did run
    expect(tx.product.update).not.toHaveBeenCalled();
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
    expect(prisma.product.update).not.toHaveBeenCalled();
    expect(res.updated).toBe(1);
    expect(res.skipped).toBe(0);
  });
});
