import { API_ERROR_CODES } from "@routeflow/types";
import { genericToastCopy } from "./generic-toast-copy";

/**
 * B297 PR5 (#3726): the filing lock's refusals and the locked-period guards show fixed copy by code. Before this,
 * FILING_PERIOD_RUNNING fell through to the neutral 409 sentence and lost the "wait for the period to end" advice.
 */
const NEUTRAL_409 =
  "That conflicts with something that already exists or is in use. Check it and try again.";
const err = (code: string) => ({
  message: "Request failed with status code 409",
  response: { status: 409, data: { code, message: "raw server text" } },
});

describe("genericToastCopy: filing-lock codes", () => {
  it.each([
    [
      API_ERROR_CODES.FILING_PERIOD_RUNNING,
      "This period hasn't ended yet. Lock the filing after the period ends.",
    ],
    [API_ERROR_CODES.FILING_ALREADY_LOCKED, "This filing is already locked."],
    [
      API_ERROR_CODES.FILING_NOT_LOCKABLE,
      "Only a filing that generated successfully can be locked. Generate it again, then lock it.",
    ],
    [
      API_ERROR_CODES.FILED_PERIOD_LOCKED,
      "This change would move money in a filed, locked period. Record a return or a credit note instead.",
    ],
    [
      API_ERROR_CODES.LEDGER_PERIOD_LOCKED,
      "The filing for this period is locked, so this can't be saved. Refresh and try again.",
    ],
  ])("%s has its own sentence, never the neutral 409 or the raw text", (code, copy) => {
    const shown = genericToastCopy(err(code));
    expect(shown).toBe(copy);
    expect(shown).not.toBe(NEUTRAL_409);
    expect(shown).not.toContain("raw server text");
  });
});
