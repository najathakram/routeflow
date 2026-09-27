import { readFileSync } from "fs";
import { join } from "path";

// RN screens aren't renderable in this jest lane (pure-logic only), so the wiring is
// source-pinned — mirrors credit-limit-wiring.test.ts's own precedent.
//
// #2089 (owner ruling): "once a delivery completes, automatically open that order's
// invoice and ask whether to send it." This was the ORIGINAL, literal gap #2089 was
// filed for — the driver completion screen had NO invoice prompt at all. It reuses the
// SAME shared decision (postDeliveryInvoicePrompt, @routeflow/types) and the SAME dumb
// send-options sheet (SendInvoiceSheet) the operator screen already opens, rather than
// building a second send dialog.
describe("post-delivery invoice prompt — driver wiring (#2089)", () => {
  const src = readFileSync(
    join(__dirname, "..", "app/(driver)/route/stop/[stopId]/payment.tsx"),
    "utf8",
  );

  it("imports the shared decision function and reuses SendInvoiceSheet (no second send dialog)", () => {
    expect(src).toMatch(
      /import\s*\{\s*postDeliveryInvoicePrompt,\s*type InvoiceStatus\s*\}\s*from\s*"@routeflow\/types"/,
    );
    expect(src).toMatch(
      /import \{ SendInvoiceSheet \} from "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/components\/SendInvoiceSheet"/,
    );
  });

  it("checks offline FIRST, before ever reading the order's invoice", () => {
    const at = src.indexOf("const primaryOrderId = stop?.orders?.[0]?.id;");
    expect(at).toBeGreaterThan(-1);
    const fetchAt = src.indexOf("qc.fetchQuery(", at);
    expect(fetchAt).toBeGreaterThan(at);
    const gate = src.slice(at, fetchAt);
    expect(gate).toMatch(
      // #2265: `online` is the LIVE read (isLiveOnline), never the render-time selector.
      /postDeliveryInvoicePrompt\(\{\s*invoice:\s*undefined,\s*online\s*\}\)\s*===\s*"offline-later"/,
    );
  });

  it("never calls the OPERATOR-only from-order create endpoint — reads the order's existing invoice instead", () => {
    expect(src).not.toMatch(/useCreateInvoiceFromOrder\(/);
    expect(src).toMatch(
      /qc\.fetchQuery\(\{\s*\.\.\.orderQueryOptions\(primaryOrderId\),\s*staleTime: 0,/,
    );
  });

  it("routes the fetched invoice's status through postDeliveryInvoicePrompt and threads issuePrompt to the sheet", () => {
    const at = src.indexOf("qc.fetchQuery({");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf(".catch(", at));
    expect(body).toMatch(
      /postDeliveryInvoicePrompt\(\{\s*invoice:\s*inv \? \{ status: inv\.status as InvoiceStatus \} : null,\s*online:\s*true,\s*\}\)/,
    );
    expect(body).toMatch(/issuePrompt:\s*outcome === "issue-and-send"/);
    expect(src).toMatch(/<SendInvoiceSheet[\s\S]*?issuePrompt=\{sendSheet\?\.issuePrompt\}/);
  });

  it("never dead-ends: no-invoice/offline/skip/fetch-failure all still navigate the driver onward", () => {
    const matches = src.match(/proceedToRoute\(\)/g) ?? [];
    // Called directly from every exit path that skips the sheet: no invoice,
    // offline, skip-or-no-invoice-after-fetch...
    expect(matches.length).toBeGreaterThanOrEqual(3);
    // ...and handed to the fetch-failure fallback (#2251), which calls it after its toast
    // (post-delivery-invoice-fallback.test.ts).
    expect(src).toMatch(/proceed:\s*proceedToRoute/);
  });

  it("also navigates onward when the driver dismisses the sheet without picking a channel", () => {
    expect(src).toMatch(/afterInvoicePromptRef\.current = proceedToRoute;/);
    expect(src).toMatch(
      /const closeSendSheet = \(\) => \{[\s\S]*?afterInvoicePromptRef\.current\(\);/,
    );
  });

  it("#2251 fold: a failed invoice fetch is never silent — same toast as offline, logged", () => {
    const at = src.indexOf("qc.fetchQuery({");
    const tail = src.slice(src.indexOf(".catch(", at), src.indexOf(".catch(", at) + 300);
    expect(tail).toMatch(/onPostDeliveryInvoiceFetchFailed\(/);
    expect(tail).toMatch(/toast:\s*showToast/);
    expect(tail).toMatch(/proceed:\s*proceedToRoute/);
    // The offline branch and the failure branch share ONE message constant.
    expect(src).toMatch(/showToast\(INVOICE_LATER_TOAST\)/);
    expect(src).not.toMatch(/\.catch\(\(\) => proceedToRoute\(\)\)/);
  });
});
