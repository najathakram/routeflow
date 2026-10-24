/**
 * Must-fix 3 (row 318 review): the operator invoice screen printed `e.response.data.message` for a failed
 * reminder (owner rule: no raw server strings in the UI, like credit-note-error-copy). The reminder refusals are
 * mapped to FIXED client copy by the server's `body.code`; anything else is one generic line.
 */
import { API_ERROR_CODES } from "@routeflow/types";
import {
  REMINDER_ERROR_COPY,
  REMINDER_FALLBACK_COPY,
  reminderErrorCopy,
} from "../lib/invoice-reminder-error-copy";
import { UNCONFIRMED_COPY } from "../lib/credit-note-error-copy";

const apiError = (data: Record<string, unknown>) => ({ response: { data } });

describe("reminderErrorCopy", () => {
  it.each([
    [API_ERROR_CODES.REMINDER_NOT_ISSUED, /issued and is still unpaid/],
    [API_ERROR_CODES.REMINDER_NO_BALANCE_DUE, /no balance due.*nothing to remind/],
    [API_ERROR_CODES.EMAIL_NOT_CONFIGURED, /Email isn't set up/],
    [API_ERROR_CODES.EMAIL_SEND_FAILED, /email couldn't be sent/],
  ])("%s -> fixed copy, never the server message", (code, re) => {
    const out = reminderErrorCopy(apiError({ code, message: "RAW SERVER TEXT" }));
    expect(out).toMatch(re);
    expect(out).toBe(REMINDER_ERROR_COPY[code as string]);
    expect(out).not.toContain("RAW SERVER");
  });

  it("an unknown, missing or inherited code is the generic line; the message is ignored", () => {
    for (const data of [
      { code: "SOMETHING_NEW", message: "RAW SERVER TEXT" },
      { message: "RAW SERVER TEXT" },
      { code: "toString", message: "RAW SERVER TEXT" },
    ]) {
      const out = reminderErrorCopy(apiError(data));
      expect(out).toBe(REMINDER_FALLBACK_COPY);
      expect(out).not.toContain("RAW SERVER");
    }
    expect(reminderErrorCopy(undefined)).toBe(REMINDER_FALLBACK_COPY);
    expect(reminderErrorCopy(new Error("RAW SERVER TEXT"))).toBe(REMINDER_FALLBACK_COPY);
  });

  it("a request with no response may have been emailed: the 'couldn't confirm' line", () => {
    expect(reminderErrorCopy({ request: {}, message: "Network Error" })).toBe(UNCONFIRMED_COPY);
  });
});
