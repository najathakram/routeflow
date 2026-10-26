"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  AlertTriangle,
  User,
  FileText,
  CheckCircle2,
  Loader2,
  Pencil,
  RefreshCcw,
  RotateCcw,
  Trash2,
  Calendar,
} from "lucide-react";
import { Badge, Button, Card, useToast, type BadgeStatus } from "@routeflow/ui/web";
import { orderLineName } from "@/lib/product-display";
import { usePageTitle } from "@/lib/page-title-context";
import {
  useOrder,
  useUpdateOrderStatus,
  useUpdateOrderItems,
  useReopenOrder,
  useDeleteOrder,
  useUpdateOrderShipment,
  useCustomerPriceHistory,
  useResolveChangeRequest,
  useCancelImpact,
  usePatchOrderFulfillPath,
  type ItemUpdate,
} from "@/lib/api/orders";
import { useAuth } from "@/lib/auth-context";
import { useHasAddon } from "@/lib/api/tobacco";
import { ORDERS_INLINE_RETURNS_ADDON, SALES_AGENTS_ADDON, useOrderUiV2 } from "@/lib/api/addons";
import { OrderStatusBadge } from "@/components/OrderStatusBadge";
import { HandOverStamp } from "@/components/HandOverStamp";
import { seesHandOverStamp } from "@/lib/handover-stamp";
import { useTenantTimeZone } from "@/lib/tenant-timezone";
import { useStaffFulfilment } from "@/lib/fulfilment-caps";
import { OrderFulfilmentRow, fulfillPathErrorCopy } from "../_components/OrderFulfilmentRow";
import { RecordReturnAction } from "../../returns/_components/RecordReturnAction";
import { OrdersMoreMenu } from "../_components/OrdersMoreMenu";
import {
  OrderInlineReturnsSection,
  type OrderInlineReturnsSectionHandle,
} from "../_components/OrderInlineReturnsSection";
import {
  RETURN_SAVE_BLOCKED,
  useOrderInlineReturnSave,
} from "../_components/use-order-inline-return-save";
import { OrderReturnsPanel } from "./_components/OrderReturnsPanel";
import { useOrderOverpayGuard } from "./_components/OrderOverpayNotice";
import { useOrderStaleRevision } from "./_components/OrderStaleNotice";
import { rebaseOnReload } from "./_components/order-edit-rebase";
import { describeCancelImpact } from "@/lib/cancel-impact";
import { fmtCalendarDate, isInternalEmail } from "@/lib/formatting";
import { formatMoney } from "@/lib/format";
import { OrderRevisionLog } from "./_components/OrderRevisionLog";
import { SendInvoiceModal, type InvoiceModalData } from "./_components/SendInvoiceModal";
import {
  describeChangeRequest,
  describeResolution,
  type ChangeRequest,
  type ChangeRequestResolveAction,
} from "@/lib/change-requests";
import { useCreateInvoiceFromOrder } from "@/lib/api/invoices";
import { LicenseGuardModal } from "../_components/LicenseGuardModal";
import { CancelOrderButton } from "./CancelOrderButton";
import { OrderShipmentSection } from "./_components/OrderShipmentSection";
import { UnmarkShippedConfirm } from "./UnmarkShippedConfirm";
import { orderHasFinalInvoice } from "@/lib/unmark-shipped";
import { orderActionAccess } from "./order-action-access";
import { ShippedOrderExits } from "./ShippedOrderExits";
import { OrderLineItemsTable } from "./_components/OrderLineItemsTable";
import { OrderLineItemCards } from "./_components/OrderLineItemCards";
import { ActionTier } from "./_components/ActionTier";
import { usePhoneWidth } from "./_components/use-phone-width";
import { phoneActionItems } from "./_components/phone-action-items";
import { useInvoiceDraftNotice } from "./_components/use-invoice-draft-notice";
import { SAVE_CHORD_KEYS, saveChordHandler } from "./_components/use-save-chord";
import { PickupHandOverButton, PickupHandOverDialog } from "./_components/PickupHandOver";
import { CompleteAtCounterAction, CompleteAtCounterDialog } from "./_components/CompleteAtCounter";
import {
  ConfirmedPrimaryAction,
  OutForDeliveryPrimary,
  PosCutAfterHandOverNote,
  PosOrderActions,
  PosProgress,
  posMoveOptions,
} from "./_components/PosOrderActions";
import { DeleteOrderTier } from "./_components/DeleteOrderTier";
import { isPosOrder } from "@/lib/api/pos-orders";
import { FulfillPathMoveConfirm } from "./_components/FulfillPathMoveConfirm";
import { InvoicesNeedReviewBadge } from "./_components/InvoicesNeedReviewBadge";
import { EditClosedChip } from "./_components/EditClosedChip";
import { EditItemsLockedNote, InvoicedEditNotice } from "./_components/InvoicedEditNotice";
import { StickyEditBar } from "./_components/StickyEditBar";
import { DemoteReasonModal } from "./_components/DemoteReasonModal";
import { EditTaxLabel } from "./_components/EditTaxLabel";
import { deliveredLockedLineIds } from "@/lib/order-line-lock";
import { findLockedUnitLineEdit, lockedUnitLineRefusal } from "./_components/unit-line-lock";
import { parseRegulatedAuthError, type BlockedCategory } from "@/lib/api/authorizations";
import { parseSellingRestricted } from "@/lib/api/selling-restricted";
import { BlockedLinesDialog } from "@/components/BlockedLinesDialog";
import { useRestrictionWarningRetry } from "@/lib/use-restriction-warning-retry";
import { postDeliveryInvoicePrompt, type BlockedLine } from "@routeflow/types";
import { CreditLimitGuardDialog } from "@/components/CreditLimitGuardDialog";
import { parseCreditLimitError, type CreditLimitInfo } from "@/lib/api/credit-limit";
import { customerTierFor, roundMoney } from "@routeflow/pricing";
import { useCustomer, useCustomerPrices } from "@/lib/api/customers";
import { PriceLayerNotice, pricesUnconfirmed } from "@/components/PriceLayerNotice";
import { customerPricingGate, gateNoticeLayer } from "@/lib/customer-pricing-gate";
import { useCustomerLinePricing } from "@/lib/useCustomerLinePricing";
import { MoneyInput } from "@/components/MoneyInput";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { summarizeQtyByUnit } from "@/lib/order-qty-summary";
import { isEditDirty, useEditLeaveGuard } from "./edit-leave-guard";
import { AppliedCreditsPanel, appliedOnOrderRows } from "./AppliedCreditsPanel";
import { SplitInvoiceModal } from "../_components/SplitInvoiceModal";
import { toSplitInvoiceLine } from "@/lib/split-invoice-line";
import { InvoicePreviewModal, DivergenceNote } from "../../_components/LinkedDocPreviewModal";
import { CreditNotePicker, type CreditSelection } from "../_components/CreditNotePicker";
import { OrderLineUnitPicker } from "@/components/OrderLineUnitPicker";
import { codedToastCopy } from "@/lib/generic-toast-copy";
import { orderErrorText } from "@/lib/order-error-text";
import { ReadOnlyHint, WriteButton, useReadOnlyGate } from "@/lib/read-only-gate";
import {
  type ApiOrderStatus,
  type EditItemState,
  needsSpecialTierReason,
  buildEditItemFromLine,
  buildItemUpdates,
  editLineSubtotal,
  CommissionEditModal,
  EditableLineItems,
} from "./_components/order-line-edit";

// ─── Page ─────────────────────────────────────────────────────────────────────

/**
 * Render a date-only field (stored midnight UTC) as its calendar day. Parsing the
 * parts by hand avoids the day-behind shift `new Date(iso)` causes west of UTC.
 */
