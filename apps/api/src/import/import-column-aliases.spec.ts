import { PRODUCT_IMPORT_COLUMNS, CUSTOMER_IMPORT_COLUMNS } from "@routeflow/types";
import {
  PRODUCT_IMPORT_COLUMNS as API_PRODUCT_IMPORT_COLUMNS,
  CUSTOMER_IMPORT_COLUMNS as API_CUSTOMER_IMPORT_COLUMNS,
} from "./import-column-aliases";

// The API mirrors the shared import-column alias lists (it may not value-import @routeflow/types
// at runtime). A spec runs through ts-jest, so it can — and pins the mirror to the source.
describe("import column alias mirror", () => {
  it("product columns equal @routeflow/types PRODUCT_IMPORT_COLUMNS", () => {
    expect(API_PRODUCT_IMPORT_COLUMNS).toEqual(PRODUCT_IMPORT_COLUMNS);
  });

  it("customer columns equal @routeflow/types CUSTOMER_IMPORT_COLUMNS", () => {
    expect(API_CUSTOMER_IMPORT_COLUMNS).toEqual(CUSTOMER_IMPORT_COLUMNS);
  });
});
