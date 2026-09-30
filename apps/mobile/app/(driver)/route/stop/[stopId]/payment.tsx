import { useMemo, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { onlineManager, useQueryClient } from "@tanstack/react-query";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { ios } from "@routeflow/ui/tokens";
import { NavAction, NavBackButton, NavBar, SegmentedControl } from "@routeflow/ui/mobile/ios";
import {
  useActiveRouteRun,
  useAttachPodArtifact,
  useCompleteWithPayment,
  useRouteRun,
  type RouteRunOrder,
} from "../../../../../lib/api/routes";
import { podPhotoArtifactId } from "../../../../../lib/pod-artifacts";
import {
  artifactIdsFromPodPhotoUrls,
  pendingPodArtifacts,
  type PendingArtifactCandidate,
} from "../../../../../lib/pod-reconcile";
import {
  DATA_URL_JPEG_QUALITY,
  DATA_URL_MAX_WIDTH,
  MAX_POD_DATA_URL_LENGTH,
} from "../../../../../lib/pod-image";
import { orderQueryOptions, type Order } from "../../../../../lib/api/orders";
import { useDriverPayments } from "../../../../../lib/api/addons";
import { useUploadPaymentImage } from "../../../../../lib/api/payments";
import { productImageFile } from "../../../../../lib/product-image";
import { PhotoCapture } from "../../../../../components/PhotoCapture";
import { usePodStore } from "../../../../../store/podStore";
import { useDeliveryPlanStore } from "../../../../../store/delivery-plan-store";
import { useRunSettlementStore } from "../../../../../store/runSettlementStore";
import type { CollectedMethod } from "../../../../../lib/run-settlement";
import {
  activeOrderSubtotal,
  orderAmountDue,
  reconciledAmountDue,
  reconciledDoorDue,
  shortPickCategoryTax,
} from "../../../../../lib/run-money";
import {
  classifyMutationError,
  isStopAlreadyCompletedError,
} from "../../../../../lib/offline-errors";
import {
  buildStopDeliveries,
  deliveredSoFarByLine,
  doorQuoteLines,
  fallbackShortPickLines,
  linesAwaitingEntry,
  normalizeDeliveryPlan,
  planPendingButLinesNotLoaded,
  reconciledTotal,
  remainingByLine,
  shortPickLinesFromOrder,
  type ShortPickLine,
} from "../../../../../lib/short-pick";
import { showToast } from "../../../../../lib/toast";
import {
  INVOICE_LATER_TOAST,
  onPostDeliveryInvoiceFetchFailed,
} from "../../../../../lib/post-delivery-invoice-fallback";
import { regulatedPodGateError } from "../../../../../lib/pod-gating";
import { openRouteInMaps } from "../../../../../components/openInMaps";
import { useOfflineQueue } from "../../../../../store/offlineQueue";
import { DRIVER_CRITICAL_NETWORK_MODE, isLiveOnline } from "../../../../../lib/live-online";
import * as Location from "expo-location";
import { postDeliveryInvoicePrompt, type InvoiceStatus } from "@routeflow/types";
import { useInvoicePdf, useSendInvoice } from "../../../../../lib/api/invoices";
import {
  invoiceReadyMessage,
  nextPdfSharePhase,
  planWhatsAppSend,
  preferredPhone,
  smsUrl,
  smtpFallbackNotice,
  type PdfSharePhase,
} from "../../../../../lib/invoice-send-logic";
import {
  ACTIVATION_BUDGET_MS,
  canShareFilesHere,
  openPdfInTab,
  sharePdf,
} from "../../../../../lib/share-pdf";
import { SendInvoiceSheet } from "../../../../../components/SendInvoiceSheet";
import { alertInfo } from "../../../../../lib/confirm";

// Driver-vocabulary labels for the at-door SegmentedControl. Segments are
// `flex: 1`, so with five of them each label gets ~60pt of text width on a
// 375-390pt phone — "On account" ellipsizes there, hence the shorter
// "Account" (the submit button below still spells out "Mark on account").
const METHODS = ["Cash", "Card", "Cheque", "Zelle", "Account"] as const;
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "·", "0", "⌫"];

async function readDriverLocation(): Promise<{ lat: number; lng: number } | null> {
  if (Platform.OS === "web") return null;
  try {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (perm.status !== "granted") return null;
    const cur = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return { lat: cur.coords.latitude, lng: cur.coords.longitude };
  } catch {
    return null;
  }
}

// Stable reference for "no plan recorded for this stop" so the zustand
// selector below never hands React a fresh {} on every render — a fresh
// object each call defeats useSyncExternalStore's tearing check and causes
// an infinite re-render loop (this IS the common case: a stop with no
// short-pick overrides, or a stale deep link straight to this screen).
const EMPTY_DELIVERY_PLAN: Record<string, number> = {};

// REG-B305: the driver "amount due" is the server's tax-inclusive total.
// `isTaxExempt` mirrors reconciledAmountDue's own input just below — an
// exempt customer's server-side reconcile zeroes BOTH tax terms.
function fullOrderTotal(order: RouteRunOrder, isTaxExempt: boolean): number {
  return orderAmountDue(order, isTaxExempt);
}

function formatCurrency(n: number | string | undefined): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

