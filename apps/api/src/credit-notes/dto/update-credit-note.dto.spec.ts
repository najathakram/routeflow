import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UpdateCreditNoteDto } from "./update-credit-note.dto";

describe("UpdateCreditNoteDto (#2648 PATCH)", () => {
  const errs = (o: object) => validate(plainToInstance(UpdateCreditNoteDto, o));

  it("accepts an empty body, a reason, an ISO expiry and a null expiry", async () => {
    expect(await errs({})).toHaveLength(0);
    expect(await errs({ reason: "Damaged case" })).toHaveLength(0);
    expect(await errs({ expiresAt: "2031-05-01T00:00:00.000Z" })).toHaveLength(0);
    expect(await errs({ expiresAt: null })).toHaveLength(0);
  });

  it("accepts a 450-character reason (same bound as the reissue DTO)", async () => {
    expect(await errs({ reason: "x".repeat(450) })).toHaveLength(0);
  });

  it("rejects a non-string or over-long reason and a non-ISO expiry", async () => {
    expect(await errs({ reason: 7 })).not.toHaveLength(0);
    expect(await errs({ reason: "x".repeat(451) })).not.toHaveLength(0);
    expect(await errs({ expiresAt: "next tuesday" })).not.toHaveLength(0);
  });
});
