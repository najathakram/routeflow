import { ValidationPipe } from "@nestjs/common";
import { ReceivePurchaseOrderDto } from "./create-purchase-order.dto";

/**
 * B780 — POST purchase-orders/:id/receive is unvalidated today (paramtype
 * `Object` in the compiled controller: `any` carries no runtime class), so
 * whitelist/forbidNonWhitelisted/transform never engage — a string
 * receivedQty sails through to `Number(item.qtyReceived) + actualQty`, which
 * string-CONCATENATES instead of adding. Mirrors the global pipe's exact
 * options (main.ts:145-149 — not exported, so reproduced here; see that file
 * if these ever drift).
 */
describe("ReceivePurchaseOrderDto", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  });
  const meta = { type: "body" as const, metatype: ReceivePurchaseOrderDto, data: "" };

  it("REG-B780: a string receivedQty is rejected, not silently string-concatenated", async () => {
    await expect(
      pipe.transform(
        { items: [{ id: "11111111-1111-4111-8111-111111111111", receivedQty: "5" }] },
        meta,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("REG-B780: a negative qtyReceived is rejected", async () => {
    await expect(
      pipe.transform(
        { items: [{ itemId: "11111111-1111-4111-8111-111111111111", qtyReceived: -1 }] },
        meta,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("REG-B780: an unknown key is rejected — whitelist is live", async () => {
    await expect(
      pipe.transform(
        {
          items: [{ id: "11111111-1111-4111-8111-111111111111", receivedQty: 1 }],
          unknownField: "x",
        },
        meta,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("REG-B780: an empty items array is rejected", async () => {
    await expect(pipe.transform({ items: [] }, meta)).rejects.toMatchObject({ status: 400 });
  });

  it("REG-B780: an item with neither an identifier nor a quantity is rejected", async () => {
    await expect(pipe.transform({ items: [{}] }, meta)).rejects.toMatchObject({ status: 400 });
  });

  it("REG-B780: an item with an identifier but no quantity at all is rejected", async () => {
    await expect(
      pipe.transform({ items: [{ id: "11111111-1111-4111-8111-111111111111" }] }, meta),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("PASS — web's traced payload (lib/api/inventory.ts useReceivePurchaseOrder)", async () => {
    const body = {
      items: [
        { id: "11111111-1111-4111-8111-111111111111", receivedQty: 5 },
        { id: "22222222-2222-4222-8222-222222222222", receivedQty: 0 },
      ],
    };
    await expect(pipe.transform({ ...body }, meta)).resolves.toBeDefined();
  });

  it("PASS — mobile's traced bare-qty payload ((operator)/purchase-orders/[id]/receive.tsx)", async () => {
    const body = {
      items: [{ itemId: "11111111-1111-4111-8111-111111111111", qtyReceived: 3 }],
      notes: "left on the dock",
    };
    await expect(pipe.transform({ ...body }, meta)).resolves.toBeDefined();
  });

  it("PASS — mobile's traced boxed payload, no qtyReceived at all (a boxed PO line)", async () => {
    const body = {
      items: [{ itemId: "11111111-1111-4111-8111-111111111111", boxes: 2, pieces: 3 }],
    };
    await expect(pipe.transform({ ...body }, meta)).resolves.toBeDefined();
  });
});
