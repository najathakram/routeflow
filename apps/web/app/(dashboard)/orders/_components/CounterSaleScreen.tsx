"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Button, cn } from "@routeflow/ui/web";
import { getTierPrice } from "@routeflow/pricing";
import type {
  CounterSaleItem,
  CounterSalePaymentMethod,
  CounterSaleResponse,
} from "@routeflow/types";
import { apiClient } from "@/lib/api-client";
import { useCustomers } from "@/lib/api/customers";
import { useProducts } from "@/lib/api/products";
import { useCounterSaleGate, useCreateCounterSale } from "@/lib/api/counter-sale";
import { displayProductName } from "@/lib/product-display";
import {
  PAYMENT_PROBLEM_COPY,
  cartTotals,
  changeDue,
  counterSaleErrorCopy,
  parseScanField,
  paymentMethodOptions,
  preselectFulfilment,
  quickTenderOptions,
  readAutoPrint,
  validatePayment,
  writeAutoPrint,
} from "@/lib/counter-sale";
import { mergeQtyIntoLine, newLineQty } from "./add-line-merge";

interface SaleLine {
  tempId: string;
  productId: string;
  name: string;
  unitPrice: number;
  qty: number;
  unitsPerBox?: number;
  boxes?: number;
  pieces?: number;
}
interface PickedCustomer {
  id: string;
  businessName: string;
  email?: string | null;
  pricingTier?: number | null;
  fulfillPath?: string | null;
}

const money = (n: number) => `$${n.toFixed(2)}`;

/** The wire item for one line: a boxed product sends boxes/pieces, a plain one a qty; the server prices it. */
export const toSaleItem = (l: SaleLine): CounterSaleItem =>
  l.unitsPerBox
    ? { productId: l.productId, boxes: l.boxes ?? 0, pieces: l.pieces ?? 0 }
    : { productId: l.productId, qty: l.qty };

