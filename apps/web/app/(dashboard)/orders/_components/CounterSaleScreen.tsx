"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Button, TAP_TARGET, cn } from "@routeflow/ui/web";
import {
  formatReceiptMoney as money,
  normalizeBoxesPieces,
  roundMoney,
  type ParkedCartPayload,
  type SellLevel,
} from "@routeflow/pricing";
import type {
  CounterSaleItem,
  CounterSaleRequest,
  CounterSalePaymentMethod,
  CounterSaleResponse,
} from "@routeflow/types";
import { API_ERROR_CODES, staffMay } from "@routeflow/types";
import { apiClient } from "@/lib/api-client";
import { useOptionalAuth } from "@/lib/auth-context";
import {
  setCounterCartBusy,
  setCounterCartHasLines,
  setCounterDiscardHook,
} from "@/lib/counter-cart-signal";
import { useCustomers } from "@/lib/api/customers";
import { useTrackedCategories } from "@/lib/api/tracked-categories";
import { useCreateDraft } from "@/lib/api/drafts";
import { DidYouMeanPicker } from "@/components/scan/DidYouMeanPicker";
import {
  COUNTER_SHIP_FAILED_COPY,
  COUNTER_SHIP_WALK_IN_CAPTION,
  counterShipDraftInput,
} from "@/lib/counter-ship-handoff";
import {
  useCounterSaleByKey,
  useCounterSaleGate,
  useCreateCounterSale,
} from "@/lib/api/counter-sale";
import { usePermissionDeniedWatcher } from "@/lib/api/my-permissions";
import { displayProductName } from "@/lib/product-display";
import {
  COUNTER_LOOKUP_FAILED_COPY,
  COUNTER_OFFLINE_COPY,
  COUNTER_DISCARD_COPY,
  COUNTER_OUTCOME_UNKNOWN_COPY,
  COUNTER_NO_ACCESS_COPY,
  COUNTER_SALES_DISABLED_COPY,
  counterSaleGate,
  isTenderShortCopy,
  paymentProblemCopy,
  cartTotals,
  amountDue,
  changeDue,
  clearHeldAttempt,
  counterSaleErrorCopy,
  finalCounterSaleCopy,
  heldAttemptKey,
  isCounterSaleIncomplete,
  isCounterSaleNotFound,
  isDefinitiveCounterSaleRefusal,
  isFinalSaleMessage,
  isNotSentOffline,
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
import { keptSaleHref } from "@/lib/kept-draft-invoice";
import { receiptCustomerName, type ReceiptBusinessProfile } from "@/lib/counter-receipt";
import { isCounterSaleDayClosed } from "@/lib/day-closed-copy";
import { CounterReceiptBody } from "./CounterReceiptBody";
import { CounterCustomerCredit } from "./CounterCustomerCredit";
import { CounterGateOffline } from "./CounterGateOffline";
import { CounterCustomerMatches, useCustomerListbox } from "./CounterCustomerMatches";
import {
  CounterLastSale,
  lastSaleNoteFrom,
  useLastSaleNote,
  type LastSaleNote,
} from "./CounterLastSale";
import { useCounterLineUndo } from "./useCounterLineUndo";
import { COUNTER_SCAN_FAILED_COPY } from "./useCounterSaleScan";
import { useCounterReprice } from "./useCounterReprice";
import { repriceLines } from "./counter-sale-reprice";
import { PRICE_LAYER_TOO_MANY_COPY } from "@/components/PriceLayerNotice";
import { isTextEntryActive } from "@/lib/refocus-scanner";
import { scrollPageToTop } from "@/lib/scroll-top";
import { useCounterLiveCart } from "./useCounterLiveCart";
import { liveCartKey } from "@/lib/counter-live-cart-keys";
import { addScannedProduct, stepLine, type SaleLine, type StepUnit } from "./counter-sale-scan";
import { CounterLineRow } from "./CounterLineRow";
import type { CounterPriceEdit } from "./CounterLinePriceEdit";
import {
  applyPriceEdit,
  discountsTotal,
  lineNeedingReason,
  resetPriceEdit,
} from "./counter-sale-price-edit";
import {
  isBoxedLine,
  lineQtyLabel,
  restoreLine,
  setLineQty,
  type TypedQty,
  setLineNote,
  takeLine,
  toSaleItem,
} from "./counter-sale-line-edit";
import { useCounterSaleScan } from "./useCounterSaleScan";
import { useCounterScanFocus } from "./useCounterScanFocus";
import { CounterReceiptActions } from "./CounterReceiptActions";
import { CounterTodaysSales } from "./CounterTodaysSales";
import { ParkedSales } from "./ParkedSales";
import { QuickKeysGrid } from "./QuickKeysGrid";
import { ReadOnlyHint, WriteButton, useReadOnlyGate } from "@/lib/read-only-gate";

interface PickedCustomer {
  id: string;
  businessName: string;
  email?: string | null;
  pricingTier?: number | null;
  fulfillPath?: string | null;
  /** the system walk-in customer record (a pick of it is still a walk-in on the receipt) */
  isWalkIn?: boolean | null;
  /** owes no sales tax and no levy: the estimate, the order and the invoice all say so */
  isTaxExempt?: boolean | null;
}

export { lineQtyLabel, toSaleItem } from "./counter-sale-line-edit";

export function CounterSaleScreen() {
  const readOnlyGate = useReadOnlyGate();
  const router = useRouter();
  const gate = useCounterSaleGate();
  usePermissionDeniedWatcher();
  // CQ-30: once the capability check has failed, the retry panel stays up for the WHOLE refetch. React Query flips a failed,
  // data-less lookup back to "loading" the moment it refetches; without this the panel gave way to the blank loading
  // placeholder for the length of the request. It leaves only when the lookup settles (the sale UI, or the panel again).
  const gateWasFailedRef = React.useRef(false);
  if (gate.failed) gateWasFailedRef.current = true;
  else if (!gate.loading) gateWasFailedRef.current = false;
  const keepRetryPanel = gate.failed || (gate.loading && gateWasFailedRef.current);
  const createSale = useCreateCounterSale();
  const lookupSale = useCounterSaleByKey();
  const createDraft = useCreateDraft();
  const authUser = useOptionalAuth()?.user;
  // POS-5 / SA-762r: the ONE price-edit gate (operator + admin). False = no price control exists on the screen.
  const mayEditPrices = staffMay(authUser?.role, "EDIT_LINE_PRICE");
  // A held attempt is scoped to the signed-in tenant + user: it never stores or restores for anyone else (or when unknown).
  const heldKey = heldAttemptKey(authUser?.tenantSlug, authUser?.id);
  const liveKey = liveCartKey(authUser?.tenantSlug, authUser?.id);
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
  // Row 466: where the sale landed when the call failed AFTER it committed (the invoice, else the order).
  const [recordedHref, setRecordedHref] = React.useState<string | null>(null);
  const [heldCorrupt, setHeldCorrupt] = React.useState(false); // a stored attempt was unreadable: locked, only "recent sales" or discard
  const [lookupFailed, setLookupFailed] = React.useState(false); // "Check sale status" itself failed (not a 404 answer)
  // CQ-29: the key of a sale that got no answer for want of a connection. The form is usable again, and the next Complete reuses
  // it: the server answers an identical retry with the same sale, and a changed cart with a key mismatch (never a second sale).
  const offlineKeyRef = React.useRef<string | null>(null);
  const submittingRef = React.useRef(false);
  const customerFindRef = React.useRef<HTMLInputElement>(null);
  // B1210: "Ship this order instead" is an intent that completes on its own once the cart can be handed over (a customer is
  // picked, no scan is still resolving). A walk-in keeps the intent open while the clerk finds a customer.
  const [shipIntent, setShipIntent] = React.useState(false);
  const [shipFailed, setShipFailed] = React.useState(false);
  const shipRunningRef = React.useRef(false);
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const awaitingCustomerRef = React.useRef(false);

  const [customer, setCustomer] = React.useState<PickedCustomer | null>(null); // null = Walk-in customer
  const [customerSearch, setCustomerSearch] = React.useState("");
  const [lines, setLines] = React.useState<SaleLine[]>([]);
  const [lastSale, setLastSale] = useLastSaleNote(lines.length); // CQ-17: the order "Complete & next" just finished
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
  // While a walk-in sale waits for the customer to ship to, the customer field keeps focus instead.
  const { refocus, focusCustomerFind, refocusFromActive } = useCounterScanFocus({
    scanRef,
    customerFindRef,
    awaitingCustomerRef,
  });
  // CQ-18: a refusal shown in the checkout bar belongs to the cart that was refused. Any edit to the cart's lines (a scan, a
  // quantity, a removal, a re-price) makes it stale, so it goes. A FINAL message (the sale was voided / changed / saved
  // unpaid) is about a sale that exists and stays. The tender has its own rule just below.
  React.useEffect(() => {
    setError((e) => (isFinalSaleMessage(e) ? e : ""));
  }, [lines]);
  // Fixing the tender clears the "Enter at least $X" message and ONLY that one (never a server or final-sale error).
  const clearUnderpaidError = () => setError((e) => (isTenderShortCopy(e) ? "" : e));
  const locked = outcomeUnknown; // every cart / payment control is disabled while the outcome is unknown
  // SA-748 section 1: the unfinished cart survives a refresh (restored UNLOCKED; a held attempt always wins).
  const liveCart = useCounterLiveCart({
    storeKey: liveKey,
    heldKey,
    snapshot: { lines, customer, method, tendered, reference },
    suspended: createSale.isPending || outcomeUnknown || receipt !== null,
    canRestore: lines.length === 0 && !receipt,
    onRestore: (snap) => {
      setLines(snap.lines as SaleLine[]);
      setCustomer((snap.customer as PickedCustomer | null) ?? null);
      setMethod(snap.method as CounterSalePaymentMethod);
      // The cash is not restored: prices may have moved since it was tapped, so it is entered against today's total.
      setReference(snap.reference);
    },
    onClearedElsewhere: () => {
      setLines([]);
      setCustomer(null);
      setReference("");
    },
  });
  const hasLines = lines.length > 0; // POS-7: the register header's Exit asks before discarding a cart with lines
  React.useEffect(() => {
    setCounterCartHasLines(hasLines);
    return () => setCounterCartHasLines(false);
  }, [hasLines]);
  // The register's "Discard this sale?" also drops the stored live cart, or it would come back next visit.
  const discardLiveCart = liveCart.discard;
  React.useEffect(() => {
    setCounterDiscardHook(discardLiveCart);
    return () => setCounterDiscardHook(null);
  }, [discardLiveCart]);
  // A sale POST, a ship draft save or an unknown sale outcome: the register's Exit must not leave (it would drop the receipt).
  const busy = createSale.isPending || createDraft.isPending || outcomeUnknown;
  React.useEffect(() => {
    setCounterCartBusy(busy);
    return () => setCounterCartBusy(false);
  }, [busy]);
  // Closing or reloading the tab mid-sale loses the attempt too: ask the browser to confirm while busy.
  React.useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);
  // POS-3: every LINE control (stepper, remove, note, Undo) is also off while the sale POST is in flight.
  // `sending` covers the sale request (set in `send`, validation refusals never reach it), so the freeze never depends on the mutation's own flag
  // re-rendering in time; `saleInFlight()` is the same truth for HANDLERS, which must no-op rather than lean on `disabled`.
  const [sending, setSending] = React.useState(false);
  const salePosting = createSale.isPending || sending;
  const saleInFlight = () => submittingRef.current || createSale.isPending;
  // A park / resume / discard request in flight (reported by ParkedSales): lines, scans and Complete wait for it, so the cart
  // that is parked is the cart that is cleared.
  const [parkBusy, setParkBusy] = React.useState(false);
  const parkBusyRef = React.useRef(false);
  const onParkBusy = (busy: boolean) => {
    parkBusyRef.current = busy;
    setParkBusy(busy);
  };
  const lineLocked = locked || salePosting || parkBusy;
  // A KEYBOARD activation of a tender / method button (detail 0) keeps focus where it is, so Tab goes on to the next control.
  // One scan-focus owner (row 237): a digit typed while a NON-text control holds focus (a button, a checkbox, <body>)
  // is a scan or the start of one, so it goes to the scan box instead of starting an Enter on "Add note" or a stray shortcut.
  // Text fields, Ctrl/Meta/Alt combos and open dialogs are never redirected.
  React.useEffect(() => {
    if (receipt || locked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (!/^[0-9]$/.test(e.key)) return; // digits only: letters are the g-then-x navigation shortcuts
      const scanEl = scanRef.current;
      if (!scanEl || document.activeElement === scanEl || isTextEntryActive()) return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      // a Radix Select / Menu typeahead owns the digits while its list or trigger holds focus
      if (
        document.activeElement?.closest(
          '[role="listbox"],[role="menu"],[role="combobox"],[data-radix-popper-content-wrapper],[data-radix-select-viewport],[data-radix-menu-content]',
        )
      )
        return;
      scanEl.focus();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [receipt, locked]);
  // Row 112: the sticky checkout bar floats over the page below md; the screen reserves its measured height at the bottom so
  // the last cart line and the Cash/Card buttons can always scroll clear of it (the bar grows with an error or a change line).
  const [barHeight, setBarHeight] = React.useState(0);
  const barObserver = React.useRef<ResizeObserver | null>(null);
  // A CALLBACK ref: the bar mounts after the gate's loading render and again after the receipt view, so the observer is
  // attached whenever the element appears and torn down whenever it goes.
  const barRef = React.useCallback((el: HTMLDivElement | null) => {
    barObserver.current?.disconnect();
    barObserver.current = null;
    if (!el) return;
    const measure = () => setBarHeight(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    barObserver.current = new ResizeObserver(measure);
    barObserver.current.observe(el);
  }, []);
  // Rows 330a / 368: below md the checkout bar floats at the bottom of the scroll container. `position: sticky` stops at the
  // container's own padding (the shell's pb-24), so left alone the bar floated 96 px up with cart lines showing below it.
  // The bar's `bottom` is pulled down through that padding and the screen draws the same padding back in (a negative
  // margin), so the bar is the LAST thing in the scroll and rests at the real bottom: the only space reserved for it is its
  // own in-flow height. A control that takes focus mid-page (a quantity, Tab, the keyboard) is scrolled to the container's
  // bottom edge, under the floating bar, so the container's scroll-padding is exactly the bar's height. Let go on unmount.
  const [mainPad, setMainPad] = React.useState(0);
  React.useEffect(() => {
    const main = document.getElementById("main-content");
    // md+ lays the bar out in the payment column (static), so only the floating one needs this
    const floating = !window.matchMedia?.("(min-width: 768px)").matches;
    if (!main || !floating) {
      setMainPad(0);
      return;
    }
    setMainPad(parseFloat(getComputedStyle(main).paddingBottom) || 0);
    if (barHeight === 0) return;
    main.style.setProperty("scroll-padding-bottom", `${barHeight}px`);
    return () => {
      main.style.removeProperty("scroll-padding-bottom");
    };
  }, [barHeight]);
  const refocusAfterPointer = (e: React.MouseEvent) => {
    if (e.detail > 0) refocus();
  };
  const receiptHeadingRef = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    if (!receipt) refocus();
    else {
      // POS-1: keyboard focus lands on the receipt heading. CQ-33: without scrolling to it, and the page back at its top, so
      // a clerk who had scrolled the sale down to the Complete buttons reads the receipt from its first line.
      receiptHeadingRef.current?.focus({ preventScroll: true });
      scrollPageToTop();
    }
  }, [receipt, refocus]);

  const isWalkIn = customer === null;
  const { data: settings } = useQuery<ReceiptBusinessProfile>({
    queryKey: ["settings"],
    queryFn: () => apiClient.get("/settings").then((r) => r.data),
    staleTime: 60_000,
  });
  const taxRate = (settings?.taxRate ?? 0) / 100;
  // The regulated levy and the exempt customer's $0 tax are in the estimate, so it is the receipt's figure to the cent
  // (CQ-01 / CQ-02 / CQ-28): the same saleTotals the order and invoice sums run.
  const { data: categoryRows, isSuccess: categoriesLoaded } = useTrackedCategories();
  const categories = React.useMemo(
    () => new Map((Array.isArray(categoryRows) ? categoryRows : []).map((c) => [c.id, c])),
    [categoryRows],
  );
  const totals = cartTotals(lines, taxRate, {
    categories,
    isTaxExempt: customer?.isTaxExempt === true,
  });
  const discounts = discountsTotal(lines, settings?.hideOriginalPrice === true); // POS-5: the `Discounts` row (display only; the total already includes it)
  const tenderedNum = Number(tendered) || 0;

  const { data: customersData, isFetching: customersFetching } = useCustomers({
    search: customerSearch.trim() || undefined,
  });
  const matches = customerSearch.trim() ? (customersData?.data ?? []).slice(0, 6) : [];
  const pickCustomer = (c: PickedCustomer) => {
    if (lineLocked || saleInFlight()) return;
    setCustomer(c);
    setCustomerSearch("");
    refocus();
  };
  const customerListbox = useCustomerListbox(
    matches as PickedCustomer[],
    customerSearch,
    pickCustomer,
  );

  // The fulfilment pre-selection for "Ship this order instead": the customer's own path first, then the staff default.
  const shipPreselected = preselectFulfilment(customer?.fulfillPath, gate.capability) === "SHIP";

  // POS-2: a customer pick (or a revert to walk-in) re-prices the cart for them; Pay waits on the lookup. Display only.
  // SA-748: a resumed parked cart bumps `repriceEpoch` so its lines are re-priced for display even when the customer is unchanged.
  const [repriceEpoch, setRepriceEpoch] = React.useState(0);
  const reprice = useCounterReprice({
    customer,
    lines,
    setLines,
    locked: lineLocked,
    epoch: repriceEpoch,
  });
  const repriceBlockedRef = React.useRef(false);
  repriceBlockedRef.current = reprice.blocked;

  // The ONE add path: a scan, a picker click and a quick-key tap all land a product through here.
  const addProduct = (product: any, level: SellLevel, n: number) =>
    setLines((prev) =>
      addScannedProduct(
        prev,
        product,
        level,
        n,
        reprice.tierFor(product.id),
        reprice.layerOf(product.id),
      ),
    );

  // B1206-B1208: every scan joins one FIFO queue resolved through the shared exact-code ladder (see useCounterSaleScan).
  const scan = useCounterSaleScan({
    locked: lineLocked,
    refocus,
    add: (product, level, n) => {
      scanCueArmedRef.current = true;
      setLines((prev) =>
        addScannedProduct(
          prev,
          product,
          level,
          n,
          reprice.tierFor(product.id),
          reprice.layerOf(product.id),
        ),
      );
    },
  });

  // A scan that lands on a line already in the cart says so (a new line is its own signal): "Cola · now 2".
  const [scanCue, setScanCue] = React.useState<string | null>(null);
  const scanCueArmedRef = React.useRef(false);
  const prevLinesRef = React.useRef<SaleLine[]>(lines);
  const scanCueTimerRef = React.useRef<number | null>(null);
  // The cue's timer lives in a ref: a later line change must not cancel it (the cue would stick with stale text).
  React.useEffect(
    () => () => {
      if (scanCueTimerRef.current !== null) window.clearTimeout(scanCueTimerRef.current);
    },
    [],
  );
  React.useEffect(() => {
    const before = prevLinesRef.current;
    prevLinesRef.current = lines;
    if (!scanCueArmedRef.current) return;
    scanCueArmedRef.current = false;
    const grown = lines.find((l) => {
      const was = before.find((b) => b.tempId === l.tempId);
      return !!was && was.qty !== l.qty;
    });
    if (!grown) return;
    setScanCue(`${grown.name} · now ${lineQtyLabel(grown).replace(/^× /, "")}`);
    if (scanCueTimerRef.current !== null) window.clearTimeout(scanCueTimerRef.current);
    scanCueTimerRef.current = window.setTimeout(() => {
      scanCueTimerRef.current = null;
      setScanCue(null);
    }, 2500);
  }, [lines]);

  // The scan field is disabled during the POST: hand focus back when the POST ends without a receipt.
  const wasPendingRef = React.useRef(false);
  React.useEffect(() => {
    if (wasPendingRef.current && !salePosting && !receipt && !locked) refocus();
    wasPendingRef.current = salePosting;
  }, [salePosting, receipt, locked, refocus]);

  const scanBusy = scan.waiting > 0;
  const scanBusyRef = React.useRef(false);
  scanBusyRef.current = scanBusy;
  awaitingCustomerRef.current = shipIntent && customer === null && lines.length > 0;

  const openBuilderToShip = () =>
    router.push(`/orders?action=new&ship=1${shipPreselected ? "&preselect=SHIP" : ""}`);

  const onShipClick = () => {
    if (locked || saleInFlight()) return; // never both rung up AND parked
    setShipFailed(false);
    if (lines.length === 0 && !scanBusy) {
      openBuilderToShip(); // nothing to carry over: the old hand-off to a blank builder
      return;
    }
    if (customer === null) {
      awaitingCustomerRef.current = lines.length > 0;
      focusCustomerFind();
    }
    setShipIntent(true);
  };

  // Parks the cart + customer as an ORDER draft (fulfillPath SHIP) and resumes it in the builder. The cart is cleared only
  // once the draft exists; a failed save leaves the sale exactly as it was.
  const runShip = async (to: PickedCustomer, cart: SaleLine[]) => {
    if (shipRunningRef.current || saleInFlight()) return;
    shipRunningRef.current = true;
    try {
      const draft = await createDraft.mutateAsync(counterShipDraftInput(cart, to));
      if (!draft?.id) throw new Error("draft has no id");
      if (!mountedRef.current) return; // the clerk left the counter meanwhile: the draft stays parked, no navigation
      setShipIntent(false);
      liveCart.discard(); // the cart now lives in the draft: its stored copy must not outlive this screen
      resetSale();
      router.push(`/orders?resumeDraft=${encodeURIComponent(draft.id)}`);
    } catch {
      setShipIntent(false);
      setShipFailed(true);
      refocus();
    } finally {
      shipRunningRef.current = false;
    }
  };

  React.useEffect(() => {
    if (!shipIntent || locked || scanBusy || reprice.blocked || shipRunningRef.current) return;
    if (createSale.isPending || submittingRef.current || receipt) return;
    if (lines.length === 0) {
      setShipIntent(false); // the cart emptied while we waited: nothing to hand over
      return;
    }
    if (customer === null) return; // waiting for the pick
    void runShip(customer, lines);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shipIntent, locked, scanBusy, reprice.blocked, customer, lines, createSale.isPending]);

  // R7b 1.2 (a): Enter in an EMPTY scan box with lines in the cart moves to the payment (a scanner never sends an empty Enter).
  const tenderRef = React.useRef<HTMLInputElement>(null);
  // The ONE place the payment area takes focus (Enter in an empty scan box, and the tender radiogroup's arrow keys).
  const focusNode = (el: HTMLElement | null | undefined) => el?.focus();
  const focusPayment = () =>
    focusNode(
      method === "CASH" && tenderRef.current
        ? tenderRef.current
        : document.querySelector<HTMLButtonElement>(
            '[data-testid="counter-checkout-actions"] button',
          ),
    );
  // R7b 1.2 (b): the tender methods are a WAI-ARIA radiogroup: Left/Right (and Up/Down) move to the next enabled method.
  const onTenderKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const dir =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (!dir || locked) return;
    const options = paymentMethodOptions(isWalkIn).filter((m) => !m.disabled);
    const at = options.findIndex((m) => m.method === method);
    const next = options[(at + dir + options.length) % options.length];
    if (!next) return;
    e.preventDefault();
    setMethod(next.method);
    focusNode(e.currentTarget.querySelector<HTMLButtonElement>(`[data-method="${next.method}"]`));
  };

  function onScanSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (lineLocked || saleInFlight()) return; // frozen while the sale POST is in flight: a mid-POST scan would miss the sale
    const text = scanText;
    setScanText("");
    scan.submit(text);
  }

  const stepItem = (tempId: string, unit: StepUnit, dir: 1 | -1) => {
    if (lineLocked || saleInFlight()) return;
    setLines((prev) => prev.map((l) => (l.tempId === tempId ? stepLine(l, unit, dir) : l)));
    refocus();
  };

  // POS-3: a removed line is held (LINE_UNDO_MS, CQ-27) in ONE slot (a newer removal makes the older one final). Undo puts it
  // back at its index, or merges it into the same product if that was re-scanned meanwhile. Pay uses `lines`, which never has it.
  const { undo, hold: holdRemoved, drop: dropUndo, bar: undoBar } = useCounterLineUndo(refocus);

  const removeLine = (tempId: string) => {
    if (lineLocked || saleInFlight()) return;
    const taken = takeLine(lines, tempId);
    if (!taken) return;
    setLines(taken.lines);
    holdRemoved(taken.removed);
    refocus();
  };

  const undoRemove = () => {
    if (!undo || lineLocked || saleInFlight()) return;
    // A customer pick may have re-priced the cart while the line sat in the undo window: price it for them too (an edited price is kept).
    setLines(
      (prev) => repriceLines(restoreLine(prev, undo), reprice.tierFor, reprice.layerOf).lines,
    );
    dropUndo();
    refocus();
  };

  // A TYPED quantity (steppers stay): the same normalized split a stepper makes; a refused value changes nothing.
  const typeQty = (tempId: string, typed: TypedQty): boolean => {
    if (lineLocked || saleInFlight()) return false;
    const cur = lines.find((l) => l.tempId === tempId);
    if (!cur || !setLineQty(cur, typed)) return false;
    setLines((prev) => prev.map((l) => (l.tempId === tempId ? (setLineQty(l, typed) ?? l) : l)));
    return true;
  };

  const noteLine = (tempId: string, note: string) => {
    if (lineLocked || saleInFlight()) return;
    setLines((prev) => setLineNote(prev, tempId, note));
  };

  // POS-5: an edited price only replaces `override` / `unitPrice` on that line; it never touches the sale, payment, lock
  // or idempotency state and never sends a request. Closing the dialog hands focus back to the scan field (onPriceClosed).
  const editPrice = (tempId: string, edit: CounterPriceEdit) => {
    if (lineLocked || saleInFlight()) return;
    setLines((prev) => applyPriceEdit(prev, tempId, edit));
  };
  const resetPrice = (tempId: string) => {
    if (lineLocked || saleInFlight()) return;
    setLines((prev) => resetPriceEdit(prev, tempId));
    refocus();
  };

  function resetSale() {
    dropUndo();
    setLastSale(null);
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
    offlineKeyRef.current = null;
    clearHeldAttempt(heldKey);
    liveCart.endSend();
    setOutcomeUnknown(false);
    setHeldCorrupt(false);
    setLookupFailed(false);
    setShipIntent(false);
    setShipFailed(false);
    awaitingCustomerRef.current = false;
    refocus();
  }

  // SA-748: a resumed parked cart replaces the screen's cart, customer, method, tendered and reference (the same state a
  // finished sale resets); the lines are then re-priced for display. No sale key exists yet: it is minted at Complete.
  function restoreParked(p: ParkedCartPayload) {
    resetSale();
    setLines(p.lines as SaleLine[]);
    setCustomer(p.customer as PickedCustomer | null);
    setMethod(p.method as CounterSalePaymentMethod);
    setTendered(p.tendered);
    setReference(p.reference);
    setRepriceEpoch((n) => n + 1);
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
    // CQ-29: read BEFORE the request leaves: a browser already offline cannot have delivered it.
    const offlineAtSend = typeof navigator !== "undefined" && navigator.onLine === false;
    setSending(true); // from here to the answer the cart is frozen (a validation refusal never reaches this point)
    liveCart.beginSend(); // the stored cart goes NOW, before the POST can leave: a refresh mid-send must not bring it back
    try {
      const sent = await createSale.mutateAsync({ dto: attempt.dto, idempotencyKey: attempt.key });
      // The method the cashier chose, if the server's answer does not echo it (captured before the screen resets).
      const res = { ...sent, method: sent.method ?? attempt.dto.payment.method };
      attemptRef.current = null;
      offlineKeyRef.current = null;
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
        liveCart.endSend();
      } else if (!attempt.unknown && isNotSentOffline(err, offlineAtSend)) {
        // CQ-29: offline, so nothing was sent. Say so, unfreeze the form, and keep the key for the retry.
        offlineKeyRef.current = attempt.key;
        attemptRef.current = null;
        clearHeldAttempt(heldKey);
        setOutcomeUnknown(false);
        setError(COUNTER_OFFLINE_COPY);
        liveCart.endSend();
      } else if (!attempt.unknown && isDefinitiveCounterSaleRefusal(err)) {
        attemptRef.current = null;
        clearHeldAttempt(heldKey);
        setOutcomeUnknown(false);
        // FIXED copy, never the server message; a walk-in sale has no customer record to fix a license on
        setError(counterSaleErrorCopy(err, { walkIn: attempt.dto.walkIn === true }));
        liveCart.endSend();
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
        // A tender refused for a CLOSED DAY leaves the sale saved but unpaid: say so (the banner below is the generic one).
        setError(isCounterSaleDayClosed(err) ? counterSaleErrorCopy(err) : "");
        setRecordedHref(keptSaleHref(err));
        setOutcomeUnknown(true);
      }
      return null;
    } finally {
      setSending(false);
    }
  };

  const complete = async (next: boolean): Promise<CounterSaleResponse | null> => {
    setError("");
    if (attemptRef.current) return send(attemptRef.current); // an unknown outcome: the SAME body, the SAME key
    if (lines.length === 0) {
      setError("Add at least one item.");
      return null;
    }
    // A regulated line's deposit / excise comes from the categories list: until it has loaded the total is short by
    // exactly that, so the sale waits rather than tender against a figure the server will refuse (CQ-01 / CQ-28).
    if (!categoriesLoaded && lines.some((l) => l.trackedCategoryId)) {
      setError("Still loading the regulated charges. Try again in a moment.");
      return null;
    }
    // POS-5: the shared rule (decideStaffOverride) says a special-price customer's edited line needs a reason: no POST.
    const unreasoned = lineNeedingReason(lines, reprice.tierFor);
    if (unreasoned) {
      setError(
        `Add a reason for ${unreasoned.name}. ${customer?.businessName ?? "This customer"} has a special price on it.`,
      );
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
      setError(paymentProblemCopy(problem, totals.total));
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
    dropUndo(); // the sale is going out: a removed line can no longer come back
    attemptRef.current = {
      key: offlineKeyRef.current ?? newIdempotencyKey(),
      dto,
      next,
      unknown: false,
    };
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
      printAfterRenderRef.current = { reset: startFresh, note: lastSaleNoteFrom(res) };
      setReceipt(res);
    } else if (startFresh) {
      resetSale();
      setLastSale(lastSaleNoteFrom(res)); // CQ-17: after the reset, so the fresh sale names the one just finished
    } else setReceipt(res);
  };

  const completeSale = async (next: boolean, retry = false) => {
    if (submittingRef.current) return; // a double Enter / click is one sale
    if (parkBusyRef.current) return; // a park / resume request is still running
    if (shipRunningRef.current || createDraft.isPending) return; // a ship hand-off is saving this cart
    // A scan still resolving (or waiting on Retry / the picker) is not on the cart yet: never post without it.
    if (!retry && (scanBusyRef.current || repriceBlockedRef.current)) return;
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
  const printAfterRenderRef = React.useRef<{ reset: boolean; note?: LastSaleNote } | null>(null);
  React.useEffect(() => {
    if (!receipt || !printAfterRenderRef.current) return;
    const { reset, note } = printAfterRenderRef.current;
    printAfterRenderRef.current = null;
    window.print(); // once per completed sale
    if (reset) {
      resetSale();
      if (note) setLastSale(note);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt]);

  const toggleAutoPrint = (on: boolean) => {
    setAutoPrint(on);
    writeAutoPrint(on);
  };

  // A failed check keeps its retry panel up through a retry (CQ-30, see `keepRetryPanel`).
  if (keepRetryPanel) {
    return <CounterGateOffline onRetry={gate.retry} retrying={gate.retrying || gate.loading} />;
  }

  // The features answer is not in yet: an empty, non-interactive placeholder, with no copy (neither the sale UI nor a false
  // "not turned on").
  if (gate.loading) return <div data-testid="counter-sale-loading" aria-busy="true" />;

  // BO-07: the counter is on for the business but this operator's admin has not turned selling on for their account (read
  // live; a PERMISSION_DENIED from any till call lands here too). A plain panel, checked before the "off" copy, never a toast.
  if (gate.mayUseTill === false && counterSaleGate(gate.capability).showButton) {
    return (
      <div className="mx-auto max-w-md p-4 text-sm" data-testid="counter-sale-no-access">
        {COUNTER_NO_ACCESS_COPY}
      </div>
    );
  }

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
    return (
      <div
        className="mx-auto max-w-md space-y-4 p-4 print:max-w-none print:p-0"
        data-testid="counter-sale-receipt"
      >
        <CounterReceiptBody
          receipt={receipt}
          lines={lines}
          enteredTender={enteredTender}
          profile={settings}
          fallbackMethod={method}
          customerName={receiptCustomerName(customer)}
          headingRef={receiptHeadingRef}
        />
        <CounterReceiptActions
          orderId={receipt.orderId}
          customer={customer}
          onNewSale={resetSale}
        />
      </div>
    );
  }

  return (
    <div
      className="mx-auto w-full max-w-5xl space-y-4 p-4 max-md:mb-[calc(-1*var(--counter-main-pb,0px))] max-md:pb-0"
      style={
        {
          "--counter-bar-h": `${barHeight}px`,
          "--counter-main-pb": `${mainPad}px`,
        } as React.CSSProperties
      }
      data-testid="counter-sale-screen"
      data-counter-screen
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Counter sale</h1>
        <CounterTodaysSales />
        <ParkedSales
          cart={{ lines, customer, method, tendered, reference }}
          blocked={
            locked ||
            salePosting ||
            createDraft.isPending ||
            scanBusy ||
            reprice.blocked ||
            shipIntent
          }
          inFlight={() => saleInFlight() || shipRunningRef.current || scanBusyRef.current}
          canEditPrices={mayEditPrices}
          onBusyChange={onParkBusy}
          onParked={resetSale}
          onRestore={restoreParked}
        />
        {gate.offerShipInstead ? (
          <WriteButton
            className="min-h-[44px]"
            variant="secondary"
            disabled={locked || salePosting || createDraft.isPending}
            onClick={onShipClick}
          >
            Ship this order instead
          </WriteButton>
        ) : null}
      </div>

      {lastSale ? <CounterLastSale note={lastSale} /> : null}

      <div
        className="flex flex-col gap-4 [&>*]:min-w-0 md:grid md:grid-cols-[minmax(0,1fr)_320px] md:items-start xl:grid-cols-[minmax(0,1fr)_380px]"
        data-testid="counter-sale-columns"
      >
        <div className="min-w-0 space-y-4" data-testid="counter-cart-column">
          {/* customer: Walk-in by default */}
          <section aria-label="Customer" className="space-y-2">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">
                {customer ? customer.businessName : "Walk-in customer"}
              </span>
              {customer ? (
                <button
                  type="button"
                  className="min-h-[44px] text-brand-700 underline"
                  disabled={lineLocked}
                  onClick={() => {
                    if (lineLocked || saleInFlight()) return;
                    setCustomer(null);
                  }}
                >
                  Use Walk-in customer
                </button>
              ) : null}
            </div>
            <input
              {...customerListbox.inputProps}
              ref={customerFindRef}
              aria-label="Find a customer"
              className="min-h-[44px] w-full rounded border px-3 py-2 text-sm"
              placeholder="Find a customer (optional)"
              disabled={lineLocked}
              value={customerSearch}
              onChange={(e) => {
                if (lineLocked || saleInFlight()) return;
                setCustomerSearch(e.target.value);
              }}
            />
            {customer && !customer.isWalkIn ? (
              <CounterCustomerCredit customerId={customer.id} />
            ) : null}
            {reprice.noteText ? (
              <p
                role="status"
                className="flex flex-wrap items-center gap-x-3 text-sm text-brand-700"
                data-testid="counter-reprice-note"
              >
                <span>{reprice.noteText}</span>
                <button
                  type="button"
                  className={cn(TAP_TARGET, "underline disabled:opacity-40")}
                  disabled={lineLocked}
                  onClick={reprice.undo}
                >
                  Undo
                </button>
                <button
                  type="button"
                  className={cn(TAP_TARGET, "underline")}
                  onClick={reprice.dismiss}
                >
                  Dismiss
                </button>
              </p>
            ) : null}
            {shipIntent && isWalkIn && lines.length > 0 ? (
              <p
                role="status"
                className="text-sm font-medium text-brand-700"
                data-testid="ship-who"
              >
                {COUNTER_SHIP_WALK_IN_CAPTION}
              </p>
            ) : null}
            <CounterCustomerMatches
              listbox={customerListbox.listbox}
              search={customerSearch}
              matches={matches as PickedCustomer[]}
              answered={customersData !== undefined && !customersFetching}
              disabled={lineLocked}
              onPick={pickCustomer}
            />
          </section>

          {/* SA-747: quick keys; a tap is the scan add path, and a frozen cart ignores it */}
          <QuickKeysGrid
            locked={lineLocked}
            onAdd={(key, e) => {
              if (lineLocked || saleInFlight() || receipt) return;
              addProduct(key.product, key.sellLevel, 1);
              refocusAfterPointer(e); // a keyboard activation keeps focus on the key, like the tender buttons
            }}
          />

          {/* scan / search: always focused; a typed quantity multiplies the next scan */}
          <form
            onSubmit={onScanSubmit}
            className="sticky top-0 z-20 flex items-center gap-2 bg-white py-2"
            data-testid="counter-scan-bar"
          >
            <input
              ref={scanRef}
              aria-label="Scan or search items"
              className="min-h-[44px] w-full rounded border px-3 py-2 text-base"
              placeholder="Scan or type an item"
              aria-describedby="counter-scan-hint"
              value={scanText}
              disabled={lineLocked}
              onChange={(e) => {
                if (lineLocked || saleInFlight()) return;
                setScanText(e.target.value);
              }}
              onKeyDown={(e) => {
                // POS-3: Ctrl/Cmd+Z with an empty scan field takes the last removal back (the same as the Undo button).
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !scanText && undo) {
                  e.preventDefault();
                  undoRemove();
                }
                if (e.key === "Enter" && !scanText.trim() && lines.length > 0 && !lineLocked) {
                  e.preventDefault(); // no empty scan; the next keys are the payment
                  focusPayment();
                }
              }}
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
          {/* The multiply tip lives under the field: in the placeholder it was cut off at 390px. */}
          <p id="counter-scan-hint" className="-mt-1 text-xs text-navy/70" data-testid="scan-hint">
            Type a quantity first to multiply.
          </p>
          {scanCue ? (
            <p
              role="status"
              className="rounded bg-navy/5 px-2 py-1 text-sm font-medium"
              data-testid="counter-scan-cue"
            >
              {scanCue}
            </p>
          ) : null}
          {scan.message ? <p className="text-sm text-red-700">{scan.message}</p> : null}
          {scan.failed ? (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm"
              data-testid="counter-scan-error"
            >
              <span>{COUNTER_SCAN_FAILED_COPY}</span>
              <Button className="min-h-[44px]" onClick={scan.retry}>
                Retry
              </Button>
              <Button className="min-h-[44px]" variant="secondary" onClick={scan.dismissFailure}>
                Skip this scan
              </Button>
              {scan.waiting > 1 ? <span>{scan.waiting - 1} more waiting</span> : null}
            </div>
          ) : null}
          {scan.picker ? (
            <div className="space-y-1" data-testid="counter-scan-picker">
              {scan.picker.category ? (
                <p className="text-sm font-medium" data-testid="counter-category-heading">
                  {scan.picker.category.name}: {scan.picker.matches.length} items
                </p>
              ) : null}
              <DidYouMeanPicker
                matches={scan.picker.matches.map((p: any) => ({
                  id: p.id,
                  name: displayProductName(p),
                }))}
                onConfirm={(m) =>
                  scan.choose(scan.picker?.matches.find((p: any) => p.id === m.id) ?? m)
                }
                onCancel={scan.cancelPicker}
              />
              {scan.picker.category?.hasMore ? (
                <Button
                  type="button"
                  variant="secondary"
                  className="min-h-[44px]"
                  disabled={scan.moreBusy}
                  onClick={() => void scan.loadMore()}
                >
                  Show more
                </Button>
              ) : null}
              {scan.waiting > 1 ? (
                <p className="text-sm">{scan.waiting - 1} more scans waiting</p>
              ) : null}
            </div>
          ) : null}

          {liveCart.notice ? (
            <div
              role="status"
              className="flex items-center justify-between gap-2 rounded border border-navy/20 bg-navy/5 p-2 text-sm"
              data-testid={
                liveCart.notice === "restored"
                  ? "counter-cart-restored"
                  : liveCart.notice === "other-tab"
                    ? "counter-cart-other-tab"
                    : "counter-cart-cleared-elsewhere"
              }
            >
              <span>
                {liveCart.notice === "restored"
                  ? "We put back your unfinished sale."
                  : liveCart.notice === "other-tab"
                    ? "Another tab has an unfinished sale. This tab's cart won't survive a refresh."
                    : "That sale was finished in another tab."}
              </span>
              <Button className="min-h-[44px]" variant="secondary" onClick={liveCart.dismissNotice}>
                OK
              </Button>
            </div>
          ) : null}
          <ul className="divide-y rounded border" aria-label="Items">
            {lines.length === 0 ? (
              <li className="p-3 text-sm text-navy/60">No items yet.</li>
            ) : null}
            {lines.map((l) => (
              <CounterLineRow
                key={l.tempId}
                line={l}
                locked={lineLocked}
                onStep={stepItem}
                onRemove={removeLine}
                onNote={noteLine}
                onQty={typeQty}
                canEditPrices={mayEditPrices}
                priceTier={reprice.tierFor(l.productId)}
                customerName={customer?.businessName}
                onPriceEdit={editPrice}
                onPriceReset={resetPrice}
                onPriceClosed={refocus}
                onNoteClosed={refocus}
                onQtyEnter={refocusFromActive}
                hideOriginalPrice={settings?.hideOriginalPrice === true}
              />
            ))}
          </ul>

          <div
            role="status"
            aria-live="polite"
            aria-label="Removed item"
            data-testid="line-undo-bar"
            className={cn(
              undo &&
                "flex items-center justify-between gap-2 rounded border border-navy/20 bg-navy/5 p-2 text-sm",
            )}
            {...undoBar}
          >
            {undo ? (
              <>
                <span>Line removed.</span>
                <button
                  type="button"
                  className={cn(
                    TAP_TARGET,
                    "rounded border px-3 font-semibold disabled:opacity-40",
                  )}
                  aria-label={`Undo: put back ${undo.line.name}`}
                  disabled={lineLocked}
                  onClick={undoRemove}
                >
                  Undo
                </button>
              </>
            ) : null}
          </div>
        </div>

        <div
          className="contents [&>*]:min-w-0 md:sticky md:top-4 md:block md:max-h-[calc(100vh-5rem)] md:min-w-0 md:space-y-4 md:overflow-y-auto"
          data-testid="counter-payment-column"
        >
          {/* payment on the same screen */}
          <section aria-label="Payment" className="space-y-3">
            <div
              className="flex flex-wrap gap-2"
              role="radiogroup"
              aria-label="Payment method"
              data-testid="counter-tender-methods"
              onKeyDown={onTenderKeyDown}
            >
              {paymentMethodOptions(isWalkIn).map((m) => (
                <button
                  key={m.method}
                  type="button"
                  role="radio"
                  disabled={m.disabled || locked}
                  aria-checked={method === m.method}
                  tabIndex={method === m.method ? 0 : -1}
                  data-method={m.method}
                  className={cn(
                    TAP_TARGET,
                    "rounded border px-3 text-sm disabled:opacity-40",
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
                      className={cn(TAP_TARGET, "rounded border px-3 text-sm disabled:opacity-40")}
                      onClick={(e) => {
                        setTendered(String(q.amount));
                        clearUnderpaidError();
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
                    ref={tenderRef}
                    aria-label="Amount tendered"
                    inputMode="decimal"
                    className="mt-1 min-h-[44px] w-full rounded border px-3 py-2"
                    value={tendered}
                    disabled={locked}
                    onChange={(e) => {
                      setTendered(e.target.value);
                      clearUnderpaidError();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void completeSale(false);
                      }
                    }}
                  />
                </label>
              </div>
            ) : null}

            {method === "CHECK" ? (
              <label className="block text-sm">
                Check number
                <input
                  aria-label="Check number"
                  className="mt-1 min-h-[44px] w-full rounded border px-3 py-2"
                  value={reference}
                  disabled={locked}
                  onChange={(e) => setReference(e.target.value)}
                />
              </label>
            ) : null}
          </section>

          <label className="flex min-h-[44px] items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-5 w-5 max-lg:h-11 max-lg:w-11"
              checked={autoPrint}
              onChange={(e) => toggleAutoPrint(e.target.checked)}
            />
            Print receipt automatically
          </label>

          {outcomeUnknown ? (
            <div
              role="alert"
              className="space-y-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm"
              data-testid="counter-outcome-unknown"
            >
              <p className="font-semibold">{COUNTER_OUTCOME_UNKNOWN_COPY}</p>
              {lookupFailed ? <p>{COUNTER_LOOKUP_FAILED_COPY}</p> : null}
              {recordedHref ? (
                <p>
                  The sale was recorded.{" "}
                  <Link href={recordedHref} className="text-brand-700 underline">
                    Open it
                  </Link>{" "}
                  to check it. Try again finishes it once, without ringing it twice.
                </p>
              ) : null}
              {heldCorrupt ? <p>{COUNTER_DISCARD_COPY}</p> : null}
              <div className="flex flex-wrap items-center gap-3">
                {heldCorrupt ? (
                  <Button className="min-h-[44px]" variant="secondary" onClick={resetSale}>
                    Discard and start a new sale
                  </Button>
                ) : (
                  <>
                    <Button
                      className="min-h-[44px]"
                      onClick={() => void completeSale(false, true)}
                      disabled={createSale.isPending || lookupSale.isPending}
                    >
                      Try again
                    </Button>
                    <Button
                      className="min-h-[44px]"
                      variant="secondary"
                      onClick={() => void checkSaleStatus()}
                      disabled={createSale.isPending || lookupSale.isPending}
                    >
                      Check sale status
                    </Button>
                  </>
                )}
                <Link
                  href="/orders"
                  className="inline-flex min-h-[44px] items-center text-brand-700 underline"
                >
                  Check recent sales
                </Link>
              </div>
            </div>
          ) : null}

          {shipFailed ? (
            <p role="alert" className="text-sm text-red-700" data-testid="counter-ship-failed">
              {COUNTER_SHIP_FAILED_COPY}
            </p>
          ) : null}

          {reprice.unconfirmed === "failed" ? (
            <p
              role="alert"
              className="text-sm text-red-700"
              data-testid="counter-price-layer-failed"
            >
              Couldn&apos;t load this customer&apos;s prices.{" "}
              <button type="button" className={cn(TAP_TARGET, "underline")} onClick={reprice.retry}>
                Retry
              </button>
            </p>
          ) : reprice.unconfirmed === "incomplete" ? (
            <p
              role="status"
              className="text-sm text-navy/70"
              data-testid="counter-price-layer-incomplete"
            >
              {PRICE_LAYER_TOO_MANY_COPY}
            </p>
          ) : reprice.unconfirmed === "pending" ? (
            <p
              role="status"
              className="text-sm text-navy/70"
              data-testid="counter-price-layer-pending"
            >
              Checking this customer&apos;s prices…
            </p>
          ) : reprice.failed ? (
            <p role="alert" className="text-sm text-red-700" data-testid="counter-reprice-failed">
              Couldn&apos;t update prices for this customer. The old prices are still showing.{" "}
              <button type="button" className={cn(TAP_TARGET, "underline")} onClick={reprice.retry}>
                Retry price update
              </button>
            </p>
          ) : reprice.blocked ? (
            <p role="status" className="text-sm text-navy/70" data-testid="counter-reprice-busy">
              Updating prices…
            </p>
          ) : null}

          {scanBusy ? (
            <p role="status" className="text-sm text-navy/70" data-testid="counter-scan-busy">
              Adding scanned items…
            </p>
          ) : null}

          {/* SA-733r6: read-only keeps the cart; Charge is disabled and says why - above the bar, so the bar's box never moves. */}
          <ReadOnlyHint className="text-sm text-slate-700" />
          <div
            ref={barRef}
            className="sticky bottom-0 z-20 space-y-2 border-t bg-white pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] pt-2 max-md:bottom-[calc(-1*var(--counter-main-pb,0px))] md:static md:border-t-0 md:py-0"
            data-testid="counter-checkout-bar"
          >
            {/* CQ-08: the number explains itself, in the receipt's order: Subtotal at the system prices, Discounts, Tax,
                each named regulated charge, then the total. Every figure is the one the receipt prints. */}
            <div className="flex justify-between text-sm" data-testid="running-subtotal">
              <span>Subtotal</span>
              <span>{money(roundMoney(totals.subtotal + discounts))}</span>
            </div>
            {discounts > 0 ? (
              <div className="flex justify-between text-sm" data-testid="running-discounts">
                <span>Discount</span>
                <span>−{money(discounts)}</span>
              </div>
            ) : null}
            {totals.tax > 0 ? (
              <div className="flex justify-between text-sm" data-testid="running-tax">
                <span>Tax</span>
                <span>{money(totals.tax)}</span>
              </div>
            ) : null}
            {totals.chargeLines.map((c) => (
              <div
                key={c.key}
                className="flex justify-between text-sm"
                data-testid={`running-charge-${c.key}`}
              >
                <span>{c.label}</span>
                <span>{money(c.amount)}</span>
              </div>
            ))}
            <div className="flex justify-between text-lg font-semibold" data-testid="running-total">
              <span>Estimated total</span>
              <span>{money(totals.total)}</span>
            </div>

            {method === "CASH" ? (
              <p className="text-3xl font-bold" data-testid="change-due" role="status">
                {changeDue(totals.total, tenderedNum) > 0
                  ? `Change ${money(changeDue(totals.total, tenderedNum))}`
                  : `Amount due ${money(amountDue(totals.total, tenderedNum))}`}
              </p>
            ) : null}

            {/* The payment / sale error lives in the bar: below the fold it was out of sight at 390px (row 238). */}
            {error ? (
              <p role="alert" className="text-sm text-red-700">
                {error}
              </p>
            ) : null}

            <div className="flex flex-wrap gap-2" data-testid="counter-checkout-actions">
              <Button
                className="min-h-[44px]"
                onClick={() => void completeSale(false)}
                aria-describedby={readOnlyGate.readOnly ? readOnlyGate.hintId : undefined}
                disabled={
                  readOnlyGate.readOnly ||
                  salePosting ||
                  createDraft.isPending ||
                  locked ||
                  scanBusy ||
                  reprice.blocked ||
                  parkBusy
                }
              >
                Complete &amp; show receipt
              </Button>
              <Button
                className="min-h-[44px]"
                variant="secondary"
                onClick={() => void completeSale(true)}
                aria-describedby={readOnlyGate.readOnly ? readOnlyGate.hintId : undefined}
                disabled={
                  readOnlyGate.readOnly ||
                  salePosting ||
                  createDraft.isPending ||
                  locked ||
                  scanBusy ||
                  reprice.blocked ||
                  parkBusy
                }
              >
                Complete &amp; next sale
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
