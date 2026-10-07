"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Button, cn } from "@routeflow/ui/web";
import { normalizeBoxesPieces, roundMoney } from "@routeflow/pricing";
import type {
  CounterSaleItem,
  CounterSaleRequest,
  CounterSalePaymentMethod,
  CounterSaleResponse,
} from "@routeflow/types";
import { API_ERROR_CODES } from "@routeflow/types";
import { apiClient } from "@/lib/api-client";
import { useOptionalAuth } from "@/lib/auth-context";
import { useCustomers } from "@/lib/api/customers";
import {
  useCounterSaleByKey,
  useCounterSaleGate,
  useCreateCounterSale,
} from "@/lib/api/counter-sale";
import { displayProductName } from "@/lib/product-display";
import {
  COUNTER_LOOKUP_FAILED_COPY,
  COUNTER_OUTCOME_UNKNOWN_COPY,
  COUNTER_SALES_DISABLED_COPY,
  PAYMENT_PROBLEM_COPY,
  cartTotals,
  changeDue,
  clearHeldAttempt,
  counterSaleErrorCopy,
  finalCounterSaleCopy,
  heldAttemptKey,
  isCounterSaleIncomplete,
  isCounterSaleNotFound,
  isDefinitiveCounterSaleRefusal,
  newIdempotencyKey,
  paymentMethodOptions,
  preselectFulfilment,
  quickTenderOptions,
  readAutoPrint,
  readHeldAttempt,
  validatePayment,
  writeAutoPrint,
  writeHeldAttempt,
} from "@/lib/counter-sale";
import { COUNTER_SCAN_FAILED_COPY } from "./useCounterSaleScan";
import { addScannedProduct, stepLine, type SaleLine, type StepUnit } from "./counter-sale-scan";
import { useCounterSaleScan } from "./useCounterSaleScan";

interface PickedCustomer {
  id: string;
  businessName: string;
  email?: string | null;
  pricingTier?: number | null;
  fulfillPath?: string | null;
}

const money = (n: number) => `$${n.toFixed(2)}`;

/** A pack of 1 (or no pack) has no box/piece split: it reads in pieces. Only unitsPerBox > 1 is a boxed line. */
const isBoxedLine = (l: SaleLine) => (l.unitsPerBox ?? 0) > 1;

/** ONE quantity label for the cart and the receipt: whole boxes, then loose pieces; a plain line reads "× qty". */
export const lineQtyLabel = (l: SaleLine): string =>
  isBoxedLine(l)
    ? `${l.boxes ?? 0} box${(l.boxes ?? 0) === 1 ? "" : "es"}${l.pieces ? ` + ${l.pieces} pcs` : ""}`
    : `× ${l.qty}`;

/**
 * The wire item for one line, shaped the way the server's normaliser reads it (`normalizeBoxesPieces`): a boxed product
 * (unitsPerBox > 1) sends `{boxes, pieces, qty}` with `qty` the integer piece count; anything else (no pack, or a pack of 1,
 * which has no box/piece split) sends `qty` alone. Boxes without a qty is what the server reads as 0.
 */
export const toSaleItem = (l: SaleLine): CounterSaleItem => {
  const n = normalizeBoxesPieces({
    boxes: l.boxes,
    pieces: l.pieces,
    qty: l.qty,
    unitsPerBox: l.unitsPerBox,
  });
  return n.boxes === null || n.pieces === null
    ? { productId: l.productId, qty: n.qty }
    : { productId: l.productId, boxes: n.boxes, pieces: n.pieces, qty: n.qty };
};

const STEP_BTN = "rounded border px-2 py-0.5 text-xs disabled:opacity-40";