export function CounterSaleScreen() {
  const router = useRouter();
  const gate = useCounterSaleGate();
  const createSale = useCreateCounterSale();
  const scanRef = React.useRef<HTMLInputElement>(null);

  const [customer, setCustomer] = React.useState<PickedCustomer | null>(null); // null = Walk-in customer
  const [customerSearch, setCustomerSearch] = React.useState("");
  const [lines, setLines] = React.useState<SaleLine[]>([]);
  const [scanText, setScanText] = React.useState("");
  const [pendingQty, setPendingQty] = React.useState(1);
  const [scanMessage, setScanMessage] = React.useState("");
  const [method, setMethod] = React.useState<CounterSalePaymentMethod>("CASH");
  const [tendered, setTendered] = React.useState("");
  const [reference, setReference] = React.useState("");
  const [error, setError] = React.useState("");
  const [receipt, setReceipt] = React.useState<CounterSaleResponse | null>(null);
  const [autoPrint, setAutoPrint] = React.useState(false);

  React.useEffect(() => setAutoPrint(readAutoPrint()), []);
  // The scan field is ALWAYS focused: after every action, and whenever the sale view is showing.
  const refocus = React.useCallback(() => window.setTimeout(() => scanRef.current?.focus(), 0), []);
  React.useEffect(() => {
    if (!receipt) refocus();
  }, [receipt, refocus]);

  const isWalkIn = customer === null;
  const { data: settings } = useQuery<{ taxRate?: number }>({
    queryKey: ["settings"],
    queryFn: () => apiClient.get("/settings").then((r) => r.data),
    staleTime: 60_000,
  });
  const taxRate = (settings?.taxRate ?? 0) / 100;
  const totals = cartTotals(lines, taxRate);
  const tenderedNum = Number(tendered) || 0;

  const { data: customersData } = useCustomers({ search: customerSearch.trim() || undefined });
  const matches = customerSearch.trim() ? (customersData?.data ?? []).slice(0, 6) : [];

  // The fulfilment pre-selection for "Ship this order instead": the customer's own path first, then the staff default.
  const shipPreselected =
    preselectFulfilment(customer?.fulfillPath, gate.capability?.staffDefault) === "SHIP";

  const [lookup, setLookup] = React.useState<{ search?: string; scanCode?: string } | null>(null);
  const { data: found, isFetching } = useProducts(
    { ...(lookup ?? {}), isActive: true, includeVariants: true },
    { enabled: lookup !== null },
  );
  // A lookup result becomes a line (or merges +pendingQty), then the field is cleared and refocused.
  const lookupQtyRef = React.useRef(1);
  React.useEffect(() => {
    if (!lookup || isFetching) return;
    const product = (found as { data?: any[] } | undefined)?.data?.[0];
    if (!product) {
      setScanMessage("No product found for that code.");
    } else {
      addProduct(product, lookupQtyRef.current);
      setScanMessage("");
    }
    setLookup(null);
    refocus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [found, isFetching, lookup]);

  function addProduct(product: any, n: number) {
    const upb = product.unitsPerBox ? Number(product.unitsPerBox) : undefined;
    const tier = customer?.pricingTier ?? 1;
    setLines((prev) => {
      const idx = prev.findIndex((l) => l.productId === product.id);
      if (idx >= 0) return prev.map((l, i) => (i === idx ? mergeQtyIntoLine(l, n) : l));
      return [
        ...prev,
        {
          tempId: `${product.id}-${prev.length}`,
          productId: product.id,
          name: displayProductName(product),
          unitPrice: getTierPrice(product, tier),
          unitsPerBox: upb,
          ...newLineQty(upb, n),
        },
      ];
    });
  }

  function onScanSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = parseScanField(scanText);
    setScanText("");
    if (parsed.kind === "qty") {
      setPendingQty(parsed.qty); // type a quantity, then scan: it multiplies the next scan
      return;
    }
    if (!parsed.code) return;
    lookupQtyRef.current = pendingQty;
    setPendingQty(1);
    setLookup(/^\d{8,14}$/.test(parsed.code) ? { scanCode: parsed.code } : { search: parsed.code });
  }

  const removeLine = (tempId: string) => {
    setLines((prev) => prev.filter((l) => l.tempId !== tempId));
    refocus();
  };

  function resetSale() {
    setCustomer(null);
    setCustomerSearch("");
    setLines([]);
    setScanText("");
    setPendingQty(1);
    setScanMessage("");
    setMethod("CASH");
    setTendered("");
    setReference("");
    setError("");
    setReceipt(null);
    refocus();
  }

  const complete = async (): Promise<CounterSaleResponse | null> => {
    setError("");
    if (lines.length === 0) {
      setError("Add at least one item.");
      return null;
    }
    const problem = validatePayment({
      method,
      total: totals.total,
      tendered: tenderedNum,
      reference,
      isWalkIn,
    });
    if (problem) {
      setError(PAYMENT_PROBLEM_COPY[problem]);
      return null;
    }
    try {
      const res = await createSale.mutateAsync({
        ...(customer ? { customerId: customer.id } : { walkIn: true }),
        items: lines.map(toSaleItem),
        payment: {
          method,
          ...(method === "CASH" ? { amount: tenderedNum } : {}),
          ...(reference.trim() ? { reference: reference.trim() } : {}),
        },
      });
      return res;
    } catch (err) {
      setError(counterSaleErrorCopy(err)); // FIXED copy, never the server message
      return null;
    }
  };

  const completeSale = async (next: boolean) => {
    const res = await complete();
    if (!res) return;
    if (autoPrint) window.print(); // once, before any reset
    if (next) resetSale();
    else setReceipt(res);
  };

  const toggleAutoPrint = (on: boolean) => {
    setAutoPrint(on);
    writeAutoPrint(on);
  };

  // The capability said "off": this business does not use counter sales (a deep link or a stale tab).
  if (gate.capability && !gate.showButton) {
    return (
      <div className="mx-auto max-w-md p-4 text-sm" data-testid="counter-sale-off">
        Counter sales are not turned on for this business.
      </div>
    );
  }

  if (receipt) {
    return (
      <div className="mx-auto max-w-md space-y-4 p-4" data-testid="counter-sale-receipt">
        <h1 className="text-xl font-semibold">Receipt</h1>
        <p className="text-sm text-navy/70">
          Order {receipt.orderNumber} · Invoice {receipt.invoiceNumber}
        </p>
        <ul className="divide-y text-sm">
          {lines.map((l) => (
            <li key={l.tempId} className="flex justify-between py-1">
              <span>
                {l.name} ×{" "}
                {l.unitsPerBox ? `${l.boxes ?? 0} box${(l.boxes ?? 0) === 1 ? "" : "es"}` : l.qty}
              </span>
            </li>
          ))}
        </ul>
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between">
            <dt>Total</dt>
            <dd>{money(receipt.total)}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Paid</dt>
            <dd>{money(receipt.paid)}</dd>
          </div>
          {receipt.balanceDue > 0 ? (
            <div className="flex justify-between">
              <dt>Balance due</dt>
              <dd>{money(receipt.balanceDue)}</dd>
            </div>
          ) : null}
          {receipt.change != null && receipt.change > 0 ? (
            <div className="flex justify-between text-lg font-semibold">
              <dt>Change</dt>
              <dd>{money(receipt.change)}</dd>
            </div>
          ) : null}
        </dl>
        <div className="flex flex-wrap gap-2 print:hidden">
          <Button onClick={() => window.print()}>Print</Button>
          <Button variant="secondary" onClick={resetSale}>
            New sale
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4" data-testid="counter-sale-screen">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Counter sale</h1>
        {gate.offerShipInstead ? (
          <Button
            variant="secondary"
            onClick={() =>
              router.push(`/orders?action=new&ship=1${shipPreselected ? "&preselect=SHIP" : ""}`)
            }
          >
            Ship this order instead
          </Button>
        ) : null}
      </div>

      {/* customer: Walk-in by default */}
      <section aria-label="Customer" className="space-y-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">
            {customer ? customer.businessName : "Walk-in customer"}
          </span>
          {customer ? (
            <button
              type="button"
              className="text-brand-700 underline"
              onClick={() => setCustomer(null)}
            >
              Use Walk-in customer
            </button>
          ) : null}
        </div>
        <input
          aria-label="Find a customer"
          className="w-full rounded border px-3 py-2 text-sm"
          placeholder="Find a customer (optional)"
          value={customerSearch}
          onChange={(e) => setCustomerSearch(e.target.value)}
        />
        {matches.length > 0 ? (
          <ul className="rounded border text-sm">
            {matches.map((c: any) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left hover:bg-gray-50"
                  onClick={() => {
                    setCustomer(c);
                    setCustomerSearch("");
                    refocus();
                  }}
                >
                  {c.businessName}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {/* scan / search: always focused; a typed quantity multiplies the next scan */}
      <form onSubmit={onScanSubmit} className="flex items-center gap-2">
        <input
          ref={scanRef}
          aria-label="Scan or search items"
          className="w-full rounded border px-3 py-2 text-base"
          placeholder="Scan or type an item (type a quantity first to multiply)"
          value={scanText}
          onChange={(e) => setScanText(e.target.value)}
          onBlur={() => !receipt && refocus()}
          autoFocus
        />
        {pendingQty > 1 ? (
          <span
            className="rounded bg-amber-100 px-2 py-1 text-sm font-semibold"
            data-testid="pending-qty"
          >
            ×{pendingQty}
          </span>
        ) : null}
      </form>
      {scanMessage ? <p className="text-sm text-red-700">{scanMessage}</p> : null}

      <ul className="divide-y rounded border" aria-label="Items">
        {lines.length === 0 ? <li className="p-3 text-sm text-navy/60">No items yet.</li> : null}
        {lines.map((l) => (
          <li key={l.tempId} className="flex items-center justify-between gap-2 p-3 text-sm">
            <span>
              {l.name} ·{" "}
              {l.unitsPerBox
                ? `${l.boxes ?? 0} box${(l.boxes ?? 0) === 1 ? "" : "es"}${l.pieces ? ` + ${l.pieces} pcs` : ""}`
                : `× ${l.qty}`}
            </span>
            <span className="flex items-center gap-3">
              <span>{money(cartTotals([l], 0).subtotal)}</span>
              <button
                type="button"
                aria-label={`Remove ${l.name}`}
                onClick={() => removeLine(l.tempId)}
              >
                ×
              </button>
            </span>
          </li>
        ))}
      </ul>

      <div className="flex justify-between text-lg font-semibold" data-testid="running-total">
        <span>Total</span>
        <span>{money(totals.total)}</span>
      </div>

      {/* payment on the same screen */}
      <section aria-label="Payment" className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {paymentMethodOptions(isWalkIn).map((m) => (
            <button
              key={m.method}
              type="button"
              disabled={m.disabled}
              aria-pressed={method === m.method}
              className={cn(
                "rounded border px-3 py-2 text-sm disabled:opacity-40",
                method === m.method && "border-brand-600 bg-brand-50 font-semibold",
              )}
              onClick={() => {
                setMethod(m.method);
                refocus();
              }}
            >
              {m.label}
            </button>
          ))}
        </div>

        {method === "CASH" ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              {quickTenderOptions(totals.total).map((q) => (
                <button
                  key={q.label}
                  type="button"
                  disabled={q.disabled}
                  className="rounded border px-3 py-2 text-sm disabled:opacity-40"
                  onClick={() => {
                    setTendered(String(q.amount));
                    refocus();
                  }}
                >
                  {q.label}
                </button>
              ))}
            </div>
            <label className="block text-sm">
              Amount tendered
              <input
                aria-label="Amount tendered"
                inputMode="decimal"
                className="mt-1 w-full rounded border px-3 py-2"
                value={tendered}
                onChange={(e) => setTendered(e.target.value)}
              />
            </label>
            <p className="text-3xl font-bold" data-testid="change-due">
              Change {money(changeDue(totals.total, tenderedNum))}
            </p>
          </div>
        ) : null}

        {method === "CHECK" ? (
          <label className="block text-sm">
            Check number
            <input
              aria-label="Check number"
              className="mt-1 w-full rounded border px-3 py-2"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </label>
        ) : null}
      </section>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={autoPrint}
          onChange={(e) => toggleAutoPrint(e.target.checked)}
        />
        Print receipt automatically
      </label>

      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void completeSale(false)} disabled={createSale.isPending}>
          Complete sale
        </Button>
        <Button
          variant="secondary"
          onClick={() => void completeSale(true)}
          disabled={createSale.isPending}
        >
          Complete &amp; next sale
        </Button>
      </div>
    </div>
  );
}
