import { readyForPickupCopy } from "./ready-for-pickup-copy";

/** W-1043 (SA-1062 MUST 19) R16: the five sentences staff read, word for word. Only SENT is a success. */
describe("readyForPickupCopy", () => {
  it.each([
    [
      { notice: "SENT", email: "buyer@acme.test" },
      "Ready for pickup. Email sent to buyer@acme.test.",
      true,
    ],
    [
      { notice: "NO_EMAIL" },
      "Ready for pickup. Acme Co has no email on file, so nobody was told.",
      false,
    ],
    [
      { notice: "OPTED_OUT" },
      "Ready for pickup. Acme Co turned off order emails, so nobody was told.",
      false,
    ],
    [{ notice: "OFF" }, "Ready for pickup. Your order emails are off, so nobody was told.", false],
    [
      { notice: "FAILED" },
      "Ready for pickup. The email didn't send, so please tell Acme Co another way.",
      false,
    ],
  ] as const)("%j", (done, text, success) => {
    expect(readyForPickupCopy(done as never, "Acme Co")).toEqual({ text, success });
  });

  it("names the customer generically when the order has no name", () => {
    expect(readyForPickupCopy({ notice: "NO_EMAIL" }, null).text).toBe(
      "Ready for pickup. The customer has no email on file, so nobody was told.",
    );
  });

  it("a SENT notice with no address does not claim one", () => {
    expect(readyForPickupCopy({ notice: "SENT" }, "Acme Co")).toEqual({
      text: "Ready for pickup. Email sent.",
      success: true,
    });
  });
});
