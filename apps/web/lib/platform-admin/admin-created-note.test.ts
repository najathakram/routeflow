import { adminCreatedNote } from "./admin-created-note";

describe("adminCreatedNote (row 551)", () => {
  it("says it was emailed only when the API reports a delivered send", () => {
    expect(adminCreatedNote(true)).toMatch(/was also emailed/);
  });

  it.each([false, undefined, null])(
    "%s: never claims an email; tells the super admin to pass it on",
    (v) => {
      const note = adminCreatedNote(v as never);
      expect(note).not.toMatch(/was also emailed/);
      expect(note).toMatch(/could not be emailed|not emailed/i);
      expect(note).toMatch(/change it the first time they sign in/);
    },
  );
});
