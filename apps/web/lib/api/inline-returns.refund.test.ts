// POS-4b: the inline-return refund goes to the INLINE route. POST /returns/:id/refund is the
// standard returns flow and refuses an inline return.
const post = jest.fn();
jest.mock("../api-client", () => ({ apiClient: { post: (...a: unknown[]) => post(...a) } }));

import { refundReturn } from "./inline-returns";

describe("refundReturn", () => {
  beforeEach(() =>
    post.mockReset().mockResolvedValue({ data: { id: "ret-1", refundPending: false } }),
  );

  it("POSTs /returns/inline/:id/refund with tender, expectedAmount and an optional reason", async () => {
    await expect(
      refundReturn("ret-1", { tender: "CASH", expectedAmount: 12.4, reason: "Changed mind" }),
    ).resolves.toEqual({ id: "ret-1", refundPending: false });
    expect(post).toHaveBeenCalledWith("/returns/inline/ret-1/refund", {
      tender: "CASH",
      expectedAmount: 12.4,
      reason: "Changed mind",
    });
  });

  it("never calls the standard returns refund route", async () => {
    await refundReturn("ret-1", { tender: "CARD", expectedAmount: 5 });
    expect(post.mock.calls[0][0]).not.toBe("/returns/ret-1/refund");
  });
});

describe("storeCreditInstead", () => {
  beforeEach(() =>
    post.mockReset().mockResolvedValue({ data: { id: "ret-1", creditNoteId: "cn-1" } }),
  );

  it("POSTs /returns/inline/:id/store-credit (SA-727b) and answers the return", async () => {
    const { storeCreditInstead } = await import("./inline-returns");
    await expect(storeCreditInstead("ret-1")).resolves.toEqual({
      id: "ret-1",
      creditNoteId: "cn-1",
    });
    expect(post).toHaveBeenCalledWith("/returns/inline/ret-1/store-credit", {});
  });
});
