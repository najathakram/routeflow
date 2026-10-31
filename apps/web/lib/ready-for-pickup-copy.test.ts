import {
  readyForPickupCopy,
  readyLineCopy,
  readyWhen,
  toldOnceCopy,
} from "./ready-for-pickup-copy";

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

/** W-1060 (SA-1070 rule 6): the one line's words and its one action, per state. */
describe("readyLineCopy / toldOnceCopy", () => {
  const AT = "2026-10-31T14:14:00.000Z";
  const rec = (preview: object, last: object | null) => ({ preview, last }) as never;

  it("a SENT send names the address and the time; Send again only once Ready", () => {
    const r = rec(
      { notice: "SENT", email: "b@acme.test" },
      { notice: "SENT", email: "b@acme.test", at: AT },
    );
    expect(readyLineCopy(r, true, "UTC")).toEqual({
      text: "Ready email sent to b@acme.test, Oct 31, 2:14 PM.",
      action: "SEND_AGAIN",
    });
    expect(readyLineCopy(r, false, "UTC")?.action).toBeNull();
  });
  it("a FAILED send offers Send email once Ready", () => {
    const r = rec({ notice: "SENT", email: "b@acme.test" }, { notice: "FAILED", at: AT });
    expect(readyLineCopy(r, true, "UTC")).toEqual({
      text: "The ready email didn't send, Oct 31, 2:14 PM.",
      action: "SEND_EMAIL",
    });
  });
  it.each([
    [{ notice: "SENT", email: "b@acme.test" }, "Marking ready emails b@acme.test."],
    [{ notice: "NO_EMAIL" }, "No email on file, so marking ready tells nobody."],
    [{ notice: "OPTED_OUT" }, "This customer turned off order emails."],
    [{ notice: "OFF" }, "Your order emails are off."],
  ])("no record: the preview %j reads %s", (preview, text) => {
    expect(readyLineCopy(rec(preview, null), false, "UTC")).toEqual({ text, action: null });
  });
  it("a zone Intl does not know falls back to UTC instead of throwing", () => {
    expect(readyWhen(AT, "Not/AZone")).toEqual({ day: "Oct 31", time: "2:14 PM" });
  });
  it("toldOnce names the address, or the customer when there is none", () => {
    expect(toldOnceCopy({ toldOnce: true, email: "b@acme.test", at: AT }, "Acme")).toBe(
      "Ready for pickup. b@acme.test was already emailed, so no new email went.",
    );
    expect(toldOnceCopy({ toldOnce: true, at: AT }, "Acme")).toBe(
      "Ready for pickup. Acme was already emailed, so no new email went.",
    );
  });
});
