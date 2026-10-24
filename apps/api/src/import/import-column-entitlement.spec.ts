import { ForbiddenException } from "@nestjs/common";
import { columnEntitlementDenied, ENTITLEMENT_COLUMN_MAX } from "./import-column-entitlement";

describe("columnEntitlementDenied (B987-E c)", () => {
  it("builds the 403 body: code, the unchanged message, requires, and the column as data", () => {
    const e = columnEntitlementDenied(
      "MSRP",
      "MSRP",
      'Column "MSRP" needs the MSRP plan flag; remove the column or enable it',
    );
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(e.getStatus()).toBe(403);
    expect(e.getResponse()).toEqual({
      code: "IMPORT_COLUMN_NEEDS_ENTITLEMENT",
      message: 'Column "MSRP" needs the MSRP plan flag; remove the column or enable it',
      requires: "MSRP",
      column: "MSRP",
    });
  });

  it("caps `column` at ENTITLEMENT_COLUMN_MAX (120) characters, so a huge header cannot bloat the body", () => {
    expect(ENTITLEMENT_COLUMN_MAX).toBe(120);
    const e = columnEntitlementDenied("FORECASTING", "R".repeat(500), "msg");
    const body = e.getResponse() as { column: string; message: string };
    expect(body.column).toHaveLength(120);
    expect(body.message).toBe("msg"); // the sentence is the caller's, never rebuilt from the header here
  });

  it("never interpolates the header into a sentence of its own", () => {
    const e = columnEntitlementDenied("MSRP", "<script>x</script>", "fixed");
    expect(JSON.stringify(e.getResponse()).includes("fixed")).toBe(true);
    expect((e.getResponse() as { message: string }).message).toBe("fixed");
  });
});
