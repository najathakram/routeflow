import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { RequestMethod } from "@nestjs/common";
import { PATH_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { CreateOrderDto } from "./create-order.dto";
import { OrdersController } from "../orders.controller";

/**
 * B451 Phase A — Strix coverage gap 2 (rule id
 * strix-coverage/mass-assignment-totalamount-subtotal-taxamount-status-tenantid).
 * NOTE: the SARIF finding text targets POST /orders + PATCH /orders/{id}, not
 * invoice create as the registry brief paraphrased it — see
 * create-invoice.mass-assignment.spec.ts for the invoice-side sibling check.
 * Reproduces the real global ValidationPipe options
 * (apps/api/src/main.ts:145-149): { whitelist: true, forbidNonWhitelisted: true }.
 */
function attackPayload(extra: Record<string, unknown>) {
  return plainToInstance(CreateOrderDto, {
    customerId: "cust-1",
    items: [{ productId: "prod-1", qty: 1 }],
    ...extra,
  });
}

describe("CreateOrderDto — mass assignment (B451 gap 2)", () => {
  it.each(["totalAmount", "subtotal", "taxAmount", "tenantId"])(
    "REFUTED: %s is not a declared field — forbidNonWhitelisted rejects it (400)",
    async (field) => {
      const instance = attackPayload({ [field]: 999_999 });
      const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
      const whitelistError = errors.find((e) => e.constraints?.whitelistValidation);
      expect(whitelistError).toBeDefined();
      expect(whitelistError!.property).toBe(field);
    },
  );

  it("status IS declared but constrained to the create-time enum — REFUTED as an arbitrary-status writer", async () => {
    const legit = attackPayload({ status: "PENDING" });
    expect(await validate(legit, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);

    // Every terminal/operational status (PAID-adjacent, DELIVERED, etc.) is
    // rejected at create time — only DRAFT/PENDING are ever accepted here.
    const attack = attackPayload({ status: "DELIVERED" });
    const errors = await validate(attack, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.some((e) => e.property === "status" && e.constraints?.isEnum)).toBe(true);
  });

  it("REFUTED: no route exists for a bare PATCH /orders/:id — the SARIF-named PATCH target is not reachable", () => {
    const proto = OrdersController.prototype;
    const patchPaths = Object.getOwnPropertyNames(proto)
      .filter((name) => name !== "constructor")
      .map((name) => proto[name as keyof typeof proto])
      .filter(
        (fn): fn is object =>
          typeof fn === "function" &&
          Reflect.getMetadata(METHOD_METADATA, fn) === RequestMethod.PATCH,
      )
      .map((fn) => Reflect.getMetadata(PATH_METADATA, fn) as string);

    // Only narrow sub-resource PATCH routes exist (:id/status, :id/items,
    // :id/shipment, :id/fulfill-path, :id/urgent, :id/commission-rate) — a
    // bare ":id" that could accept an arbitrary order-shaped body is absent.
    expect(patchPaths).not.toContain(":id");
    expect(patchPaths.length).toBeGreaterThan(0);
  });
});
