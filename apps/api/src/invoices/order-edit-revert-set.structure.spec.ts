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

  it("the money-holding statuses are PAID, PARTIAL and WRITTEN_OFF", () => {
    const fn = src.slice(src.indexOf("export async function selectEditBlockingInvoices("));
    expect(fn).toMatch(
      /status: \{ in: \[InvoiceStatus\.PAID, InvoiceStatus\.PARTIAL, InvoiceStatus\.WRITTEN_OFF\] \}/,
    );
  });
});
