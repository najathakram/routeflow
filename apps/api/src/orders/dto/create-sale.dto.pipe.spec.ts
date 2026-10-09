import "reflect-metadata";
import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { CreateSaleDto } from "./create-sale.dto";

/**
 * B1224: "New sale" (POST /orders/sell) was refused with 400 "property idempotencyKey should not
 * exist" even though the web never sends it. The api compiles to ES2023 (define semantics), so an
 * undecorated `idempotencyKey?: string;` is emitted as an OWN `undefined` property on every
 * class-transformer instance, and the global whitelist + forbidNonWhitelisted pipe rejects it.
 *
 * The pipe below is the SAME as apps/api/src/main.ts.
 */
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
const meta = { type: "body" as const, metatype: CreateSaleDto };

const validBody = () => ({
  customerId: "5f0c8f0e-6a1b-4a5e-9d0e-2b6f1c7e9a11",
  items: [{ productId: "prod-acme-1", qty: 2 }],
  deliveredNow: true,
});

describe("CreateSaleDto through the global ValidationPipe (B1224)", () => {
  it("accepts a valid New-sale body that carries no idempotencyKey", async () => {
    const out = await pipe.transform(validBody(), meta);
    expect(out).toBeInstanceOf(CreateSaleDto);
    expect(out.customerId).toBe(validBody().customerId);
  });

  it("emits no own idempotencyKey property on a transformed instance", async () => {
    const out = await pipe.transform(validBody(), meta);
    expect(Object.prototype.hasOwnProperty.call(out, "idempotencyKey")).toBe(false);
  });

  it("still refuses a client-sent idempotencyKey (internal field, never from a body)", async () => {
    const err = await pipe
      .transform({ ...validBody(), idempotencyKey: "client-chosen" }, meta)
      .then(() => null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(JSON.stringify((err as BadRequestException).getResponse())).toContain(
      "property idempotencyKey should not exist",
    );
  });
});
