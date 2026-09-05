import { ValidationPipe } from "@nestjs/common";
import { UpdateOrderTemplateDto } from "./update-order-template.dto";

/**
 * B09/R20: PATCH /order-templates/:id had no `items` field, so the customer's
 * "Edit Standing Order" modal could only ever change name/days/isActive/notes
 * — added lines never reached the API and silently dropped. Precedent:
 * `apps/api/src/route-optimization/dto/apply-route-variant.dto.spec.ts`.
 */
describe("UpdateOrderTemplateDto", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  });
  const meta = { type: "body" as const, metatype: UpdateOrderTemplateDto, data: "" };

  it("REG-B09 accepts items on a PATCH and whitelists productId/qty (T23)", async () => {
    await expect(
      pipe.transform({ name: "x", items: [{ productId: "p1", qty: 2 }] }, meta),
    ).resolves.toMatchObject({ name: "x", items: [{ productId: "p1", qty: 2 }] });
  });

  // T24 (R20, R11 pins) — no token, outside the red gate: these already pass
  // today because the whole `items` key is rejected as non-whitelisted.
  it("rejects an empty items array (pin)", async () => {
    await expect(pipe.transform({ items: [] }, meta)).rejects.toMatchObject({ status: 400 });
  });

  it("rejects qty 0 on a template item (pin)", async () => {
    await expect(
      pipe.transform({ items: [{ productId: "p1", qty: 0 }] }, meta),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a client-supplied unitPrice on a template item (pin, R11 — no price field on a template item)", async () => {
    await expect(
      pipe.transform({ items: [{ productId: "p1", qty: 1, unitPrice: 5 }] }, meta),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("accepts a body with no items key at all (pin)", async () => {
    await expect(pipe.transform({ name: "x" }, meta)).resolves.toMatchObject({ name: "x" });
  });
});
