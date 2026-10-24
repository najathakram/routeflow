import "reflect-metadata";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UserRole } from "@prisma/client";
import { ReceiptController } from "./receipt.controller";
import { SendReceiptDto } from "./send-receipt.dto";
import { RolesGuard } from "../auth/guards/roles.guard";

/** The HTTP edge of POST /orders/:id/receipt: route, role gate, DTO validation. */
describe("ReceiptController", () => {
  const service = { send: jest.fn().mockResolvedValue({ channel: "email", to: "a@example.com" }) };
  const controller = new ReceiptController(service as never);
  beforeEach(() => service.send.mockClear());

  it("is POST /orders/:id/receipt", () => {
    expect(Reflect.getMetadata("path", ReceiptController)).toBe("orders");
    expect(Reflect.getMetadata("path", ReceiptController.prototype.send)).toBe(":id/receipt");
    expect(Reflect.getMetadata("method", ReceiptController.prototype.send)).toBe(1); // RequestMethod.POST
  });

  describe("role gate (the real RolesGuard over the route's metadata)", () => {
    const guard = new RolesGuard(new Reflector());
    const allows = (role: UserRole) =>
      guard.canActivate({
        getHandler: () => ReceiptController.prototype.send,
        getClass: () => ReceiptController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      } as unknown as ExecutionContext);

    it.each([UserRole.OPERATOR, UserRole.TENANT_ADMIN])("%s passes", (role) => {
      expect(allows(role)).toBe(true);
    });
    it.each([UserRole.DRIVER, UserRole.CUSTOMER])("%s is refused", (role) => {
      expect(allows(role)).toBe(false);
    });
  });

  it("hands the order id and the body to the service", async () => {
    const dto = { channel: "email", to: "a@example.com" } as SendReceiptDto;
    await expect(controller.send("ord-1", dto)).resolves.toEqual({
      channel: "email",
      to: "a@example.com",
    });
    expect(service.send).toHaveBeenCalledWith("ord-1", dto);
  });

  describe("SendReceiptDto", () => {
    const check = async (body: unknown) =>
      validate(plainToInstance(SendReceiptDto, body as object));

    it("accepts an email channel and a real address", async () => {
      expect(await check({ channel: "email", to: "name@example.com" })).toHaveLength(0);
    });

    it.each([
      ["a bare word", "name"],
      ["no domain", "name@"],
      ["no local part", "@example.com"],
      ["a space inside", "na me@example.com"],
      ["empty", ""],
      ["a name-and-address form", "Name <name@example.com>"],
    ])("rejects %s", async (_label, to) => {
      const errors = await check({ channel: "email", to });
      expect(errors.map((e) => e.property)).toContain("to");
    });

    it("rejects an address over 254 characters", async () => {
      const to = `${"a".repeat(250)}@example.com`;
      expect((await check({ channel: "email", to })).map((e) => e.property)).toContain("to");
    });

    it("rejects a missing address, a non-string address and a missing body", async () => {
      expect((await check({ channel: "email" })).map((e) => e.property)).toContain("to");
      expect((await check({ channel: "email", to: 5 })).map((e) => e.property)).toContain("to");
      expect((await check({})).map((e) => e.property).sort()).toEqual(["channel", "to"]);
    });

    it.each(["sms", "whatsapp", "EMAIL", "", null])(
      "rejects the channel %j (only the registered channels)",
      async (channel) => {
        expect((await check({ channel, to: "a@example.com" })).map((e) => e.property)).toContain(
          "channel",
        );
      },
    );

    it("trims padding around the address before validating", async () => {
      const dto = plainToInstance(SendReceiptDto, { channel: "email", to: "  name@example.com  " });
      expect(await validate(dto)).toHaveLength(0);
      expect(dto.to).toBe("name@example.com");
    });
  });
});