/** B1208: a boxed line steps by a box or a piece; a plain line by one. Nothing steps a line to zero (x removes it). */
function LineStepper({
  line,
  locked,
  onStep,
}: {
  line: SaleLine;
  locked: boolean;
  onStep: (tempId: string, unit: StepUnit, dir: 1 | -1) => void;
}) {
  const btn = (label: string, text: string, unit: StepUnit, dir: 1 | -1) => (
    <button
      type="button"
      className={STEP_BTN}
      aria-label={label}
      disabled={locked || stepLine(line, unit, dir) === line}
      onClick={() => onStep(line.tempId, unit, dir)}
    >
      {text}
    </button>
  );
  return isBoxedLine(line) ? (
    <span className="flex items-center gap-1" role="group" aria-label={`Quantity of ${line.name}`}>
      {btn(`Remove a box from ${line.name}`, "\u2212 box", "box", -1)}
      {btn(`Add a box to ${line.name}`, "+ box", "box", 1)}
      {btn(`Remove a piece from ${line.name}`, "\u2212 pc", "piece", -1)}
      {btn(`Add a piece to ${line.name}`, "+ pc", "piece", 1)}
    </span>
  ) : (
    <span className="flex items-center gap-1" role="group" aria-label={`Quantity of ${line.name}`}>
      {btn(`Remove one ${line.name}`, "\u2212", "piece", -1)}
      {btn(`Add one ${line.name}`, "+", "piece", 1)}
    </span>
  );
}

