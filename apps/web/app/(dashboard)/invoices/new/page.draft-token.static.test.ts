import { readFileSync } from "fs";
import { join } from "path";

/**
 * H4 (SA must): the composer PATCHes its OWN preview draft (preview, download, submit). Every one of those
 * PATCHes must carry the draft's token, threaded from each create / update response and re-read after a PDF
 * render (the first render writes pdfUrl, a new updatedAt). Otherwise the no-token log never goes quiet and
 * making the token required would break the composer. Source pin: the page is too heavy to mount here.
 */
const src = readFileSync(join(__dirname, "page.tsx"), "utf8");

/** The argument text of every `updateInvoice.mutate(...)` / `.mutateAsync(...)` call (balanced parens). */
function updateCalls(text: string): string[] {
  const out: string[] = [];
  const re = /updateInvoice\.mutate(?:Async)?\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < text.length && depth > 0) {
      if (text[i] === "(") depth += 1;
      else if (text[i] === ")") depth -= 1;
      i += 1;
    }
    out.push(text.slice(m.index, i));
  }
  return out;
}

describe("/invoices/new draft token (H4)", () => {
  it("every PATCH of the composer's draft sends expectedUpdatedAt from the draft token", () => {
    const calls = updateCalls(src);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      // the token is in the payload object, i.e. before the options object of .mutate(dto, opts)
      const payload = c.split(/\},\s*\{\s*\n?\s*onSuccess/)[0];
      expect(payload).toMatch(/expectedUpdatedAt:\s*draftToken\.current/);
    }
  });

  it("the token is taken from every create and update response", () => {
    expect(src).toMatch(/draftToken\.current\s*=\s*saved\?\.updatedAt/);
    expect(src).toMatch(/draftToken\.current\s*=\s*created\?\.updatedAt/);
  });

  it("the token is re-read after every PDF render (preview and download)", () => {
    const pdfGets = src.match(
      /`\/invoices\/\$\{invoiceId\}\/pdf`[\s\S]{0,120}?\);\s*\n\s*await refreshDraftToken\(invoiceId\);/g,
    );
    expect(pdfGets?.length).toBe(2);
    expect(src.match(/`\/invoices\/\$\{invoiceId\}\/pdf`/g)?.length).toBe(2);
  });

  it("a 409 INVOICE_STALE shows the fixed stale copy", () => {
    expect(src).toMatch(/isInvoiceStale\(err\) \? INVOICE_STALE_COPY/);
    expect(src.match(/staleCopy\(err\) \?\?/g)?.length).toBe(3);
  });
});
