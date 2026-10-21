import { importJobErrorCopy, importRefusalCopy, IMPORT_JOB_FALLBACK_COPY } from "./import-job-copy";

describe("import job copy (B980: codes in, fixed words out)", () => {
  it("maps the closed set of codes to fixed sentences", () => {
    expect(importJobErrorCopy("WORKSPACE_READ_ONLY")).toMatch(/read-only/);
    expect(importJobErrorCopy("IMPORT_FAMILY_PRICING_ON")).toMatch(/Family pricing is on/);
    expect(importJobErrorCopy("IMPORT_FAMILY_TOO_MANY_ROWS")).toMatch(/too many rows/);
  });

  it("anything else, or nothing, is the one fallback and never echoes the input", () => {
    expect(importJobErrorCopy("boom: select * from users")).toBe(IMPORT_JOB_FALLBACK_COPY);
    expect(importJobErrorCopy(undefined)).toBe(IMPORT_JOB_FALLBACK_COPY);
    expect(importJobErrorCopy("constructor")).toBe(IMPORT_JOB_FALLBACK_COPY);
  });

  it("a file refusal is known only for the two family codes", () => {
    expect(importRefusalCopy("IMPORT_FAMILY_PRICING_ON")).not.toBeNull();
    expect(importRefusalCopy("WORKSPACE_READ_ONLY")).toBeNull();
    expect(importRefusalCopy(undefined)).toBeNull();
  });
});
