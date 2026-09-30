import { BadRequestException } from "@nestjs/common";
import { assertBuyerDiffShape, classifyEditPayload } from "./order-edit-payload";
import type { UpdateOrderItemsDto } from "./dto/update-order-items.dto";

describe("classifyEditPayload (A4/B13 payload classification)", () => {
  const order = { lineItems: [{ id: "li-unlisted", productId: null }] };

  it("a plain replace-all payload (no id/action/substitute entries) is not a diff", () => {
    const dto = { items: [{ productId: "p1", qty: 2 }] } as UpdateOrderItemsDto;
    expect(classifyEditPayload(order, dto, { role: "OPERATOR" })).toBe(false);
  });

  it("replaceAll: false is a diff even with no id/action entries", () => {
    const dto = { replaceAll: false, items: [{ productId: "p1", qty: 2 }] } as UpdateOrderItemsDto;
    expect(classifyEditPayload(order, dto, { role: "OPERATOR" })).toBe(true);
  });

  it("an id/action/substituteProductId entry is a diff even with replaceAll unset", () => {
    const dto = { items: [{ id: "li-1", action: "CANCEL" }] } as UpdateOrderItemsDto;
    expect(classifyEditPayload(order, dto, { role: "OPERATOR" })).toBe(true);
  });

  it("a CUSTOMER diff payload is classified, not refused here: the 400 is assertBuyerDiffShape's, after the unit guard (SA-507a)", async () => {
    const dto = { replaceAll: false, items: [{ id: "li-1", qty: 3 }] } as UpdateOrderItemsDto;
    expect(classifyEditPayload(order, dto, { role: "CUSTOMER" })).toBe(true);
    await expect(
      assertBuyerDiffShape(
        { customerId: "c1", ...order } as any,
        dto,
        { role: "CUSTOMER" },
        true,
        async () => ({ id: "c1" }),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("a DRIVER diff payload strips unitPrice/overrideReason from catalog-linked entries only", () => {
    const dto = {
      replaceAll: false,
      items: [
        { id: "li-catalog", productId: "p1", qty: 3, unitPrice: 9.99, overrideReason: "damaged" },
        { id: "li-unlisted", qty: 1, unitPrice: 5, overrideReason: "custom" },
      ],
    } as UpdateOrderItemsDto;
    const isDiff = classifyEditPayload(order, dto, { role: "DRIVER" });
    expect(isDiff).toBe(true);
    expect(dto.items![0]).not.toHaveProperty("unitPrice");
    expect(dto.items![0]).not.toHaveProperty("overrideReason");
    expect(dto.items![0]).toMatchObject({ id: "li-catalog", productId: "p1", qty: 3 });
    // The unlisted line (id matches order.lineItems' unlisted row) keeps its client price —
    // it has no catalog price to fall back to.
    expect(dto.items![1]).toMatchObject({ unitPrice: 5, overrideReason: "custom" });
  });

  it("an OPERATOR diff payload is never price-stripped (B13 targets non-staff only)", () => {
    const dto = {
      replaceAll: false,
      items: [{ id: "li-catalog", productId: "p1", qty: 3, unitPrice: 9.99 }],
    } as UpdateOrderItemsDto;
    classifyEditPayload(order, dto, { role: "OPERATOR" });
    expect(dto.items![0]).toMatchObject({ unitPrice: 9.99 });
  });

  it("a fresh (id-less) unlisted DRIVER entry with a real name keeps its price too", () => {
    const dto = {
      replaceAll: false,
      items: [
        { id: "li-catalog", productId: "p1", qty: 1, unitPrice: 1 },
        { name: "Pallet deposit", qty: 1, unitPrice: 15 },
      ],
    } as UpdateOrderItemsDto;
    classifyEditPayload(order, dto, { role: "DRIVER" });
    expect(dto.items![1]).toMatchObject({ name: "Pallet deposit", unitPrice: 15 });
  });
});
