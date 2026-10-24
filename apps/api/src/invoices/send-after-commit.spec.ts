import { BadRequestException, InternalServerErrorException } from "@nestjs/common";
import { sendAfterCommit, sendCommitted, withKeptDraft } from "./send-after-commit";
import { sendSale } from "../orders/sale-replay-guard";

/** Row 466: every send failure after the draft committed carries the draft's invoiceId. */
describe("send-after-commit", () => {
  it("merges the ids into a string-bodied HttpException and keeps its status", () => {
    const err = withKeptDraft(new BadRequestException("blocked"), {
      invoiceId: "i1",
      orderId: "o1",
    });
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toMatchObject({
      statusCode: 400,
      message: "blocked",
      invoiceId: "i1",
      orderId: "o1",
    });
  });

  it("omits orderId when there is none", () => {
    const err = withKeptDraft(new BadRequestException({ code: "X" }), { invoiceId: "i1" });
    expect(err.getResponse()).toEqual({ code: "X", invoiceId: "i1" });
  });

  it("wraps a non-HTTP error in a coded 500 with the original as its cause", () => {
    const cause = new Error("boom");
    const err = withKeptDraft(cause, { invoiceId: "i1" });
    expect(err).toBeInstanceOf(InternalServerErrorException);
    expect(err.cause).toBe(cause);
    expect(err.getResponse()).toMatchObject({
      code: "INVOICE_SEND_AFTER_CREATE_FAILED",
      invoiceId: "i1",
    });
  });

  it("returns the value on success and rethrows on failure (never swallows)", async () => {
    await expect(sendAfterCommit({ invoiceId: "i1" }, async () => 7)).resolves.toBe(7);
    await expect(
      sendAfterCommit({ invoiceId: "i1" }, async () => {
        throw new BadRequestException("no");
      }),
    ).rejects.toMatchObject({ response: { invoiceId: "i1" } });
  });

  it("sendCommitted forwards the id and options to send()", async () => {
    const send = jest.fn().mockResolvedValue("ok");
    await expect(sendCommitted({ send }, "i1", "o1", { suppressNotify: true })).resolves.toBe("ok");
    expect(send).toHaveBeenCalledWith("i1", { suppressNotify: true });
  });

  it("sendSale: a replayed invoice already past DRAFT is kept, not resent", async () => {
    const send = jest.fn();
    const inv = { id: "i1", status: "SENT" };
    await expect(sendSale({ send }, inv, "o1", true)).resolves.toBe(inv);
    expect(send).not.toHaveBeenCalled();
  });

  it("sendSale: a DRAFT (or a first attempt) is sent, and its failure carries both ids", async () => {
    const send = jest.fn().mockRejectedValue(new BadRequestException("blocked"));
    await expect(
      sendSale({ send }, { id: "i1", status: "DRAFT" }, "o1", true),
    ).rejects.toMatchObject({
      response: { invoiceId: "i1", orderId: "o1" },
    });
    await expect(sendSale({ send }, { id: "i2" }, "o1", false)).rejects.toMatchObject({
      response: { invoiceId: "i2", orderId: "o1" },
    });
  });
});
