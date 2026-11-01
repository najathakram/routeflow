/**
 * SA-1060 PR-1 (MUST 1) — `GET /returns?holdReason=` whitelist at the controller boundary, like `kind`. The held-returns screen asks
 * for the holds staff can approve ("DRIVER_CAP,ALREADY_RETURNED"); a value that is not a known hold reason is a 400 and the
 * service is NEVER called, so a raw string never reaches `where.holdReason`.
 */
import { BadRequestException } from "@nestjs/common";
import { ReturnsController } from "./returns.controller";

describe("ReturnsController#findAll — holdReason query whitelist (SA-1060 PR-1)", () => {
  const findAllForUser = jest.fn().mockResolvedValue({
    data: [],
    meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
  });
  let controller: ReturnsController;
  const user = { sub: "u1", role: "OPERATOR" } as any;
  const call = (holdReason?: string) =>
    controller.findAll(
      user,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "INLINE",
      undefined,
      holdReason,
    );

  beforeEach(() => {
    findAllForUser.mockClear();
    controller = new ReturnsController({ findAllForUser } as any, {} as any, {} as any, {} as any);
  });

  it("omitted holdReason is not passed on", async () => {
    await call();
    expect(findAllForUser).toHaveBeenCalledWith(
      user,
      expect.objectContaining({ holdReason: undefined }),
    );
  });

  it("one known reason passes as a one-item list", async () => {
    await call("DRIVER_CAP");
    expect(findAllForUser).toHaveBeenCalledWith(
      user,
      expect.objectContaining({ holdReason: ["DRIVER_CAP"] }),
    );
  });

  it("the approval screen's pair passes as a list, in order", async () => {
    await call("DRIVER_CAP,ALREADY_RETURNED");
    expect(findAllForUser).toHaveBeenCalledWith(
      user,
      expect.objectContaining({ holdReason: ["DRIVER_CAP", "ALREADY_RETURNED"] }),
    );
  });

  it.each([
    "FOO",
    "driver_cap",
    "DRIVER_CAP,",
    ",DRIVER_CAP",
    "DRIVER_CAP;x",
    "DRIVER_CAP,FOO",
    "",
  ])("holdReason=%p is rejected with 400 and the service is never called", (bad) => {
    expect(() => call(bad)).toThrow(BadRequestException);
    expect(findAllForUser).not.toHaveBeenCalled();
  });
});
