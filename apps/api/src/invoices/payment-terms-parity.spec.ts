import * as api from "./payment-terms";

/**
 * W-1487 / B-6 / L-261: the API never value-imports @routeflow/types, so the payment-terms table and helpers are an API
 * literal. A spec may import the shared copy, and pins the two equal: the presets by value, the helpers by behaviour.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const shared: typeof api = require("@routeflow/types");

const CUSTOM = ["Net 21", "Net 1", "Net 365", "Net 120", "Net 99"];
const REFUSED = [
  "Net 0",
  "Net 366",
  "Net 400",
  "Net 7.5",
  "Net -3",
  "net 30 days",
  "Net 030",
  "",
  "Net",
  "30",
];

describe("payment-terms: the API literal is pinned to packages/types", () => {
  it("PAYMENT_TERM_PRESETS are equal and in order", () => {
    expect([...api.PAYMENT_TERM_PRESETS]).toEqual([...shared.PAYMENT_TERM_PRESETS]);
    expect([...api.PAYMENT_TERM_PRESETS]).toEqual([
      "Due on Receipt",
      "Net 7",
      "Net 15",
      "Net 30",
      "Net 45",
      "Net 60",
      "Net 90",
    ]);
  });

  it("termDays agrees on every preset and on five custom labels", () => {
    for (const label of [...shared.PAYMENT_TERM_PRESETS, ...CUSTOM]) {
      expect(api.termDays(label)).toBe(shared.termDays(label));
      expect(api.termDays(label)).not.toBeNull();
    }
    expect(api.termDays("Due on Receipt")).toBe(0);
    expect(api.termDays("Net 7")).toBe(7);
    expect(api.termDays("Net 90")).toBe(90);
    expect(api.termDays("Net 21")).toBe(21);
  });

  it("termDays refuses the same labels in both copies", () => {
    for (const label of [...REFUSED, null, undefined]) {
      expect(api.termDays(label)).toBeNull();
      expect(shared.termDays(label)).toBeNull();
    }
  });

  it("termDays agrees on the edge list (whitespace, case, padding, fullwidth, range, junk)", () => {
    const EDGES = [
      " Net 30 ",
      "Net 30\n",
      "net 21",
      "NET 7",
      "Net  7",
      "Net 07",
      "Net 1e2",
      "Net ７", // fullwidth 7
      "Net 1000",
      "Net 0",
      "Net 366",
      "Net -5",
      "Net 7.5",
      "due on receipt",
      "Due on Receipt ",
      "",
      "Net",
    ];
    for (const label of EDGES) {
      expect({ label, days: api.termDays(label) }).toEqual({
        label,
        days: shared.termDays(label),
      });
      const n = api.termDays(label);
      if (n !== null) expect(api.netLabel(n)).toBe(shared.netLabel(n));
    }
  });

  it("netLabel agrees, in range and out", () => {
    for (const n of [0, 1, 7, 21, 90, 365, 366, 7.5, -3, NaN]) {
      expect(api.netLabel(n)).toBe(shared.netLabel(n));
    }
    expect(api.netLabel(21)).toBe("Net 21");
    expect(api.netLabel(0)).toBeNull();
  });
});

describe("IsPaymentTerm: the customer and tenant default-terms DTOs take a preset or a custom Net N", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { validateSync } = require("class-validator");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { UpdateCustomerDto } = require("../customers/dto/update-customer.dto");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { UpdateInvoiceSettingsDto } = require("../system-config/dto/update-invoice-settings.dto");
  const errorsFor = (Dto: any, field: string, value: unknown) => {
    const dto = Object.assign(new Dto(), { [field]: value });
    return validateSync(dto).filter((e: any) => e.property === field);
  };

  it.each(["Due on Receipt", "Net 7", "Net 90", "Net 21", "Net 365", ""])(
    "the customer DTO accepts %p",
    (v) => expect(errorsFor(UpdateCustomerDto, "defaultPaymentTerms", v)).toHaveLength(0),
  );

  it.each([
    " Net 30 ",
    "Net 30 ",
    " Due on Receipt",
    "Net 30\n",
    "net 21",
    "NET 7",
    "due on receipt",
  ])(
    "the customer DTO refuses non-canonical %p (whitespace or case: it would be stored as typed)",
    (v) => expect(errorsFor(UpdateCustomerDto, "defaultPaymentTerms", v)).toHaveLength(1),
  );

  it.each(["Net 0", "Net 366", "Net 7.5", "net 30 days", "Net -3"])(
    "the customer DTO refuses %p",
    (v) => expect(errorsFor(UpdateCustomerDto, "defaultPaymentTerms", v)).toHaveLength(1),
  );

  it("the tenant default takes Net 90 and a custom Net 21, but not an empty string", () => {
    expect(errorsFor(UpdateInvoiceSettingsDto, "defaultTerms", "Net 90")).toHaveLength(0);
    expect(errorsFor(UpdateInvoiceSettingsDto, "defaultTerms", "Net 21")).toHaveLength(0);
    expect(errorsFor(UpdateInvoiceSettingsDto, "defaultTerms", "")).toHaveLength(1);
    expect(errorsFor(UpdateInvoiceSettingsDto, "defaultTerms", "Net 400")).toHaveLength(1);
  });
});
