import { INVOICE_STATUS_VALUES, OPEN_INVOICE_STATUS_VALUES } from "@routeflow/types";
import { OPEN_INVOICE_STATUS_LIST, isOpenInvoiceStatus } from "./open-invoice-status";

describe("isOpenInvoiceStatus / OPEN_INVOICE_STATUS_LIST", () => {
  it("is exactly the shared open set", () => {
    expect([...OPEN_INVOICE_STATUS_LIST]).toEqual([...OPEN_INVOICE_STATUS_VALUES]);
  });

  it.each([...OPEN_INVOICE_STATUS_VALUES])("%s is open", (status) => {
    expect(isOpenInvoiceStatus(status)).toBe(true);
  });

  it.each(INVOICE_STATUS_VALUES.filter((s) => !OPEN_INVOICE_STATUS_VALUES.includes(s as never)))(
    "%s is not open",
    (status) => {
      expect(isOpenInvoiceStatus(status)).toBe(false);
    },
  );

  it("an unknown, empty or missing status is not open", () => {
    expect(isOpenInvoiceStatus("SOMETHING_NEW")).toBe(false);
    expect(isOpenInvoiceStatus("")).toBe(false);
    expect(isOpenInvoiceStatus(null)).toBe(false);
    expect(isOpenInvoiceStatus(undefined)).toBe(false);
  });
});
