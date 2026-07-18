import { useState } from "react";
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
  type OrderStatus,
} from "../../../../lib/api/orders";
import {
  useCreateInvoiceFromOrder,
  useInvoicePdf,
  useSendInvoice,
} from "../../../../lib/api/invoices";
import {
  invoiceReadyMessage,
  preferredPhone,
  smsUrl,
  whatsappUrl,
} from "../../../../lib/invoice-send-logic";
import { showToast } from "../../../../lib/toast";
import { confirm } from "../../../../lib/confirm";
import { formatQtySplit } from "../../../../lib/pricing";
import { sharePdf } from "../../../../lib/share-pdf";
import { ShipmentSection, ShipmentEditModal } from "../../../../components/ShipmentSection";
import { SendInvoiceSheet } from "../../../../components/SendInvoiceSheet";

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

interface StatusAction {
  label: string;
  toStatus: OrderStatus;
  style: "primary" | "secondary" | "warning" | "danger";
  icon: string;
  confirmMessage?: string;
  /** Passed to PATCH /status (e.g. the demote-to-CONFIRMED reason). */
  reason?: string;
  /** Route through POST /orders/:id/reopen (CANCELLED → PENDING) instead of /status. */
  reopenCancelled?: boolean;
}

function statusActions(current: string): StatusAction[] {
  switch (current) {
    case "DRAFT":
      return [
        {
          label: "Submit for review",
          toStatus: "PENDING",
          style: "primary",
          icon: "arrow-forward-circle-outline",
        },
      ];
    case "PENDING":
      return [
        {
          label: "Confirm order",
          toStatus: "CONFIRMED",
          style: "primary",
          icon: "checkmark-circle-outline",
        },
        {
          label: "Cancel order",
          toStatus: "CANCELLED",
          style: "danger",
          icon: "close-circle-outline",
          confirmMessage: "Cancel this order? It cannot be undone easily.",
        },
      ];
    case "CONFIRMED":
      return [
        {
          label: "Send for delivery",
          toStatus: "OUT_FOR_DELIVERY",
          style: "primary",
          icon: "car-outline",
        },
        {
          label: "Quick deliver",
          toStatus: "DELIVERED",
          style: "secondary",
          icon: "flash-outline",
          confirmMessage: "Mark as delivered without going through dispatch?",
        },
        {
          label: "Back to pending",
          toStatus: "PENDING",
          style: "warning",
          icon: "arrow-back-circle-outline",
          confirmMessage: "Revert order back to Pending?",
        },
        {
          label: "Cancel order",
          toStatus: "CANCELLED",
          style: "danger",
          icon: "close-circle-outline",
          confirmMessage: "Cancel this order?",
        },
      ];
    case "OUT_FOR_DELIVERY":
      return [
        {
          label: "Mark delivered",
          toStatus: "DELIVERED",
          style: "primary",
          icon: "checkmark-done-circle-outline",
        },
        {
          label: "Partial delivery",
          toStatus: "PARTIALLY_DELIVERED",
          style: "secondary",
          icon: "git-branch-outline",
        },
        {
          label: "Back to confirmed",
          toStatus: "CONFIRMED",
          style: "warning",
          icon: "arrow-back-circle-outline",
          confirmMessage: "Revert order back to Confirmed?",
        },
        {
          label: "Cancel order",
          toStatus: "CANCELLED",
          style: "danger",
          icon: "close-circle-outline",
          confirmMessage: "Cancel this order?",
        },
      ];
    case "PARTIALLY_DELIVERED":
      return [
        {
          label: "Mark fully delivered",
          toStatus: "DELIVERED",
          style: "primary",
          icon: "checkmark-done-circle-outline",
        },
        {
          label: "Back out for delivery",
          toStatus: "OUT_FOR_DELIVERY",
          style: "warning",
          icon: "arrow-back-circle-outline",
          confirmMessage: "Revert back to Out for delivery?",
        },
        {
          label: "Cancel order",
          toStatus: "CANCELLED",
          style: "danger",
          icon: "close-circle-outline",
          confirmMessage: "Cancel this order?",
        },
      ];
    // Note: DELIVERED has NO reopen — the API deliberately blocks
    // DELIVERED→CONFIRMED (removed as BUG-ORD-01); it would always 400. Only a
    // CANCELLED order can be reopened, via the dedicated /reopen endpoint below.
    case "CANCELLED":
      // POST /orders/:id/reopen → PENDING (OPERATOR-only; server 400s if a
      // paid/partial/written-off invoice exists).
      return [
        {
          label: "Reopen order",
          toStatus: "PENDING",
          style: "primary",
          icon: "refresh-outline",
          confirmMessage: "Reopen this cancelled order back to Pending?",
          reopenCancelled: true,
        },
      ];
    default:
      return [];
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
  const actions = statusActions(order.status);
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
   * R4: after confirming an order, jump straight to its (draft) invoice for
   * convenience — the operator can tap back to return to the order. from-order is
   * idempotent get-or-create; `push` (not `replace`) keeps the order underneath so
   * the invoice screen's back button returns here.
   */
  const openInvoiceForOrder = () => {
    createInvoiceMut.mutate(order.id, {
      onSuccess: (invoices) => {
        const inv = invoices[0];
        if (inv) router.push(`/(operator)/invoices/${inv.id}` as any);
        else showToast("Invoice ready — open it from the Invoices tab.");
      },
      onError: (e) => toastError(e, "Order confirmed. Open the invoice from the Invoices tab."),
    });
  };

  const handleStatusChange = (action: StatusAction) => {
    const onDone = (msg: string) => ({
      onSuccess: () => {
        showToast(msg);
        refetch();
      },
      onError: (e: unknown) => toastError(e),
    });
    const doChange = () => {
      if (action.reopenCancelled) {
        reopenMut.mutate(order.id, onDone("Order reopened"));
        return;
      }
      changeMut.mutate(
        { id: order.id, status: action.toStatus, reason: action.reason },
        {
          onSuccess: () => {
            showToast(`Order ${action.toStatus.toLowerCase().replace(/_/g, " ")}`);
            refetch();
            // Post-delivery: offer to send the invoice (any path into DELIVERED).
            if (action.toStatus === "DELIVERED") openSendForOrder();
            // R4: on confirm, auto-open the (draft) invoice for convenience.
            else if (action.toStatus === "CONFIRMED") openInvoiceForOrder();
          },
          onError: (e: unknown) => toastError(e),
        },
      );
    };

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
  const sendEmail = order.customer?.email;
  const buildMessage = () =>
    sendSheet
      ? invoiceReadyMessage(
          order.customer?.businessName ?? "there",
          sendSheet.invoiceNumber,
          sendSheet.totalFmt,
        )
      : "";

  const handleWhatsApp = () => {
    if (!sendSheet || !sendPhone) return;
    Linking.openURL(whatsappUrl(sendPhone, buildMessage())).catch(() =>
      showToast("Couldn't open WhatsApp."),
    );
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
        onSuccess: () => {
          showToast("Invoice emailed");
          setSendSheet(null);
        },
        onError: (e) => toastError(e),
      },
    );
  };
  const handleSharePdf = () => {
    if (!sendSheet) return;
    pdfMut.mutate(
      { id: sendSheet.invoiceId, variant: "final" },
      {
        onSuccess: async (data) => {
          if (!data?.url) {
            showToast("PDF is still generating, try again in a moment.");
            return;
          }
          try {
            await sharePdf({
              url: data.url,
              filename: `${sendSheet.invoiceNumber || "invoice"}.pdf`,
              dialogTitle: `Invoice ${sendSheet.invoiceNumber ?? ""}`.trim(),
            });
          } catch (e) {
            toastError(e, "Couldn't share the PDF.");
          }
        },
        onError: (e) => toastError(e),
      },
    );
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
            </View>
            <Text style={styles.customerName}>{order.customer?.businessName ?? "Customer"}</Text>
            {order.customer?.contactName || order.customer?.phone ? (
              <Text style={styles.customerSub}>
                {[order.customer?.contactName, order.customer?.phone].filter(Boolean).join(" · ")}
              </Text>
            ) : null}
            {order.requestedDeliveryDate ? (
              <Text style={styles.customerSub}>
                Requested {new Date(order.requestedDeliveryDate).toLocaleDateString()}
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
                // Show "1 box + 2 pcs · $30 / box" when split, otherwise the
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
              <Pressable
                style={[styles.actionBtn, styles.dangerAction]}
                onPress={handleDelete}
                disabled={deleteMut.isPending}
              >
                <Ionicons name="trash-outline" size={18} color={ios.system.red} />
                <Text style={[styles.actionBtnText, { color: ios.system.red }]}>Delete order</Text>
              </Pressable>
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
        onClose={() => setSendSheet(null)}
        customerName={order.customer?.businessName ?? "Customer"}
        invoiceNumber={sendSheet?.invoiceNumber ?? ""}
        totalFmt={sendSheet?.totalFmt ?? ""}
        phone={sendPhone}
        email={sendEmail}
        emailSending={sendMut.isPending}
        pdfSending={pdfMut.isPending}
        onWhatsApp={handleWhatsApp}
        onSms={handleSms}
        onEmail={handleEmailInvoice}
        onSharePdf={handleSharePdf}
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
});
