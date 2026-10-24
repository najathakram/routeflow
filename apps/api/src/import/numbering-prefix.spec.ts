import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { DOCUMENT_PREFIX_MAX_LENGTH, validateDocumentPrefix } from "../common/document-prefix";
import { UpdateNumberingDto } from "./dto/update-numbering.dto";

// B1188 (SA-723 MUST 3): the api-owned prefix validator (common/document-prefix.ts, mirrored on web and pinned by
// document-prefix-parity.spec.ts) used by the api DTO. A prefix ending in a digit merges into the padded number ("INV2" + "0043" ->
// "INV20043"), so the numeric-max scan reads it as INV + 20043 and the series corrupts.
describe("validateDocumentPrefix (shared, B1188)", () => {
  it.each(["INV-", "EST-", "CN-", "2026-", "A/B-", "INV.", "INV_", "A", "INV-2026-"])(
    "accepts %j",
    (prefix) => {
      expect(validateDocumentPrefix(prefix)).toBeNull();
    },
  );

  it.each(["INV2", "INV-2026", "7", "AB-9"])("rejects %j: ends in a digit", (prefix) => {
    expect(validateDocumentPrefix(prefix)).toMatch(/digit/i);
  });

  it("rejects a prefix over the max length", () => {
    expect(validateDocumentPrefix("A".repeat(DOCUMENT_PREFIX_MAX_LENGTH))).toBeNull();
    expect(validateDocumentPrefix("A".repeat(DOCUMENT_PREFIX_MAX_LENGTH + 1))).toMatch(
      /at most 16/i,
    );
  });

  it.each(["IN V-", "INV;", "INV'-", "INV%", "ÉCOLE-", "INV\n", "#", "-INV-", "/X-", ".X-", "_X-"])(
    "rejects %j: characters outside the allowed set",
    (prefix) => {
      expect(validateDocumentPrefix(prefix)).toMatch(/letters, numbers/i);
    },
  );

  it("rejects an empty prefix", () => {
    expect(validateDocumentPrefix("")).toMatch(/enter a prefix/i);
  });

  it("rejects a non-string", () => {
    expect(validateDocumentPrefix(42)).not.toBeNull();
    expect(validateDocumentPrefix(null)).not.toBeNull();
  });
});

describe("UpdateNumberingDto.prefix uses the shared validator (B1188)", () => {
  const run = (body: Record<string, unknown>) =>
    validate(plainToInstance(UpdateNumberingDto, { expectedNextNumber: 1, ...body }));

  it("refuses a trailing-digit prefix with the shared message", async () => {
    const errors = await run({ prefix: "INV2" });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe("prefix");
    expect(JSON.stringify(errors[0].constraints)).toMatch(/digit/i);
  });

  it("refuses a prefix with a disallowed character", async () => {
    expect(await run({ prefix: "IN V-" })).toHaveLength(1);
  });

  it("accepts a clean prefix and a body without a prefix", async () => {
    expect(await run({ prefix: "INV-" })).toHaveLength(0);
    expect(await run({ padding: 5 })).toHaveLength(0);
  });
});
