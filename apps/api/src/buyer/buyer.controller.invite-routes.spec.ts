import { NotFoundException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { BuyerController } from "./buyer.controller";
import { InviteTokenDto } from "./dto/invite-token.dto";
import { LEGACY_INVITE_ACCEPT_UNTIL } from "../auth/legacy-link-windows";

/**
 * The invite token travels in a request BODY (POST /buyer/invites/details and /accept). The two
 * path-token routes are the legacy form: they work until LEGACY_INVITE_ACCEPT_UNTIL and answer
 * with the generic not-found afterwards.
 */
const NOT_FAKED = [
  "nextTick",
  "setImmediate",
  "clearImmediate",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "queueMicrotask",
] as const;
const at = (now: Date) => jest.useFakeTimers({ now, doNotFake: [...NOT_FAKED] });
const INSIDE = new Date(LEGACY_INVITE_ACCEPT_UNTIL.getTime() - 60_000);
const AFTER = new Date(LEGACY_INVITE_ACCEPT_UNTIL.getTime() + 60_000);

describe("BuyerController — invite routes", () => {
  const buyer = { sub: "buyer-1" } as any;
  let service: { getInviteDetails: jest.Mock; acceptInvite: jest.Mock };
  let controller: BuyerController;

  beforeEach(() => {
    service = {
      getInviteDetails: jest.fn().mockResolvedValue({ sellerName: "Acme" }),
      acceptInvite: jest.fn().mockResolvedValue({ linkId: "link-1" }),
    };
    controller = Object.create(BuyerController.prototype);
    (controller as any).buyerService = service;
  });

  afterEach(() => jest.useRealTimers());

  it("POST invites/details takes the token from the body", async () => {
    await expect(controller.getInviteDetailsByBody({ token: "tok-1" })).resolves.toEqual({
      sellerName: "Acme",
    });
    expect(service.getInviteDetails).toHaveBeenCalledWith("tok-1");
  });

  it("POST invites/accept takes the token from the body and the buyer from the session", async () => {
    await controller.acceptInviteByBody({ token: "tok-2" }, buyer);
    expect(service.acceptInvite).toHaveBeenCalledWith("tok-2", "buyer-1");
  });

  it("the body routes keep working after the legacy window (only the path form is retired)", async () => {
    at(AFTER);
    await controller.getInviteDetailsByBody({ token: "tok-1" });
    await controller.acceptInviteByBody({ token: "tok-2" }, buyer);
    expect(service.getInviteDetails).toHaveBeenCalledTimes(1);
    expect(service.acceptInvite).toHaveBeenCalledTimes(1);
  });

  it("the path routes still work inside the legacy window", async () => {
    at(INSIDE);
    await controller.getInviteDetails("tok-3");
    await controller.acceptInvite("tok-4", buyer);
    expect(service.getInviteDetails).toHaveBeenCalledWith("tok-3");
    expect(service.acceptInvite).toHaveBeenCalledWith("tok-4", "buyer-1");
  });

  it("the path routes answer the generic not-found after the window and never reach the service", () => {
    at(AFTER);
    expect(() => controller.getInviteDetails("tok-3")).toThrow(NotFoundException);
    expect(() => controller.acceptInvite("tok-4", buyer)).toThrow(
      "Invite not found or already used",
    );
    expect(service.getInviteDetails).not.toHaveBeenCalled();
    expect(service.acceptInvite).not.toHaveBeenCalled();
  });

  describe("InviteTokenDto", () => {
    const errorsFor = async (body: unknown) =>
      validate(plainToInstance(InviteTokenDto, body as object));

    it("accepts a token string (any shape: a bad one is answered by the lookup, not by validation)", async () => {
      expect(await errorsFor({ token: "invalid-token-xyz-123" })).toHaveLength(0);
      expect(await errorsFor({ token: "a".repeat(64) })).toHaveLength(0);
    });

    it.each([[{}], [{ token: "" }], [{ token: 7 }], [{ token: "a".repeat(257) }]])(
      "rejects %j",
      async (body) => {
        expect((await errorsFor(body)).length).toBeGreaterThan(0);
      },
    );
  });
});
