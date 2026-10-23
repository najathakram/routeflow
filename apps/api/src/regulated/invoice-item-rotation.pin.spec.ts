import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * Row 683 pin R-P2 (SA-789 F3, SA-896): every place that deletes or rotates the items of an EXISTING invoice is classified by
 * (file, function), because the regulated ledger keys on `invoiceItemId` and has no FK to it. A new site, or a site that
 * moves to another function, fails here until someone states how its ledger stays equal to the lines.
 *  - LEDGER_SYNCED: the regulated content is compared and the ledger resynced (or settled) in the same flow.
 *  - WHOLE_INVOICE_DELETE_REVERSED: the whole invoice goes, and its ledger is settled to zero first.
 *  - REFUSED_WHEN_REGULATED: the write refuses while the tenant holds regulated records (SA-896, the financial wipe).
 *  - NON_REGULATED: the rows deleted can never carry a regulated line (with the reason).
 * `TO_VERIFY` is not a class: the pin fails while any site is unclassified.
 */
type RotationClass =
  "LEDGER_SYNCED" | "WHOLE_INVOICE_DELETE_REVERSED" | "REFUSED_WHEN_REGULATED" | "NON_REGULATED";

const SITES: Record<string, { class: RotationClass; why: string }> = {
  "invoices/invoices.service.ts#reconcileOrderDraftInvoiceLocked": {
    class: "LEDGER_SYNCED",
    why: "F2: regulatedContentChanged → resyncInvoiceLedger (the sole-draft legacy rebuild)",
  },
  "invoices/invoices.service.ts#rebuildSiblingDrafts": {
    class: "LEDGER_SYNCED",
    why: "always reverses and rewrites through resyncInvoiceLedger",
  },
  "invoices/invoices.service.ts#update": {
    class: "LEDGER_SYNCED",
    why: "order lines resync via syncLines; F4 gates a freeform regulated change through the same helper",
  },
  "invoices/invoices.service.ts#deleteInvoice": {
    class: "WHOLE_INVOICE_DELETE_REVERSED",
    why: "reverseInvoiceEntries before the delete",
  },
  "orders/orders.service.ts#deleteOrder": {
    class: "WHOLE_INVOICE_DELETE_REVERSED",
    why: "B65: each linked invoice's ledger is reversed before its items go",
  },
  "orders/orders.service.ts#forceConsolidateCustomer": {
    class: "WHOLE_INVOICE_DELETE_REVERSED",
    why: "clearLoserDraftForDelete settles the loser's DRAFT mirror to zero (INVOICE_ZEROED) before its delete (R10)",
  },
  "customers/customers.service.ts#deleteAllCustomers": {
    class: "WHOLE_INVOICE_DELETE_REVERSED",
    why: "settleRegulatedLedger INVOICE_ZEROED per invoice before the delete",
  },
  "customers/customers.service.ts#runImportedCustomersCleanup": {
    class: "WHOLE_INVOICE_DELETE_REVERSED",
    why: "settleRegulatedLedger INVOICE_ZEROED per invoice before the delete",
  },
  "system-config/settings.controller.ts#clearFinancialData": {
    class: "REFUSED_WHEN_REGULATED",
    why: "SA-896 (b): 409 FINANCIAL_WIPE_BLOCKED_REGULATED while any ledger row, tobacco report or filing exists",
  },
};

const SRC = join(__dirname, "..");
const ROTATION = /\binvoiceItem\.(delete|deleteMany)\(/;
/** A nested `items: { deleteMany | delete }` counts only inside an INVOICE update (vendor-bill items are not invoice items). */
const NESTED = /\bitems:\s*\{\s*(deleteMany|delete)\b/;
const INVOICE_WRITE = /\binvoice\.(update|upsert)\(/;
const DECL =
  /^\s*(?:export\s+)?(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/;
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "await", "function"]);

const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** `file#function` for every rotation site in a source text (the nearest enclosing declaration above it). */
export function rotationSites(file: string, text: string): string[] {
  const lines = stripComments(text).split("\n");
  const out: string[] = [];
  lines.forEach((line, i) => {
    const nestedInInvoice =
      NESTED.test(line) &&
      lines.slice(Math.max(0, i - 8), i + 1).some((l) => INVOICE_WRITE.test(l));
    if (!ROTATION.test(line) && !nestedInInvoice) return;
    let fn = "<top>";
    for (let k = i; k >= 0; k--) {
      const m = DECL.exec(lines[k]);
      if (m && !KEYWORDS.has(m[1]) && /^ {0,2}\S/.test(lines[k].replace(/^(\s*export\s+)/, ""))) {
        fn = m[1];
        break;
      }
    }
    out.push(`${file}#${fn}`);
  });
  return out;
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) return name === "node_modules" ? [] : sources(abs);
    return /\.ts$/.test(name) && !/\.spec\.ts$/.test(name) ? [abs] : [];
  });
}

describe("Row 683 pin R-P2: every InvoiceItem rotation is classified", () => {
  it("the detector finds a planted rotation and names its function; comments are ignored (self-test)", () => {
    const planted = [
      "export class S {",
      "  async sneaky(id: string) {",
      "    // await tx.invoiceItem.deleteMany({}) in a comment does not count",
      "    await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });",
      "  }",
      "}",
    ].join("\n");
    expect(rotationSites("x/planted.ts", planted)).toEqual(["x/planted.ts#sneaky"]);
    expect(SITES["x/planted.ts#sneaky"]).toBeUndefined(); // so the scan below would fail on it
  });

  it("every rotation site in the api source is classified, and every classified site still exists", () => {
    const found = new Set(
      sources(SRC).flatMap((f) => rotationSites(relative(SRC, f), readFileSync(f, "utf8"))),
    );
    const unclassified = [...found].filter((k) => !SITES[k]);
    expect(unclassified).toEqual([]);
    const stale = Object.keys(SITES).filter((k) => !found.has(k));
    expect(stale).toEqual([]);
  });
});
