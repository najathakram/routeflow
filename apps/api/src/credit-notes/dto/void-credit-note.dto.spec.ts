import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { VoidCreditNoteDto } from "./void-credit-note.dto";

describe("VoidCreditNoteDto (#2540)", () => {
  const errs = (o: object) => validate(plainToInstance(VoidCreditNoteDto, o));

  it("accepts no body fields and a short reason", async () => {
    expect(await errs({})).toHaveLength(0);
    expect(await errs({ reason: "duplicate credit" })).toHaveLength(0);
  });

  it("rejects a non-string or over-long reason", async () => {
    expect(await errs({ reason: 5 })).not.toHaveLength(0);
    expect(await errs({ reason: "x".repeat(501) })).not.toHaveLength(0);
  });
});
