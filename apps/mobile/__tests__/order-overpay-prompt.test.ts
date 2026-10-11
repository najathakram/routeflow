const confirmMock = jest.fn();
const toastMock = jest.fn();
jest.mock("../lib/confirm", () => ({ confirm: (...a: unknown[]) => confirmMock(...a) }));
jest.mock("../lib/toast", () => ({ showToast: (...a: unknown[]) => toastMock(...a) }));

import { handleOrderOverpay } from "../lib/order-overpay-prompt";

const err = (code = "ORDER_EDIT_WOULD_OVERPAY") => ({
  response: { status: 409, data: { code, message: "server leak", excess: 5 } },
});

beforeEach(() => jest.clearAllMocks());

describe("handleOrderOverpay", () => {
  it("ignores other errors", () => {
    expect(
      handleOrderOverpay(err("OTHER"), { id: "o", customerId: "c" }, { push: jest.fn() }),
    ).toBe(false);
    expect(confirmMock).not.toHaveBeenCalled();
  });
  it("prompts with fixed copy; confirming pushes the inline-return route", () => {
    const push = jest.fn();
    expect(
      handleOrderOverpay(err(), { id: "o1", customerId: "c1", canRecordReturn: true }, { push }),
    ).toBe(true);
    const [title, message, onConfirm, opts] = confirmMock.mock.calls[0];
    expect(title).toBe("This change would overpay the invoice");
    expect(message).toContain("$5.00");
    expect(message).toMatch(/record a return/);
    expect(message).not.toContain("server leak");
    expect(opts).toEqual({ confirmText: "Record a return" });
    onConfirm();
    expect(push).toHaveBeenCalledWith({
      pathname: "/(operator)/returns/inline",
      params: { customerId: "c1", orderId: "o1" },
    });
  });
  it("without the inline-returns add-on: a toast with no record-a-return exit, never a prompt", () => {
    const push = jest.fn();
    expect(
      handleOrderOverpay(err(), { id: "o1", customerId: "c1", canRecordReturn: false }, { push }),
    ).toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0][0]).not.toMatch(/return/i);
  });
  it("falls back to a toast when the customer is unknown", () => {
    expect(
      handleOrderOverpay(err(), { id: "o1", canRecordReturn: true }, { push: jest.fn() }),
    ).toBe(true);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0][0]).not.toContain("server leak");
  });
});
