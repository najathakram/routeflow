import {
  COUNTER_SALE_DAY_CLOSED_COPY,
  DAY_CLOSED_FOR_PAYMENT_DATE_COPY,
  dayClosedCopy,
  isCounterSaleDayClosed,
  isDayClosedRefusal,
} from "./day-closed-copy";

const refusal = (
  code: string,
  message = "server words that must never be shown",
  status = 409,
) => ({
  response: { status, data: { code, message, closedThrough: "2026-10-09T05:00:00.000Z" } },
});

describe("dayClosedCopy (fixed copy for the end-of-day close refusals)", () => {
  it("DAY_CLOSED_FOR_PAYMENT_DATE -> the fixed copy, never the server message", () => {
    expect(dayClosedCopy(refusal("DAY_CLOSED_FOR_PAYMENT_DATE"))).toBe(
      "That day is closed. Record it with today's date.",
    );
    expect(DAY_CLOSED_FOR_PAYMENT_DATE_COPY).toBe(
      "That day is closed. Record it with today's date.",
    );
  });

  it("COUNTER_SALE_DAY_CLOSED -> the fixed copy, never the server message", () => {
    expect(dayClosedCopy(refusal("COUNTER_SALE_DAY_CLOSED"))).toBe(
      "This day has been closed. Reopen the close first.",
    );
    expect(COUNTER_SALE_DAY_CLOSED_COPY).toBe("This day has been closed. Reopen the close first.");
  });

  it.each([
    ["another 409 code", refusal("SOMETHING_ELSE")],
    ["the day-closed code on a non-409", refusal("DAY_CLOSED_FOR_PAYMENT_DATE", "x", 400)],
    ["no response", {}],
    ["null", null],
  ])("%s -> null (the caller keeps its own copy)", (_n, err) => {
    expect(dayClosedCopy(err)).toBeNull();
  });
});

describe("isDayClosedRefusal / isCounterSaleDayClosed", () => {
  it("both codes are day-close refusals; only COUNTER_SALE_DAY_CLOSED is a till write", () => {
    expect(isDayClosedRefusal(refusal("DAY_CLOSED_FOR_PAYMENT_DATE"))).toBe(true);
    expect(isDayClosedRefusal(refusal("COUNTER_SALE_DAY_CLOSED"))).toBe(true);
    expect(isCounterSaleDayClosed(refusal("COUNTER_SALE_DAY_CLOSED"))).toBe(true);
    expect(isCounterSaleDayClosed(refusal("DAY_CLOSED_FOR_PAYMENT_DATE"))).toBe(false);
  });

  it.each([
    ["another 409 code", refusal("SOMETHING_ELSE")],
    ["a non-409", refusal("COUNTER_SALE_DAY_CLOSED", "x", 400)],
    ["no response", {}],
    ["null", null],
  ])("%s is not a day-close refusal", (_n, err) => {
    expect(isDayClosedRefusal(err)).toBe(false);
    expect(isCounterSaleDayClosed(err)).toBe(false);
  });
});
