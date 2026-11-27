import {
  INVOICE_STATUS_BUYER_LABEL,
  INVOICE_STATUS_BUYER_TONE,
  INVOICE_STATUS_LABEL,
  INVOICE_STATUS_LEGEND,
  INVOICE_STATUS_TONE,
  INVOICE_STATUS_VALUES,
  invoiceStatusTone,
  type InvoiceStatus,
  type InvoiceStatusTone,
} from "@routeflow/types";

/**
 * W-1470: the one invoice status table. Tone and both word sets are keyed on the shared enum, so a new
 * status fails type-check until it has a tone, a staff word and a buyer word (the @ts-expect-error
 * lines below stop compiling, and tsc fails, the day a table stops being `Record<InvoiceStatus, ...>`).
 */
describe("invoice status table (W-1470, S-4)", () => {
  it.each(INVOICE_STATUS_VALUES)("%s has a tone, a staff word and a buyer word", (status) => {
    expect(typeof INVOICE_STATUS_TONE[status]).toBe("string");
    expect(INVOICE_STATUS_LABEL[status].length).toBeGreaterThan(0);
    expect(INVOICE_STATUS_BUYER_LABEL[status].length).toBeGreaterThan(0);
  });

  it("the three tables hold exactly the enum values", () => {
    const sorted = [...INVOICE_STATUS_VALUES].sort();
    expect(Object.keys(INVOICE_STATUS_TONE).sort()).toEqual(sorted);
    expect(Object.keys(INVOICE_STATUS_LABEL).sort()).toEqual(sorted);
    expect(Object.keys(INVOICE_STATUS_BUYER_LABEL).sort()).toEqual(sorted);
  });

  it("the legend has one row per status, in enum order, with the table's word and tone", () => {
    expect(INVOICE_STATUS_LEGEND).toHaveLength(8);
    expect(INVOICE_STATUS_LEGEND.map((r) => r.status)).toEqual([...INVOICE_STATUS_VALUES]);
    for (const row of INVOICE_STATUS_LEGEND) {
      expect(row.label).toBe(INVOICE_STATUS_LABEL[row.status]);
      expect(row.tone).toBe(INVOICE_STATUS_TONE[row.status]);
    }
  });

  it("buyer words are today's buyer list words, unchanged", () => {
    expect(INVOICE_STATUS_BUYER_LABEL).toEqual({
      DRAFT: "Draft",
      SENT: "Sent",
      VIEWED: "Viewed",
      PARTIAL: "Partial",
      PAID: "Paid",
      OVERDUE: "Overdue",
      VOID: "Void",
      WRITTEN_OFF: "Written Off",
    });
  });

  it("staff tones: sent-but-not-due is blue (info), overdue red, partial amber, written off its own tone", () => {
    expect(INVOICE_STATUS_TONE.SENT).toBe("info");
    expect(INVOICE_STATUS_TONE.VIEWED).toBe("info");
    expect(INVOICE_STATUS_TONE.OVERDUE).toBe("danger");
    expect(INVOICE_STATUS_TONE.PARTIAL).toBe("warning");
    expect(INVOICE_STATUS_TONE.PAID).toBe("success");
    expect(INVOICE_STATUS_TONE.WRITTEN_OFF).not.toBe(INVOICE_STATUS_TONE.VOID);
    expect(INVOICE_STATUS_TONE.WRITTEN_OFF).not.toBe(INVOICE_STATUS_TONE.DRAFT);
  });

  it("invoiceStatusTone reads the table, and a status this build does not know is neutral", () => {
    for (const s of INVOICE_STATUS_VALUES)
      expect(invoiceStatusTone(s)).toBe(INVOICE_STATUS_TONE[s]);
    expect(invoiceStatusTone("SOMETHING_NEW")).toBe("neutral");
  });

  it("type level: a table that misses a status does not compile", () => {
    // @ts-expect-error WRITTEN_OFF is missing, so this is not a Record<InvoiceStatus, InvoiceStatusTone>
    const missing: Record<InvoiceStatus, InvoiceStatusTone> = {
      DRAFT: "neutral",
      SENT: "info",
      VIEWED: "info",
      PARTIAL: "warning",
      PAID: "success",
      OVERDUE: "danger",
      VOID: "muted",
    };
    expect(Object.keys(missing)).toHaveLength(7);
    // @ts-expect-error a tone that is not in the vocabulary
    const bad: InvoiceStatusTone = "purple";
    expect(bad).toBe("purple");
  });
});

describe("INVOICE_STATUS_BUYER_TONE: the buyer tones live in the shared table (brief criterion 6)", () => {
  it("is the B1122 buyer tone per status, one row per enum value", () => {
    expect(INVOICE_STATUS_BUYER_TONE).toEqual({
      DRAFT: "neutral",
      SENT: "warning",
      VIEWED: "info",
      PARTIAL: "warning",
      PAID: "success",
      OVERDUE: "danger",
      VOID: "danger",
      WRITTEN_OFF: "danger",
    });
  });
});
