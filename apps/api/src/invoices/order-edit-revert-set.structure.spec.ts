import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

/**
 * SA-1144 (W-871 reopened), case 13: the refusal of a pre-delivery edit of a paid, part-paid or written-off invoice has ONE
 * selection (`selectEditBlockingInvoices`) and ONE caller (`revertLinkedInvoicesToDraft`, which every pre-delivery edit and
 * merge reaches). A second reader would be a second copy of "which invoices hold money". Source-text pin.
 */
const SRC = join(__dirname, "..");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory()
      ? walk(p)
      : p.endsWith(".ts") && !p.endsWith(".spec.ts")
        ? [p]
        : [];
  });

describe("selectEditBlockingInvoices (SA-1144)", () => {
  const home = join(__dirname, "order-edit-revert-set.ts");
  const src = readFileSync(home, "utf8");

  it("is exported from order-edit-revert-set.ts, and no other production file reads it", () => {
    expect(src).toMatch(/export async function selectEditBlockingInvoices\(/);
    const others = walk(SRC).filter(
      (f) => f !== home && /selectEditBlockingInvoices/.test(readFileSync(f, "utf8")),
    );
    expect(others).toEqual([]);
  });

  it("is called exactly once, inside revertLinkedInvoicesToDraft", () => {
    const calls = src.match(/await selectEditBlockingInvoices\(/g) ?? [];
    expect(calls).toHaveLength(1);
    const body = src.slice(src.indexOf("export async function revertLinkedInvoicesToDraft("));
    expect(body).toMatch(/await selectEditBlockingInvoices\(/);
  });

  it("the money-holding statuses are one list (PAID, PARTIAL, WRITTEN_OFF), read by the helper and the merge fragment", () => {
    const fn = src.slice(src.indexOf("export async function selectEditBlockingInvoices("));
    expect(fn).toMatch(/status: \{ in: EDIT_BLOCKING_STATUSES \}/);
    expect(src).toMatch(
      /EDIT_BLOCKING_STATUSES: InvoiceStatus\[\] = \[\s*InvoiceStatus\.PAID,\s*InvoiceStatus\.PARTIAL,\s*InvoiceStatus\.WRITTEN_OFF,\s*\]/,
    );
    expect(src.match(/EDIT_BLOCKING_STATUSES/g)).toHaveLength(4); // declaration + helper + fragment + the `in`
  });

  it("EDIT_BLOCKING_INVOICE_WHERE is read by merge-candidates.ts and by nothing else (SA-1144 D6)", () => {
    const readers = walk(SRC).filter(
      (f) => f !== home && /EDIT_BLOCKING_INVOICE_WHERE/.test(readFileSync(f, "utf8")),
    );
    expect(readers.map((f) => f.split(/[\\/]/).pop())).toEqual(["merge-candidates.ts"]);
    expect(
      readFileSync(join(SRC, "orders", "merge-candidates.ts"), "utf8").match(
        /invoices: \{ none: EDIT_BLOCKING_INVOICE_WHERE \}/g,
      ),
    ).toHaveLength(1);
  });
});
