/**
 * #2406 (SA-484c) — `GET /returns?kind=` whitelist at the controller boundary. Default
 * STANDARD keeps the existing Returns list unchanged; INLINE/ALL are opt-in for the
 * order-detail "Returns on this order" panel. Anything else is a 400 and the service is
 * NEVER called — a bad value must never reach `where.kind` as a raw string.
 */
import { BadRequestException } from "@nestjs/common";
import { ReturnsController } from "./returns.controller";

describe("ReturnsController#findAll — kind query whitelist (#2406)", () => {
  const findAllForUser = jest.fn().mockResolvedValue({
    data: [],
    meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
  });
  let controller: ReturnsController;
  const user = { sub: "u1", role: "OPERATOR" } as any;

  beforeEach(() => {
    findAllForUser.mockClear();
    controller = new ReturnsController({ findAllForUser } as any, {} as any, {} as any, {} as any);
  });

  it("omitted kind defaults to STANDARD", async () => {
    await controller.findAll(user);
    expect(findAllForUser).toHaveBeenCalledWith(
      user,
      expect.objectContaining({ kind: "STANDARD" }),
    );
  });

  it("kind=INLINE passes through", async () => {
    await controller.findAll(
      user,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "INLINE",
    );
    expect(findAllForUser).toHaveBeenCalledWith(user, expect.objectContaining({ kind: "INLINE" }));
  });

  it("kind=ALL passes through", async () => {
    await controller.findAll(
      user,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "ALL",
    );
    expect(findAllForUser).toHaveBeenCalledWith(user, expect.objectContaining({ kind: "ALL" }));
  });

  it.each(["FOO", "standard; drop", "ALL,INLINE", "inline", "all", ""])(
    "kind=%p is rejected with 400 and the service is never called",
    (bad) => {
      expect(() =>
        controller.findAll(
          user,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          bad,
        ),
      ).toThrow(BadRequestException);
      expect(findAllForUser).not.toHaveBeenCalled();
    },
  );
});

describe("ReturnsController#findAll — ?pendingRefund (SA-727b)", () => {
  const findAllForUser = jest.fn().mockResolvedValue({ data: [], meta: {} });
  const user = { sub: "u1", role: "OPERATOR" } as any;
  const call = (pending?: string) =>
    new ReturnsController({ findAllForUser } as any, {} as any, {} as any, {} as any).findAll(
      user,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "INLINE",
      pending,
    );
  beforeEach(() => findAllForUser.mockClear());

  it("only the literal 'true' turns the filter on", async () => {
    await call("true");
    expect(findAllForUser).toHaveBeenLastCalledWith(
      user,
      expect.objectContaining({ pendingRefund: true }),
    );
    for (const v of [undefined, "false", "1", "TRUE", ""]) {
      await call(v);
      expect(findAllForUser).toHaveBeenLastCalledWith(
        user,
        expect.objectContaining({ pendingRefund: false }),
      );
    }
  });
});
