/**
 * D-12: POST /inventory/purchase-orders took an unbound `@Body() dto: any`, so the global
 * ValidationPipe (whitelist + forbidNonWhitelisted) had no metatype to check and passed anything
 * through. The endpoint is now bound to CreatePurchaseOrderDto, which describes the payloads every
 * real client sends: web's per-piece `qty`, mobile's per-piece `qtyOrdered`, and the per-case
 * `packSize`/`caseCost`/`cases`/`loosePieces` both of them send for a boxed product.
 */
import "reflect-metadata";
import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { InventoryController } from "./inventory.controller";
import { CreatePurchaseOrderDto } from "./dto/create-purchase-order.dto";

const SUPPLIER = "22222222-2222-4222-8222-222222222222";
const PRODUCT = "11111111-1111-4111-8111-111111111111";

// The exact options main.ts registers globally.
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

/** Runs a body through the global pipe with the metatype the controller actually declares. */
const throughEndpoint = (body: unknown) => {
  const [metatype] = Reflect.getMetadata(
    "design:paramtypes",
    InventoryController.prototype,
    "createPO",
  );
  return pipe.transform(body, { type: "body", metatype });
};

describe("D-12: POST /inventory/purchase-orders is bound to CreatePurchaseOrderDto", () => {
  it("the endpoint's body is typed as the DTO, so the global pipe validates it", () => {
    const [metatype] = Reflect.getMetadata(
      "design:paramtypes",
      InventoryController.prototype,
      "createPO",
    );
    expect(metatype).toBe(CreatePurchaseOrderDto);
  });

  it("REG-D12: an unknown top-level field is a 400", async () => {
    await expect(
      throughEndpoint({
        supplierId: SUPPLIER,
        items: [{ productId: PRODUCT, qty: 5, unitCost: 4 }],
        status: "RECEIVED",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("REG-D12: an unknown line field is a 400", async () => {
    await expect(
      throughEndpoint({
        supplierId: SUPPLIER,
        items: [{ productId: PRODUCT, qty: 5, unitCost: 4, totalCost: 1 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  describe("every valid create a real client sends passes unchanged", () => {
    it("web per-piece line (qty + unitCost), with notes and an expected date", async () => {
      const body = {
        supplierId: SUPPLIER,
        expectedDate: "2026-10-01",
        notes: "e2e PO",
        items: [{ productId: PRODUCT, qty: 5, unitCost: 4 }],
      };
      await expect(throughEndpoint(body)).resolves.toMatchObject(body);
    });

    it("mobile per-piece line (qtyOrdered + unitCost), including a decimal-unit quantity", async () => {
      const body = {
        supplierId: SUPPLIER,
        items: [{ productId: PRODUCT, qtyOrdered: 2.5, unitCost: 3.25 }],
      };
      await expect(throughEndpoint(body)).resolves.toMatchObject(body);
    });

    it("per-case line (packSize + caseCost + cases + loosePieces), web and mobile alike", async () => {
      const body = {
        supplierId: SUPPLIER,
        items: [{ productId: PRODUCT, packSize: 12, caseCost: 11, cases: 1000, loosePieces: 3 }],
      };
      await expect(throughEndpoint(body)).resolves.toMatchObject(body);
    });
  });

  it("PIN: a line with neither form, or a case line with no case count, is a 400", async () => {
    await expect(
      throughEndpoint({ supplierId: SUPPLIER, items: [{ productId: PRODUCT }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      throughEndpoint({
        supplierId: SUPPLIER,
        items: [{ productId: PRODUCT, packSize: 12, caseCost: 11 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
