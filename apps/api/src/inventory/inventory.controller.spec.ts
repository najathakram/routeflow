import "reflect-metadata";
import { InventoryController } from "./inventory.controller";
import { ReceivePurchaseOrderDto } from "./dto/create-purchase-order.dto";

/**
 * B780 — POST purchase-orders/:id/receive is unvalidated today (paramtype
 * `Object` in the compiled controller: `any` carries no runtime class, the
 * same erasure as a mapped TS type — B777/#1295's exact root cause). Mirrors
 * that PR's InvoicesController paramtypes pin.
 */
describe("InventoryController — POST purchase-orders/:id/receive body metatype (B780)", () => {
  it("REG-B780: receivePO()'s body param is ReceivePurchaseOrderDto, never the bare Object `any` erases to", () => {
    const paramTypes = Reflect.getMetadata(
      "design:paramtypes",
      InventoryController.prototype,
      "receivePO",
    ) as unknown[];
    // receivePO(id: string, dto: ReceivePurchaseOrderDto, user): the body is the second param.
    expect(paramTypes?.[1]).toBe(ReceivePurchaseOrderDto);
    expect(paramTypes?.[1]).not.toBe(Object);
  });
});
