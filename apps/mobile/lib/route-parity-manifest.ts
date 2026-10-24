/**
 * #2337 route-parity manifest (plan §3 Phase 0, §5 R5): EVERY web page (apps/web/app/**\/page.tsx,
 * except the dev-only apps/web/app/dev/**) maps to its mobile screen(s), is web-only by design, or
 * is a known mobile gap. `__tests__/route-parity.test.ts` fails when a web page has no row, a row
 * has no page, or a mobile reference is not a real route file — so "web added a page" is a red
 * test, not silent drift. Keys: the page directory under apps/web/app. Mobile refs: route files
 * under apps/mobile/app, without ".tsx". Source: native-parity plan §1 (parity inventory).
 */
export type ParityRow = { mobile: readonly string[] } | { webOnly: string } | { missing: string };

export const ROUTE_PARITY: Readonly<Record<string, ParityRow>> = {
  // ─── Auth / shared (plan §1.4) ───
  "(auth)/admin-login": { mobile: ["(auth)/login", "(auth)/sign-in"] },
  "(auth)/admin/login": { mobile: ["(auth)/login", "(auth)/sign-in"] },
  "(auth)/auth/google/callback": { mobile: ["(auth)/auth/google/callback"] },
  "(auth)/callback": { mobile: ["(auth)/google-callback"] },
  "(auth)/forgot-password": { mobile: ["(auth)/forgot-password"] },
  "(auth)/login": { mobile: ["(auth)/login"] },
  "(auth)/platform/auth/callback": { webOnly: "platform admin" },
  "(auth)/reset-password": { mobile: ["(auth)/reset-password"] },
  "(auth)/signup/check-email": {
    webOnly: "tenant signup stays on web (Apple 5.1.1(v))",
  },
  "(auth)/signup": { webOnly: "tenant signup stays on web (Apple 5.1.1(v))" },
  "change-password": { mobile: ["(auth)/force-change-password"] },
  "verify-email": { webOnly: "email-link flow; the browser handles it" },
  handoff: {
    webOnly: "the hybrid shell's sign-in entry (#2653); the WebView loads it, no native screen",
  },

  // ─── Operator dashboard: orders, dispatch, routes (plan §1.3) ───
  "(dashboard)/dashboard": { mobile: ["(operator)/(tabs)/home"] },
  "(dashboard)/getting-started": { mobile: ["(operator)/getting-started"] },
  "(dashboard)/get-the-app": {
    webOnly: "install links for the native app; the app itself never shows them",
  },
  "(dashboard)/orders/[id]": { mobile: ["(operator)/(tabs)/orders/[id]"] },
  "(dashboard)/orders": { mobile: ["(operator)/(tabs)/orders/index"] },
  "(dashboard)/orders/new": {
    webOnly:
      "a web link target that redirects to the Orders page's builder intent (row 331); mobile opens the builder from its Orders tab",
  },
  "(dashboard)/orders/counter-sale": {
    missing:
      "walk-in counter sale (POST /orders/counter-sale) is web-first; the mobile operator sale mode is its own flow, so parity is a later owner call",
  },
  "(dashboard)/returns/[id]": { mobile: ["(operator)/returns/[id]"] },
  "(dashboard)/returns": { mobile: ["(operator)/returns/index"] },
  "(dashboard)/dispatch": { mobile: ["(operator)/(tabs)/dispatch"] },
  "(dashboard)/routes/[id]/dispatch": {
    mobile: ["(operator)/routes/[id]", "(operator)/routes/[id]/assign-driver"],
  },
  "(dashboard)/routes/[id]": { mobile: ["(operator)/routes/[id]"] },
  "(dashboard)/routes/create": { mobile: ["(operator)/routes/create"] },
  "(dashboard)/routes/my-runs": { mobile: ["(driver)/route/index"] },
  "(dashboard)/routes": { mobile: ["(operator)/routes/index"] },
  "(dashboard)/routes/templates/[id]": {
    missing: "route-templates parity is TO VERIFY — no mobile screen yet",
  },
  "(dashboard)/routes/trips/new": { mobile: ["(operator)/trips/new"] },
  "(dashboard)/routes/trips": { mobile: ["(operator)/trips/index"] },
  "(dashboard)/deliveries/new": { mobile: ["(operator)/trips/new"] },
  "(dashboard)/deliveries": { mobile: ["(operator)/trips/index"] },
  "(dashboard)/drivers/[id]": { mobile: ["(operator)/drivers/[id]/edit"] },
  "(dashboard)/drivers": { mobile: ["(operator)/drivers/index"] },

  // ─── Operator dashboard: customers, warehouse (plan §1.3) ───
  "(dashboard)/customers/[id]": { mobile: ["(operator)/customers/[id]"] },
  "(dashboard)/customers/create": { mobile: ["(operator)/customers/create"] },
  "(dashboard)/customers": { mobile: ["(operator)/customers/index"] },
  "(dashboard)/inventory/movements": { mobile: ["(operator)/movements"] },
  "(dashboard)/inventory/stock-counts/[id]": {
    mobile: ["(operator)/products/stock-count/[id]"],
  },
  "(dashboard)/inventory/stock-counts": { mobile: ["(operator)/products/stock-counts"] },
  "(dashboard)/inventory": { mobile: ["(operator)/(tabs)/warehouse"] },
  "(dashboard)/purchase-orders": { mobile: ["(operator)/purchase-orders/index"] },
  "(dashboard)/purchase-orders/[id]": { mobile: ["(operator)/purchase-orders/[id]"] },
  "(dashboard)/products/[id]": { mobile: ["(operator)/products/[id]"] },
  "(dashboard)/products/create": { mobile: ["(operator)/products/create"] },
  "(dashboard)/products": { mobile: ["(operator)/products/index"] },
  "(dashboard)/promotions": { missing: "W>M, no mobile screen" },
  "(dashboard)/suppliers/[id]": { mobile: ["(operator)/suppliers/[id]"] },
  "(dashboard)/suppliers": { mobile: ["(operator)/suppliers/index"] },
  "(dashboard)/purchases": { mobile: ["(operator)/purchase-orders/index"] },
  "(dashboard)/vendor-bills/[id]": { mobile: ["(operator)/vendor-bills/[id]"] },
  "(dashboard)/vendor-bills": { mobile: ["(operator)/vendor-bills/index"] },
  "(dashboard)/tobacco": { mobile: ["(operator)/tobacco/index"] },
  "(dashboard)/compliance/[categoryId]": { mobile: ["(operator)/compliance/[id]"] },
  "(dashboard)/compliance": { mobile: ["(operator)/compliance/index"] },

  // ─── Operator dashboard: finance (plan §1.3) ───
  "(dashboard)/finance": { mobile: ["(operator)/(tabs)/finance"] },
  "(dashboard)/finance/dashboard": { mobile: ["(operator)/(tabs)/finance"] },
  "(dashboard)/finance/expenses/new": { mobile: ["(operator)/expenses/new"] },
  "(dashboard)/finance/expenses": { mobile: ["(operator)/expenses/index"] },
  "(dashboard)/finance/payments/[id]": { mobile: ["(operator)/payments/[id]"] },
  "(dashboard)/finance/payments": { mobile: ["(operator)/payments/index"] },
  "(dashboard)/finance/payment-requests": { missing: "W>M, no mobile screen" },
  "(dashboard)/finance/customers": { missing: "AR by customer — W>M, TO VERIFY" },
  "(dashboard)/finance/reports": { mobile: ["(operator)/reports/index"] },
  "(dashboard)/finance/statements": { mobile: ["(operator)/statements/index"] },
  "(dashboard)/finance/commissions/[id]": {
    missing: "addon-gated SALES_AGENTS, deferred",
  },
  "(dashboard)/finance/commissions": { missing: "addon-gated SALES_AGENTS, deferred" },
  "(dashboard)/sales-agents/[id]": { missing: "addon-gated SALES_AGENTS, deferred" },
  "(dashboard)/sales-agents": { missing: "addon-gated SALES_AGENTS, deferred" },
  "(dashboard)/bookkeeping/[transactionId]": {
    missing: "owner triage: candidate web-only",
  },
  "(dashboard)/bookkeeping": { missing: "owner triage: candidate web-only" },

  // ─── Operator dashboard: invoices, estimates, credit notes, shipments ───
  "(dashboard)/invoices/[id]/edit": { mobile: ["(operator)/(tabs)/invoices/[id]/edit"] },
  "(dashboard)/invoices/[id]": { mobile: ["(operator)/(tabs)/invoices/[id]"] },
  "(dashboard)/invoices/create": { mobile: ["(operator)/(tabs)/invoices/create"] },
  "(dashboard)/invoices/new": { mobile: ["(operator)/(tabs)/invoices/new"] },
  "(dashboard)/invoices": { mobile: ["(operator)/(tabs)/invoices/index"] },
  "(dashboard)/invoices/payments": {
    mobile: [
      "(operator)/(tabs)/invoices/[id]/record-payment",
      "(operator)/(tabs)/invoices/[id]/payments/[paymentId]/edit",
    ],
  },
  "(dashboard)/invoices/recurring/[id]/edit": { mobile: ["(operator)/recurring-invoices/[id]"] },
  "(dashboard)/invoices/recurring/new": { mobile: ["(operator)/recurring-invoices/new"] },
  "(dashboard)/invoices/recurring": { mobile: ["(operator)/recurring-invoices/index"] },
  "(dashboard)/estimates/[id]": { mobile: ["(operator)/estimates/[id]"] },
  "(dashboard)/estimates": { mobile: ["(operator)/estimates/index"] },
  "(dashboard)/credit-notes/[id]": { mobile: ["(operator)/credit-notes/[id]"] },
  "(dashboard)/credit-notes": { mobile: ["(operator)/credit-notes/index"] },
  "(dashboard)/shipments": { mobile: ["(operator)/shipments"] },

  // ─── Operator dashboard: analytics, settings, billing (plan §1.3) ───
  "(dashboard)/analytics": { mobile: ["(operator)/analytics/index"] },
  "(dashboard)/settings": { mobile: ["(operator)/settings/index"] },
  "(dashboard)/settings/product-categories": { missing: "W>M, owner triage" },
  "(dashboard)/settings/restrictions": { missing: "W>M, owner triage" },
  "(dashboard)/settings/restrictions/rules": { missing: "W>M, owner triage" },
  // Row 509: the rule detail (products & labels, edit with history). Mobile manages no rules (owner: out of 509).
  "(dashboard)/settings/restrictions/rules/[id]": { missing: "W>M, owner triage" },
  "(dashboard)/settings/units": { missing: "W>M, owner triage" },
  "(dashboard)/settings/batch-import": { webOnly: "desktop file flows" },
  "(dashboard)/settings/import": { webOnly: "desktop file flows" },
  "(dashboard)/settings/migration": { webOnly: "desktop file flows" },
  "(dashboard)/settings/billing": { webOnly: "App Store 3.1.1: no plan purchase in the iOS app" },
  "(dashboard)/choose-plan": { webOnly: "App Store 3.1.1: no plan purchase in the iOS app" },

  // ─── Buyer portal (plan §1.1) ───
  "buyer/login": { mobile: ["(auth)/customer-login"] },
  "buyer/register": { missing: "W>M, no self-registration screen calls buyerRegister" },
  "buyer/forgot-password": { mobile: ["(auth)/forgot-password"] },
  "buyer/reset-password": { mobile: ["(auth)/reset-password"] },
  "buyer/change-password": { mobile: ["(customer)/change-password"] },
  "buyer/invite/[token]": { missing: "W>M, needs a routeflow:// deep link" },
  "buyer/verify-email": { webOnly: "email-link flow stays on web" },
  "buyer/verify-merge": { webOnly: "email-link flow stays on web" },
  buyer: { mobile: ["(customer)/sellers"] },
  "buyer/portal": { mobile: ["(customer)/sellers", "(customer)/sellers/connect"] },
  "buyer/portal/settings": { mobile: ["(customer)/profile", "(customer)/(tabs)/more"] },
  "buyer/portal/[seller]": { mobile: ["(customer)/(tabs)/home"] },
  "buyer/portal/[seller]/dashboard": { mobile: ["(customer)/(tabs)/home"] },
  "buyer/portal/[seller]/shop": { mobile: ["(customer)/(tabs)/catalog"] },
  "buyer/portal/[seller]/shop/[productId]": {
    missing: "W>M, no product-detail screen — catalog tile is inline only",
  },
  "buyer/portal/[seller]/cart": { mobile: ["(customer)/orders/cart"] },
  "buyer/portal/[seller]/orders/[id]": { mobile: ["(customer)/orders/[id]"] },
  "buyer/portal/[seller]/orders": {
    mobile: ["(customer)/(tabs)/orders", "(customer)/orders/index"],
  },
  "buyer/portal/[seller]/invoices/[id]": { mobile: ["(customer)/invoices/[id]"] },
  "buyer/portal/[seller]/invoices": { mobile: ["(customer)/(tabs)/invoices"] },
  "buyer/portal/[seller]/payments": { mobile: ["(customer)/payments"] },
  "buyer/portal/[seller]/finances": { mobile: ["(customer)/finances"] },
  "buyer/portal/[seller]/shelf": { mobile: ["(customer)/shelf"] },
  "buyer/portal/[seller]/favorites": { mobile: ["(customer)/favorites"] },
  "buyer/portal/[seller]/templates": { mobile: ["(customer)/standing-orders"] },
  "buyer/portal/[seller]/licenses": { mobile: ["(customer)/licenses"] },
  "buyer/portal/[seller]/account": { mobile: ["(customer)/profile"] },

  // ─── Marketing site — web-only (plan §1.4) ───
  "(marketing)/book-a-demo": { webOnly: "marketing site" },
  "(marketing)/company": { webOnly: "marketing site" },
  "(marketing)/contact": { webOnly: "marketing site" },
  "(marketing)": { webOnly: "marketing site" },
  "(marketing)/pricing": { webOnly: "marketing site" },
  "(marketing)/privacy": { webOnly: "marketing site" },
  "(marketing)/product": { webOnly: "marketing site" },
  "(marketing)/retailers": { webOnly: "marketing site" },
  "(marketing)/sign-in": { webOnly: "marketing site" },
  "(marketing)/terms": { webOnly: "marketing site" },
  "(marketing)/wholesalers": { webOnly: "marketing site" },

  // ─── Platform admin — web-only (plan §1.4) ───
  "(platform-admin)/admin/audit-logs": { webOnly: "platform admin" },
  "(platform-admin)/admin/billing": { webOnly: "platform admin" },
  "(platform-admin)/admin/buyers/[id]": { webOnly: "platform admin" },
  "(platform-admin)/admin/buyers/merge-requests/[id]": { webOnly: "platform admin" },
  "(platform-admin)/admin/buyers/merge-requests": { webOnly: "platform admin" },
  "(platform-admin)/admin/buyers": { webOnly: "platform admin" },
  "(platform-admin)/admin/dashboard": { webOnly: "platform admin" },
  "(platform-admin)/admin/plans": { webOnly: "platform admin" },
  "(platform-admin)/admin/profile": { webOnly: "platform admin" },
  "(platform-admin)/admin/settings": { webOnly: "platform admin" },
  "(platform-admin)/admin/tenants/[id]": { webOnly: "platform admin" },
  "(platform-admin)/admin/tenants/new": { webOnly: "platform admin" },
  "(platform-admin)/admin/tenants": { webOnly: "platform admin" },
};
