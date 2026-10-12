import { describeSaveError } from "./reason-copy";

/** A save refused by a READ_ONLY workspace is a 403 with code READ_ONLY: the read-only line, not "no permission". */
describe("describeSaveError: READ_ONLY", () => {
  it("a 403 READ_ONLY says the read-only line, never the server text", () => {
    const copy = describeSaveError({
      response: { status: 403, data: { code: "READ_ONLY", message: "RAW GUARD TEXT" } },
    });
    expect(copy).toBe("Not available while read-only. Your admin can restore it.");
    expect(copy).not.toMatch(/RAW GUARD TEXT/);
  });

  it("a code-less 403 keeps the permission copy", () => {
    expect(describeSaveError({ response: { status: 403 } })).toBe(
      "You don't have permission to do that.",
    );
  });
});
