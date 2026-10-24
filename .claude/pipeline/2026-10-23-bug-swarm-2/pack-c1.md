# Pack C1 (bugs 301, 296, 300) - master e6acb9955

## 1. Confirmation
- 301 LIVE. CounterLinePriceEdit.tsx:273 `<Button type="submit">Apply</Button>`; Cancel :270 same. Button = packages/ui/src/web/Button.tsx, default size md = `h-[34px] px-3.5` (lines 25-40; sm 28, lg 40). Real height 34px. Cancel is also 34px.
- 296 LIVE (CreateOrderModal.tsx), all 3 + register text (WORK-REGISTER row 296 / ACTION-ITEMS 354; same text: "backdate link 40px + 'Use today' ~14px + Change-customer X 24px -> >=44px hit areas; Scan barcode icon aria-label; Enter on Change customer needs human keyboard check; Tab order; B6 stale-credit copy unverified"):
  - Change customer X :2561-2568: `className="rounded p-1 text-navy/70 hover:text-danger transition-colors"`, icon h-4 w-4 => 24px.
  - 'Use today' :3092-3100 inside <p class text-[11px]>; className `font-medium text-brand-500 hover:underline` => ~14px line box.
  - Backdate link :3105-3114: `min-h-10 text-sm ...` (40px).
  - Extra items in the row (Scan barcode aria-label, keyboard/tab) are NOT in the 3 listed; aria-label only if cheap, else defer.
- 300 LIVE. invoices/new/page.tsx:2943 (`<span>Tax ({(taxRate * 100).toFixed(0)}%)</span>`) and :2999 (`<dt ...>`). taxRate = (settings?.taxRate ?? 0)/100 at :937 (percent/100). Sets 8.25 -> "Tax (8%)".

## Shared helper (exists, reuse)
`taxRowLabel(ratePercent: number|null|undefined): string` in packages/pricing/src/explained-tax-rate.ts:24, exported from `@routeflow/pricing` (index.ts). => `Tax (${Number(r.toFixed(3))}%)`, null => "Tax". Percent in, not fraction. Fix: `taxRowLabel(settings?.taxRate)` (pass percent; do NOT use taxRate*100: float noise e.g. 8.25 ok after toFixed(3) anyway). Handle settings.taxRate undefined/0: tax>0 guard at :2940 stays; decide null vs 0 (0 => "Tax (0%)").
Other formatters: lib/order-tax-label.ts `orderTaxLabel` (order+invoices, wraps taxRowLabel; used by orders/[id] via _components/EditTaxLabel); lib/counter-receipt.ts `adjustmentLabel = taxRowLabel`. CreateOrderModal.tsx:3009 prints raw `Tax ({settings?.taxRate ?? 10}%)` (no rounding; not a toFixed bug). Amount/rate VALUE untouched.

## 2. Touch-target convention
Counter buttons: `min-h-[44px] lg:min-h-0` (CounterLinePriceEdit.tsx:158 `min-h-[44px] min-w-[44px] lg:min-h-0 lg:min-w-0`, :170 `min-h-[44px] lg:min-h-0`; CounterSaleScreen/QuickKeysGrid `min-h-[44px] ... lg:min-h-9`). Also `min-h-11` in CounterBuyerChoice/GateOffline/ReceiptView/HandOverRows/OrdersMoreMenu. Use `min-h-[44px] lg:min-h-0` (tablet+mobile 44, desktop compact) per CQ-32. Apply fix: `className="min-h-[44px] lg:min-h-0"` on both footer Buttons (keeps size/height override since className merges via cn; check twMerge resolves h-[34px] vs min-h: min-h wins in CSS, ok). X: add `inline-flex min-h-[44px] min-w-[44px] items-center justify-center lg:min-h-0 lg:min-w-0` (keep ref/onClick). Use today: `inline-flex min-h-[44px] items-center lg:min-h-0`. Backdate: `min-h-[44px] lg:min-h-10`.
Existing pin: CounterSaleScreen.tap-targets.test.tsx (asserts class `min-h-[44px]` via toHaveClass; jsdom has no layout, so class assertions only). No 44 pin exists for CounterLinePriceEdit or CreateOrderModal.

## 3. Test files / patterns
- CounterLinePriceEdit.test.tsx: RTL render/fireEvent/waitFor, `mount(over)` helper with jest.fn onApply/onClosed/onReset, props `canEditPrices` + PriceEditLine fixtures; no provider mocks. Add test: open editor, `getByRole("button",{name:"Apply"})` toHaveClass("min-h-[44px]").
- CreateOrderModal.backdate.test.tsx: renderWithProviders (@/test-utils/render), `window.HTMLElement.prototype.scrollIntoView = jest.fn()`, product fixtures PLAIN/PARENT, userEvent; covers "Backdate this order" link + Use today. Add class pins here (use name "Backdate this order", "Use today"); Change customer via `getByRole("button",{name:"Change customer"})` after a customer is chosen (see CreateOrderModal.customer-keyboard.test.tsx for selection setup).
- invoices/new: page.test.tsx (renders NewInvoicePage via renderWithProviders, jest.mock next/navigation useRouter, api hooks mocked). No existing "Tax (" assertion. Add a test with settings.taxRate 8.25 and a taxable line -> text "Tax (8.25%)" in both the bar (:2943) and summary (:2999) if both mount; else a static pin like invoices/tax-rate-precision.static.test.ts (fs.readFileSync source regex: no `toFixed(0)` near "Tax (", imports taxRowLabel). Check page.test.tsx settings mock shape first (grep useTenantSettings/taxRate).

## 4. Lessons (digest grep: no 44/touch/tax-label entry)
L-331 (infer rate: configured rate first, shortest precision; never back-calculate a printed rate) relevant to 300. L-305 (enumerate surfaces by search, pin the list) apply to 296: grep all sub-44 raw buttons in CreateOrderModal before declaring done. L-276 (rerun full report after scoped jest; escape path regex like `(dashboard)`). No touch-target lesson exists.
