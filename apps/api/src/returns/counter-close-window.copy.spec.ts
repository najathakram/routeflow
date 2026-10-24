import { dayClosedConflict } from "./counter-close-window";

/**
 * Owner ruling 10-12: there is no Reopen control (Edit count replaced it), so the closed-day refusal never tells anyone to
 * "reopen the close". The web chooses its copy by `code`; the server text still has to be honest where a client shows it.
 */
describe("dayClosedConflict (the closed-window refusal)", () => {
  it("is a coded 409 whose text names a real next step and never a Reopen control", () => {
    const e = dayClosedConflict();
    expect(e.getStatus()).toBe(409);
    const body = e.getResponse() as { code: string; message: string };
    expect(body.code).toBe("COUNTER_SALE_DAY_CLOSED");
    expect(body.message).toBe(
      "This day is closed, so this can't be changed. Record it with today's date instead.",
    );
    expect(body.message).not.toMatch(/reopen/i);
  });
});