export default function PaymentScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const params = useLocalSearchParams<{ stopId: string; runId?: string }>();
  const stopId = params.stopId;

  const { data: activeData } = useActiveRouteRun();
  const runId = params.runId ?? activeData?.data?.[0]?.id;
  const { data: run, isLoading } = useRouteRun(runId ?? "");
  const stop = useMemo(() => run?.stops?.find((s) => s.id === stopId), [run, stopId]);

  // B762: fetch EVERY order on the stop, not just orders[0] — the short-pick
  // review (short-pick.tsx) now lets the driver reconcile any order at the
  // stop, so this screen must be able to read a reconciled plan for any of
  // them too, not just the first. Same shared query definition useOrder
  // uses (orderQueryOptions) — lands on the same cache entry, never a
  // second, divergent fetch. Not gated on `isLoading` below (matches the
  // pre-B762 screen exactly): the driver can tap Close before every order's
  // richer data has landed, so `closeStop`/`invoiceTotal` both fall back to
  // the stop's own embedded snapshot per order rather than blocking.
  const stopOrderIds = useMemo(() => (stop?.orders ?? []).map((o) => o.id), [stop]);
  const { ordersById } = useQueries({
    queries: stopOrderIds.map((id) => orderQueryOptions(id)),
    combine: (results) => ({
      ordersById: Object.fromEntries(
        stopOrderIds
          .map((id, i) => [id, results[i]?.data] as const)
          .filter((entry): entry is [string, Order] => !!entry[1]),
      ),
    }),
  });
  const deliveredQtyById = useDeliveryPlanStore((s) =>
    stopId ? (s.plansByStop[stopId] ?? EMPTY_DELIVERY_PLAN) : EMPTY_DELIVERY_PLAN,
  );
  const clearPlan = useDeliveryPlanStore((s) => s.clearStop);

  // The RECONCILED lines per order — empty for an order whose richer fetch
  // hasn't landed (or that has nothing left to adjust). `deliveredQtyById`
  // is shared/flat across every order (keyed by orderItemId, which is
  // globally unique), so it's safe to hand the SAME map to every order's
  // own reconciliation without partitioning it. B648/SA-094: each order's
  // lines already carry unitLabel/unitsPerBox/boxes (shortPickLinesFromOrder
  // threads them through), so a Case line reconciles correctly no matter
  // which order on the stop it belongs to.
  // B785/SA-116: per-line pieces delivered at OTHER visits, off the stop's own run snapshot — a
  // second visit reconciles (and sends explicit entries for) the REMAINING, never the full order.
  // SA-367a: quantities come from the server's per-line `remaining`; soFar prices money only.
  const soFarById = useMemo(() => deliveredSoFarByLine(stop?.orders), [stop]);
  const remainingById = useMemo(() => remainingByLine(stop?.orders), [stop]);
  const richShortPickLinesByOrder: Record<string, ShortPickLine[]> = useMemo(() => {
    const map: Record<string, ShortPickLine[]> = {};
    for (const id of stopOrderIds) {
      map[id] = shortPickLinesFromOrder(ordersById[id], remainingById, soFarById);
    }
    return map;
  }, [stopOrderIds, ordersById, remainingById, soFarById]);

  // SA-094b (B762 adaptation item 3): the ONE normalized plan every reader
  // of deliveredQtyById must use, computed over EVERY order's lines — a raw
  // entry for a unit-aware line can be any leftover piece count; only this
  // snapped map is safe to feed the category-tax half (which has no
  // unit-awareness of its own) so it agrees with reconciledTotal's own
  // (already-snapped) subtotal, for whichever order the line belongs to.
  const allShortPickLines = useMemo(
    () => stopOrderIds.flatMap((id) => richShortPickLinesByOrder[id] ?? []),
    [stopOrderIds, richShortPickLinesByOrder],
  );
  const normalizedPlan = useMemo(
    () => normalizeDeliveryPlan(allShortPickLines, deliveredQtyById),
    [allShortPickLines, deliveredQtyById],
  );

  // Charge across EVERY order on the stop (B762: generalized from order[0]
  // only — the short-pick review now reconciles ANY order at the stop, not
  // just the first). Each order uses ITS OWN reconciled (post-short-pick)
  // total once its richer per-order fetch has landed, else its full ordered
  // total (covers both "not yet loaded" and "loaded but nothing left to
  // adjust" — matches the pre-B762 screen's own fallback exactly, just no
  // longer gated to a single order). Summing all orders is what keeps a
  // multi-order stop charged in full instead of collecting only one order's
  // amount.
  const invoiceTotal = (stop?.orders ?? []).reduce((sum, o) => {
    // #2300: a later visit whose details haven't loaded prices its served remaining, never the full total.
    const shortPickLines = doorQuoteLines(
      o,
      richShortPickLinesByOrder[o.id] ?? [],
      !!ordersById[o.id],
    );
    return (
      sum +
      (shortPickLines.length > 0
        ? // REG-B305 round 2 (RULING 3): follow the SERVER's own delivered-basis
          // rule (invoices.service.ts#reconcileOrderDraftInvoice) — regular tax
          // scales by the delivered share of the ORDER's own subtotal, category
          // tax is the Σ of each DELIVERED line's own snapshot
          // (deliveredCategoryTax), and every open draft's discount/fee stay
          // whole. Never the draft's whole `taxAmount` prorated by subtotal
          // share (that can't tell which lines shipped). REG-B305 round 4: both
          // halves MUST derive from `shortPickLines` — never pass the raw
          // `o.lineItems` to the category-tax half, or a cancelled/already-
          // delivered regulated line leaks its full category tax into the quote
          // while contributing zero subtotal (see run-money.ts#shortPickCategoryTax).
          // B810/SA-130a: reconciledDoorDue is the ONE decision point for
          // what to add to this visit's reconciledAmountDue estimate — an
          // open draft's leftover payables, a deposit mirror restated and
          // netted against what it already collected, or (a plain,
          // already-finalized payable) nothing at all, since re-adding the
          // estimate on top of it double-counts (see reconciledDoorDue's own
          // docstring for the full three-way rule and the exact bug this
          // fixes: a SENT $100 invoice, short-picked, used to quote ~$190).
          reconciledDoorDue({
            hasOpenDraft: (o.invoices?.length ?? 0) > 0,
            reconciledEstimate: reconciledAmountDue({
              drafts: o.invoices ?? [],
              order: {
                subtotal: o.subtotal,
                tax: o.tax,
                // B305 round 5: the no-draft fallback basis (this order's own
                // discount/fee) when o.invoices is empty — the DEFAULT state
                // pre-completion.
                discountAmount: o.discountAmount,
                shippingFee: o.shippingFee,
              },
              // SA-092b: the FULL active-line subtotal (ALL of o.lineItems,
              // never the delivered-basis shortPickLines below) — gives the
              // discount its own SEEDING share, distinct from the delivered
              // share applied to regular tax. See run-money.ts's
              // ReconciledAmountDueInput.activeSubtotal docstring.
              activeSubtotal: activeOrderSubtotal({ lineItems: o.lineItems ?? [] }),
              // B648/SA-094b: normalizedPlan (not the raw deliveredQtyById) —
              // a unit-aware line's raw entry can be any leftover piece count;
              // only the snapped map keeps this agreeing with reconciledTotal's
              // own (already-snapped) subtotal.
              deliveredSubtotal: reconciledTotal(shortPickLines, normalizedPlan),
              deliveredCategoryTax: shortPickCategoryTax(
                o.lineItems ?? [],
                shortPickLines,
                normalizedPlan,
              ),
              // B305 round 3: an exempt customer's server-side reconcile zeroes
              // BOTH tax terms — mirror that here (RUN_STOP_INCLUDE.customer
              // projects the column; RouteRunStop.customer.isTaxExempt above).
              isTaxExempt: stop?.customer?.isTaxExempt === true,
            }),
            payableInvoices: o.payableInvoices ?? [],
          })
        : fullOrderTotal(o, stop?.customer?.isTaxExempt === true))
    );
  }, 0);
  // REG-B305 round 2 (RULING 3): the short-pick branch bills an ESTIMATE (the
  // server recomputes the real invoice total independently once the batch
  // lands) — flag it inline so the driver doesn't read it as the final
  // figure. B762: true once ANY order on the stop is reconciled, not just
  // the first.
  const anyOrderReconciled = (stop?.orders ?? []).some(
    (o) => doorQuoteLines(o, richShortPickLinesByOrder[o.id] ?? [], !!ordersById[o.id]).length > 0,
  );
  const invoiceLabel = stop?.orders?.[0]?.orderNumber
    ? `ORDER ${stop.orders[0].orderNumber} · ${(stop.customer?.businessName ?? "Customer").toUpperCase()}${
        anyOrderReconciled ? " (est. — final on invoice)" : ""
      }`
    : "PAYMENT";

  // Per-tenant opt-in for at-door money collection (owner decision
  // 2026-08-24: acme collects, acme-distribution bills on account). Fail-CLOSED:
  // while the flag is unknown the collection UI stays hidden and the close
  // sends no payment — that path is allowed for every tenant, so a flaky
  // addons fetch can never strand a driver at the door (the server's
  // DriverPaymentsGuard only 403s an actual amount > 0).
  const { enabled: canCollect } = useDriverPayments();

  const [method, setMethod] = useState<string>("Cash");
  const [received, setReceived] = useState<string>("0");
  const [amountError, setAmountError] = useState<string | null>(null);
  const [photos, setPhotos] = useState<string[]>([]);
  const receivedNum = Number(received);
  const change = Math.max(0, receivedNum - invoiceTotal);

  const completeWithPaymentMut = useCompleteWithPayment();
  const attachPodMut = useAttachPodArtifact();
  const uploadImageMut = useUploadPaymentImage();
  const pod = usePodStore((s) => (stopId ? s.pods[stopId] : undefined));
  const clearPod = usePodStore((s) => s.clear);

  // #2089 (owner ruling): "once a delivery completes, automatically open that
  // order's invoice and ask whether to send it." Reuses the SAME shared
  // decision (packages/types) and the SAME dumb send-options sheet
  // (components/SendInvoiceSheet) the operator screen already opens on
  // "any path into DELIVERED" — no second send dialog. `useCreateInvoiceFromOrder`
  // is OPERATOR-only server-side, so this reads the order's EXISTING invoice
  // (already created earlier in its lifecycle — see RouteRunOrder.invoiceId,
  // populated before the driver ever reaches this screen) via a fresh
  // orderQueryOptions fetch, rather than creating one.
  const sendMut = useSendInvoice();
  const pdfMut = useInvoicePdf();
  const [sendSheet, setSendSheet] = useState<{
    invoiceId: string;
    invoiceNumber: string;
    totalFmt: string;
    issuePrompt: boolean;
    customerPhone?: string;
    customerEmail?: string;
  } | null>(null);
  const [whatsAppPhase, setWhatsAppPhase] = useState<PdfSharePhase>("idle");
  const [pdfSharePhase, setPdfSharePhase] = useState<PdfSharePhase>("idle");
  const whatsAppShareRef = useRef<Parameters<typeof sharePdf>[0] | null>(null);
  const pdfShareRef = useRef<Parameters<typeof sharePdf>[0] | null>(null);
  const [openPdfPending, setOpenPdfPending] = useState(false);
  // The one navigation step every post-completion path funnels through —
  // called immediately when there's no prompt to show, and from the sheet's
  // onClose when there was one, so completion never dead-ends on a driver who
  // dismisses the sheet without picking a channel.
  const afterInvoicePromptRef = useRef<() => void>(() => {});
  const closeSendSheet = () => {
    setSendSheet(null);
    setWhatsAppPhase("idle");
    setPdfSharePhase("idle");
    whatsAppShareRef.current = null;
    pdfShareRef.current = null;
    afterInvoicePromptRef.current();
  };
  const sendPhone = preferredPhone(sendSheet?.customerPhone, undefined);
  const buildInvoiceMessage = () =>
    sendSheet
      ? invoiceReadyMessage(
          stop?.customer?.businessName ?? "there",
          sendSheet.invoiceNumber,
          sendSheet.totalFmt,
        )
      : "";
  const emailSending = sendMut.isPending && sendMut.variables?.email != null;
  const markingSent = sendMut.isPending && sendMut.variables?.email == null;
  const runPdfShare = (
    ref: typeof whatsAppShareRef,
    setPhase: (phase: PdfSharePhase) => void,
    text: string | undefined,
  ) => {
    if (!sendSheet) return;
    const cached = ref.current;
    if (cached) {
      ref.current = null;
      setPhase("preparing");
      sharePdf({ ...cached, budgetMs: ACTIVATION_BUDGET_MS })
        .then((outcome) => {
          if (outcome === "ready-await-tap") ref.current = cached;
          setPhase(nextPdfSharePhase(outcome));
        })
        .catch(() => {
          setPhase("idle");
          showToast("Couldn't share the PDF.");
        });
      return;
    }
    const filename = `${sendSheet.invoiceNumber || "invoice"}.pdf`;
    const dialogTitle = `Invoice ${sendSheet.invoiceNumber ?? ""}`.trim();
    const startedAt = Date.now();
    setPhase("preparing");
    pdfMut.mutate(
      { id: sendSheet.invoiceId, variant: "final" },
      {
        onSuccess: async (data) => {
          if (!data?.url) {
            setPhase("idle");
            showToast("PDF is still generating, try again in a moment.");
            return;
          }
          const remaining = ACTIVATION_BUDGET_MS - (Date.now() - startedAt);
          const opts = {
            url: data.url,
            filename,
            dialogTitle,
            text,
            budgetMs: remaining,
            retapHandled: true,
          };
          try {
            const outcome = await sharePdf(opts);
            if (outcome === "ready-await-tap") ref.current = opts;
            setPhase(nextPdfSharePhase(outcome));
          } catch {
            setPhase("idle");
            showToast("Couldn't share the PDF.");
          }
        },
        onError: () => {
          setPhase("idle");
          showToast("Couldn't share the PDF.");
        },
      },
    );
  };
  const handleWhatsApp = () => {
    if (!sendSheet || !sendPhone) return;
    const plan = planWhatsAppSend({
      phone: sendPhone,
      message: buildInvoiceMessage(),
      canShareFiles: canShareFilesHere(),
    });
    if (plan.mode === "share-file") {
      runPdfShare(whatsAppShareRef, setWhatsAppPhase, plan.text);
      return;
    }
    Linking.openURL(plan.url).catch(() => showToast("Couldn't open WhatsApp."));
  };
  const handleSms = () => {
    if (!sendSheet || !sendPhone) return;
    const sep = Platform.OS === "ios" ? "&" : "?";
    Linking.openURL(smsUrl(sendPhone, buildInvoiceMessage(), sep)).catch(() =>
      showToast("Couldn't open Messages."),
    );
  };
  const handleEmailInvoice = () => {
    if (!sendSheet || !sendSheet.customerEmail) return;
    sendMut.mutate(
      { id: sendSheet.invoiceId, email: sendSheet.customerEmail },
      {
        onSuccess: (res) => {
          const notice = "warning" in res ? smtpFallbackNotice(res) : null;
          if (notice) alertInfo("Invoice emailed", notice);
          else showToast("Invoice emailed");
          closeSendSheet();
        },
        onError: () => showToast("Couldn't email the invoice."),
      },
    );
  };
  const handleSharePdf = () => runPdfShare(pdfShareRef, setPdfSharePhase, undefined);
  const handleOpenPdf = () => {
    if (!sendSheet) return;
    setOpenPdfPending(true);
    pdfMut.mutate(
      { id: sendSheet.invoiceId, variant: "final" },
      {
        onSuccess: (data) => {
          setOpenPdfPending(false);
          if (!data?.url) {
            showToast("PDF is still generating, try again in a moment.");
            return;
          }
          openPdfInTab(data.url);
        },
        onError: () => {
          setOpenPdfPending(false);
          showToast("Couldn't open the PDF.");
        },
      },
    );
  };
  const handleMarkAsSent = () => {
    if (!sendSheet) return;
    sendMut.mutate(
      { id: sendSheet.invoiceId },
      {
        onSuccess: () => {
          showToast("Invoice marked as sent");
          closeSendSheet();
        },
        onError: () => showToast("Couldn't mark the invoice as sent."),
      },
    );
  };

  // `closing` spans the whole close sequence (POD attaches + completion), not
  // just the completion mutation — without it a second tap during the attach
  // uploads would run closeStop twice.
  const [closing, setClosing] = useState(false);
  const submitting = closing || completeWithPaymentMut.isPending;

  // Best-effort: the stop is already completed by the time this runs — a
  // failed photo attach must NEVER surface as a failed delivery/payment, so
  // this stays silent on error (no toast) rather than interrupting the
  // driver mid-route. HEIC-safe transcode mirrors the operator record-payment
  // flow (products/[id].tsx has the same trap).
  const uploadPaymentPhoto = async (uri: string, paymentId: string) => {
    try {
      const jpeg = await manipulateAsync(uri, [], { compress: 0.8, format: SaveFormat.JPEG });
      const file = productImageFile({ uri: jpeg.uri, mimeType: "image/jpeg" });
      await uploadImageMut.mutateAsync({ paymentId, file });
    } catch {
      // swallow — never blocks/fails stop completion
    }
  };

  // REG-B111 leg A: PhotoCapture's transcode-failure fallback
  // (components/PhotoCapture.tsx:66-68) hands back a local `file://` URI
  // instead of a `data:` URL when the resize/base64 transcode fails. That
  // capture must still reach the attach loop below — never be silently
  // filtered out — so convert it here on a best-effort basis instead.
  // Resizes on the SAME budget PhotoCapture uses (lib/pod-image.ts): a
  // full-resolution camera JPEG transcoded without a resize routinely exceeds
  // the server's 1.9MB dataUrl cap and its 2MB JSON body limit, so an
  // unresized rescue would fail the attach every time. A result that is still
  // over the cap counts as a conversion failure (the caller keeps the capture)
  // rather than a request the server is guaranteed to reject.
  const podPhotoToDataUrl = async (uri: string): Promise<string | null> => {
    if (uri.startsWith("data:")) {
      return uri.length > MAX_POD_DATA_URL_LENGTH ? null : uri;
    }
    try {
      const jpeg = await manipulateAsync(uri, [{ resize: { width: DATA_URL_MAX_WIDTH } }], {
        compress: DATA_URL_JPEG_QUALITY,
        format: SaveFormat.JPEG,
        base64: true,
      });
      if (!jpeg.base64) return null;
      const dataUrl = `data:image/jpeg;base64,${jpeg.base64}`;
      return dataUrl.length > MAX_POD_DATA_URL_LENGTH ? null : dataUrl;
    } catch {
      return null;
    }
  };

  const closeStop = async () => {
    if (!stopId || !runId || !stop || submitting) return;

    // RF-006: block submit when a money-collecting method has zero collected
    // amount. Every method except "Account" (on account) collects something at
    // the door. With driver payments disabled there is no method picker at all
    // — every close is on account, so no amount is ever required.
    const requiresAmount = canCollect && method !== "Account";
    if (requiresAmount && receivedNum === 0) {
      // "Zelle" is a brand name — never lowercased.
      const noun = method === "Zelle" ? "Zelle" : method.toLowerCase();
      setAmountError(`Enter the ${noun} amount received before closing.`);
      return;
    }
    setAmountError(null);

    // SA-094a review (5), per-order (B762 adaptation item 4): see
    // lib/short-pick.ts#planPendingButLinesNotLoaded -- refuse to close
    // rather than silently discard a driver's recorded short-pick choice
    // for ANY order at the stop whose richer data is still loading.
    const anyPlanPendingButNotLoaded = (stop.orders ?? []).some((o) =>
      planPendingButLinesNotLoaded(
        deliveredQtyById,
        (o.lineItems ?? []).map((li) => li.id),
        !!ordersById[o.id],
      ),
    );
    if (anyPlanPendingButNotLoaded) {
      setAmountError("Delivery details are still loading — wait a moment and try again.");
      return;
    }

    // RF-005: use the atomic complete-with-payment endpoint so both writes
    // succeed or fail together (no orphaned completed stop without payment).
    // P10-POS-7/B762: when the short-pick review screen recorded per-line
    // delivered qty for an order, honor it (PARTIAL/REFUSED reprice via the
    // server's own proration — see lib/short-pick.ts). SA-109/SA-109a: EVERY
    // order on the stop must appear with EXPLICIT per-line entries — an
    // order missing from this array entirely reads as fully UNDELIVERED
    // server-side — and `type` always goes through `deliveryTypeForQty`
    // (via buildDeliveries), never a hardcoded literal. B648/SA-094b: the
    // GLOBAL normalizedPlan (snapped across every order) is what
    // buildStopDeliveries reads through richShortPickLinesByOrder — a
    // unit-aware line's delivered qty is already snapped to a whole Case
    // before this ever runs.
    //
    // SA-115 required (2): the fallback triggers ONLY when the order's
    // fetch has NOT LANDED (`ordersById[o.id]` undefined) — never merely
    // because its rich lines came back empty. A LANDED order with nothing
    // adjustable (every line already delivered on an earlier visit, or all
    // cancelled) sends its rich (empty) lines as-is — zero entries for
    // THIS close, which the server reads as no new delivery action for it,
    // not a downgrade of an order that's already DELIVERED. Falling back to
    // the raw snapshot for that case would have re-claimed full delivery on
    // lines the driver's own loaded data says are already settled.
    const stopPlans = (stop.orders ?? []).map((o) => ({
      orderId: o.id,
      lines: ordersById[o.id] ? (richShortPickLinesByOrder[o.id] ?? []) : fallbackShortPickLines(o),
      deliveredQtyById: normalizedPlan,
    }));
    // SA-367a: a line the server served no remaining for has no default — the driver must enter
    // it on the review screen first (buildStopDeliveries would refuse; say so readably instead).
    const awaiting = stopPlans.flatMap((p) => linesAwaitingEntry(p.lines, deliveredQtyById));
    if (awaiting.length > 0) {
      setAmountError(
        `Enter how many were delivered for ${awaiting.length === 1 ? "1 line" : `${awaiting.length} lines`} in Review delivery before closing.`,
      );
      return;
    }
    const deliveries = buildStopDeliveries(stopPlans);

    // NEW-m1-3: validate that at least one item is being delivered
    if (deliveries.length === 0) {
      setAmountError("At least one item must be marked for delivery before completing this stop.");
      return;
    }

    // W7b: a regulated delivery must carry the demanded age/ID checks + a signature
    // (the server enforces this too — this is a UX shortcut to avoid a wasted
    // round-trip; see lib/pod-gating.ts for the tested pure logic).
    const podGateError = regulatedPodGateError({
      ageCheckRequired: !!stop.ageCheckRequired,
      identityCheckRequired: !!stop.identityCheckRequired,
      hasSignature: !!pod?.signatureUri,
      ageVerified: pod?.ageVerified,
      identityVerified: pod?.identityVerified,
      identityType: pod?.identityType,
    });
    if (podGateError) {
      setAmountError(podGateError);
      return;
    }

    const apiMethod = ({
      Cash: "CASH",
      Card: "CREDIT_CARD",
      Cheque: "CHECK",
      Zelle: "ZELLE",
      Account: "ADVANCE",
    }[method] ?? "OTHER") as CollectedMethod;
    const collected = !canCollect || method === "Account" ? 0 : Math.min(receivedNum, invoiceTotal);

    setClosing(true);

    // Durable POD: upload captured photos as individual JSON attaches BEFORE
    // the completion. JSON rides the offline queue (FormData does not) and the
    // queue replays FIFO, so offline attaches land before the queued
    // completion. The server appends each photo's storage key to the stop —
    // the completion payload no longer carries photo strings at all (sending
    // them would overwrite keys attached by queued replays). Failures never
    // block the driver: a lost photo is no worse than the pre-upload behavior.
    const podPhotos = pod?.photoUrls ?? [];
    // Captures that did NOT reach the server. `clearPod` below wipes the whole
    // POD entry once the stop completes, so anything still in here is written
    // back afterwards — a photo the server never received is never deleted
    // from the device (REG-B111).
    const unsentUris: string[] = [];
    // Convert every capture ONCE, then write a converted `file://` fallback
    // back into podStore. `podPhotoArtifactId` hashes the data URL, so
    // re-encoding the same file on the next attempt (a failed completion
    // leaves the POD in place) could otherwise mint a SECOND id for the same
    // photo and append a duplicate. Persisting the converted data URL makes
    // the id stable across retries (D3, REG-B136).
    const stableUrls = [...podPhotos];
    const candidates: PendingArtifactCandidate[] = [];
    for (const [index, rawUrl] of podPhotos.entries()) {
      const dataUrl = await podPhotoToDataUrl(rawUrl);
      if (!dataUrl) {
        // Conversion failed (exotic/corrupt file, or still over the server's
        // size cap). Treated exactly like a failed attach: the capture is kept
        // on the device and the failure is recorded in the offline queue's
        // failedActions, so it survives the navigation away from this screen.
        const reason =
          "A delivery photo couldn't be prepared for upload. It's saved on this device and listed under failed actions.";
        unsentUris.push(rawUrl);
        setAmountError(reason);
        showToast(reason);
        useOfflineQueue.getState().addFailedAction({
          action: {
            id: `pod-photo-${stopId}-unconvertible-${index}`,
            endpoint: `/route-runs/${runId}/stops/${stopId}/pod-artifact`,
            method: "POST",
            // The source URI only — never the base64 payload: failedActions is
            // persisted to AsyncStorage as one JSON blob, so an image body
            // there would bloat the offline queue by megabytes per failure.
            body: { kind: "photo", sourceUri: rawUrl },
            timestamp: Date.now(),
            retries: 0,
          },
          reason,
          failedAt: Date.now(),
        });
        continue;
      }
      stableUrls[index] = dataUrl;
      candidates.push({ artifactId: podPhotoArtifactId(dataUrl), dataUrl });
    }
    if (stableUrls.some((url, i) => url !== podPhotos[i])) {
      usePodStore.getState().setPhotos(stopId, stableUrls);
    }

    // Attach only what the server does not already hold for this stop: its
    // `podPhotoUrls` are `…/photo-<artifactId>.<ext>` storage keys, so
    // reconciling against them is what stops an app-kill relaunch (podStore
    // now hydrates) or a retry after a failed completion from appending the
    // same photo twice — the server's own guard only dedupes an identical
    // artifactId (D3, REG-B136).
    const pending =
      pendingPodArtifacts(candidates, {
        podArtifactIds: artifactIdsFromPodPhotoUrls(stop.podPhotoUrls),
      }) ?? [];
    for (const { artifactId, dataUrl } of pending) {
      try {
        await attachPodMut.mutateAsync({
          runId,
          stopId,
          kind: "photo",
          dataUrl,
          artifactId,
        });
      } catch (e: any) {
        // The stop completion must proceed either way — but the failure is
        // never silent: it's surfaced inline + as a toast, recorded in the
        // offline queue's failedActions, and the capture is kept on the
        // device (REG-B111 leg B) instead of vanishing from an empty catch.
        const reason =
          e?.response?.data?.message ?? e?.message ?? "Delivery photo failed to upload.";
        unsentUris.push(dataUrl);
        setAmountError(reason);
        showToast(reason);
        useOfflineQueue.getState().addFailedAction({
          action: {
            id: `pod-photo-${stopId}-${artifactId}`,
            endpoint: `/route-runs/${runId}/stops/${stopId}/pod-artifact`,
            method: "POST",
            // artifactId only — the base64 image never enters failedActions
            // (persisted to AsyncStorage; see the note above).
            body: { kind: "photo", artifactId },
            timestamp: Date.now(),
            retries: 0,
          },
          reason,
          failedAt: Date.now(),
        });
      }
    }

    // BUG-DRV1-3: stable per-attempt idempotency-key. The header is captured
    // by the offline-queue persister so a retry after a network blip cannot
    // double-charge — the server (RF-019) returns the original response.
    const idempotencyKey = `stop-${stopId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let paymentIds: string[] | undefined;
    try {
      const result = await completeWithPaymentMut.mutateAsync({
        runId,
        stopId,
        deliveries,
        // The signature stays inline (an SVG data URL is a few KB): the server
        // ingests it into storage during completion, and the regulated
        // signature gate needs it present on THIS request.
        signatureUrl: pod?.signatureUri,
        driverNote: pod?.note,
        ageVerified: pod?.ageVerified,
        identityVerified: pod?.identityVerified,
        identityType: pod?.identityType,
        // The server resolves the invoice from the delivered orders — we only
        // send amount + method (a client invoiceId was always undefined here).
        payment: collected > 0 ? { amount: collected, method: apiMethod } : undefined,
        idempotencyKey,
      });
      // paymentIds rides on the response but isn't in RouteRunStop's type yet
      // (routes.ts is out of scope for this change — already-returned/just-
      // untyped, same pattern as admin.ts's orderId/invoiceGroupId).
      paymentIds = (result as unknown as { paymentIds?: string[] }).paymentIds;
    } catch (e: any) {
      const outcome = classifyMutationError(e);
      if (outcome.kind === "queued") {
        // REG-B308: a queued offline completion is a pending success, not a
        // failure — mirror the success path's cleanup below. `setClosing(false)`
        // below releases the latch right before the Alert/navigate, exactly
        // like the success path does further down — the mutation has already
        // settled either way, and this screen navigates away next regardless.
        // Known gap (TO FILE, out of scope here): the payment photo upload is
        // dropped entirely on this path — it needs `paymentIds` off the real
        // (non-queued) response, which never arrives for a queued completion.
        showToast("Offline — completion queued and will sync when you reconnect");
        clearPod(stopId);
        if (unsentUris.length) usePodStore.getState().setPhotos(stopId, unsentUris);
        if (stopId) clearPlan(stopId);
        if (collected > 0 && runId) {
          useRunSettlementStore.getState().recordCollection(runId, {
            stopId,
            method: apiMethod,
            amount: collected,
            collectedAt: Date.now(),
          });
        }
        const remaining = (run?.stops ?? []).filter(
          (s) => s.id !== stopId && (s.status === "PENDING" || s.status === "IN_PROGRESS"),
        );
        setClosing(false);
        if (Platform.OS !== "web" && remaining.length > 0) {
          Alert.alert(
            "Continue in Google Maps?",
            `${remaining.length} stop${remaining.length === 1 ? "" : "s"} left. Re-open Maps with the updated route from your current location?`,
            [
              {
                text: "Stay in app",
                style: "cancel",
                onPress: () => router.replace("/(driver)/route"),
              },
              {
                text: "Open Maps",
                onPress: async () => {
                  const loc = await readDriverLocation();
                  openRouteInMaps(remaining, loc ? { originLat: loc.lat, originLng: loc.lng } : {});
                  router.replace("/(driver)/route");
                },
              },
            ],
          );
          return;
        }
        router.replace("/(driver)/route");
        return;
      }
      // REG-DRIVER-DUR-C: completeWithPayment mints a fresh idempotency key on
      // every manual retry, so RF-019 cannot collapse a retry after a lost
      // response — but the server refuses ANY write once the stop is
      // COMPLETED, before its transaction. So this 400 on a retry means the
      // FIRST attempt already landed; treat it as success (refresh + navigate)
      // instead of surfacing the raw server message and re-arming the button.
      if (isStopAlreadyCompletedError(e)) {
        await qc.invalidateQueries({ queryKey: ["route-runs", runId] });
        await qc.invalidateQueries({ queryKey: ["route-runs", "active"] });
        setClosing(false);
        showToast("Stop already completed");
        router.replace("/(driver)/route");
        return;
      }
      setClosing(false);
      showToast(outcome.message);
      return;
    }
    setClosing(false);

    clearPod(stopId);
    // Any capture the server never received survives the clear: the driver
    // still has the photo, and the failedActions entries above say why.
    if (unsentUris.length) usePodStore.getState().setPhotos(stopId, unsentUris);
    if (stopId) clearPlan(stopId);
    if (collected > 0 && runId) {
      useRunSettlementStore.getState().recordCollection(runId, {
        stopId,
        method: apiMethod,
        amount: collected,
        collectedAt: Date.now(),
      });
    }
    // Best-effort payment photo: the delivery rows created by this stop are
    // ungrouped, so the photo attaches to the FIRST invoice's payment row
    // (acceptable for v1 — see plan). Fire-and-forget, never awaited: the
    // stop is already done and must not wait on this.
    if (photos[0] && paymentIds?.[0]) {
      uploadPaymentPhoto(photos[0], paymentIds[0]);
    }
    showToast("Stop completed");

    // The pre-#2089 nav flow — extracted so the invoice prompt below can defer
    // it to the sheet's onClose without duplicating the Maps-relaunch dance.
    const proceedToRoute = () => {
      const remaining = (run?.stops ?? []).filter(
        (s) => s.id !== stopId && (s.status === "PENDING" || s.status === "IN_PROGRESS"),
      );
      if (Platform.OS !== "web" && remaining.length > 0) {
        // Native only: offer to re-launch Google Maps with remaining stops.
        // Deep-links are fire-and-forget — relaunching is the only way to drop
        // the completed stop and re-route to the next one.
        Alert.alert(
          "Continue in Google Maps?",
          `${remaining.length} stop${remaining.length === 1 ? "" : "s"} left. Re-open Maps with the updated route from your current location?`,
          [
            {
              text: "Stay in app",
              style: "cancel",
              onPress: () => router.replace("/(driver)/route"),
            },
            {
              text: "Open Maps",
              onPress: async () => {
                const loc = await readDriverLocation();
                openRouteInMaps(remaining, loc ? { originLat: loc.lat, originLng: loc.lng } : {});
                router.replace("/(driver)/route");
              },
            },
          ],
        );
        return;
      }
      router.replace("/(driver)/route");
    };

    // #2089 (owner ruling): "automatically open the invoice, then ask if you
    // want to send it." Offline is checked FIRST and unconditionally
    // (postDeliveryInvoicePrompt's own contract) — no network round trip means
    // no way to know whether an invoice even exists. W4: a mixed regulated
    // order can return sibling invoices; prompt for the primary (first) order
    // on the stop, same as web/operator.
    const primaryOrderId = stop?.orders?.[0]?.id;
    if (!primaryOrderId) {
      proceedToRoute();
      return;
    }
    // #2265: read connectivity LIVE here — the render-time `isOnline` is stale after the await.
    const online = isLiveOnline({
      browserOnline: onlineManager.isOnline(),
      netInfoOnline: useOfflineQueue.getState().isOnline,
    });
    if (postDeliveryInvoicePrompt({ invoice: undefined, online }) === "offline-later") {
      showToast(INVOICE_LATER_TOAST);
      proceedToRoute();
      return;
    }
    // `useCreateInvoiceFromOrder` is OPERATOR-only server-side — this order
    // already has its invoice from earlier in its lifecycle (RouteRunOrder.
    // invoiceId is populated before the driver ever reaches this screen), so a
    // fresh GET (driver-accessible) reads its now-current post-completion
    // status instead of creating one.
    // staleTime: 0 — this order's query cache may still hold the PRE-completion
    // snapshot (populated by the useQueries fan-out above); force a real
    // network hit rather than risk reading it back unchanged.
    // #2265: networkMode "always" — offline, fail fast into the fallback below instead of pausing.
    qc.fetchQuery({
      ...orderQueryOptions(primaryOrderId),
      staleTime: 0,
      networkMode: DRIVER_CRITICAL_NETWORK_MODE,
    })
      .then((fresh) => {
        const inv = fresh?.invoices?.[0];
        const outcome = postDeliveryInvoicePrompt({
          invoice: inv ? { status: inv.status as InvoiceStatus } : null,
          online: true,
        });
        if (!inv || outcome === "skip" || outcome === "offline-later") {
          proceedToRoute();
          return;
        }
        afterInvoicePromptRef.current = proceedToRoute;
        setSendSheet({
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          totalFmt: formatCurrency(inv.total),
          issuePrompt: outcome === "issue-and-send",
          customerPhone: stop?.customer?.phone,
          // Known gap (TO FILE): the driver stop payload carries no customer
          // email today (RouteRunStop.customer has no `email` field) — the
          // Email channel stays hidden here until that's threaded through;
          // WhatsApp/SMS/Share PDF/Mark-as-sent cover it meanwhile.
          customerEmail: undefined,
        });
      })
      // #2251: never silent — log it, tell the driver in the offline path's words, move on.
      .catch((err) =>
        onPostDeliveryInvoiceFetchFailed(err, {
          toast: showToast,
          log: console.warn,
          proceed: proceedToRoute,
        }),
      );
  };

  const press = (k: string) => {
    setReceived((prev) => {
      if (k === "⌫") return prev.slice(0, -1) || "0";
      if (k === "·") return prev.includes(".") ? prev : prev + ".";
      if (prev === "0" || prev === "0.00") return k;
      return prev + k;
    });
  };

  const whole = Math.floor(invoiceTotal);
  const fraction = invoiceTotal.toFixed(2).split(".")[1] ?? "00";

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          tint="light"
          inlineTitle="Collect payment"
          leading={<NavBackButton label="Stop" onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        tint="light"
        inlineTitle={canCollect ? "Collect payment" : "Complete stop"}
        leading={<NavBackButton label="Stop" onPress={() => router.back()} />}
        trailing={<NavAction label="Skip" onPress={() => router.back()} />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.totalBlock}>
          <Text style={styles.eyebrow}>{invoiceLabel}</Text>
          <View style={styles.totalRow}>
            <Text style={styles.currency}>$</Text>
            <Text style={styles.totalWhole}>{whole}</Text>
            <Text style={styles.totalFraction}>.{fraction}</Text>
          </View>
        </View>

        {canCollect ? (
          <>
            <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
              <SegmentedControl
                items={METHODS as unknown as string[]}
                value={method}
                onChange={setMethod}
              />
            </View>

            <View style={styles.receivedBlock}>
              <View>
                <Text style={styles.eyebrowSmall}>{method.toUpperCase()} RECEIVED</Text>
                <Text style={styles.receivedValue}>${received}</Text>
              </View>
              <View style={styles.changeBlock}>
                <Text style={styles.changeEyebrow}>CHANGE</Text>
                <Text style={styles.changeValue}>${change.toFixed(2)}</Text>
              </View>
            </View>

            <View style={styles.quickGrid}>
              {[
                Math.max(20, Math.round(invoiceTotal * 0.5)),
                Math.round(invoiceTotal),
                Math.round(invoiceTotal) + 20,
                Math.round(invoiceTotal) + 50,
              ]
                .filter((n) => n > 0)
                .map((n) => (
                  <Pressable key={n} style={styles.quickCell} onPress={() => setReceived(`${n}`)}>
                    <Text style={styles.quickText}>${n}</Text>
                  </Pressable>
                ))}
            </View>

            <View style={styles.keypad}>
              {KEYS.map((k) => (
                <Pressable key={k} style={styles.key} onPress={() => press(k)}>
                  <Text style={styles.keyText}>{k}</Text>
                </Pressable>
              ))}
            </View>

            <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
              <Text style={styles.eyebrowSmall}>PAYMENT PHOTO (OPTIONAL)</Text>
              <View style={{ marginTop: 8 }}>
                <PhotoCapture
                  photos={photos}
                  onAdd={(uri) => setPhotos([uri])}
                  onRemove={(uri) => setPhotos((p) => p.filter((u) => u !== uri))}
                  maxPhotos={1}
                  label="Payment photo"
                />
              </View>
            </View>
          </>
        ) : (
          // Money collection is disabled for this workspace: the close goes on
          // the customer's account and the office records the payment later.
          // Plain honest copy (no dead controls) per the design directives.
          <View style={styles.onAccountNote}>
            <Text style={styles.onAccountTitle}>Invoice goes on account</Text>
            <Text style={styles.onAccountBody}>
              This workspace doesn&apos;t collect payment at the door. Completing the stop records
              the delivery and invoices the customer&apos;s account — the office handles payment.
            </Text>
          </View>
        )}

        <View style={{ padding: 16 }}>
          {amountError ? (
            <View style={styles.amountErrorBox}>
              <Text style={styles.amountErrorText}>{amountError}</Text>
            </View>
          ) : null}
          <Pressable
            style={[styles.greenBtn, submitting && styles.greenBtnDisabled]}
            onPress={submitting ? undefined : closeStop}
            disabled={submitting}
          >
            <Text style={styles.greenBtnText}>
              {submitting
                ? "Closing…"
                : !canCollect || method === "Account"
                  ? "Mark on account & close"
                  : "Receive payment & close"}
            </Text>
          </Pressable>
        </View>
      </ScrollView>

      <SendInvoiceSheet
        open={sendSheet !== null}
        onClose={closeSendSheet}
        customerName={stop?.customer?.businessName ?? "Customer"}
        invoiceNumber={sendSheet?.invoiceNumber ?? ""}
        totalFmt={sendSheet?.totalFmt ?? ""}
        phone={sendPhone}
        email={sendSheet?.customerEmail}
        emailSending={emailSending}
        whatsAppPhase={whatsAppPhase}
        pdfPhase={pdfSharePhase}
        onWhatsApp={handleWhatsApp}
        onSms={handleSms}
        onEmail={handleEmailInvoice}
        onSharePdf={handleSharePdf}
        onOpenPdf={handleOpenPdf}
        openPdfPending={openPdfPending}
        onMarkAsSent={handleMarkAsSent}
        markingSent={markingSent}
        issuePrompt={sendSheet?.issuePrompt}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bgElev },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  totalBlock: {
    backgroundColor: ios.bgElev,
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 20,
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  eyebrow: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.6,
    textAlign: "center",
  },
  totalRow: { flexDirection: "row", alignItems: "flex-end", marginTop: 12 },
  currency: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: ios.label2,
    marginBottom: 8,
    marginRight: 2,
  },
  totalWhole: {
    fontSize: 52,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -2.2,
    lineHeight: 52,
    fontVariant: ["tabular-nums"],
  },
  totalFraction: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: ios.gray[3],
    marginBottom: 4,
    fontVariant: ["tabular-nums"],
  },
  receivedBlock: {
    marginHorizontal: 16,
    marginTop: 14,
    backgroundColor: ios.bg,
    borderRadius: 14,
    padding: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  eyebrowSmall: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.9,
  },
  receivedValue: {
    fontSize: 30,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.8,
    fontVariant: ["tabular-nums"],
    marginTop: 2,
  },
  changeBlock: {
    backgroundColor: ios.system.greenWash,
    padding: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    alignItems: "flex-end",
  },
  changeEyebrow: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    color: ios.system.greenInk,
    letterSpacing: 0.9,
  },
  changeValue: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: ios.system.greenInk,
    fontVariant: ["tabular-nums"],
  },
  quickGrid: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 8,
  },
  quickCell: {
    flex: 1,
    backgroundColor: ios.fill3,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  quickText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  keypad: {
    marginHorizontal: 16,
    marginTop: 14,
    backgroundColor: ios.bg,
    borderRadius: 14,
    overflow: "hidden",
    flexDirection: "row",
    flexWrap: "wrap",
  },
  key: {
    width: "33.333%",
    height: 56,
    backgroundColor: ios.bgElev,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.bg,
  },
  keyText: {
    fontSize: 22,
    fontFamily: "Inter_500Medium",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  greenBtn: {
    backgroundColor: ios.system.green,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
  },
  greenBtnDisabled: {
    opacity: 0.55,
  },
  greenBtnText: {
    color: "#fff",
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
  },
  onAccountNote: {
    marginHorizontal: 16,
    marginTop: 16,
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  onAccountTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: ios.label,
  },
  onAccountBody: {
    marginTop: 4,
    fontSize: 13,
    lineHeight: 18,
    color: ios.label2,
  },
  amountErrorBox: {
    backgroundColor: "#FEE2E2",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 10,
  },
  amountErrorText: {
    color: "#B91C1C",
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    textAlign: "center",
  },
});
