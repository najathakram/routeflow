import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CUSTOMER_IMPORT_LITERAL_HEADERS as SHARED_LITERAL_HEADERS,
  CUSTOMER_IMPORT_TEMPLATE_HEADERS,
  LEGACY_IMPORT_KEY_COLUMNS,
  PRODUCT_IMPORT_TEMPLATE_HEADERS,
} from "@routeflow/types";
import { CUSTOMER_IMPORT_LITERAL_HEADERS } from "./import-column-aliases";
import {
  CUSTOMER_COLUMNS,
  PRODUCT_COLUMNS,
  resolveColumns,
  withoutCustomerLiteralHeaders,
} from "./import-columns";

// The download template must never carry a column the importer would ignore.
const serviceSource = readFileSync(join(__dirname, "import.service.ts"), "utf8");
const readByName = (header: string) => serviceSource.includes(`row["${header}"]`);

describe("import template columns", () => {
  it.each(PRODUCT_IMPORT_TEMPLATE_HEADERS)("products: the importer accepts %s", (header) => {
    expect(resolveColumns([header], PRODUCT_COLUMNS).unknownColumns).toEqual([]);
  });

  it.each(CUSTOMER_IMPORT_TEMPLATE_HEADERS)("customers: the importer accepts %s", (header) => {
    const known = resolveColumns([header], CUSTOMER_COLUMNS).unknownColumns.length === 0;
    expect(known || readByName(header)).toBe(true);
  });

  it("RED: a column the importer doesn't read is refused by the same check", () => {
    const made = "Favourite Colour";
    expect(resolveColumns([made], CUSTOMER_COLUMNS).unknownColumns).toEqual([made]);
    expect(readByName(made)).toBe(false);
    expect(resolveColumns([made], PRODUCT_COLUMNS).unknownColumns).toEqual([made]);
  });

  it("carries no column twice, and starts with the name column", () => {
    for (const headers of [PRODUCT_IMPORT_TEMPLATE_HEADERS, CUSTOMER_IMPORT_TEMPLATE_HEADERS]) {
      expect(new Set(headers).size).toBe(headers.length);
    }
    expect(PRODUCT_IMPORT_TEMPLATE_HEADERS[0]).toBe("Item Name");
    expect(CUSTOMER_IMPORT_TEMPLATE_HEADERS[0]).toBe("Customer Name");
  });

  it("the API's named-header list equals the shared one", () => {
    expect(CUSTOMER_IMPORT_LITERAL_HEADERS).toEqual(SHARED_LITERAL_HEADERS);
  });

  it("the preview keeps calling a truly unknown column unknown, and stops flagging named ones", () => {
    expect(withoutCustomerLiteralHeaders(["Phone", "Billing City", "Average Cost"])).toEqual([
      "Average Cost",
    ]);
  });

  it("matches the by-name headers exactly: a case or spacing variant is still reported unknown", () => {
    const variants = ["phone", "Billing_City", "billing city", "First  Name"];
    expect(withoutCustomerLiteralHeaders(variants)).toEqual(variants);
  });

  it("the key columns named on the invoices, payments and expenses cards are read by the service", () => {
    for (const names of Object.values(LEGACY_IMPORT_KEY_COLUMNS)) {
      for (const name of names) {
        expect(serviceSource).toContain(`["${name}"]`);
      }
    }
  });
});
