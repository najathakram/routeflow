import { readFileSync } from "fs";
import { join } from "path";

// RN screens aren't renderable in this jest lane (pure-logic only), so the wiring is
// source-pinned — mirrors credit-limit-wiring.test.ts's own precedent.
//
// #2089 (owner ruling): "once an order is delivered, automatically open that order's
// invoice and ask whether to send it." The operator's "any path into DELIVERED" ->
// openSendForOrder() already auto-opened the send sheet; this pins that it now routes
// through the ONE shared postDeliveryInvoicePrompt (@routeflow/types) — offline checked
// FIRST (before the createInvoiceMut network call), then the invoice's real status
// decides the sheet's "issue-and-send" vs plain "send" wording.
describe("post-delivery invoice prompt — operator wiring (#2089)", () => {
  const src = readFileSync(join(__dirname, "..", "app/(operator)/(tabs)/orders/[id].tsx"), "utf8");

  it("imports the shared decision function and the online signal", () => {
    expect(src).toMatch(
      /import\s*\{\s*postDeliveryInvoicePrompt,\s*type BlockedLine\s*\}\s*from\s*"@routeflow\/types"/,
    );
    expect(src).toMatch(/useOfflineQueue\(\(s\) => s\.isOnline\)/);
  });

  it("checks offline FIRST in openSendForOrder, before the createInvoiceMut call", () => {
    const at = src.indexOf("const openSendForOrder = () => {");
    expect(at).toBeGreaterThan(-1);
    const mutateAt = src.indexOf("createInvoiceMut.mutate(order.id", at);
    expect(mutateAt).toBeGreaterThan(at);
    const gate = src.slice(at, mutateAt);
    expect(gate).toMatch(
      /postDeliveryInvoicePrompt\(\{\s*invoice:\s*undefined,\s*online:\s*isOnline\s*\}\)\s*===\s*"offline-later"/,
    );
  });

  it("routes the invoice's status through postDeliveryInvoicePrompt to decide the sheet's wording", () => {
    const at = src.indexOf("const openSendForOrder = () => {");
    const body = src.slice(at, src.indexOf("onError: (e) => toastError(e", at));
    expect(body).toMatch(
      /postDeliveryInvoicePrompt\(\{\s*invoice:\s*inv \? \{ status: inv\.status \} : null,\s*online:\s*true,\s*\}\)/,
    );
    expect(body).toMatch(/issuePrompt:\s*outcome === "issue-and-send"/);
  });

  it("passes issuePrompt through to <SendInvoiceSheet>", () => {
    expect(src).toMatch(/<SendInvoiceSheet[\s\S]*?issuePrompt=\{sendSheet\?\.issuePrompt\}/);
  });
});
