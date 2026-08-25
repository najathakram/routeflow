import { useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import { useAdminOrder } from "../../../../lib/api/admin";
import {
  useChangeOrderStatus,
  useDeleteOrder,
  useReopenOrder,
  useToggleOrderUrgent,
  useUpdateOrderShipment,
  fetchCancelImpact,
  type OrderStatus,
} from "../../../../lib/api/orders";
import { describeCancelImpact } from "../../../../lib/cancel-impact";
import { isInternalEmail } from "../../../../lib/internal-email";
import { fmtCalendarDate } from "../../../../lib/format-date";
import {
  useCreateInvoiceFromOrder,
  useInvoicePdf,
  useSendInvoice,
} from "../../../../lib/api/invoices";
import {
  invoiceReadyMessage,
  nextPdfSharePhase,
  planWhatsAppSend,
  preferredPhone,
  smsUrl,
  smtpFallbackNotice,
  type PdfSharePhase,
} from "../../../../lib/invoice-send-logic";
import { showToast } from "../../../../lib/toast";
import { alertInfo, confirm } from "../../../../lib/confirm";
import { formatQtySplit } from "../../../../lib/pricing";
import { freeUnitsLabel } from "../../../../lib/buyer-cart-logic";
import {
  ACTIVATION_BUDGET_MS,
  canShareFilesHere,
  openPdfInTab,
  sharePdf,
} from "../../../../lib/share-pdf";
import { ShipmentSection, ShipmentEditModal } from "../../../../components/ShipmentSection";
import { SendInvoiceSheet } from "../../../../components/SendInvoiceSheet";
import { ReasonSheet } from "../../../../components/ReasonSheet";
import { canDeleteOrder, demotionRequiresReason } from "../../../../lib/order-status-flow";
import { statusActions, type StatusAction } from "../../../../lib/order-actions";

function formatCurrency(n: number | string | undefined): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

function statusPill(status: string): {
  variant: "brand" | "green" | "orange" | "red" | "gray";
  label: string;
} {
  switch (status) {
    case "DRAFT":
      return { variant: "gray", label: "Draft" };
    case "PENDING":
      return { variant: "orange", label: "Pending" };
    case "CONFIRMED":
      return { variant: "brand", label: "Confirmed" };
    case "OUT_FOR_DELIVERY":
      return { variant: "brand", label: "Out for delivery" };
    case "PARTIALLY_DELIVERED":
      return { variant: "orange", label: "Partial delivery" };
    case "DELIVERED":
      return { variant: "green", label: "Delivered" };
    case "CANCELLED":
      return { variant: "red", label: "Cancelled" };
    default:
      return { variant: "gray", label: status };
  }
}

export default function OrderDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: order, isLoading, isError, refetch } = useAdminOrder(id ?? "");
  const changeMut = useChangeOrderStatus();
  const reopenMut = useReopenOrder();
  const deleteMut = useDeleteOrder();
  const urgentMut = useToggleOrderUrgent();
  const shipmentMut = useUpdateOrderShipment();
  const createInvoiceMut = useCreateInvoiceFromOrder();
  const sendMut = useSendInvoice();
  const pdfMut = useInvoicePdf();
  const [shipmentModal, setShipmentModal] = useState(false);
  const [sendSheet, setSendSheet] = useState<{
    invoiceId: string;
    invoiceNumber: string;
    totalFmt: string;
  } | null>(null);
  // WhatsApp (file-share mode) and Share PDF each run their own prepare →
  // (maybe) tap-again → share dance against ACTIVATION_BUDGET_MS — see
  // share-pdf.ts. The ref holds the already-prepared sharePdf() args so a
  // "PDF ready — tap to share" retap shares synchronously instead of
  // re-fetching the signed url.
  const [whatsAppPhase, setWhatsAppPhase] = useState<PdfSharePhase>("idle");
  const [pdfSharePhase, setPdfSharePhase] = useState<PdfSharePhase>("idle");
  const whatsAppShareRef = useRef<Parameters<typeof sharePdf>[0] | null>(null);
  const pdfShareRef = useRef<Parameters<typeof sharePdf>[0] | null>(null);
  // A1: "Open PDF" — the guaranteed-visible fallback when Share PDF is
  // unavailable/fails. Own pending flag rather than piggybacking on the
  // Share-PDF phase dance (pdfSharePhase/pdfShareRef), which owns the
  // separate prepare→tap-again→share budget contract.
  const [openPdfPending, setOpenPdfPending] = useState(false);
  // The demotion awaiting a reason. The server rejects a blank one, so the sheet
  // holds the action until the operator supplies it.
  const [reasonFor, setReasonFor] = useState<StatusAction | null>(null);

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Order" leading={<NavBackButton onPress={() => router.back()} />} />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  if (isError || !order) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Order" leading={<NavBackButton onPress={() => router.back()} />} />
        <View style={styles.center}>
          <Text style={styles.notFoundTitle}>Order not found</Text>
          <Pressable onPress={() => router.back()} style={styles.notFoundBtn}>
            <Text style={styles.notFoundBtnText}>Back to orders</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const s = statusPill(order.status);
  // `AdminOrder.status` is a plain string (server-shaped payload); `order-actions`
  // pins its signature to the narrower `OrderStatus` union so a typo'd status
  // string is caught at the call site instead of silently falling through to
  // the switch's `default: []`.
  const actions = statusActions(order.status as OrderStatus, order.fulfillPath);
  // R1: trust the server edit-window — items are now editable at every live stage
  // (incl. OUT_FOR_DELIVERY / DELIVERED); only CANCELLED closes it. Fall back to a
  // non-cancelled check for older API responses that don't send editWindow.
  const canEdit = order.editWindow?.editable ?? order.status !== "CANCELLED";
  const isTerminal = order.status === "DELIVERED" || order.status === "CANCELLED";

  const toastError = (e: unknown, fallback = "Try again.") => {
    const err = e as { response?: { data?: { message?: string } }; message?: string };
    showToast(err?.response?.data?.message ?? err?.message ?? fallback);
  };

  /**
   * Create-or-fetch the invoice for this order (idempotent) and open the send
   * sheet. Mirrors web's handleDeliver: the server auto-creates the DRAFT on
   * DELIVERED fire-and-forget, so we call from-order here to get the id back
   * synchronously. A regulated order can split into several invoices — we send
   * the first; the rest are reachable from the Invoices list.
   */
  const openSendForOrder = () => {
    createInvoiceMut.mutate(order.id, {
      onSuccess: (invoices) => {
        const inv = invoices[0];
        if (!inv) {
          showToast("Invoice created — open it from Invoices to send.");
          return;
        }
        // Reset any leftover share phase/cache from a previous open — a
        // stale "ready" tap-again would otherwise share the wrong PDF.
        setWhatsAppPhase("idle");
        setPdfSharePhase("idle");
        whatsAppShareRef.current = null;
        pdfShareRef.current = null;
        setSendSheet({
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          totalFmt: formatCurrency(inv.total),
        });
      },
      onError: (e) => toastError(e, "Couldn't prepare the invoice. Create it from Invoices."),
    });
  };

  /**
   * Get-or-create the invoice for this order and navigate to it. Used by the
   * explicit "Generate invoice" tile only — PR-4 removed the auto-fire on
   * confirm, which used to dump the operator onto a locked pending-mirror
   * invoice. `push` (not `replace`) keeps the order underneath so the invoice
   * screen's back button returns here.
   */
  const openInvoiceForOrder = () => {
    createInvoiceMut.mutate(order.id, {
      onSuccess: (invoices) => {
        const inv = invoices[0];
        if (inv) router.push(`/(operator)/invoices/${inv.id}` as any);
        else showToast("Invoice ready — open it from the Invoices tab.");
      },
      onError: (e) => toastError(e, "Couldn't prepare the invoice. Open it from Invoices."),
    });
  };

  /**
   * Perform the status change. Split out of `handleStatusChange` so the demote
   * flow can re-enter it once the ReasonSheet has supplied the reason the server
   * insists on.
   */
  const runStatusChange = (action: StatusAction) => {
    const onDone = (msg: string) => ({
      onSuccess: () => {
        showToast(msg);
        refetch();
      },
      onError: (e: unknown) => toastError(e),
    });
    if (action.reopenCancelled) {
      reopenMut.mutate(order.id, onDone("Order reopened"));
      return;
    }
    changeMut.mutate(
      { id: order.id, status: action.toStatus, reason: action.reason },
      {
        onSuccess: () => {
          // Only close the sheet once the server accepted it; on failure it stays
          // open with the text intact so the reason isn't retyped.
          setReasonFor(null);
          showToast(`Order ${action.toStatus.toLowerCase().replace(/_/g, " ")}`);
          refetch();
          // Post-delivery: offer to send the invoice (any path into DELIVERED).
          // PR-4: confirming just toasts and stays — it no longer auto-opens the
          // invoice, which used to push the operator onto a locked
          // pending-mirror invoice they couldn't edit or send.
          if (action.toStatus === "DELIVERED") openSendForOrder();
        },
        onError: (e: unknown) => toastError(e),
      },
    );
  };

  const handleStatusChange = (action: StatusAction) => {
    const doChange = () => runStatusChange(action);

    // Cancelling voids live invoices and hands applied credits back, so the
    // operator is told exactly what moves — and which payment blocks it —
    // before committing, rather than discovering it afterwards.
    if (action.toStatus === "CANCELLED") {
      fetchCancelImpact(order.id)
        .then((impact) => {
          const copy = describeCancelImpact(impact);
          if (copy.blockedReason) {
            confirm("Can't cancel yet", copy.blockedReason, () => {}, { confirmText: "OK" });
            return;
          }
          const body = [`Order ${order.orderNumber ?? ""} will be cancelled.`, ...copy.lines]
            .filter(Boolean)
            .join("\n\n");
          confirm(copy.title, body, doChange, { confirmText: "Cancel order", destructive: true });
        })
        .catch(() => {
          // Preview unavailable (offline mid-round): fall back to the plain
          // prompt rather than blocking the cancel — the server re-checks anyway.
          confirm("Cancel this order?", action.confirmMessage ?? "", doChange, {
            confirmText: "Confirm",
          });
        });
      return;
    }

    // A demotion without a reason is a guaranteed 400 ("A reason is required
    // when demoting an order"). The sheet collects it and doubles as the
    // confirmation, so the plain yes/no prompt is skipped here.
    if (demotionRequiresReason(order.status, action.toStatus)) {
      setReasonFor(action);
      return;
    }

    if (action.confirmMessage) {
      confirm("Confirm action", action.confirmMessage, doChange, { confirmText: "Confirm" });
    } else {
      doChange();
    }
  };

  // Channel handlers for the send sheet. WhatsApp/SMS are client deep-links with
  // no status change (mirrors web); Email is a real server send; Share PDF pushes
  // the file bytes through the OS share sheet.
  const sendPhone = preferredPhone(order.customer?.mobile, order.customer?.phone);
  // Import sentinels aren't real inboxes — hide the Email channel (mirrors web).
  const sendEmail = isInternalEmail(order.customer?.email) ? undefined : order.customer?.email;
  const buildMessage = () =>
    sendSheet
      ? invoiceReadyMessage(
          order.customer?.businessName ?? "there",
          sendSheet.invoiceNumber,
          sendSheet.totalFmt,
        )
      : "";

  /**
   * Runs the shared "prepare → (maybe) tap-again → share" dance for a PDF
   * channel (WhatsApp file-share mode, or the plain Share PDF row).
   *
   * THE TRAP (binding, see share-pdf.ts): never `await` a fetch between the
   * tap and calling `sharePdf` — that includes the presigned-url mutation
   * below. So this never does `await pdfMut.mutateAsync(...)` before calling
   * `sharePdf`; instead it measures how much of ACTIVATION_BUDGET_MS the
   * mutation itself spent and hands `sharePdf` only what's left, so the
   * TOTAL tap→share() latency — url fetch + PDF fetch combined — never
   * silently exceeds the browser's activation window.
   *
   * A SECOND tap (ref already holds a prepared call, from a first tap that
   * timed out) skips the mutation entirely and re-tries `sharePdf` with a
   * fresh full budget — this tap's own activation — against the SAME url,
   * so it shares synchronously once the earlier fetch has finished caching.
   */
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
        .catch((e) => {
          setPhase("idle");
          toastError(e, "Couldn't share the PDF.");
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
          // retapHandled: this screen flips its own control to "PDF ready —
          // tap to share", so share-pdf.ts must not also raise a dialog.
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
          } catch (e) {
            setPhase("idle");
            toastError(e, "Couldn't share the PDF.");
          }
        },
        onError: (e) => {
          setPhase("idle");
          toastError(e);
        },
      },
    );
  };

  const handleWhatsApp = () => {
    if (!sendSheet || !sendPhone) return;
    const plan = planWhatsAppSend({
      phone: sendPhone,
      message: buildMessage(),
      canShareFiles: canShareFilesHere(),
    });
    if (plan.mode === "share-file") {
      runPdfShare(whatsAppShareRef, setWhatsAppPhase, plan.text);
      return;
    }
    Linking.openURL(plan.url)
      .then(() => showToast("Opened WhatsApp with a text message — share the PDF separately."))
      .catch(() => showToast("Couldn't open WhatsApp."));
  };
  const handleSms = () => {
    if (!sendSheet || !sendPhone) return;
    const sep = Platform.OS === "ios" ? "&" : "?";
    Linking.openURL(smsUrl(sendPhone, buildMessage(), sep)).catch(() =>
      showToast("Couldn't open Messages."),
    );
  };
  const handleEmailInvoice = () => {
    if (!sendSheet || !sendEmail) return;
    sendMut.mutate(
      { id: sendSheet.invoiceId, email: sendEmail },
      {
        onSuccess: (res) => {
          const notice = "warning" in res ? smtpFallbackNotice(res) : null;
          // Resend rescued a broken tenant SMTP: the invoice DID go out, so this
          // is not an error — but the operator must learn their own mailbox is
          // dead and that the From address changed. A toast is the wrong surface
          // for it (nowrap, 2.2s, and a no-op on iOS), so disclose it in the
          // single-button info dialog instead. Plain successes stay a toast.
          if (notice) alertInfo("Invoice emailed", notice);
          else showToast("Invoice emailed");
          closeSendSheet();
        },
        onError: (e) => toastError(e),
      },
    );
  };
  const handleSharePdf = () => {
    runPdfShare(pdfShareRef, setPdfSharePhase, undefined);
  };
  /**
   * A1: explicit "Open PDF" row — reuses `openPdfInTab` (share-pdf.ts), the
   * same window.open fallback `sharePdf` itself falls back to. Independent of
   * the share dance/budget above: no transient-activation window to protect
   * since it never calls `navigator.share`, so a plain await-then-act is fine
   * here. Always visible in the sheet, so it never depends on the share API
   * being available or having just failed.
   */
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
        onError: (e) => {
          setOpenPdfPending(false);
          toastError(e, "Couldn't open the PDF.");
        },
      },
    );
  };
  /**
   * A1: "Mark as Sent" — the SAME bodyless `/invoices/:id/send` mutation
   * (useSendInvoice called without `email`) the invoice-detail dialog already
   * uses for its own Mark as Sent action. Always visible in the sheet: the
   * guaranteed "I delivered it myself" path so the sheet can never dead-end.
   */
  // Email and Mark-as-Sent ride the SAME useSendInvoice instance, so a bare
  // `isPending` lights up both rows at once. The in-flight variables tell them
  // apart: `email` present = the email send, absent = the bodyless mark-as-sent.
  const emailSending = sendMut.isPending && sendMut.variables?.email != null;
  const markingSent = sendMut.isPending && sendMut.variables?.email == null;
  const handleMarkAsSent = () => {
    if (!sendSheet) return;
    sendMut.mutate(
      { id: sendSheet.invoiceId },
      {
        onSuccess: () => {
          showToast("Invoice marked as sent");
          closeSendSheet();
          refetch();
        },
        onError: (e) => toastError(e),
      },
    );
  };
  const closeSendSheet = () => {
    setSendSheet(null);
    setWhatsAppPhase("idle");
    setPdfSharePhase("idle");
    setOpenPdfPending(false);
    whatsAppShareRef.current = null;
    pdfShareRef.current = null;
  };

  const handleDelete = () => {
    confirm(
      "Delete order?",
      "This permanently removes the order.",
      () =>
        deleteMut.mutate(order.id, {
          onSuccess: () => {
            showToast("Order deleted");
            router.back();
          },
          onError: (e: unknown) => {
            const err = e as { response?: { data?: { message?: string } }; message?: string };
            showToast(err?.response?.data?.message ?? err?.message ?? "Try again.");
          },
        }),
      { confirmText: "Delete", destructive: true },
    );
  };

  const handleToggleUrgent = () => {
    urgentMut.mutate(
      { id: order.id, urgent: !order.urgent },
      {
        onSuccess: () => {
          showToast(order.urgent ? "Urgent cleared" : "Marked urgent");
          refetch();
        },
        onError: (e: unknown) => {
          const err = e as { response?: { data?: { message?: string } }; message?: string };
          showToast(err?.response?.data?.message ?? err?.message ?? "Try again.");
        },
      },
    );
  };

  const handleSaveShipment = (carrier: string, trackingNumber: string) => {
    shipmentMut.mutate(
      { id: order.id, shippingCarrier: carrier, shippingTrackingNumber: trackingNumber },
      {
        onSuccess: () => {
          showToast(carrier || trackingNumber ? "Shipment saved" : "Shipment cleared");
          setShipmentModal(false);
          refetch();
        },
        onError: (e: unknown) => {
          const err = e as { response?: { data?: { message?: string } }; message?: string };
          showToast(err?.response?.data?.message ?? err?.message ?? "Try again.");
        },
      },
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={order.orderNumber}
        leading={
          <NavBackButton
            label="Orders"
            onPress={() => {
              // Always go to the orders list — `router.back()` would go to
              // wherever the user came from (e.g. /home), and after editing
              // an order they expect "Back to Orders" to mean the list, not
              // the deep link they originally followed.
              router.replace("/(operator)/(tabs)/orders" as any);
            }}
          />
        }
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 14 }}>
          {/* Status + customer */}
          <View style={styles.card}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Pill variant={s.variant} dot>
                {s.label}
              </Pill>
              {order.urgent ? <Pill variant="red">Urgent</Pill> : null}
              {/* ROUTE (the vast majority) gets no badge — a badge on every row would
                  be noise. SHIP is the exception worth calling out. */}
              {order.fulfillPath === "SHIP" ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                  <Ionicons name="cube-outline" size={12} color="#636366" />
                  <Pill variant="gray" small>
                    Ship
                  </Pill>
                </View>
              ) : null}
            </View>
            <Text style={styles.customerName}>{order.customer?.businessName ?? "Customer"}</Text>
            {order.customer?.contactName || order.customer?.phone ? (
              <Text style={styles.customerSub}>
                {[order.customer?.contactName, order.customer?.phone].filter(Boolean).join(" · ")}
              </Text>
            ) : null}
            {order.requestedDeliveryDate ? (
              <Text style={styles.customerSub}>
                Requested {fmtCalendarDate(order.requestedDeliveryDate)}
              </Text>
            ) : null}
            {order.deliveredAt ? (
              <Text style={styles.customerSub}>
                Delivered {new Date(order.deliveredAt).toLocaleDateString()}
              </Text>
            ) : null}
            {order.notes ? <Text style={styles.notes}>"{order.notes}"</Text> : null}
          </View>

          {/* Items */}
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>Items</Text>
              {canEdit ? (
                <Pressable
                  onPress={() => router.push(`/(operator)/orders/${order.id}/edit-items`)}
                  hitSlop={8}
                  style={styles.editItemsBtn}
                >
                  <Ionicons name="create-outline" size={16} color={ios.brand} />
                  <Text style={styles.linkText}>Edit items</Text>
                </Pressable>
              ) : null}
            </View>
            {order.lineItems.length === 0 ? (
              <Text style={styles.empty}>No items on this order.</Text>
            ) : (
              order.lineItems.map((li, i) => {
                const upbRaw = (li as any).product?.unitsPerBox;
                const upb = upbRaw == null ? 0 : Number(upbRaw);
                const isBoxed = upb > 1;
                // Show "1 box + 2 pcs · $30 / box of 12" when split, otherwise the
                // existing "8 ea · $5.00" form. Shared formatter — reads the
                // same on web order/invoice detail and the PDF.
                const qtyLine =
                  li.boxes != null || li.pieces != null
                    ? formatQtySplit({ qty: li.qty, boxes: li.boxes, pieces: li.pieces })
                    : `${li.qty} ${li.product?.unit ?? "ea"}`;
                return (
                  <View
                    key={li.id}
                    style={[
                      styles.itemRow,
                      i > 0 && {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: ios.separator,
                      },
                    ]}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={styles.itemNameRow}>
                        <Text style={styles.itemName} numberOfLines={1}>
                          {li.product?.name ?? li.name ?? "Item"}
                        </Text>
                        {!li.productId ? (
                          <View style={styles.customTag}>
                            <Text style={styles.customTagText}>Custom</Text>
                          </View>
                        ) : null}
                      </View>
                      <Text style={styles.itemSub}>
                        {qtyLine} · {formatCurrency(li.unitPrice)}
                        {isBoxed ? ` / box of ${upb}` : ""}
                      </Text>
                      {/* BUY_N_GET_M: name the free units, or the reduced line
                          total reads as a pricing error (web parity). */}
                      {freeUnitsLabel(li.promoFreeUnits) ? (
                        <Text style={styles.itemFreeLabel}>
                          {freeUnitsLabel(li.promoFreeUnits)}
                        </Text>
                      ) : null}
                      {li.notes?.trim() ? (
                        <Text style={[styles.itemSub, { fontStyle: "italic" }]} numberOfLines={2}>
                          {li.notes}
                        </Text>
                      ) : null}
                      {li.priceType === "MANUAL" &&
                      li.originalPrice != null &&
                      Number(li.unitPrice) > Number(li.originalPrice) ? (
                        <Text
                          style={{
                            color: ios.system.greenInk,
                            fontSize: 12,
                            fontWeight: "600",
                            marginTop: 2,
                          }}
                        >
                          Upsell
                        </Text>
                      ) : null}
                    </View>
                    <View style={{ alignItems: "flex-end", gap: 4 }}>
                      <Text style={styles.itemTotal}>{formatCurrency(li.subtotal)}</Text>
                      {li.status && li.status !== "PENDING" ? (
                        <Pill
                          variant={
                            li.status === "DELIVERED"
                              ? "green"
                              : li.status === "PARTIAL"
                                ? "orange"
                                : "gray"
                          }
                          small
                          dot={false}
                        >
                          {li.status.toLowerCase()}
                        </Pill>
                      ) : null}
                    </View>
                  </View>
                );
              })
            )}
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Subtotal</Text>
              <Text style={styles.totalValue}>{formatCurrency(order.subtotal)}</Text>
            </View>
            {order.tax ? (
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Tax</Text>
                <Text style={styles.totalValue}>{formatCurrency(order.tax)}</Text>
              </View>
            ) : null}
            {/* RF-4: regulated (category) tax the server folded into order.total —
                the Σ of the non-cancelled lines' snapshotted amounts. */}
            {(() => {
              const catTax = (order.lineItems ?? [])
                .filter((li) => li.status !== "CANCELLED")
                .reduce((s, li) => s + Number(li.categoryTaxAmount ?? 0), 0);
              return catTax > 0 ? (
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>Regulated tax</Text>
                  <Text style={styles.totalValue}>{formatCurrency(catTax)}</Text>
                </View>
              ) : null;
            })()}
            {Number(order.shippingFee ?? 0) > 0 ? (
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Shipping</Text>
                <Text style={styles.totalValue}>{formatCurrency(order.shippingFee)}</Text>
              </View>
            ) : null}
            <View style={[styles.totalRow, styles.totalRowMain]}>
              <Text style={styles.totalLabelMain}>Total</Text>
              <Text style={styles.totalValueMain}>{formatCurrency(order.total)}</Text>
            </View>
          </View>

          {/* Applied credits — order-scoped credit-note intents (server:
              OrderCreditNote). "Applied so far" sums this credit's CREDIT_NOTE
              payments across the order's invoices; the reason renders via the
              relation so a later edit shows up here automatically. */}
          {(order.orderCreditNotes?.length ?? 0) > 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Applied credits</Text>
              {order.orderCreditNotes!.map((oc, i) => {
                const appliedSoFar = (order.invoices ?? [])
                  .flatMap((inv) => inv.payments ?? [])
                  .filter((p) => p.creditNoteId === oc.creditNoteId)
                  .reduce((s, p) => s + Number(p.amount ?? 0), 0);
                return (
                  <View
                    key={oc.id}
                    style={[
                      styles.invoiceRow,
                      i > 0 && {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: ios.separator,
                      },
                    ]}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.invoiceNumber} numberOfLines={1}>
                        {oc.creditNote?.creditNoteNumber ?? "Credit"}
                      </Text>
                      {oc.creditNote?.reason ? (
                        <Text style={styles.itemSub} numberOfLines={2}>
                          {oc.creditNote.reason}
                        </Text>
                      ) : null}
                      <Text style={styles.itemSub}>
                        {oc.amount != null
                          ? `Requested ${formatCurrency(oc.amount)}`
                          : "Up to remaining balance"}
                      </Text>
                    </View>
                    <Text style={styles.itemTotal}>{formatCurrency(appliedSoFar)}</Text>
                  </View>
                );
              })}
            </View>
          ) : null}

          {/* R3: Invoice — mirror web's Invoice card. A CONFIRMED (or later) order
              can already have a draft invoice; surface it so mobile can open it, or
              generate one on demand. Hidden on DRAFT/CANCELLED (nothing to bill). */}
          {order.status !== "DRAFT" && order.status !== "CANCELLED" ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>
                {(order.invoices?.length ?? 0) > 1 ? "Invoices" : "Invoice"}
              </Text>
              {(order.invoices?.length ?? 0) > 0 ? (
                order.invoices!.map((inv, i) => (
                  <Pressable
                    key={inv.id}
                    style={[
                      styles.invoiceRow,
                      i > 0 && {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: ios.separator,
                      },
                    ]}
                    onPress={() => router.push(`/(operator)/invoices/${inv.id}` as any)}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.invoiceNumber} numberOfLines={1}>
                        {inv.invoiceNumber}
                      </Text>
                      <Text style={styles.itemSub}>{inv.status.toLowerCase()}</Text>
                    </View>
                    <Text style={styles.itemTotal}>{formatCurrency(inv.total)}</Text>
                    <Ionicons name="chevron-forward" size={16} color={ios.label2} />
                  </Pressable>
                ))
              ) : (
                <>
                  <Text style={styles.empty}>No invoice yet.</Text>
                  <Pressable
                    style={[styles.actionBtn, styles.secondaryAction]}
                    onPress={openInvoiceForOrder}
                    disabled={createInvoiceMut.isPending}
                  >
                    <Ionicons name="document-text-outline" size={18} color={ios.brand} />
                    <Text style={styles.actionBtnText}>
                      {createInvoiceMut.isPending ? "Preparing…" : "Generate invoice"}
                    </Text>
                  </Pressable>
                </>
              )}
            </View>
          ) : null}

          {/* Carrier shipment */}
          <ShipmentSection shipment={order} onEdit={() => setShipmentModal(true)} />

          {/* Status transitions */}
          {actions.length > 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Status</Text>
              <View style={styles.actionsCol}>
                {actions.map((action) => (
                  <Pressable
                    key={action.toStatus}
                    style={[
                      styles.actionBtn,
                      action.style === "primary" && styles.primaryAction,
                      action.style === "secondary" && styles.secondaryAction,
                      action.style === "warning" && styles.warningAction,
                      action.style === "danger" && styles.dangerAction,
                      (changeMut.isPending || reopenMut.isPending) && styles.actionDisabled,
                    ]}
                    onPress={() => handleStatusChange(action)}
                    disabled={changeMut.isPending || reopenMut.isPending}
                  >
                    <Ionicons
                      name={action.icon as "checkmark-circle-outline"}
                      size={18}
                      color={
                        action.style === "primary"
                          ? "#fff"
                          : action.style === "danger"
                            ? ios.system.red
                            : action.style === "warning"
                              ? ios.system.orange
                              : ios.brand
                      }
                    />
                    <Text
                      style={[
                        styles.actionBtnText,
                        action.style === "primary" && { color: "#fff" },
                        action.style === "danger" && { color: ios.system.red },
                        action.style === "warning" && { color: ios.system.orange },
                      ]}
                    >
                      {action.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {order.fulfillPath === "SHIP" &&
              actions.some((a) => a.toStatus === "OUT_FOR_DELIVERY") ? (
                <Text style={styles.shipHint}>
                  Sets the order to Out for delivery — the customer is notified it's on the way.
                </Text>
              ) : null}
            </View>
          ) : null}

          {/* Other actions */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>More</Text>
            <View style={styles.actionsCol}>
              {/* Split into multiple invoices — available once the order has items
                  and isn't a draft / cancelled. The screen prevents over-invoicing via
                  OrderItem.invoicedQty. */}
              {order.status !== "DRAFT" &&
              order.status !== "CANCELLED" &&
              (order.lineItems?.length ?? 0) > 0 ? (
                <Pressable
                  style={[styles.actionBtn, styles.secondaryAction]}
                  onPress={() => router.push(`/(operator)/orders/${order.id}/split-invoice`)}
                >
                  <Ionicons name="document-outline" size={18} color={ios.brand} />
                  <Text style={styles.actionBtnText}>Split into invoice…</Text>
                </Pressable>
              ) : null}
              {/* Re-open the post-delivery send sheet — the invoice is auto-created
                  on DELIVERED, so this is a re-send affordance (idempotent). */}
              {order.status === "DELIVERED" ? (
                <Pressable
                  style={[styles.actionBtn, styles.secondaryAction]}
                  onPress={openSendForOrder}
                  disabled={createInvoiceMut.isPending}
                >
                  <Ionicons name="paper-plane-outline" size={18} color={ios.brand} />
                  <Text style={styles.actionBtnText}>
                    {createInvoiceMut.isPending ? "Preparing…" : "Send invoice…"}
                  </Text>
                </Pressable>
              ) : null}
              {!isTerminal ? (
                <Pressable
                  style={[styles.actionBtn, styles.secondaryAction]}
                  onPress={handleToggleUrgent}
                  disabled={urgentMut.isPending}
                >
                  <Ionicons
                    name={order.urgent ? "flame" : "flame-outline"}
                    size={18}
                    color={ios.system.red}
                  />
                  <Text style={styles.actionBtnText}>
                    {order.urgent ? "Clear urgent flag" : "Mark as urgent"}
                  </Text>
                </Pressable>
              ) : null}
              {order.customer?.id ? (
                <Pressable
                  style={[styles.actionBtn, styles.secondaryAction]}
                  onPress={() => router.push(`/(operator)/customers/${order.customer!.id}`)}
                >
                  <Ionicons name="person-outline" size={18} color={ios.brand} />
                  <Text style={styles.actionBtnText}>View customer</Text>
                </Pressable>
              ) : null}
              {/* The server allows deleting only DRAFT/PENDING/CANCELLED, so the
                  tile is hidden elsewhere rather than earning a guaranteed 400
                  after a destructive-looking confirm. Cancel is the live-order path. */}
              {canDeleteOrder(order.status) ? (
                <Pressable
                  style={[styles.actionBtn, styles.dangerAction]}
                  onPress={handleDelete}
                  disabled={deleteMut.isPending}
                >
                  <Ionicons name="trash-outline" size={18} color={ios.system.red} />
                  <Text style={[styles.actionBtnText, { color: ios.system.red }]}>
                    Delete order
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>

      <ShipmentEditModal
        open={shipmentModal}
        shipment={order}
        saving={shipmentMut.isPending}
        onClose={() => setShipmentModal(false)}
        onSave={handleSaveShipment}
      />

      <SendInvoiceSheet
        open={sendSheet !== null}
        onClose={closeSendSheet}
        customerName={order.customer?.businessName ?? "Customer"}
        invoiceNumber={sendSheet?.invoiceNumber ?? ""}
        totalFmt={sendSheet?.totalFmt ?? ""}
        phone={sendPhone}
        email={sendEmail}
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
      />

      <ReasonSheet
        visible={reasonFor !== null}
        title={reasonFor?.label ?? "Reason"}
        message={reasonFor?.confirmMessage}
        submitLabel="Confirm"
        submitting={changeMut.isPending}
        onCancel={() => setReasonFor(null)}
        onSubmit={(reason) => reasonFor && runStatusChange({ ...reasonFor, reason })}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  notFoundTitle: { fontSize: 17, color: ios.label, marginBottom: 16 },
  notFoundBtn: { paddingVertical: 10, paddingHorizontal: 20 },
  notFoundBtnText: { color: ios.brand, fontSize: 15 },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14, gap: 10 },
  cardHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  linkText: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.brand },
  editItemsBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
  customerName: { fontSize: 17, fontFamily: "Inter_700Bold", color: ios.label, marginTop: 4 },
  customerSub: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  notes: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 6,
    fontStyle: "italic",
  },
  empty: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, paddingVertical: 8 },
  itemRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  itemNameRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  itemName: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label, flexShrink: 1 },
  customTag: {
    backgroundColor: ios.system.orangeWash,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  customTagText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.system.orangeInk,
    letterSpacing: 0.2,
  },
  itemSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  itemFreeLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.brand,
    marginTop: 2,
  },
  invoiceRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  invoiceNumber: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  itemTotal: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 8,
    marginTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  totalRowMain: { paddingTop: 8, borderTopWidth: 0, marginTop: 0 },
  totalLabel: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  totalValue: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  totalLabelMain: { fontSize: 15, fontFamily: "Inter_700Bold", color: ios.label },
  totalValueMain: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  actionsCol: { gap: 8 },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 13,
    paddingHorizontal: 14,
    borderRadius: 12,
  },
  primaryAction: { backgroundColor: ios.brand },
  secondaryAction: { backgroundColor: ios.fill3 },
  warningAction: { backgroundColor: ios.fill3 },
  dangerAction: { backgroundColor: ios.fill3 },
  actionBtnText: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  actionDisabled: { opacity: 0.5 },
  shipHint: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 8 },
});