function formatDateOnly(iso: string): string {
  const [y, m, d] = iso.split("T")[0].split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Map the order's stored credit-note intents into the picker's selection shape. */
function creditSelectionsFromOrder(o: {
  orderCreditNotes?: Array<{ creditNoteId: string; amount?: number | string | null }>;
}): CreditSelection[] {
  return (o.orderCreditNotes ?? []).map((oc) => ({
    creditNoteId: oc.creditNoteId,
    amount: oc.amount != null ? Number(oc.amount) : undefined,
  }));
}

export default function OrderDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const { setTitle } = usePageTitle();
  const { data: order, isLoading, isError } = useOrder(id);
  // `order_ui_v2` (dark): card-list lines instead of the table.
  const orderUiV2 = useOrderUiV2();
  const staffFulfilment = useStaffFulfilment();
  // Keep the Fulfillment row rendered once it has been shown for this order: a PICKUP -> SHIP move on a
  // ship-only account would otherwise hide the select the moment the order's path becomes an offered one.
  const [fulfilRowPinned, setFulfilRowPinned] = React.useState(false);
  React.useEffect(() => setFulfilRowPinned(false), [id]);
  const orderFulfillPath = order?.fulfillPath;
  React.useEffect(() => {
    if (
      orderFulfillPath &&
      !staffFulfilment.formMethods.includes(orderFulfillPath as "ROUTE" | "SHIP")
    )
      setFulfilRowPinned(true);
  }, [orderFulfillPath, staffFulfilment.formMethods]);
  const { data: priceHistory } = useCustomerPriceHistory(order?.customerId);
  // Customer tier pricing (mirrors mobile's edit-items screen): a substituted
  // line prices off the customer's effective tier, not the raw list price.
  const customerQuery = useCustomer(order?.customerId ?? "");
  const { data: customerDetail } = customerQuery;
  const customerPricesQuery = useCustomerPrices(order?.customerId);
  const { data: customerPrices } = customerPricesQuery;
  // B62 (REG-B62): tier defaults to 1 while these queries are in flight, so any
  // line added/substituted in that window bakes the LIST price (the substitute
  // path even SENDS it). Gate pricing-dependent controls until both settle.
  // NOTE: a disabled query is isPending forever — short-circuit when there is no
  // customer. W-745: an errored read with no data no longer falls back to a tier-1 "degraded mode" (LIST): the shared gate
  // fails closed, with the failed copy and Retry; a PLAN_GATE 403 on the prices read is an empty read.
  const cpMap = React.useMemo(() => {
    const m = new Map<string, number | null>();
    for (const cp of (customerPrices ?? []) as Array<{
      productId: string;
      pricingTier: number | null;
    }>) {
      m.set(cp.productId, cp.pricingTier);
    }
    return m;
  }, [customerPrices]);
  const customerTier = customerTierFor(
    undefined,
    (customerDetail as { pricingTier?: number } | undefined)?.pricingTier,
  );
  // units_v1: the EFFECTIVE numeric tier `OrderLineUnitPicker` needs (it resolves the ladder
  // price at this tier, same source as isSpecialTierForProductId below).
  const tierForProductId = React.useCallback(
    (productId: string) => customerTierFor(cpMap.get(productId), customerTier),
    [cpMap, customerTier],
  );
  const { priceLayer, tierPriceFor, isSpecialTierFor, isSpecialTierForProductId } =
    useCustomerLinePricing(order?.customerId, tierForProductId);
  // S19b: flag on, the customer's price layer must also have settled (a price is UNCONFIRMED while it reads or failed); flag
  // off it is ready at once, no request.
  const pricingGate = customerPricingGate({
    customerQuery: order?.customerId ? customerQuery : {},
    customerPricesQuery: order?.customerId ? customerPricesQuery : {},
    priceLayer,
  });
  const pricingReady = !order?.customerId || !pricingGate.blockPick;
  const retryCustomerPricing = () => {
    void customerQuery.refetch();
    void customerPricesQuery.refetch();
  };
  const router = useRouter();
  const updateStatus = useUpdateOrderStatus();
  // The cancel flow renders its own error (every other status change keeps the global toast), so it has its own instance.
  const cancelOrder = useUpdateOrderStatus({ localErrorToast: true });
  const reopenOrder = useReopenOrder();
  const rw = useRestrictionWarningRetry(); // row 510: staff warning + override dialog
  const deleteOrder = useDeleteOrder({ localErrorToast: true });
  const updateShipment = useUpdateOrderShipment();
  const createInvoiceFromOrder = useCreateInvoiceFromOrder();
  const patchFulfillPath = usePatchOrderFulfillPath({ localErrorToast: true });
  const applyFulfillPath = (fulfillPath: "ROUTE" | "SHIP") =>
    patchFulfillPath.mutate(rw.attach({ id, fulfillPath }), {
      onSuccess: () => toast({ title: "Fulfillment updated", variant: "success" }),
      onError: (err: any) =>
        rw.handle(err, () => applyFulfillPath(fulfillPath)) ||
        toast({
          title: "Could not update fulfillment",
          description: fulfillPathErrorCopy(err),
          variant: "error",
        }),
    });
  const [showShipDialog, setShowShipDialog] = React.useState(false);
  const [showUnmarkConfirm, setShowUnmarkConfirm] = React.useState(false);
  // Picked-up dialog + a pending move off pickup: page-level so they outlive the status-gated action rows.
  const [pickupOpen, setPickupOpen] = React.useState(false);
  const [completeOpen, setCompleteOpen] = React.useState(false); // I-120: Complete at counter
  const openComplete = () => setCompleteOpen(true);
  const [pendingPath, setPendingPath] = React.useState<"ROUTE" | "SHIP" | null>(null);

  // Order-level commission override (staff + sales_agents addon only — the
  // server independently re-checks both via PlanFlagGuard/parseCommissionRatePct).
  const { user } = useAuth();
  const stampZone = useTenantTimeZone(seesHandOverStamp(user?.role)); // row 342: the hand-over time
  const isStaff = user?.role === "OPERATOR" || user?.role === "TENANT_ADMIN";
  const hasSalesAgents = useHasAddon(SALES_AGENTS_ADDON);
  const [commissionEditOpen, setCommissionEditOpen] = React.useState(false);
  // apple-ux r4: phone width folds the action bar into one row + a More menu; Record return then opens from that menu.
  const phone = usePhoneWidth();
  const returnAvailable = useHasAddon(ORDERS_INLINE_RETURNS_ADDON);
  const [returnOpen, setReturnOpen] = React.useState(false);
  const readOnlyGate = useReadOnlyGate();
  // F07: the draft invoice just made says it was not sent, and takes focus.
  const invoiceNotice = useInvoiceDraftNotice(order?.invoices);

  // P5-11: change-request resolution (office side; driver-at-stop is P10 mobile).
  const resolveCr = useResolveChangeRequest();
  const [declineTargetId, setDeclineTargetId] = React.useState<string | null>(null);
  const [declineReason, setDeclineReason] = React.useState("");

  // License guard (W6b): the edit/promote guard can 409 REGULATED_AUTH_REQUIRED.
  const [licenseBlock, setLicenseBlock] = React.useState<BlockedCategory[] | null>(null);
  const licenseRetryRef = React.useRef<(() => void) | null>(null);
  // Selling restrictions: lines the API refused for this customer (a dialog, not a raw toast).
  const [restrictedBlock, setRestrictedBlock] = React.useState<BlockedLine[] | null>(null);
  // Credit limit: the server's numbers + a "collect a payment" exit (no override exists).
  const [creditBlock, setCreditBlock] = React.useState<CreditLimitInfo | null>(null);
  // Opens the guard modal on a REGULATED_AUTH_REQUIRED 409; other errors fall
  // through to the global mutation toast.
  const guardError = (retry: () => void) => (err: unknown) => {
    if (overpay.capture(err) || stale.capture(err) || rw.handle(err, retry)) return;
    const restricted = parseSellingRestricted(err);
    if (restricted) {
      setRestrictedBlock(restricted);
      return;
    }
    const blocked = parseRegulatedAuthError(err);
    if (blocked && blocked.length > 0) {
      licenseRetryRef.current = retry;
      setLicenseBlock(blocked);
      return;
    }
    // A credit-limit 409 gets its own dialog (real numbers + a way out), not a bare toast.
    const credit = parseCreditLimitError(err);
    if (credit) setCreditBlock(credit);
  };

  // Status tracking — use actual API status directly
  const [localStatus, setLocalStatus] = React.useState<ApiOrderStatus>("PENDING");

  // Item editing
  const [isEditing, setIsEditing] = React.useState(false);
  const overpay = useOrderOverpayGuard(order, isEditing);
  const stale = useOrderStaleRevision(order, isEditing, (fresh, base) => {
    const n = rebaseOnReload(
      {
        editItems,
        editShippingFee,
        editCredits,
        creditsTouched,
        deps: { seed: buildEditItemFromLine },
        setEditItems,
        setPendingDeletes,
        setEditShippingFee,
        setEditCredits,
        setCreditsTouched,
      },
      fresh,
      base,
    );
    if (n > 0) toast({ title: "Someone else changed this order — re-check it", variant: "error" });
  });
  const updateItems = useUpdateOrderItems({
    localErrorToast: (e) => overpay.ownsToast(e) || stale.ownsToast(e),
  });
  const savingItems = updateItems.isPending;
  const saveLatchRef = React.useRef(false);
  const [focusFirstQty, setFocusFirstQty] = React.useState(false);
  const [editItems, setEditItems] = React.useState<EditItemState[]>([]);
  // S19b M3: while this customer's prices are unconfirmed (layer pending / failed / this product missing from an incomplete
  // layer) the edit cannot be saved or published; flag off nothing is read, so this is false.
  const layerBlocked = pricesUnconfirmed(
    priceLayer,
    editItems.map((it) => it.productId),
  );
  const [pendingDeletes, setPendingDeletes] = React.useState<string[]>([]);
  // Row 604 S4: bumped each time edit mode opens or closes (save, publish, cancel, discard).
  const editSessionRef = React.useRef(0);
  React.useEffect(() => {
    editSessionRef.current += 1;
  }, [isEditing]);
  const [draftAutoEntered, setDraftAutoEntered] = React.useState(false);
  // Staff-editable shipping fee (operator/tenant-admin only page). Initialized from
  // the stored order fee whenever edit mode opens; never taxed.
  const [editShippingFee, setEditShippingFee] = React.useState(0);
  // Credit-note selection (edit mode) — initialized from order.orderCreditNotes
  // whenever edit mode opens; `creditsTouched` gates whether it's sent on save
  // (undefined on the wire = leave the server's stored intents untouched).
  const [editCredits, setEditCredits] = React.useState<CreditSelection[]>([]);
  const [creditsTouched, setCreditsTouched] = React.useState(false);
  // Row 604 F24: Back / tab close / the Orders link ask before unsaved edits are dropped.
  const editDirty =
    isEditing &&
    !!order &&
    isEditDirty(
      {
        items: order.lineItems.filter((li) => li.status !== "CANCELLED").map(buildEditItemFromLine),
        shippingFee: Number(order.shippingFee ?? 0),
      },
      { items: editItems, pendingDeletes, shippingFee: editShippingFee, creditsTouched },
    );
  const leaveGuard = useEditLeaveGuard(editDirty, cancelEditMode, () => router.push("/orders"));
  // #2406: an inline return started in edit mode, folded into the SAME updateOrderItems write.
  const returnsRef = React.useRef<OrderInlineReturnsSectionHandle>(null);
  const returnSave = useOrderInlineReturnSave(returnsRef, (why) =>
    toast({ title: RETURN_SAVE_BLOCKED[why], variant: "error" }),
  );

  // Demotion modal
  const [demoteTarget, setDemoteTarget] = React.useState<ApiOrderStatus | null>(null);

  // Cancel confirmation
  const [showCancelConfirm, setShowCancelConfirm] = React.useState(false);
  // Fetched only while the dialog is open, so the page costs nothing extra.
  const cancelImpact = useCancelImpact(order?.id ?? "", showCancelConfirm);
  const cancelCopy = describeCancelImpact(cancelImpact.data);

  // Delete confirmation
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);

  // Invoice send modal (shown after marking delivered)
  const [invoiceModal, setInvoiceModal] = React.useState<InvoiceModalData | null>(null);

  // Split-invoice modal (operator can split an order into multiple invoices)
  const [splitInvoiceOpen, setSplitInvoiceOpen] = React.useState(false);

  // Floating invoice-preview popup (from the Invoices card).
  const [previewInvoiceId, setPreviewInvoiceId] = React.useState<string | null>(null);

  const { toast, dismiss } = useToast();
  // Row 604 nit: Undo toasts of the current edit session; dismissed when it ends (an Undo would be a no-op).
  const undoToastIds = React.useRef<string[]>([]);
  React.useEffect(() => {
    const ids = undoToastIds.current;
    return () => {
      for (const id of ids.splice(0)) dismiss(id);
    };
  }, [isEditing, dismiss]);

  React.useEffect(() => {
    if (order) {
      setTitle(order.orderNumber);
      setLocalStatus(order.status as ApiOrderStatus);
      // Auto-enter edit mode for draft orders so the user can immediately add items
      if (order.status === "DRAFT" && !draftAutoEntered) {
        setDraftAutoEntered(true);
        setEditItems(
          order.lineItems.filter((li) => li.status !== "CANCELLED").map(buildEditItemFromLine),
        );
        setPendingDeletes([]);
        setEditShippingFee(Number(order.shippingFee ?? 0));
        setEditCredits(creditSelectionsFromOrder(order));
        setCreditsTouched(false);
        setIsEditing(true);
      }
    }
  }, [order, setTitle, draftAutoEntered]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-navy/70" />
      </div>
    );
  }

  if (isError || !order) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Order not found.</p>
        <Button variant="secondary" href="/orders">
          Back to Orders
        </Button>
      </div>
    );
  }

  const total = Number(order.total);
  const shippingFee = Number((order as any).shippingFee ?? 0);
  // P5-08 / R1: the server's edit window is authoritative. Items are now editable at
  // every live stage (incl. OUT_FOR_DELIVERY / DELIVERED) — only a CANCELLED order
  // closes it — and post-delivery edits re-sync the linked invoice + ledger server-side.
  // Fall back to the status check when the field isn't present (older API responses).
  const canEdit =
    order?.editWindow?.editable ??
    (localStatus === "DRAFT" || localStatus === "PENDING" || localStatus === "CONFIRMED");

  // SA-763r P-2: a POS-mode order = PICKUP and not a counter sale (counter sales keep their own flow).
  const isPos = isPosOrder(order);

  // Fulfillment path can only change while the order is open — mirrors the
  // server's PATCH /orders/:id/fulfill-path rejection rule exactly.
  const fulfillPathLocked =
    localStatus === "OUT_FOR_DELIVERY" ||
    localStatus === "DELIVERED" ||
    localStatus === "CANCELLED";

  // B1134: what THIS session may do on the action bar (customers reach this page; fails closed). A status the
  // local copy has not yet caught up with (or has moved past) is no status at all, never the stale initial one.
  const access = orderActionAccess(
    user?.role,
    localStatus === order.status ? localStatus : "",
    order.cancelBlockedReason === "WITH_CARRIER",
  );

  const changeRequests = order.changeRequests ?? [];
  const pendingChangeRequests = changeRequests.filter((cr) => cr.status === "PENDING");

  /**
   * Resolve a change request. G6 race rule: the FIRST resolution wins and
   * locks server-side — a lost race is 409 CHANGE_REQUEST_ALREADY_RESOLVED
   * (typically the driver resolved it at the stop first). We NEVER retry a
   * lost race: toast what happened and let the hook's onSettled invalidation
   * refetch the winning state. REGULATED_AUTH_REQUIRED routes into the
   * existing license-guard modal with a retry, like every other guarded 409
   * on this page. CREDIT_LIMIT_EXCEEDED opens the credit guard dialog via guardError;
   * INSUFFICIENT_STOCK carries a server message and surfaces via the global mutation toast.
   */
  function handleResolve(cr: ChangeRequest, action: ChangeRequestResolveAction, reason?: string) {
    const run = () =>
      resolveCr.mutate(
        // Row 510: a restricted add/raise warns the office (409 RESTRICTION_WARNING, lineKey `cr:<id>`); the dialog's
        // "Sell anyway" calls run() again and attach() adds the ack to this SAME request, once.
        rw.attach({ orderId: order!.id, crId: cr.id, action, reason }),
        {
          onSuccess: () => {
            setDeclineTargetId(null);
            setDeclineReason("");
            toast({
              title:
                action === "DECLINE"
                  ? "Change request declined"
                  : action === "APPROVE_NEXT_DELIVERY"
                    ? "Approved — drafted onto the next delivery"
                    : "Approved — merged into this order",
              variant: "success",
            });
          },
          onError: (err: any) => {
            const code = err?.response?.data?.code;
            if (code === "CHANGE_REQUEST_ALREADY_RESOLVED") {
              toast({
                title: "Already resolved",
                description:
                  "This request was just resolved elsewhere (likely by the driver) — showing the latest state.",
                variant: "error",
              });
              setDeclineTargetId(null);
            } else if (code === "STOP_ALREADY_COMPLETED") {
              toast({
                title: "Stop already completed",
                description:
                  "Too late to change today's delivery — approve as next delivery instead.",
                variant: "error",
              });
            } else if (code === "LINE_ALREADY_DELIVERED") {
              toast({
                title: "Line already delivered",
                description: "The driver has delivered this line — it can no longer be changed.",
                variant: "error",
              });
            } else if (code === "CHANGE_WINDOW_CLOSED") {
              toast({
                title: "Delivery run no longer active",
                description: "The run has ended — this request can only be declined.",
                variant: "error",
              });
            } else {
              guardError(run)(err);
            }
          },
        },
      );
    run();
  }

  // ── Edit mode ──────────────────────────────────────────────────────────────

  function enterEditMode() {
    setEditItems(
      order!.lineItems.filter((li) => li.status !== "CANCELLED").map(buildEditItemFromLine),
    );
    setPendingDeletes([]);
    setEditShippingFee(Number(order!.shippingFee ?? 0));
    setEditCredits(creditSelectionsFromOrder(order!));
    setCreditsTouched(false);
    setIsEditing(true);
  }

  function cancelEditMode() {
    setIsEditing(false);
    setEditItems([]);
    setPendingDeletes([]);
    setEditShippingFee(0);
    setEditCredits([]);
    setCreditsTouched(false);
  }

  function handleDeleteItem(id: string) {
    // Row 604 S4: an Undo belongs to the edit session that removed the line; once that session saves or ends it is dropped.
    const sessionAtRemove = editSessionRef.current;
    const index = editItems.findIndex((it) => it.id === id);
    const item = editItems[index];
    if (!item) return;
    setEditItems((prev) => prev.filter((it) => it.id !== id));
    if (!item.isNew) {
      // Existing saved line — queue a DELETE action on save (falls back to CANCEL if invoiced).
      setPendingDeletes((prev) => [...prev, id]);
    }
    // F22: the DELETE is deferred to Save, so Undo is a display change: put the line back where it was.
    const toastId = toast({
      title: `Removed ${item.productName || "item"}`,
      variant: "info",
      duration: 8000,
      action: {
        label: "Undo",
        onClick: () => {
          if (editSessionRef.current !== sessionAtRemove) return;
          setPendingDeletes((prev) => prev.filter((x) => x !== id));
          setEditItems((prev) => {
            if (prev.some((it) => it.id === id)) return prev;
            const at = Math.min(index, prev.length);
            return [...prev.slice(0, at), item, ...prev.slice(at)];
          });
        },
      },
    });
    undoToastIds.current.push(toastId);
  }

  /** SA-388: refuse visibly, sending nothing, a save editing a LOCKED line (both save paths). */
  function refuseLockedUnitLineEdit(): boolean {
    const locked = findLockedUnitLineEdit(editItems, order!.lineItems);
    if (!locked) return false;
    toast({
      title: lockedUnitLineRefusal(locked.productName || "This line", locked.lockedDisplay),
      variant: "error",
    });
    return true;
  }

  function handleSaveItems() {
    // Row 698 (F23): ONE write per Save. `isPending` is stale for the second tap of a double tap, so a synchronous latch
    // holds until the write settles; a replayed second write would be judged against the revision the first just moved.
    if (saveLatchRef.current) return;
    if (refuseLockedUnitLineEdit()) return;
    // B465: refuse client-side before the server has to — a SPECIAL-tier line
    // whose price was overridden with no reason would otherwise round-trip a
    // 400 "A reason is required to change a special-price line" with no
    // indication of WHICH line to fix.
    const missingReasonLine = editItems.find(
      (it) =>
        !it.cancelled &&
        it.productId != null &&
        needsSpecialTierReason(it, isSpecialTierForProductId(it.productId, it)),
    );
    if (missingReasonLine) {
      toast({
        title: `A reason is required to change ${missingReasonLine.productName || "this"} — it's this customer's special price`,
        variant: "error",
      });
      return;
    }

    // Hard-delete (or CANCEL fallback) for lines the user removed with the trash button.
    const updates: ItemUpdate[] = [
      ...pendingDeletes.map((id): ItemUpdate => ({ id, action: "DELETE" })),
      ...buildItemUpdates(editItems, stale.baseLines() ?? order!.lineItems),
    ];

    // Only send shippingFee when it actually changed — avoids no-op churn (and
    // matches the API's "no dto.shippingFee ⇒ keep the stored fee" rule).
    const feeChanged = stale.feeChanged(editShippingFee, order!.shippingFee);

    // #2406: fold in whatever the operator has typed into the edit-mode Returns section.
    const inlineReturn = returnSave.prepare(order!.customerId, order!.id);
    if (inlineReturn === null) return;

    if (updates.length === 0 && !feeChanged && !creditsTouched && !inlineReturn) {
      setIsEditing(false);
      return;
    }

    // replaceAll:false — this screen sends an incremental diff (new items have no
    // id). F30/R10 (B198) made the flag explicit-only, so omitting it would merge
    // too; sending false states the intent at the call site rather than relying on
    // the server default.
    saveLatchRef.current = true;
    const onSaved = () => {
      setIsEditing(false);
      setEditItems([]);
      setEditCredits([]);
      setCreditsTouched(false);
      returnSave.onSuccess();
      // r4 F16: the page used to return to the detail with only a small "Edited 1×" chip.
      toast({ title: "Order updated", variant: "success" });
    };
    updateItems.mutate(
      rw.attach({
        id: order!.id,
        items: updates,
        replaceAll: false,
        expectedRevisionNumber: stale.expected(), // row 372: the revision this editor loaded
        ...(feeChanged ? { shippingFee: editShippingFee } : {}),
        // Credit-note selection: only sent when the operator actually touched
        // the picker — undefined on the wire leaves the server's stored
        // intents untouched (see CreditNotePicker / syncOrderCreditSelections).
        ...(creditsTouched ? { appliedCreditNotes: editCredits } : {}),
        ...(inlineReturn ? { inlineReturn } : {}),
      }),
      {
        // The latch is held through the own-replay re-read below, so a third click cannot send another write.
        onSettled: (_data, err) => {
          if (!err) saveLatchRef.current = false;
        },
        onSuccess: onSaved,
        onError: (err) => {
          const fail = returnSave.chainError(
            inlineReturn,
            guardError(() => handleSaveItems()),
          );
          // Row 698: a stale 409 about a save that already landed (its reply was lost) is success, not a conflict.
          void stale
            .isOwnReplay(err, updates, {
              fee: feeChanged ? editShippingFee : undefined,
              unverifiable: creditsTouched || !!inlineReturn,
            })
            .then((mine) => (mine ? onSaved() : fail(err)))
            .finally(() => {
              saveLatchRef.current = false;
            });
        },
      },
    );
  }

  // ── Status handlers ────────────────────────────────────────────────────────

  const handleConfirm = () => {
    updateStatus.mutate(
      { id: order.id, status: "CONFIRMED" },
      { onSuccess: () => setLocalStatus("CONFIRMED"), onError: guardError(() => handleConfirm()) },
    );
  };

  // A SHIP order asks for its tracking in the "Add tracking" dialog BEFORE this runs (F4), so nothing
  // here opens a second tracking prompt after the order ships.
  const handleLock = () => {
    updateStatus.mutate(
      { id: order.id, status: "OUT_FOR_DELIVERY" },
      {
        onSuccess: () => setLocalStatus("OUT_FOR_DELIVERY"),
        onError: guardError(() => handleLock()),
      },
    );
  };
  // A SHIP order asks for tracking first (one shipped email that carries it); other orders ship at once.
  const handleMarkShipped = () =>
    order.fulfillPath === "SHIP" ? setShowShipDialog(true) : handleLock();

  const handleCancel = () => setShowCancelConfirm(true);

  const confirmCancel = () => {
    // Refused cancels (cash already taken) have no confirm action — the dialog
    // just explains and closes.
    if (!cancelCopy.confirmLabel) {
      setShowCancelConfirm(false);
      return;
    }
    cancelOrder.mutate(
      { id: order.id, status: "CANCELLED" },
      {
        onSuccess: () => {
          setLocalStatus("CANCELLED");
          setShowCancelConfirm(false);
        },
        onError: (err: any) => {
          // Previously silent: a server refusal produced no toast at all.
          toast({
            title: "Couldn't cancel this order",
            description:
              codedToastCopy(err) ??
              err?.response?.data?.message ??
              "Please try again, or refresh and check its invoices.",
            variant: "error",
          });
        },
      },
    );
  };

  const handleDeliver = () => {
    updateStatus.mutate(
      { id: order.id, status: "DELIVERED" },
      {
        // Delivery can be refused for credit (B585 gate): open the guard, not a bare toast.
        onError: guardError(() => handleDeliver()),
        onSuccess: () => {
          setLocalStatus("DELIVERED");
          // #2089 (owner ruling): "automatically open the invoice, then ask if you
          // want to send it" — offline is checked FIRST and unconditionally
          // (postDeliveryInvoicePrompt's own contract), before ever attempting the
          // network call below, since a dropped connection right after delivery
          // must read as "try again once synced," never as "no invoice."
          if (
            postDeliveryInvoicePrompt({
              invoice: undefined,
              online: typeof navigator === "undefined" ? true : navigator.onLine,
            }) === "offline-later"
          ) {
            toast({
              title: "Order delivered",
              description: "The invoice will be ready to send once you're back online.",
              variant: "warning",
            });
            return;
          }
          // Create the invoice (idempotent — returns existing if already there)
          // then show the send-invoice prompt.
          const invoiceNow = () =>
            createInvoiceFromOrder.mutate(order.id, {
              onSuccess: (invoices: any) => {
                // W4: a mixed regulated order returns sibling invoices; prompt to send
                // the primary (standard/first) one — the rest show on the order detail.
                const invoice = Array.isArray(invoices) ? invoices[0] : invoices;
                // #2089: same shared decision — a DRAFT invoice still gets the prompt
                // (sendEmail issues DRAFT → SENT atomically on send, so "issue and
                // send" is one action, not two), only VOID/no-invoice skips silently.
                const outcome = postDeliveryInvoicePrompt({
                  invoice: invoice ? { status: invoice.status } : null,
                  online: true,
                });
                if (outcome === "skip" || outcome === "offline-later") return;
                setInvoiceModal({
                  invoiceId: invoice.id,
                  invoiceNumber: invoice.invoiceNumber,
                  total: Number(invoice.total),
                  customerName: order.customer?.businessName ?? "Customer",
                  customerPhone: order.customer?.phone,
                  customerMobile: order.customer?.mobile,
                  // Import sentinels aren't real inboxes — hide the Email option
                  // rather than offer a send that can only fail.
                  customerEmail: isInternalEmail(order.customer?.email)
                    ? undefined
                    : order.customer?.email,
                  issuePrompt: outcome === "issue-and-send",
                });
              },
              onError: (err: unknown) => {
                // The invoice-time backstop can block on an expired/newly-added
                // regulated line — open the license guard (capture/override) and
                // retry invoicing on resolve rather than dead-ending.
                const blocked = parseRegulatedAuthError(err);
                if (blocked && blocked.length > 0) {
                  licenseRetryRef.current = invoiceNow;
                  setLicenseBlock(blocked);
                  return;
                }
                // Non-critical — invoice can be created manually.
                toast({
                  title: "Order delivered. Create the invoice manually from the Invoices page.",
                  variant: "warning",
                });
              },
            });
          invoiceNow();
        },
      },
    );
  };

  const handleDemote = (reason: string) => {
    if (!demoteTarget) return;
    updateStatus.mutate(
      { id: order.id, status: demoteTarget, reason },
      {
        onSuccess: () => {
          setLocalStatus(demoteTarget);
          setDemoteTarget(null);
        },
      },
    );
  };

  /**
   * Shared "Delete order" trigger + inline two-tap confirm, reused across every
   * still-open status block below. The server also 409s if a linked invoice has
   * recorded payments — that's a distinct, deeper backstop (e.g. a DRAFT order
   * whose invoice somehow already has a payment); no local onError toast here,
   * an error just collapses the confirm back to the trigger and the global
   * mutation-error toast (app/providers.tsx) already surfaces the server's
   * message (e.g. "void the invoice first"), which a hand-written
   * `error.message` here would only shadow with a generic HTTP status string.
   *
   * Delivered orders (and any order past a real invoice, not just its DRAFT
   * pending-mirror) are no longer "operationally open" — deleting them would
   * destroy a fulfilled/billed record. "Reopen Order" is the sanctioned undo
   * for those; hide the trigger entirely rather than let it 409. Reuses the
   * same `order.invoices` the Invoice card below already renders — no new query.
   */
  const hasPostedInvoice = order.invoices?.some((inv) => inv.status !== "DRAFT") ?? false;
  const orderOperationallyOpen =
    localStatus !== "DELIVERED" && localStatus !== "PARTIALLY_DELIVERED";
  const renderDeleteOrderAction = (confirmMessage: string, successTitle = "Order deleted") =>
    !orderOperationallyOpen || hasPostedInvoice ? null : showDeleteConfirm ? (
      <div className="flex items-center gap-2">
        <span className="text-sm text-danger font-medium">{confirmMessage}</span>
        <Button
          size="sm"
          variant="danger"
          loading={deleteOrder.isPending}
          onClick={() => {
            deleteOrder.mutate(order.id, {
              onSuccess: () => {
                toast({ title: successTitle, variant: "success" });
                router.push("/orders");
              },
              onError: (e) => {
                toast({ title: orderErrorText(e), variant: "error" });
                setShowDeleteConfirm(false);
              },
            });
          }}
        >
          Confirm delete
        </Button>
        <button
          onClick={() => setShowDeleteConfirm(false)}
          className="text-sm text-navy/70 hover:text-navy transition-colors"
        >
          No
        </button>
      </div>
    ) : phone ? null : (
      <Button
        size="sm"
        variant="ghost"
        leftIcon={<Trash2 className="h-4 w-4" />}
        onClick={() => setShowDeleteConfirm(true)}
      >
        Delete order
      </Button>
    );

  // Phone width: what steps out of the bar into "More actions" (apple-ux r4 Q19). Same gates, same handlers.
  const phoneItems = phone
    ? phoneActionItems({
        status: localStatus,
        isEditing,
        staff: access.staff,
        canCancel: access.cancel,
        cancelBlocked: !!order.cancelBlockedReason,
        canDeleteOpen: orderOperationallyOpen && !hasPostedInvoice,
        isShip: order.fulfillPath === "SHIP",
        returnAvailable,
        onRecordReturn: () => setReturnOpen(true),
        onCancel: handleCancel,
        onDelete: () => setShowDeleteConfirm(true),
        onUnconfirm: () => setDemoteTarget("PENDING"),
        onReturnToConfirmed: () =>
          order.fulfillPath === "SHIP" && orderHasFinalInvoice(order)
            ? setShowUnmarkConfirm(true)
            : setDemoteTarget("CONFIRMED"),
      })
    : [];

  // ── Estimated totals in edit mode ──────────────────────────────────────────

  const editSubtotal = isEditing
    ? roundMoney(
        editItems.filter((it) => !it.cancelled).reduce((s, it) => s + editLineSubtotal(it), 0),
      )
    : Number(order.subtotal);

  const taxRate = order.subtotal > 0 ? Number(order.tax) / Number(order.subtotal) : 0;
  const editTax = isEditing ? editSubtotal * taxRate : Number(order.tax);
  // RF-4: regulated (category) tax the server folded into order.total — the Σ of the
  // non-cancelled lines' snapshotted per-line amounts. Surface it so the displayed
  // Subtotal + Tax + Regulated tax reconciles to the server total. In edit mode this
  // is a best-effort estimate (stored snapshots; the server re-derives it on save).
  const orderCategoryTax = roundMoney(
    order.lineItems
      .filter((li) => li.status !== "CANCELLED")
      .reduce((s, li) => s + Number(li.categoryTaxAmount ?? 0), 0),
  );
  const editTotal = editSubtotal + editTax + orderCategoryTax + editShippingFee;

  // B64: cancelling an order now marks every surviving line CANCELLED, so the
  // usual "active lines" filter would report "Line items 0 / Total quantity 0"
  // beside the order's real money totals. On a cancelled order every line IS
  // cancelled, so the filter carries no information there — show what the order
  // contained instead of nothing.
  const summaryLineItems =
    order.status === "CANCELLED"
      ? order.lineItems
      : order.lineItems.filter((li) => li.status !== "CANCELLED");

  const shipFirst = order.fulfillPath === "SHIP";
  const shipmentSection = (
    <OrderShipmentSection
      order={order}
      status={localStatus}
      staff={access.staff}
      canEditShipment={access.shipmentEdit}
      dialogOpen={showShipDialog}
      onDialogClose={() => setShowShipDialog(false)}
      updateShipment={updateShipment}
      statusPending={updateStatus.isPending}
      onShip={handleLock}
    />
  );

  return (
    <div className="space-y-5 p-6">
      {/* Back */}
      <Link
        href="/orders"
        onClick={(e) => {
          if (leaveGuard.requestLeave(() => router.push("/orders"))) e.preventDefault();
        }}
        className="flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Orders
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="mono text-2xl font-bold tracking-[-0.01em] text-navy">
              {order.orderNumber}
            </h2>
            {order.urgent && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-danger-bg px-2.5 py-1 text-xs font-semibold text-danger">
                <AlertTriangle className="h-3.5 w-3.5" />
                Urgent
              </span>
            )}
            <OrderStatusBadge
              status={localStatus as BadgeStatus}
              fulfillPath={order?.fulfillPath}
            />
            <InvoicesNeedReviewBadge review={order.invoicesNeedReview} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2.5 text-sm text-navy/70">
            <span>
              Created{" "}
              {new Date(order.createdAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
            {order.orderDate && (
              <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-surface-border bg-white px-2.5 text-xs font-medium text-navy">
                <Calendar className="h-3.5 w-3.5 text-navy/40" />
                Order date: {formatDateOnly(order.orderDate)}
              </span>
            )}
            {order.requestedDeliveryDate && (
              <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-surface-border bg-white px-2.5 text-xs font-medium text-navy">
                <Calendar className="h-3.5 w-3.5 text-navy/40" />
                Delivery: {formatDateOnly(order.requestedDeliveryDate)}
              </span>
            )}
          </div>
          {/* Row 342: who handed it over, at which register (staff reads only) */}
          <div className="mt-1.5">
            <HandOverStamp order={order} role={user?.role} timeZone={stampZone} />
          </div>
        </div>

        {/* Action bar */}
        <ReadOnlyHint className="text-xs text-slate-600" />
        {/* Phone width: ONE row (Edit, primary full width, More), chips and notes after it (r4 Q19). */}
        <div
          data-testid="order-actions"
          className="flex flex-wrap items-center gap-2 max-sm:w-full max-sm:[&>:not([data-tier])]:order-5"
        >
          {/* Edit Items button */}
          {canEdit && !order?.editItemsLocked && access.editItems && !isEditing && (
            <ActionTier tier="secondary">
              <WriteButton
                size="sm"
                variant="secondary"
                leftIcon={<Pencil className="h-4 w-4" />}
                onClick={(e) => {
                  setFocusFirstQty(e.detail === 0);
                  enterEditMode();
                }}
              >
                {isPos ? "Edit order" : "Edit Items"}
              </WriteButton>
            </ActionTier>
          )}

          {/* Record return (Returns Inside Order Creation, PR 1 — office web capture).
              Any order, no cap — never gated on order status, unlike the buttons below. */}
          {!isEditing &&
            access.staff &&
            (phone ? (
              // Phone: the action is a "More actions" entry; this only hosts its dialog.
              <RecordReturnAction
                customerId={order.customerId}
                customerName={order.customer?.businessName}
                orderId={order.id}
                allowRefund
                open={returnOpen}
                onOpenChange={setReturnOpen}
              />
            ) : (
              <ActionTier tier="secondary">
                <RecordReturnAction
                  customerId={order.customerId}
                  customerName={order.customer?.businessName}
                  orderId={order.id}
                  allowRefund
                />
              </ActionTier>
            ))}

          <EditClosedChip show={!canEdit && !isEditing} order={order} />

          <EditItemsLockedNote show={!!order?.editItemsLocked && access.editItems && !isEditing} />
          {/* P5-08: revision count + log (append-only edit history), one tap (row 330d). */}
          {!isEditing && <OrderRevisionLog revisions={order?.revisions ?? []} />}

          {/* P5-11: pending post-dispatch change requests awaiting resolution. */}
          {!isEditing && pendingChangeRequests.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
              {pendingChangeRequests.length} change request
              {pendingChangeRequests.length > 1 ? "s" : ""} pending
            </span>
          )}

          {/* DRAFT actions */}
          {localStatus === "DRAFT" && !isEditing && !access.staff && access.cancel && (
            <ActionTier tier="danger">
              <CancelOrderButton
                blockedReason={order.cancelBlockedReason}
                onClick={handleCancel}
                inMenu={phone}
              />
            </ActionTier>
          )}
          {localStatus === "DRAFT" && !isEditing && access.staff && (
            <>
              <ActionTier tier="primary">
                <WriteButton
                  size="sm"
                  leftIcon={<CheckCircle2 className="h-4 w-4" />}
                  onClick={() => {
                    const publish = () =>
                      updateStatus.mutate(rw.attach({ id: order.id, status: "PENDING" as any }), {
                        onSuccess: () => setLocalStatus("PENDING"),
                        onError: guardError(() => publish()),
                      });
                    publish();
                  }}
                  loading={updateStatus.isPending}
                >
                  Publish order
                </WriteButton>
              </ActionTier>
              <DeleteOrderTier
                orderId={order.id}
                inMenu={phone}
                deleteOrder={deleteOrder}
                open={showDeleteConfirm}
                setOpen={setShowDeleteConfirm}
                idleLabel="Delete draft"
                successTitle="Draft deleted"
                errorText={orderErrorText}
              />
            </>
          )}

          {/* PENDING actions */}
          {localStatus === "PENDING" && !isEditing && (
            <>
              {access.staff && (
                <ActionTier tier="primary">
                  <Button
                    size="sm"
                    leftIcon={<CheckCircle2 className="h-4 w-4" />}
                    onClick={handleConfirm}
                    loading={updateStatus.isPending}
                  >
                    Confirm order
                  </Button>
                </ActionTier>
              )}
              {access.staff && (
                <CompleteAtCounterAction order={order} status={localStatus} onOpen={openComplete} />
              )}
            </>
          )}

          {/* POS mode: one primary per state (Create invoice -> Hand over -> Record payment / Print). */}
          {isPos && access.staff && !isEditing && (
            <PosOrderActions
              order={order}
              orderId={order.id}
              status={localStatus}
              onHandOver={() => setPickupOpen(true)}
              onReadyForPickup={handleMarkShipped}
              readyPending={updateStatus.isPending}
              moveOptions={posMoveOptions(staffFulfilment.formMethods, staffFulfilment.formDefault)}
              onMove={setPendingPath}
            />
          )}

          {/* PENDING danger tier (Cancel, Delete): after the POS path moves so Delete is always last. */}
          {localStatus === "PENDING" && !isEditing && (
            <>
              <ActionTier tier="danger">
                {access.cancel && (
                  <CancelOrderButton
                    blockedReason={order.cancelBlockedReason}
                    onClick={handleCancel}
                    inMenu={phone}
                  />
                )}
                {/* #3219 S3: an order with the carrier is not deleted either (the server 409s) */}
                {access.staff &&
                  !order.cancelBlockedReason &&
                  (showDeleteConfirm ? (
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-danger font-medium">Delete order?</span>
                      <Button
                        size="sm"
                        variant="danger"
                        loading={deleteOrder.isPending}
                        onClick={() => {
                          deleteOrder.mutate(order.id, {
                            onSuccess: () => {
                              toast({ title: "Order deleted", variant: "success" });
                              router.push("/orders");
                            },
                            onError: (e) => {
                              toast({ title: orderErrorText(e), variant: "error" });
                              setShowDeleteConfirm(false);
                            },
                          });
                        }}
                      >
                        Confirm delete
                      </Button>
                      <button
                        onClick={() => setShowDeleteConfirm(false)}
                        className="text-sm text-navy/70 hover:text-navy transition-colors"
                      >
                        No
                      </button>
                    </div>
                  ) : phone ? null : (
                    <Button
                      size="sm"
                      variant="ghost"
                      leftIcon={<Trash2 className="h-4 w-4" />}
                      onClick={() => setShowDeleteConfirm(true)}
                    >
                      Delete
                    </Button>
                  ))}
              </ActionTier>
            </>
          )}

          {/* CONFIRMED actions */}
          {access.staff && localStatus === "CONFIRMED" && !isEditing && (
            <>
              {!isPos && (
                <ConfirmedPrimaryAction
                  fulfillPath={order.fulfillPath}
                  v2={orderUiV2.enabled}
                  onMarkShipped={handleMarkShipped}
                  pending={updateStatus.isPending}
                />
              )}
              {order.fulfillPath === "PICKUP" && !isPos && (
                <ActionTier tier="secondary">
                  <PickupHandOverButton onOpen={() => setPickupOpen(true)} />
                </ActionTier>
              )}
              <CompleteAtCounterAction order={order} status={localStatus} onOpen={openComplete} />
              {/* CONFIRMED→PENDING is a demotion — the server rejects it without a
                  reason, so the ONLY path is the DemoteReasonModal. A second
                  "Unconfirm" button used to submit directly (predating the
                  reason rule) and guaranteed a 400 with nowhere to type one. */}
              {!phone && (
                <ActionTier tier="secondary">
                  <Button
                    size="sm"
                    variant="secondary"
                    leftIcon={<RotateCcw className="h-4 w-4" />}
                    onClick={() => setDemoteTarget("PENDING")}
                    loading={updateStatus.isPending}
                  >
                    Unconfirm
                  </Button>
                </ActionTier>
              )}
              <ActionTier tier="danger">
                <CancelOrderButton
                  blockedReason={order.cancelBlockedReason}
                  onClick={handleCancel}
                  inMenu={phone}
                />
                {!order.cancelBlockedReason &&
                  renderDeleteOrderAction("Delete this order? This can't be undone.")}
              </ActionTier>
            </>
          )}

          {/* OUT_FOR_DELIVERY actions */}
          {access.staff && localStatus === "OUT_FOR_DELIVERY" && (
            <>
              <OutForDeliveryPrimary
                fulfillPath={order.fulfillPath}
                handOverLabel={isPos ? "Hand over" : undefined}
                onHandOver={() => setPickupOpen(true)}
                onDeliver={handleDeliver}
                pending={updateStatus.isPending}
              />
              <CompleteAtCounterAction order={order} status={localStatus} onOpen={openComplete} />
              {!phone && (
                <ActionTier tier="secondary">
                  <Button
                    size="sm"
                    variant="secondary"
                    leftIcon={<RefreshCcw className="h-4 w-4" />}
                    onClick={() =>
                      order.fulfillPath === "SHIP" && orderHasFinalInvoice(order)
                        ? setShowUnmarkConfirm(true)
                        : setDemoteTarget("CONFIRMED")
                    }
                  >
                    {order.fulfillPath === "SHIP" ? "Unmark shipped" : "Return to Confirmed"}
                  </Button>
                </ActionTier>
              )}
              <ActionTier tier="danger">
                <CancelOrderButton
                  blockedReason={order.cancelBlockedReason}
                  onClick={handleCancel}
                  inMenu={phone}
                />
                {!order.cancelBlockedReason &&
                  renderDeleteOrderAction(
                    "Delete this order? It's out for delivery — this can't be undone.",
                  )}
              </ActionTier>
            </>
          )}

          {/* DELIVERED actions — owner reversed policy 2026-08-25: reopening a
              delivered order is now a legal staff-only reasoned demotion
              (DELIVERED → CONFIRMED), wired through the same DemoteReasonModal
              as every other one-step-back transition. A route-delivered order
              (routeRunStopId on a COMPLETED stop) 409s server-side — that
              surfaces via the standard error toast (app/providers.tsx), no
              special-cased UI needed here. */}
          {access.staff && localStatus === "DELIVERED" && (
            <>
              {!order.editItemsLocked && ( // a paid walk-in sale stays closed (the server refuses it too)
                <ActionTier tier="secondary">
                  <div className="flex flex-col items-start gap-1">
                    <Button
                      size="sm"
                      variant="secondary"
                      leftIcon={<RotateCcw className="h-4 w-4" />}
                      onClick={() => setDemoteTarget("CONFIRMED")}
                    >
                      Reopen order
                    </Button>
                    <p className="text-[11px] text-navy/50">
                      Reopening keeps the invoice in sync while you edit. Orders delivered on a
                      route reopen at their original stop.
                    </p>
                  </div>
                </ActionTier>
              )}
              <ActionTier tier="danger">
                {renderDeleteOrderAction(
                  "Delete this delivered order? Its delivery record is removed permanently.",
                )}
              </ActionTier>
            </>
          )}

          {/* CANCELLED */}
          {access.staff && localStatus === "CANCELLED" && (
            <>
              <ActionTier tier="secondary">
                <Button
                  variant="secondary"
                  size="sm"
                  leftIcon={<RotateCcw className="h-4 w-4" />}
                  onClick={() => {
                    if (confirm("Reopen this order? It will return to Pending status.")) {
                      const reopen = () =>
                        reopenOrder.mutate(rw.attach(order.id), {
                          onSuccess: () => setLocalStatus("PENDING"),
                          onError: guardError(reopen),
                        });
                      reopen();
                    }
                  }}
                  loading={reopenOrder.isPending}
                >
                  Reopen order
                </Button>
              </ActionTier>
              <DeleteOrderTier
                orderId={order.id}
                inMenu={phone}
                deleteOrder={deleteOrder}
                open={showDeleteConfirm}
                setOpen={setShowDeleteConfirm}
                idleLabel="Delete"
                successTitle="Order deleted"
                errorText={orderErrorText}
              />
            </>
          )}

          {phoneItems.length > 0 && (
            <div data-tier="overflow" className="order-3 shrink-0">
              <OrdersMoreMenu items={phoneItems} />
            </div>
          )}
        </div>
      </div>

      {isPos && access.staff && <PosProgress order={order} status={localStatus} />}

      {/* B1135: a customer's way forward on an order that has shipped (no change request exists for it). */}
      {access.shippedExits && <ShippedOrderExits />}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* ── Main content ── */}
        <div className="space-y-5 lg:col-span-2">
          {/* Line items */}
          <div className="rounded-lg bg-white p-6 shadow-card">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2.5 text-base font-semibold text-navy">
                Line items
                {isEditing && (
                  <Badge variant="info" label="Editing" className="normal-case tracking-normal" />
                )}
              </h3>
            </div>
            {isEditing ? (
              // r4 F05: Ctrl/Cmd+Enter saves from any field in here (a chord, never a bare key).
              <div
                className="space-y-4"
                onKeyDown={saveChordHandler(handleSaveItems, layerBlocked || readOnlyGate.readOnly)}
              >
                {isPos && localStatus === "DELIVERED" && <PosCutAfterHandOverNote />}
                <p className="text-sm text-navy/70">
                  Add new items, adjust quantities, substitute or mark as unavailable.
                  {canEdit && " Change a line's price or apply a per-item discount."} Changes are
                  applied when you save.
                </p>
                {overpay.node}
                {stale.node}
                <InvoicedEditNotice invoices={order.invoices} />
                <EditableLineItems
                  focusFirstQty={focusFirstQty}
                  items={editItems}
                  onChange={setEditItems}
                  onAdd={(item) => setEditItems((prev) => [...prev, item])}
                  onDelete={handleDeleteItem}
                  canEditPrice={canEdit}
                  priceHistory={priceHistory}
                  tierPriceFor={tierPriceFor}
                  isSpecialTierFor={isSpecialTierFor}
                  tierForProductId={tierForProductId}
                  layerOf={priceLayer.layerOf}
                  pricingReady={pricingReady}
                  customer={{ id: order.customerId, name: order.customer?.businessName }}
                  orderId={order.id}
                  lockedLineIds={deliveredLockedLineIds(order.status, order.lineItems)}
                />

                {/* Live total preview */}
                <div className="ml-auto w-full max-w-xs rounded-lg border border-surface-border bg-surface-raised px-4 py-3">
                  <div className="flex justify-between text-sm text-navy/70">
                    <span>Subtotal</span>
                    <span className="money text-navy/70">{formatMoney(editSubtotal)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-navy/70 mt-1">
                    <EditTaxLabel order={order} />
                    <span className="money text-navy/70">{formatMoney(editTax)}</span>
                  </div>
                  {orderCategoryTax > 0 && (
                    <div className="flex justify-between text-sm text-navy/70 mt-1">
                      <span>Regulated tax</span>
                      <span className="money text-navy/70">{formatMoney(orderCategoryTax)}</span>
                    </div>
                  )}
                  {/* Staff-editable shipping fee — never taxed, added after tax. */}
                  <div className="flex items-center justify-between text-sm text-navy/70 mt-1">
                    <label className="flex items-center gap-2">
                      Shipping fee
                      <MoneyInput
                        min={0}
                        placeholder="0.00"
                        value={editShippingFee}
                        onChange={(v) => setEditShippingFee(Math.max(0, v ?? 0))}
                        className="w-20 rounded border border-surface-border bg-white px-2 py-0.5 text-xs text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                      />
                    </label>
                  </div>
                  <div className="flex justify-between text-base font-semibold text-navy border-t border-surface-border mt-2 pt-2">
                    <span>New total</span>
                    <span className="money text-[15px] text-navy">{formatMoney(editTotal)}</span>
                  </div>
                </div>

                {/* Credit notes — same picker as create; initialized from the order's
                    stored intents. Sent on save ONLY when touched (undefined on the
                    wire leaves the server's stored intents untouched). */}
                <CreditNotePicker
                  customerId={order.customerId}
                  value={editCredits}
                  onChange={(next) => {
                    setEditCredits(next);
                    setCreditsTouched(true);
                  }}
                  estimatedOrderTotal={editTotal}
                  appliedOnOrder={appliedOnOrderRows(order)}
                />

                {/* Returns Inside Order Creation, edit mode (#2406) — quoted here, captured
                    in the SAME save as the item edits below. */}
                <OrderInlineReturnsSection
                  ref={returnsRef}
                  customerId={order.customerId}
                  entryOrderId={order.id}
                  refusalMessage={returnSave.refusalMessage}
                  refusalReturn={returnSave.refusalReturn}
                />

                <StickyEditBar total={formatMoney(editTotal)}>
                  <PriceLayerNotice
                    layer={gateNoticeLayer(pricingGate, priceLayer, retryCustomerPricing)}
                    unconfirmed={layerBlocked || !pricingReady}
                    className="w-full text-xs text-navy/60"
                  />
                  {localStatus === "DRAFT" ? (
                    <>
                      <WriteButton
                        size="sm"
                        className="bg-amber-500 text-white hover:bg-amber-600"
                        onClick={handleSaveItems}
                        aria-keyshortcuts={SAVE_CHORD_KEYS}
                        disabled={layerBlocked}
                        loading={updateItems.isPending}
                      >
                        Save draft
                      </WriteButton>
                      {access.staff && (
                        <WriteButton
                          size="sm"
                          leftIcon={<CheckCircle2 className="h-4 w-4" />}
                          onClick={() => {
                            // Save items first, then publish. Exactly the payload
                            // "Save Draft" sends — deletes and prices included — so
                            // publishing straight from edit mode can't bill differently.
                            if (refuseLockedUnitLineEdit()) return;
                            const updates: ItemUpdate[] = [
                              ...pendingDeletes.map((id): ItemUpdate => ({ id, action: "DELETE" })),
                              ...buildItemUpdates(editItems, stale.baseLines() ?? order!.lineItems),
                            ];
                            const doPublish = () =>
                              updateStatus.mutate(
                                rw.attach({ id: order!.id, status: "PENDING" as any }),
                                {
                                  // Row 604 M1: the publish latch is held from the first tap
                                  // until the status write settles (save-then-publish included).
                                  onSettled: () => {
                                    saveLatchRef.current = false;
                                  },
                                  onSuccess: () => {
                                    setLocalStatus("PENDING");
                                    setIsEditing(false);
                                    setEditItems([]);
                                    setEditCredits([]);
                                    setCreditsTouched(false);
                                  },
                                  onError: guardError(() => doPublish()),
                                },
                              );
                            // Carry a shipping-fee edit into the publish save the same
                            // way handleSaveItems does — otherwise publishing straight
                            // from edit mode silently drops the fee the operator typed.
                            const feeChanged = stale.feeChanged(
                              editShippingFee,
                              order!.shippingFee,
                            );
                            // #2406: the Returns section rides this save too, never silently dropped.
                            const inlineReturn = returnSave.prepare(order!.customerId, order!.id);
                            if (inlineReturn === null) return;
                            const saveThenPublish = () => {
                              // Row 698: same one-write latch as handleSaveItems.
                              if (saveLatchRef.current) return;
                              saveLatchRef.current = true;
                              if (
                                updates.length > 0 ||
                                feeChanged ||
                                creditsTouched ||
                                inlineReturn
                              ) {
                                updateItems.mutate(
                                  rw.attach({
                                    id: order!.id,
                                    items: updates,
                                    // replaceAll:false — this is an incremental diff (new
                                    // items have no id, and a fee-only save sends []).
                                    // Without it the API's add-only/empty heuristic treats
                                    // the payload as a full replace and deletes untouched
                                    // lines. Mirrors handleSaveItems.
                                    replaceAll: false,
                                    expectedRevisionNumber: stale.expected(), // row 372 MF4
                                    ...(feeChanged ? { shippingFee: editShippingFee } : {}),
                                    // Same dual-path threading as handleSaveItems — the
                                    // line payload is shared (buildItemUpdates) but this
                                    // flow still assembles its own mutation, so credits
                                    // need the explicit carry-through (shippingFee had
                                    // this exact miss last PR — do not repeat it).
                                    ...(creditsTouched ? { appliedCreditNotes: editCredits } : {}),
                                    ...(inlineReturn ? { inlineReturn } : {}),
                                  }),
                                  {
                                    onSuccess: () => (returnSave.onSuccess(), doPublish()),
                                    onError: (err: unknown) => {
                                      saveLatchRef.current = false;
                                      returnSave.chainError(
                                        inlineReturn,
                                        guardError(() => saveThenPublish()),
                                      )(err);
                                    },
                                  },
                                );
                              } else {
                                doPublish();
                              }
                            };
                            saveThenPublish();
                          }}
                          disabled={layerBlocked}
                          loading={updateItems.isPending || updateStatus.isPending}
                        >
                          Publish order
                        </WriteButton>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={cancelEditMode}
                        disabled={updateItems.isPending || updateStatus.isPending}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <WriteButton
                        size="sm"
                        onClick={handleSaveItems}
                        aria-keyshortcuts={SAVE_CHORD_KEYS}
                        disabled={layerBlocked}
                        loading={savingItems}
                      >
                        Save changes
                      </WriteButton>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={cancelEditMode}
                        disabled={updateItems.isPending}
                      >
                        Cancel
                      </Button>
                    </>
                  )}
                </StickyEditBar>
              </div>
            ) : orderUiV2.enabled ? (
              <OrderLineItemCards
                lineItems={order.lineItems}
                orderStatus={order.status}
                total={total}
              />
            ) : (
              <OrderLineItemsTable
                lineItems={order.lineItems}
                orderStatus={order.status}
                total={total}
              />
            )}
          </div>

          {/* P5-11: post-dispatch change requests + office resolution. */}
          {!isEditing && changeRequests.length > 0 && (
            <Card
              title={`Change Requests${
                pendingChangeRequests.length > 0 ? ` (${pendingChangeRequests.length} pending)` : ""
              }`}
            >
              <ul className="divide-y divide-surface-border">
                {changeRequests.map((cr) => {
                  const { title, detail } = describeChangeRequest(cr, order.lineItems);
                  const outcome = describeResolution(cr);
                  const busy = resolveCr.isPending && resolveCr.variables?.crId === cr.id;
                  // Next-delivery is server-valid only for ADD_ITEM and
                  // CHANGE_QTY increases — hide it otherwise (400 INVALID_RESOLUTION_FOR_TYPE).
                  const currentLine = order.lineItems.find(
                    (li) => li.id === (cr.orderItemId ?? cr.payload.orderItemId),
                  );
                  const canNextDelivery =
                    cr.type === "ADD_ITEM" ||
                    (cr.type === "CHANGE_QTY" &&
                      Number(cr.payload.newQty ?? 0) > Number(currentLine?.qty ?? Infinity));
                  return (
                    <li key={cr.id} className="py-3 first:pt-0 last:pb-0">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-navy">{title}</p>
                          {detail && <p className="mt-0.5 text-xs text-navy/70">{detail}</p>}
                          <p className="mt-0.5 text-[11px] text-navy/50">
                            {cr.requestedByName ?? cr.requestedByRole ?? "Requester"} ·{" "}
                            {new Date(cr.createdAt).toLocaleString()}
                          </p>
                          {outcome && (
                            <p
                              className={`mt-1 text-xs font-medium ${
                                cr.status === "DECLINED" ? "text-danger" : "text-success"
                              }`}
                            >
                              {outcome}
                              {cr.resolvedByName ? ` · by ${cr.resolvedByName}` : ""}
                            </p>
                          )}
                        </div>
                        <Badge status={cr.status} />
                      </div>
                      {cr.status === "PENDING" &&
                        (declineTargetId === cr.id ? (
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <input
                              type="text"
                              value={declineReason}
                              onChange={(e) => setDeclineReason(e.target.value)}
                              placeholder="Decline reason (required, shown to the requester)"
                              maxLength={1000}
                              className="h-8 min-w-[240px] flex-1 rounded border border-surface-border bg-white px-2 text-sm text-navy placeholder:text-navy/50 focus:outline-none focus:ring-2 focus:ring-brand-500"
                            />
                            <Button
                              size="sm"
                              variant="danger"
                              disabled={!declineReason.trim() || busy}
                              loading={busy && resolveCr.variables?.action === "DECLINE"}
                              onClick={() => handleResolve(cr, "DECLINE", declineReason.trim())}
                            >
                              Decline
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setDeclineTargetId(null);
                                setDeclineReason("");
                              }}
                            >
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              disabled={busy}
                              loading={busy && resolveCr.variables?.action === "APPROVE_AT_STOP"}
                              onClick={() => handleResolve(cr, "APPROVE_AT_STOP")}
                            >
                              Approve at stop
                            </Button>
                            {canNextDelivery && (
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={busy}
                                loading={
                                  busy && resolveCr.variables?.action === "APPROVE_NEXT_DELIVERY"
                                }
                                onClick={() => handleResolve(cr, "APPROVE_NEXT_DELIVERY")}
                              >
                                Approve as next delivery
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="danger"
                              disabled={busy}
                              onClick={() => {
                                setDeclineTargetId(cr.id);
                                setDeclineReason("");
                              }}
                            >
                              Decline…
                            </Button>
                          </div>
                        ))}
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          {/* Notes */}
          {order.notes && !isEditing && (
            <Card title="Order notes">
              <div className="flex items-start gap-3">
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-navy/70" />
                <p className="text-sm text-navy/80 whitespace-pre-line">{order.notes}</p>
              </div>
            </Card>
          )}
        </div>

        {/* ── Sidebar ── */}
        <div className="space-y-4">
          {/* Customer info */}
          <div className="rounded-lg bg-white p-6 shadow-card">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-base font-semibold text-navy">Customer</h3>
              <Link
                href={`/customers/${order.customerId}`}
                className="text-xs font-medium text-brand-500 hover:underline"
              >
                View profile
              </Link>
            </div>
            <div className="flex items-start gap-2">
              <User className="mt-0.5 h-4 w-4 shrink-0 text-navy/40" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-navy">
                  {order.customer?.businessName ?? "—"}
                </p>
                {(order.customer?.contactName ||
                  order.customer?.mobile ||
                  order.customer?.phone) && (
                  <p className="mt-0.5 text-xs text-navy/70">
                    {[order.customer?.contactName, order.customer?.mobile || order.customer?.phone]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* M8: a carrier (SHIP) order shows its Shipment card above Summary, where the ship step is found. */}
          {shipFirst && shipmentSection}

          {/* Order summary */}
          <Card title="Summary">
            <dl className="space-y-2.5 text-sm">
              {access.fulfillmentPath &&
                (staffFulfilment.choice ||
                  fulfilRowPinned ||
                  !(staffFulfilment.formMethods as string[]).includes(order.fulfillPath)) && (
                  <OrderFulfilmentRow
                    orderId={order.id}
                    fulfillPath={order.fulfillPath}
                    locked={fulfillPathLocked}
                    offered={staffFulfilment.formMethods}
                    onLeavePickup={setPendingPath}
                  />
                )}
              {order.orderDate && (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-navy/70">Order date</dt>
                  <dd className="font-medium text-navy">{formatDateOnly(order.orderDate)}</dd>
                </div>
              )}
              {hasSalesAgents && (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-navy/70">Commission</dt>
                  <dd className="flex items-center gap-2 font-medium text-navy">
                    {order.commissionRatePct == null
                      ? "Default"
                      : Number(order.commissionRatePct) === 0
                        ? "Exempt (0%)"
                        : `${Number(order.commissionRatePct)}% (override)`}
                    {isStaff && (
                      <button
                        type="button"
                        className="text-xs font-medium text-brand-700 hover:underline"
                        onClick={() => setCommissionEditOpen(true)}
                      >
                        Edit
                      </button>
                    )}
                  </dd>
                </div>
              )}
              {order.requestedDeliveryDate && (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-navy/70">Delivery date</dt>
                  <dd className="font-medium text-navy">
                    {formatDateOnly(order.requestedDeliveryDate)}
                  </dd>
                </div>
              )}
              <div className="flex items-center justify-between gap-3">
                <dt className="text-navy/70">Line items</dt>
                <dd className="mono font-medium text-navy">{summaryLineItems.length}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-navy/70">Total quantity</dt>
                <dd className="mono font-medium text-navy">
                  {summarizeQtyByUnit(summaryLineItems)}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-navy/70">Subtotal</dt>
                <dd className="money text-navy">{formatMoney(order.subtotal)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-navy/70">Tax</dt>
                <dd className="money text-navy">{formatMoney(order.tax)}</dd>
              </div>
              {orderCategoryTax > 0 && (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-navy/70">Regulated tax</dt>
                  <dd className="money text-navy">{formatMoney(orderCategoryTax)}</dd>
                </div>
              )}
              {shippingFee > 0 && (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-navy/70">Shipping</dt>
                  <dd className="money text-navy">{formatMoney(shippingFee)}</dd>
                </div>
              )}
              <div className="flex items-center justify-between gap-3 border-t border-surface-border pt-2.5">
                <dt className="font-semibold text-navy">
                  {isEditing ? "Saved total" : "Order total"}
                </dt>
                <dd className="money text-[15px] font-semibold text-navy">{formatMoney(total)}</dd>
              </div>
            </dl>

            <AppliedCreditsPanel order={order} role={user?.role} />
          </Card>

          {/* Returns on this order (#2406) — server figures only, never the quote's. */}
          <OrderReturnsPanel orderId={order.id} />

          {!shipFirst && shipmentSection}

          {/* Invoice card — show for any non-draft, non-cancelled order so the operator
              can split into multiple invoices any time after the order is confirmed. */}
          {localStatus !== "DRAFT" && localStatus !== "CANCELLED" && (
            <Card title={`Invoice${((order as any).invoices?.length ?? 0) > 1 ? "s" : ""}`}>
              {/* r4 F07: always mounted (empty), so the sentence is read out when it appears. */}
              <p
                role="status"
                className={
                  invoiceNotice.message
                    ? "mb-3 rounded-md bg-surface-raised px-3 py-2 text-xs text-navy"
                    : undefined
                }
              >
                {invoiceNotice.message}
              </p>
              {(order as any).invoices?.length > 0 && (
                <div className="space-y-3">
                  {(() => {
                    // Warn when this fully-invoiced order's total no longer matches
                    // the sum of its non-void invoices (mirrors the popup note). "Fully
                    // invoiced" = no line has qty left to bill, so a partial split
                    // (which legitimately bills less) never trips the warning.
                    const nonVoid = ((order as any).invoices as any[]).filter(
                      (i) => i.status !== "VOID",
                    );
                    const invoicedTotal = nonVoid.reduce((s, i) => s + Number(i.total), 0);
                    const noRemaining = !((order.lineItems ?? []) as any[]).some(
                      (li) =>
                        li.status !== "CANCELLED" &&
                        Number(li.qty) - Number(li.invoicedQty ?? 0) > 0.001,
                    );
                    const fullyInvoiced = nonVoid.length > 0 && noRemaining;
                    return fullyInvoiced ? (
                      <DivergenceNote
                        orderTotal={Number(order.total)}
                        invoicedTotal={invoicedTotal}
                      />
                    ) : null;
                  })()}
                  {(order as any).invoices.map((inv: any) => (
                    <div key={inv.id} className="space-y-1">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-brand-500" />
                        <span
                          ref={invoiceNotice.focusRef(inv.invoiceNumber)}
                          tabIndex={-1}
                          className="mono rounded text-sm font-medium text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                        >
                          {inv.invoiceNumber}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge status={inv.status as BadgeStatus} />
                        {inv.dueDate && (
                          <span className="text-xs text-navy/70">
                            Due {fmtCalendarDate(inv.dueDate)}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => setPreviewInvoiceId(inv.id)}
                          className="text-xs font-medium text-brand-500 hover:underline"
                        >
                          Preview
                        </button>
                        <Link
                          href={`/invoices/${inv.id}`}
                          className="text-xs text-navy/60 hover:underline"
                        >
                          Open →
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {(() => {
                const items = (order.lineItems ?? []) as any[];
                const hasRemaining = items.some(
                  (li) => Number(li.qty) - Number((li as any).invoicedQty ?? 0) > 0.001,
                );
                const hasNoInvoiceYet = !((order as any).invoices?.length > 0);
                if (!hasRemaining && !hasNoInvoiceYet) return null;
                // B1134: a customer may read the invoice list above, but not bill the order.
                if (!access.invoiceActions) {
                  return hasNoInvoiceYet ? (
                    <p className="mt-3 text-xs text-navy/70">
                      No invoice has been generated for this order.
                    </p>
                  ) : null;
                }
                // apple-ux r3 Q27: an invoice made now bills the SAVED lines, not the edit in front of the
                // person. The two actions are held (disabled, with the reason as text they point at)
                // until the edit is saved or cancelled; a hidden or merely quiet button would still
                // invite the click, and an invoice cannot be taken back with Undo.
                const invoiceHold = isEditing ? "invoice-edit-hold" : undefined;
                return (
                  <div className="mt-3 space-y-2 border-t border-surface-border pt-3">
                    {isEditing && (
                      <p id="invoice-edit-hold" className="text-xs text-navy/70">
                        Save your changes first, then invoice this order.
                      </p>
                    )}
                    {hasNoInvoiceYet && (
                      <>
                        <p className="text-xs text-navy/70">
                          No invoice has been generated for this order.
                        </p>
                        <Button
                          size="sm"
                          // One filled primary leads the page: while PENDING that is Confirm Order
                          // (apple-ux r3 Q16), so invoicing is secondary until the order is confirmed.
                          variant={localStatus === "PENDING" || isEditing ? "secondary" : "primary"}
                          className="w-full justify-center"
                          leftIcon={<FileText className="h-4 w-4" />}
                          disabled={isEditing}
                          aria-describedby={invoiceHold}
                          loading={createInvoiceFromOrder.isPending}
                          onClick={() => {
                            // The invoice-time backstop can 409 on an expired/newly-added
                            // regulated line — route it into the license guard + retry.
                            const invoiceNow = () =>
                              createInvoiceFromOrder.mutate(order.id, {
                                onSuccess: (made) => invoiceNotice.announce(made),
                                onError: guardError(() => invoiceNow()),
                              });
                            invoiceNow();
                          }}
                        >
                          Generate Invoice (full order)
                        </Button>
                      </>
                    )}
                    {hasRemaining && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={isEditing}
                        aria-describedby={invoiceHold}
                        onClick={() => setSplitInvoiceOpen(true)}
                      >
                        Split into invoice…
                      </Button>
                    )}
                  </div>
                );
              })()}
            </Card>
          )}
        </div>
      </div>

      {/* Split-invoice modal: operator picks per-item qty + due date, and we POST to
          /invoices/from-order/:orderId/partial. Each call increments invoicedQty. */}
      <SplitInvoiceModal
        isOpen={splitInvoiceOpen}
        onClose={() => setSplitInvoiceOpen(false)}
        orderId={order.id}
        orderNumber={order.orderNumber ?? null}
        // One mapper for every caller (stored subtotal + box split + free units): the preview
        // prorates the stored money exactly as the server bills the split, never qty x unitPrice.
        items={(order.lineItems ?? []).map((li: any) =>
          toSplitInvoiceLine(li, orderLineName(li) ?? "Custom item"),
        )}
      />

      <InvoicePreviewModal
        open={previewInvoiceId != null}
        onClose={() => setPreviewInvoiceId(null)}
        invoiceId={previewInvoiceId ?? ""}
        orderTotal={Number(order.total)}
      />

      {leaveGuard.dialog}

      {/* Cancel confirmation */}
      <ConfirmDialog
        open={showCancelConfirm}
        onClose={() => setShowCancelConfirm(false)}
        onConfirm={confirmCancel}
        title={cancelCopy.title}
        description={
          cancelImpact.isLoading
            ? "Checking this order's invoices and credits…"
            : (cancelCopy.blockedReason ??
              [`Order ${order.orderNumber} will be marked as cancelled.`, ...cancelCopy.lines].join(
                " ",
              ))
        }
        confirmLabel={cancelCopy.confirmLabel ? "Yes, cancel order" : "Close"}
        variant="danger"
        loading={updateStatus.isPending || cancelOrder.isPending || cancelImpact.isLoading}
      />

      {access.staff && order.fulfillPath === "PICKUP" && (
        <PickupHandOverDialog
          order={order}
          open={pickupOpen}
          onClose={() => setPickupOpen(false)}
        />
      )}
      {access.staff && (
        <CompleteAtCounterDialog
          order={order}
          open={completeOpen}
          onClose={() => setCompleteOpen(false)}
        />
      )}
      <FulfillPathMoveConfirm
        open={pendingPath !== null}
        path={pendingPath}
        onClose={() => setPendingPath(null)}
        loading={patchFulfillPath.isPending}
        onConfirm={() => {
          if (pendingPath) applyFulfillPath(pendingPath);
          setPendingPath(null);
        }}
      />

      <UnmarkShippedConfirm
        open={showUnmarkConfirm}
        onClose={() => setShowUnmarkConfirm(false)}
        onConfirm={() => {
          setShowUnmarkConfirm(false);
          setDemoteTarget("CONFIRMED");
        }}
      />

      {/* Demote reason modal */}
      <DemoteReasonModal
        open={!!demoteTarget}
        onClose={() => setDemoteTarget(null)}
        onConfirm={handleDemote}
        loading={updateStatus.isPending || cancelOrder.isPending}
        targetStatus={demoteTarget ?? ""}
        fulfillPath={order?.fulfillPath}
      />

      {/* Send invoice modal — shown after marking order as delivered */}
      {invoiceModal && (
        <SendInvoiceModal data={invoiceModal} onClose={() => setInvoiceModal(null)} />
      )}

      {/* Commission rate override — staff + sales_agents addon only */}
      {hasSalesAgents && isStaff && (
        <CommissionEditModal
          open={commissionEditOpen}
          onClose={() => setCommissionEditOpen(false)}
          orderId={order.id}
          currentValue={order.commissionRatePct == null ? null : Number(order.commissionRatePct)}
        />
      )}

      {/* License guard (W6b): an edit/promote hit a 409 REGULATED_AUTH_REQUIRED.
          Lines are removed via the edit UI here, so the remove exit is omitted. */}
      <BlockedLinesDialog lines={restrictedBlock} onClose={() => setRestrictedBlock(null)} />
      {rw.dialog}
      {licenseBlock && order && (
        <LicenseGuardModal
          open
          customerId={order.customerId}
          orderId={order.id}
          blocked={licenseBlock}
          onResolved={() => {
            const retry = licenseRetryRef.current;
            setLicenseBlock(null);
            retry?.();
          }}
          onClose={() => setLicenseBlock(null)}
        />
      )}
      <CreditLimitGuardDialog
        info={creditBlock}
        customerId={order?.customerId}
        onClose={() => setCreditBlock(null)}
      />
    </div>
  );
}