export function CounterSaleScreen() {
  const router = useRouter();
  const gate = useCounterSaleGate();
  const createSale = useCreateCounterSale();
  const lookupSale = useCounterSaleByKey();
  const authUser = useOptionalAuth()?.user;
  // A held attempt is scoped to the signed-in tenant + user: it never stores or restores for anyone else (or when unknown).
  const heldKey = heldAttemptKey(authUser?.tenantSlug, authUser?.id);
  const scanRef = React.useRef<HTMLInputElement>(null);
  // One Idempotency-Key per SALE. It lives until a DEFINITIVE answer (any 2xx, or a 4xx that proves nothing was written) or a
  // reset; after a 5xx / network error / timeout the outcome is UNKNOWN, the sale is locked and "Try again" re-sends this same
  // body with this same key. Editing is impossible while it is held, so there is no "the request changed" renewal.
  const attemptRef = React.useRef<{
    key: string;
    dto: CounterSaleRequest;
    next: boolean;
    unknown: boolean; // true once an attempt came back UNKNOWN: from then on only a 2xx or the lookup's 404 settles it
  } | null>(null);
  // The total and change the clerk SAW (client figures) when the sale was submitted: compared with the server's on the way out.
  const estimateRef = React.useRef({ total: 0, change: 0 });
  const [outcomeUnknown, setOutcomeUnknown] = React.useState(false);
  const [heldCorrupt, setHeldCorrupt] = React.useState(false); // a stored attempt was unreadable: locked, only "recent sales" or discard
  const [lookupFailed, setLookupFailed] = React.useState(false); // "Check sale status" itself failed (not a 404 answer)
  const submittingRef = React.useRef(false);

  const [customer, setCustomer] = React.useState<PickedCustomer | null>(null); // null = Walk-in customer
  const [customerSearch, setCustomerSearch] = React.useState("");
  const [lines, setLines] = React.useState<SaleLine[]>([]);
  const [scanText, setScanText] = React.useState("");
  const [method, setMethod] = React.useState<CounterSalePaymentMethod>("CASH");
  const [tendered, setTendered] = React.useState("");
  const [reference, setReference] = React.useState("");
  const [error, setError] = React.useState("");
  const [receipt, setReceipt] = React.useState<CounterSaleResponse | null>(null);
  // Set only when the receipt came from "Check sale status": the cash the clerk ENTERED on the attempt (the server stores
  // no cash tendered), so the receipt can show tendered and change, labelled "as entered".
  const [enteredTender, setEnteredTender] = React.useState<number | null>(null);
  const [autoPrint, setAutoPrint] = React.useState(false);

  React.useEffect(() => setAutoPrint(readAutoPrint()), []);
  // A held UNKNOWN attempt survives leaving the screen: restore the locked sale with the SAME key and body.
  React.useEffect(() => {
    const held = readHeldAttempt(heldKey);
    if (!held || attemptRef.current) return;
    if (held === "corrupt") {
      // Something was held but cannot be trusted: stay LOCKED (a sale may have been written); the payload is already dropped.
      setHeldCorrupt(true);
      setOutcomeUnknown(true);
      return;
    }
    attemptRef.current = {
      key: held.key,
      dto: held.dto as CounterSaleRequest,
      next: held.next,
      unknown: true,
    };
    estimateRef.current = held.estimate ?? { total: 0, change: 0 };
    setLines(held.lines as SaleLine[]);
    setCustomer((held.customer as PickedCustomer | null) ?? null);
    setMethod(held.method as CounterSalePaymentMethod);
    setTendered(held.tendered ?? "");
    setReference(held.reference ?? "");
    setOutcomeUnknown(true);
  }, [heldKey]);
  // The scan field is ALWAYS focused: after every action, and whenever the sale view is showing.
  const refocus = React.useCallback(() => window.setTimeout(() => scanRef.current?.focus(), 0), []);
  const locked = outcomeUnknown; // every cart / payment control is disabled while the outcome is unknown
  // A KEYBOARD activation of a tender / method button (detail 0) keeps focus where it is, so Tab goes on to the next control.
  const refocusAfterPointer = (e: React.MouseEvent) => {
    if (e.detail > 0) refocus();
  };
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
  const shipPreselected = preselectFulfilment(customer?.fulfillPath, gate.capability) === "SHIP";

  // B1206-B1208: every scan joins one FIFO queue resolved through the shared exact-code ladder (see useCounterSaleScan).
  const scan = useCounterSaleScan({
    locked,
    refocus,
    add: (product, level, n) =>
      setLines((prev) => addScannedProduct(prev, product, level, n, customer?.pricingTier ?? 1)),
  });

  const scanBusy = scan.waiting > 0;
  const scanBusyRef = React.useRef(false);
  scanBusyRef.current = scanBusy;

  function onScanSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (locked) return;
    const text = scanText;
    setScanText("");
    scan.submit(text);
  }

  const stepItem = (tempId: string, unit: StepUnit, dir: 1 | -1) => {
    setLines((prev) => prev.map((l) => (l.tempId === tempId ? stepLine(l, unit, dir) : l)));
    refocus();
  };

  const removeLine = (tempId: string) => {
    setLines((prev) => prev.filter((l) => l.tempId !== tempId));
    refocus();
  };

  function resetSale() {
    setCustomer(null);
    setCustomerSearch("");
    setLines([]);
    setScanText("");
    scan.reset();
    setMethod("CASH");
    setTendered("");
    setReference("");
    setError("");
    setReceipt(null);
    setEnteredTender(null);
    attemptRef.current = null;
    clearHeldAttempt(heldKey);
    setOutcomeUnknown(false);
    setHeldCorrupt(false);
    setLookupFailed(false);
    refocus();
  }

  // Sends one attempt. A 2xx releases the key. A FIRST attempt's refusal that proves nothing was written releases it too.
  // Anything else, and ANY failure once an attempt is already unknown (the first try may have committed), keeps the key and
  // locks the sale as "outcome unknown".
  const send = async (attempt: {
    key: string;
    dto: CounterSaleRequest;
    next: boolean;
    unknown: boolean;
  }): Promise<CounterSaleResponse | null> => {
    setLookupFailed(false);
    try {
      const res = await createSale.mutateAsync({ dto: attempt.dto, idempotencyKey: attempt.key });
      attemptRef.current = null;
      clearHeldAttempt(heldKey);
      setOutcomeUnknown(false);
      return res;
    } catch (err) {
      const finalCopy = finalCounterSaleCopy(err);
      if (finalCopy) {
        // FINAL (even for an unknown attempt): voided or changed after it was rung. Drop the key, unlock, never retry.
        attemptRef.current = null;
        clearHeldAttempt(heldKey);
        setOutcomeUnknown(false);
        setError(finalCopy);
      } else if (!attempt.unknown && isDefinitiveCounterSaleRefusal(err)) {
        attemptRef.current = null;
        clearHeldAttempt(heldKey);
        setOutcomeUnknown(false);
        setError(counterSaleErrorCopy(err)); // FIXED copy, never the server message
      } else {
        attempt.unknown = true;
        writeHeldAttempt(heldKey, {
          key: attempt.key,
          dto: attempt.dto,
          next: attempt.next,
          estimate: estimateRef.current,
          lines,
          customer,
          method,
          tendered,
          reference,
        });
        setError("");
        setOutcomeUnknown(true);
      }
      return null;
    }
  };

  const complete = async (next: boolean): Promise<CounterSaleResponse | null> => {
    setError("");
    if (attemptRef.current) return send(attemptRef.current); // an unknown outcome: the SAME body, the SAME key
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
    const tenderAmount = roundMoney(tenderedNum);
    const dto: CounterSaleRequest = {
      ...(customer ? { customerId: customer.id } : { walkIn: true }),
      items: lines.map(toSaleItem),
      payment: {
        method,
        ...(method === "CASH" ? { amount: tenderAmount } : {}),
        ...(reference.trim() ? { reference: reference.trim() } : {}),
      },
    };
    attemptRef.current = { key: newIdempotencyKey(), dto, next, unknown: false };
    estimateRef.current = {
      total: totals.total,
      change: method === "CASH" ? changeDue(totals.total, tenderAmount) : 0,
    };
    return send(attemptRef.current);
  };

  // A sale the server confirmed: print once, then the receipt (or, for "next", a fresh sale when nothing needs the clerk's eyes).
  const finishSale = (res: CounterSaleResponse, next: boolean) => {
    // "Complete & next sale" never hides an unpaid sale: payment not recorded or a balance still due keeps the receipt
    // (whose own "New sale" starts the next one). The same holds when the server's total or change is not what the screen
    // showed the clerk (a credit auto-applied, a re-priced line): the receipt, with the SERVER's figures, shows first.
    const unpaid = res.paymentRecorded === false || res.balanceDue > 0;
    const shown = estimateRef.current;
    const figuresDiffer =
      roundMoney(res.total) !== roundMoney(shown.total) ||
      roundMoney(res.change ?? 0) !== roundMoney(shown.change);
    const startFresh = next && !unpaid && !figuresDiffer;
    if (autoPrint) {
      // D6: the RECEIPT is rendered first, then printed once (the effect below), and only then does "next" reset.
      printAfterRenderRef.current = { reset: startFresh };
      setReceipt(res);
    } else if (startFresh) resetSale();
    else setReceipt(res);
  };

  const completeSale = async (next: boolean, retry = false) => {
    if (submittingRef.current) return; // a double Enter / click is one sale
    // A scan still resolving (or waiting on Retry / the picker) is not on the cart yet: never post without it.
    if (!retry && scanBusyRef.current) return;
    submittingRef.current = true;
    try {
      if (retry) next = attemptRef.current?.next ?? next; // "Try again" finishes the sale the way it was started
      const res = await complete(next);
      if (!res) return;
      finishSale(res, next);
    } finally {
      submittingRef.current = false;
    }
  };

  // "Check sale status": ask the server whether a sale exists under the held key (with the method THIS attempt rang). A sale
  // shows its receipt; a 404 COUNTER_SALE_NOT_FOUND unlocks the cart (the next submit then mints a new key); a 409
  // COUNTER_SALE_INCOMPLETE (half-written) re-sends the SAME attempt once, like "Try again"; every other answer keeps the lock.
  const checkSaleStatus = async () => {
    const attempt = attemptRef.current;
    if (!attempt || submittingRef.current) return;
    submittingRef.current = true;
    setLookupFailed(false);
    let resend = false;
    try {
      resend = await lookupAndSettle(attempt);
    } finally {
      submittingRef.current = false;
    }
    if (resend) await completeSale(false, true); // once, through the same path as "Try again"
  };

  // One lookup. Resolves true when the sale is half-written (COUNTER_SALE_INCOMPLETE) and must be re-POSTed.
  const lookupAndSettle = async (
    attempt: NonNullable<typeof attemptRef.current>,
  ): Promise<boolean> => {
    let res: CounterSaleResponse;
    try {
      res = await lookupSale.mutateAsync({
        idempotencyKey: attempt.key,
        method: attempt.dto.payment.method,
      });
    } catch (err) {
      const finalCopy = finalCounterSaleCopy(err);
      if (finalCopy) {
        // FINAL: voided or changed after it was rung. Unlock, drop the key, show the one copy, and NEVER re-POST.
        attemptRef.current = null;
        clearHeldAttempt(heldKey);
        setOutcomeUnknown(false);
        setError(finalCopy);
        refocus();
      } else if (isCounterSaleNotFound(err)) {
        attemptRef.current = null;
        clearHeldAttempt(heldKey);
        setOutcomeUnknown(false);
        refocus();
      } else if (isCounterSaleIncomplete(err)) {
        return true; // finish the half-written sale: the SAME key, the SAME body
      } else {
        // Not an answer: the lock and banner stay, and the clerk is told the CHECK failed (fixed copy).
        setLookupFailed(true);
      }
      return false;
    }
    // The SERVER's answer is the verdict (it applied POST's own rule for the method this attempt rang): never re-derived here.
    // A partly stored tender (not recorded, balance owing) is finished by re-POSTing the SAME key and body; the attempt stays held.
    if (res.paymentRecorded === false && res.balanceDue > 0) return true;
    attemptRef.current = null;
    clearHeldAttempt(heldKey);
    setOutcomeUnknown(false);
    const { method: sentMethod, amount } = attempt.dto.payment;
    setEnteredTender(
      sentMethod === "CASH" && amount != null && res.paymentRecorded !== false ? amount : null,
    );
    finishSale({ ...res, method: res.method ?? sentMethod }, attempt.next);
    return false;
  };

  // Auto-print: runs after the receipt has committed to the DOM, so the page printed IS the receipt.
  const printAfterRenderRef = React.useRef<{ reset: boolean } | null>(null);
  React.useEffect(() => {
    if (!receipt || !printAfterRenderRef.current) return;
    const { reset } = printAfterRenderRef.current;
    printAfterRenderRef.current = null;
    window.print(); // once per completed sale
    if (reset) resetSale();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt]);

  const toggleAutoPrint = (on: boolean) => {
    setAutoPrint(on);
    writeAutoPrint(on);
  };

  // The features answer is not in yet: an empty, non-interactive placeholder, with no copy (neither the sale UI nor a false
  // "not turned on").
  if (gate.loading) return <div data-testid="counter-sale-loading" aria-busy="true" />;

  // Missing means dark: loading, error, unknown, a response without the capability, or counter "off" all render NO sale UI
  // (a deep link or a stale tab). Only "optional" / "always" open the screen.
  if (!gate.showButton) {
    return (
      <div className="mx-auto max-w-md p-4 text-sm" data-testid="counter-sale-off">
        {COUNTER_SALES_DISABLED_COPY}
      </div>
    );
  }

  if (receipt) {
    const paymentNotRecorded = receipt.paymentRecorded === false;
    // The server's tender method (echoed on the POST, derived from storage on a recovered sale): an ON_ACCOUNT sale is
    // owed on account, which is not a failed payment.
    const onAccount = receipt.method === "ON_ACCOUNT" && !paymentNotRecorded;
    // Change: the server's when it has one; else, on a RECOVERED cash sale (the server stores no cash tendered), the
    // attempt's tendered minus what was paid, labelled "as entered".
    const serverChange = receipt.change != null && receipt.change > 0 ? receipt.change : null;
    const derivedChange =
      serverChange == null && enteredTender != null && !paymentNotRecorded
        ? roundMoney(enteredTender - receipt.paid)
        : null;
    const shownChange =
      serverChange ?? (derivedChange != null && derivedChange > 0 ? derivedChange : null);
    const changeAsEntered = serverChange == null && shownChange != null;
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
                {l.name} {isBoxedLine(l) ? "× " : ""}
                {lineQtyLabel(l)}
              </span>
            </li>
          ))}
        </ul>
        {onAccount ? (
          <div
            role="status"
            className="space-y-1 rounded border border-navy/20 bg-navy/5 p-3 text-sm"
            data-testid="counter-on-account"
          >
            <p className="font-semibold">On account</p>
            <p>{money(receipt.balanceDue)} balance due on account</p>
          </div>
        ) : null}
        {paymentNotRecorded ? (
          <div
            role="status"
            className="space-y-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm"
            data-testid="counter-payment-not-recorded"
          >
            <p className="font-semibold">Sale recorded — payment not recorded</p>
            <Link
              href={`/invoices/${receipt.invoiceId}`}
              className="inline-block text-brand-700 underline print:hidden"
            >
              Record payment
            </Link>
          </div>
        ) : null}
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between text-lg font-semibold" data-testid="receipt-total">
            <dt>Total</dt>
            <dd>{money(receipt.total)}</dd>
          </div>
          {paymentNotRecorded || onAccount ? null : (
            <div className="flex justify-between">
              <dt>Paid</dt>
              <dd>{money(receipt.paid)}</dd>
            </div>
          )}
          {paymentNotRecorded || onAccount || receipt.balanceDue > 0 ? (
            <div className="flex justify-between">
              <dt>Balance due</dt>
              <dd>{money(receipt.balanceDue)}</dd>
            </div>
          ) : null}
          {enteredTender != null && !paymentNotRecorded ? (
            <div className="flex justify-between">
              <dt>Tendered</dt>
              <dd>
                {money(enteredTender)} <span className="text-xs text-navy/60">as entered</span>
              </dd>
            </div>
          ) : null}
          {!paymentNotRecorded && shownChange != null && shownChange > 0 ? (
            <div className="flex justify-between text-lg font-semibold">
              <dt>Change</dt>
              <dd>
                {money(shownChange)}
                {changeAsEntered ? (
                  <span className="ml-1 text-xs font-normal text-navy/60">as entered</span>
                ) : null}
              </dd>
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
            disabled={locked}
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
              disabled={locked}
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
          disabled={locked}
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
                  disabled={locked}
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
          disabled={locked}
          onChange={(e) => setScanText(e.target.value)}
          onBlur={(e) => {
            // only when focus is LOST (a click on blank space); Tab/click to another control keeps it there
            if (!receipt && !locked && !e.relatedTarget) refocus();
          }}
          autoFocus
        />
        {scan.pendingQty > 1 ? (
          <span
            className="rounded bg-amber-100 px-2 py-1 text-sm font-semibold"
            data-testid="pending-qty"
          >
            ×{scan.pendingQty}
          </span>
        ) : null}
      </form>
      {scan.message ? <p className="text-sm text-red-700">{scan.message}</p> : null}
      {scan.failed ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm"
          data-testid="counter-scan-error"
        >
          <span>{COUNTER_SCAN_FAILED_COPY}</span>
          <Button onClick={scan.retry}>Retry</Button>
          <Button variant="secondary" onClick={scan.dismissFailure}>
            Skip this scan
          </Button>
          {scan.waiting > 1 ? <span>{scan.waiting - 1} more waiting</span> : null}
        </div>
      ) : null}
      {scan.picker ? (
        <section
          aria-label="Choose a product"
          className="space-y-2 rounded border p-3 text-sm"
          data-testid="counter-scan-picker"
        >
          <p className="font-medium">
            Several products match &ldquo;{scan.picker.code}&rdquo;. Choose one.
          </p>
          <ul className="space-y-1">
            {scan.picker.matches.map((p: any) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="w-full rounded border px-3 py-2 text-left hover:bg-gray-50"
                  onClick={() => scan.choose(p)}
                >
                  {displayProductName(p)}
                  {p.sku ? <span className="ml-2 text-xs text-navy/60">{p.sku}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          <Button variant="secondary" onClick={scan.cancelPicker}>
            Cancel
          </Button>
          {scan.waiting > 1 ? <p>{scan.waiting - 1} more scans waiting</p> : null}
        </section>
      ) : null}

      <ul className="divide-y rounded border" aria-label="Items">
        {lines.length === 0 ? <li className="p-3 text-sm text-navy/60">No items yet.</li> : null}
        {lines.map((l) => (
          <li key={l.tempId} className="flex items-center justify-between gap-2 p-3 text-sm">
            <span>
              {l.name} · {lineQtyLabel(l)}
            </span>
            <span className="flex items-center gap-3">
              <LineStepper line={l} locked={locked} onStep={stepItem} />
              <span>{money(cartTotals([l], 0).subtotal)}</span>
              <button
                type="button"
                aria-label={`Remove ${l.name}`}
                disabled={locked}
                onClick={() => removeLine(l.tempId)}
              >
                ×
              </button>
            </span>
          </li>
        ))}
      </ul>

      <div className="flex justify-between text-lg font-semibold" data-testid="running-total">
        <span>Estimated total</span>
        <span>{money(totals.total)}</span>
      </div>

      {/* payment on the same screen */}
      <section aria-label="Payment" className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {paymentMethodOptions(isWalkIn).map((m) => (
            <button
              key={m.method}
              type="button"
              disabled={m.disabled || locked}
              aria-pressed={method === m.method}
              className={cn(
                "rounded border px-3 py-2 text-sm disabled:opacity-40",
                method === m.method && "border-brand-600 bg-brand-50 font-semibold",
              )}
              onClick={(e) => {
                setMethod(m.method);
                refocusAfterPointer(e);
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
                  disabled={q.disabled || locked}
                  className="rounded border px-3 py-2 text-sm disabled:opacity-40"
                  onClick={(e) => {
                    setTendered(String(q.amount));
                    refocusAfterPointer(e);
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
                disabled={locked}
                onChange={(e) => setTendered(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void completeSale(false);
                  }
                }}
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
              disabled={locked}
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

      {outcomeUnknown ? (
        <div
          role="alert"
          className="space-y-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm"
          data-testid="counter-outcome-unknown"
        >
          <p className="font-semibold">{COUNTER_OUTCOME_UNKNOWN_COPY}</p>
          {lookupFailed ? <p>{COUNTER_LOOKUP_FAILED_COPY}</p> : null}
          <div className="flex flex-wrap items-center gap-3">
            {heldCorrupt ? (
              <Button variant="secondary" onClick={resetSale}>
                Discard and start a new sale
              </Button>
            ) : (
              <>
                <Button
                  onClick={() => void completeSale(false, true)}
                  disabled={createSale.isPending || lookupSale.isPending}
                >
                  Try again
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => void checkSaleStatus()}
                  disabled={createSale.isPending || lookupSale.isPending}
                >
                  Check sale status
                </Button>
              </>
            )}
            <Link href="/orders" className="text-brand-700 underline">
              Check recent sales
            </Link>
          </div>
        </div>
      ) : null}

      {scanBusy ? (
        <p role="status" className="text-sm text-navy/70" data-testid="counter-scan-busy">
          Adding scanned items…
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => void completeSale(false)}
          disabled={createSale.isPending || locked || scanBusy}
        >
          Complete sale
        </Button>
        <Button
          variant="secondary"
          onClick={() => void completeSale(true)}
          disabled={createSale.isPending || locked || scanBusy}
        >
          Complete &amp; next sale
        </Button>
      </div>
    </div>
  );
}
