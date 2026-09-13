import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useEffect, useRef, useState } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill, SegmentedControl } from "@routeflow/ui/mobile/ios";
import { useAdminInvoice, useAdminInvoices } from "../../../../lib/api/admin";
import {
  useDeleteInvoice,
  useDuplicateInvoice,
  useInvoicePdf,
  type InvoicePdfVariant,
  useReopenInvoice,
  useRevertInvoiceToDraft,
  useSendInvoice,
  useSendInvoiceReminder,
  useUnvoidInvoice,
  useUpdateInvoice,
  useUpdateInvoiceShipment,
  useVoidInvoice,
} from "../../../../lib/api/invoices";
import {
  useApplyCreditNote,
  useCreditNotes,
  useUnapplyCreditNote,
} from "../../../../lib/api/credit-notes";
import { useApplyAdvancePayment, useCustomerAdvancePayments } from "../../../../lib/api/customers";
import { useGetPaymentImageUrl } from "../../../../lib/api/payments";
import { deriveInvoiceVariant } from "../../../../lib/invoice-pdf-variant";
import { fmtCalendarDate } from "../../../../lib/format-date";
import { isInternalEmail } from "../../../../lib/internal-email";
import {
  canRecordPayment,
  canSendInvoiceNow,
  canWriteOff,
  invoiceActionFlags,
  isPaymentEditable,
  isPendingOrderMirror,
} from "../../../../lib/invoices-logic";
import { isCreditOpenForApply, openCreditBalance } from "../../../../lib/credit-notes-logic";
import { siblingInvoicesOf } from "../../../../lib/invoice-siblings";
import { showToast } from "../../../../lib/toast";
import { alertInfo, confirm, chooseAction } from "../../../../lib/confirm";
import { formatQtySplit } from "@routeflow/pricing";
import { freeUnitsLabel } from "../../../../lib/buyer-cart-logic";
import { ACTIVATION_BUDGET_MS, sharePdf } from "../../../../lib/share-pdf";
import { printPdf } from "../../../../lib/print-pdf";
import {
  nextPdfSharePhase,
  smtpFallbackNotice,
  type PdfSharePhase,
} from "../../../../lib/invoice-send-logic";
import { ShipmentSection, ShipmentEditModal } from "../../../../components/ShipmentSection";

// admin.ts's AdminInvoice.payments doesn't declare the image fields even
// though the API already returns them (findOne's `payments` include has no
// `select` narrowing on the payment row itself) — same "already returned,
// just untyped" situation as orderId/invoiceGroupId (P10-REG-C). Widen
// locally rather than touching admin.ts's canonical type (out of scope here).
type PaymentImageFields = { imageKey?: string | null };

// Same situation for MSRP: the server snapshots `msrp` onto every InvoiceItem
// (display-only, per PIECE) and findOne's `items` include returns it already,
// but admin.ts's AdminInvoice.items doesn't declare it yet. Widen locally
// rather than touching admin.ts (out of scope for this change).
type ItemMsrpField = { msrp?: number | null };

function fmtCurrency(n: number | string | undefined): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

// admin.ts's AdminInvoice doesn't declare `paymentTermsLabel` yet even though
// the server now persists it on every Invoice and GET /invoices/:id returns
// it already. Widen locally rather than touching admin.ts's canonical type
// (out of scope for this change — same pattern used elsewhere for msrp).
type InvoiceTermsLabelField = { paymentTermsLabel?: string | null };

function statusPill(status: string) {
  switch (status) {
    case "DRAFT":
      return { variant: "gray" as const, label: "Draft" };
    case "SENT":
      return { variant: "brand" as const, label: "Sent" };
    case "PARTIAL":
      return { variant: "orange" as const, label: "Partial" };
    case "PAID":
      return { variant: "green" as const, label: "Paid" };
    case "OVERDUE":
      return { variant: "red" as const, label: "Overdue" };
    case "VOID":
      return { variant: "gray" as const, label: "Voided" };
    default:
      return { variant: "gray" as const, label: status };
  }
}

export default function InvoiceDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  // RF-203: defensive guard — if somehow "create" reaches this screen (e.g. the
  // static create.tsx was not matched), redirect to the proper create form
  // instead of firing a doomed /invoices/create API call and spinning forever.
  const isCreateAlias = id === "create" || id === "new";
  useEffect(() => {
    if (isCreateAlias) router.replace("/(operator)/invoices/new");
  }, [isCreateAlias, router]);

  const { data: invoice, isLoading, refetch } = useAdminInvoice(isCreateAlias ? "" : (id ?? ""));
  // REG-5: sibling invoices from the same regulated sale-split. No dedicated
  // "list siblings" endpoint exists — GET /invoices already returns
  // invoiceGroupId as a raw scalar on every row (verified: findAll's `include`
  // doesn't restrict scalars), so a narrow customerId + same-issue-date lookup
  // via the EXISTING useAdminInvoices hook is enough; zero new endpoints. Called
  // unconditionally (mirrors the "call the hook unconditionally, gate only the
  // display" convention established by P10-REG-B) — customerId/dateFrom/dateTo
  // are undefined for one render until `invoice` loads, which just widens that
  // one query harmlessly; the queryKey changes once real params land.
  const issueDay = invoice?.issueDate ? invoice.issueDate.slice(0, 10) : undefined;
  const { data: siblingCandidates } = useAdminInvoices({
    customerId: invoice?.customer?.id,
    dateFrom: issueDay,
    dateTo: issueDay,
    limit: 25,
  });
  const siblingInvoices = siblingInvoicesOf(siblingCandidates?.data ?? [], invoice);
  const sendMut = useSendInvoice();
  const voidMut = useVoidInvoice();
  const unapplyCredit = useUnapplyCreditNote();
  const deleteMut = useDeleteInvoice();
  const pdfMut = useInvoicePdf();
  const printPdfMut = useInvoicePdf();
  const [printing, setPrinting] = useState(false);
  const updateMut = useUpdateInvoice();
  const shipmentMut = useUpdateInvoiceShipment();
  const getImageUrlMut = useGetPaymentImageUrl();
  const reminderMut = useSendInvoiceReminder();
  const duplicateMut = useDuplicateInvoice();
  const reopenMut = useReopenInvoice();
  const unvoidMut = useUnvoidInvoice();
  const revertMut = useRevertInvoiceToDraft();
  const [loadingReceiptId, setLoadingReceiptId] = useState<string | null>(null);
  const [dueDateModal, setDueDateModal] = useState(false);
  const [dueDateInput, setDueDateInput] = useState("");
  const [shipmentModal, setShipmentModal] = useState(false);
  const [creditSheetOpen, setCreditSheetOpen] = useState(false);
  const [advanceSheetOpen, setAdvanceSheetOpen] = useState(false);
  // Draft/Final PDF stage — null means follow the smart default (deriveInvoiceVariant).
  const [pdfVariantOverride, setPdfVariantOverride] = useState<InvoicePdfVariant | null>(null);
  // The Share tile's prepare → (maybe) tap-again → share dance against
  // ACTIVATION_BUDGET_MS — see share-pdf.ts. The ref holds the prepared
  // sharePdf() args so a "PDF ready — tap to share" retap shares
  // synchronously instead of re-fetching the signed url. The variant is
  // stored WITH them: a prepared call belongs to the PDF stage it was
  // fetched for, so a retap after a stage flip must re-fetch rather than
  // share the other stage's file.
  const [pdfSharePhase, setPdfSharePhase] = useState<PdfSharePhase>("idle");
  const pdfShareRef = useRef<{
    variant: InvoicePdfVariant;
    opts: Parameters<typeof sharePdf>[0];
  } | null>(null);

  if (isLoading || !invoice) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Invoice" leading={<NavBackButton onPress={() => router.back()} />} />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  const s = statusPill(invoice.status);
  const balance = invoice.balanceDue ?? invoice.total;
  const paymentTermsLabel = (invoice as typeof invoice & InvoiceTermsLabelField).paymentTermsLabel;
  const isVoid = invoice.status === "VOID";
  // B4: mirrors web's allow-list exactly. The server only rejects VOID, so a
  // bare "not paid, not void" gate used to offer this on DRAFT/WRITTEN_OFF —
  // the POST succeeds, but recomputeStatus treats DRAFT as terminal, so a
  // fully-paid invoice stays DRAFT and drops out of AR/aging.
  const canRecord = canRecordPayment(invoice.status);
  // Wave 2 action gating — pure mirrors of the server guards (invoices-logic).
  const flags = invoiceActionFlags({
    status: invoice.status,
    paymentCount: invoice.payments?.length ?? 0,
    isOrderLinked: invoice.orderId != null,
  });
  // Computed BEFORE canSend: a pending mirror is locked server-side, so Send has
  // to know about it or it offers a guaranteed 400.
  const pendingMirror = isPendingOrderMirror({
    orderId: invoice.orderId,
    deliveryBatchId: invoice.deliveryBatchId,
    orderStatus: invoice.order?.status,
  });
  const canSend = canSendInvoiceNow(invoice.status, pendingMirror);
  // Draft/Final PDF stage (mirrors web): smart default per stage, operator-overridable
  // via the toggle. Governs BOTH Share and Send.
  const defaultPdfVariant = deriveInvoiceVariant(invoice);
  const pdfVariant: InvoicePdfVariant = pdfVariantOverride ?? defaultPdfVariant;

  const handleSend = () => {
    if (!id) return;
    // B6: the tile stays visually tappable for one frame around a mutation
    // settling; without this guard a fast double-tap fires two send emails.
    if (sendMut.isPending) return;
    // Import sentinels (`…@imported.local` / `…@placeholder.local`) aren't real
    // inboxes — route to the same no-email sheet (Mark as Sent / Share PDF) instead
    // of a send that can only fail. Mirrors web invoice-detail handleSend.
    const rawEmail = invoice.customer?.email;
    const customerEmail = rawEmail && !isInternalEmail(rawEmail) ? rawEmail : undefined;
    if (!customerEmail) {
      chooseAction(
        "No email on file",
        `${invoice.customer?.businessName ?? "This customer"} has no email address saved. View the PDF to send it manually, or mark it as sent to update the status.`,
        [
          {
            label: "Mark as Sent",
            style: "default",
            onPress: () =>
              sendMut.mutate(
                { id },
                {
                  onSuccess: () => {
                    showToast("Invoice marked as sent");
                    refetch();
                  },
                  onError: (e: any) =>
                    showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
                },
              ),
          },
          {
            label: `Share ${pdfVariant} PDF`,
            style: "default",
            onPress: () => handlePdf(pdfVariant),
          },
          { label: "Cancel", style: "cancel" },
        ],
      );
      return;
    }
    sendMut.mutate(
      { id, email: customerEmail, variant: pdfVariant },
      {
        onSuccess: (res) => {
          const label = `${pdfVariant === "draft" ? "Draft" : "Final"} invoice sent`;
          const notice = "warning" in res ? smtpFallbackNotice(res) : null;
          // The send succeeded (Resend rescued the tenant's failing SMTP), so this
          // is a disclosure, not an error — but it can't ride a toast: showToast is
          // nowrap/2.2s and a no-op on iOS, and a dead tenant mailbox has to be
          // read. Plain successes keep the toast.
          if (notice) alertInfo(label, notice);
          else showToast(label);
          refetch();
        },
        onError: (e: any) => {
          const code = e?.response?.data?.code;
          const msg = e?.response?.data?.message ?? e?.message ?? "Try again.";
          if (code === "EMAIL_SEND_FAILED") {
            // Invoice is still DRAFT (R5 honesty). Offer Mark as Sent so a broken
            // mail transport can't leave it stuck. Mirrors the web recovery modal.
            chooseAction(
              "Email failed — invoice not sent",
              `${msg} You can mark it as sent and share the PDF another way.`,
              [
                {
                  label: "Mark as Sent",
                  style: "default",
                  onPress: () =>
                    sendMut.mutate(
                      { id },
                      {
                        onSuccess: () => {
                          showToast("Invoice marked as sent");
                          refetch();
                        },
                        onError: (err: any) =>
                          showToast(err?.response?.data?.message ?? err?.message ?? "Try again."),
                      },
                    ),
                },
                { label: "Cancel", style: "cancel" },
              ],
            );
            return;
          }
          showToast(msg);
        },
      },
    );
  };

  /** Give an applied credit back to its note. Mirrors web's "Remove credit". */
  const handleUnapplyCredit = (creditNoteId: string, amount: unknown) => {
    if (!id) return;
    confirm(
      "Remove this credit?",
      `$${Number(amount).toFixed(2)} will be un-applied from ${invoice.invoiceNumber} and restored to the credit note's balance.`,
      () =>
        unapplyCredit.mutate(
          { id: creditNoteId, invoiceId: id },
          {
            onSuccess: () => {
              showToast("Credit returned to its note");
              refetch();
            },
            onError: (e: any) =>
              showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
          },
        ),
      { confirmText: "Remove", destructive: true },
    );
  };

  const handleVoid = () => {
    if (!id) return;
    confirm(
      "Void invoice?",
      `${invoice.invoiceNumber} will be marked void.`,
      () =>
        voidMut.mutate(id, {
          onSuccess: () => {
            showToast("Invoice voided");
            refetch();
          },
          onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
        }),
      { confirmText: "Void", destructive: true },
    );
  };

  /**
   * Permanently delete the invoice (server enforces no-payments). Reachable
   * only from the VOID state per the user's policy: "after voiding an invoice,
   * it should be able to delete them from mobile too." Operator-only — there
   * is no customer-facing delete affordance.
   */
  const handleDelete = () => {
    if (!id) return;
    confirm(
      "Delete invoice?",
      `${invoice.invoiceNumber} will be permanently removed. This cannot be undone.`,
      () =>
        deleteMut.mutate(id, {
          onSuccess: () => {
            showToast("Invoice deleted");
            router.back();
          },
          onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
        }),
      { confirmText: "Delete", destructive: true },
    );
  };

  const handleSaveShipment = (carrier: string, trackingNumber: string) => {
    if (!id) return;
    shipmentMut.mutate(
      { id, shippingCarrier: carrier, shippingTrackingNumber: trackingNumber },
      {
        onSuccess: () => {
          showToast(carrier || trackingNumber ? "Shipment saved" : "Shipment cleared");
          setShipmentModal(false);
          refetch();
        },
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  /**
   * Share the invoice PDF, respecting `navigator.share()`'s transient
   * activation window (see share-pdf.ts). THE TRAP: never `await` a fetch
   * between the tap and calling `sharePdf` — that includes the presigned-url
   * mutation below, so instead of awaiting it first, this measures how much
   * of ACTIVATION_BUDGET_MS the mutation spent and hands `sharePdf` only
   * what's left. A second tap (the ref already holds a prepared call from a
   * first tap that ran out of budget) skips the mutation and re-tries
   * `sharePdf` with a fresh full budget — this tap's own activation — but
   * ONLY when it's for the same PDF stage; after a Draft/Final flip the
   * cached call is for the wrong stage, so that tap prepares afresh.
   */
  const handlePdf = (variant: InvoicePdfVariant) => {
    if (!id) return;

    const cached = pdfShareRef.current;
    if (cached && cached.variant === variant) {
      pdfShareRef.current = null;
      setPdfSharePhase("preparing");
      sharePdf({ ...cached.opts, budgetMs: ACTIVATION_BUDGET_MS })
        .then((outcome) => {
          if (outcome === "ready-await-tap") pdfShareRef.current = cached;
          setPdfSharePhase(nextPdfSharePhase(outcome));
        })
        .catch((e: any) => {
          setPdfSharePhase("idle");
          showToast(e?.message ?? "Couldn't share the PDF.");
        });
      return;
    }

    const filename = `${invoice.invoiceNumber || "invoice"}-${variant}.pdf`;
    const dialogTitle = `${variant === "draft" ? "Draft" : "Final"} invoice ${
      invoice.invoiceNumber ?? ""
    }`.trim();
    const startedAt = Date.now();
    setPdfSharePhase("preparing");
    pdfMut.mutate(
      { id, variant },
      {
        onSuccess: async (data) => {
          if (!data?.url) {
            setPdfSharePhase("idle");
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
            budgetMs: remaining,
            retapHandled: true,
          };
          try {
            const outcome = await sharePdf(opts);
            if (outcome === "ready-await-tap") pdfShareRef.current = { variant, opts };
            setPdfSharePhase(nextPdfSharePhase(outcome));
          } catch (e: any) {
            setPdfSharePhase("idle");
            showToast(e?.message ?? "Couldn't share the PDF.");
          }
        },
        onError: (e: any) => {
          setPdfSharePhase("idle");
          showToast(e?.response?.data?.message ?? e?.message ?? "Try again.");
        },
      },
    );
  };

  // Print tile — own mutation + own `printing` state so a tap here never
  // races the Share tile's `pdfSharePhase`/`pdfMut` (mirrors handlePdf above,
  // minus the retap-dance: printPdf itself owns web vs native routing).
  const handlePrint = (variant: InvoicePdfVariant) => {
    if (!id) return;
    const filename = `${invoice.invoiceNumber || "invoice"}-${variant}.pdf`;
    setPrinting(true);
    printPdfMut.mutate(
      { id, variant },
      {
        onSuccess: async (data) => {
          if (!data?.url) {
            setPrinting(false);
            showToast("PDF is still generating, try again in a moment.");
            return;
          }
          try {
            await printPdf({ url: data.url, filename });
          } finally {
            setPrinting(false);
          }
        },
        onError: () => {
          // R6.3 (pack.md 45-46): any fetch/download failure on the print path
          // shows this exact toast, matching classifyPrintError's download-stage text.
          setPrinting(false);
          showToast("Couldn't print the PDF.");
        },
      },
    );
  };

  const handleViewReceipt = (paymentId: string) => {
    setLoadingReceiptId(paymentId);
    getImageUrlMut.mutate(paymentId, {
      onSuccess: (data) => {
        setLoadingReceiptId(null);
        Linking.openURL(data.url).catch(() => showToast("Couldn't open the receipt."));
      },
      onError: (e: any) => {
        setLoadingReceiptId(null);
        showToast(e?.response?.data?.message ?? e?.message ?? "Couldn't load the receipt.");
      },
    });
  };

  const handleReminder = () => {
    if (!id) return;
    // B6: same double-tap guard as handleSend — a fast second tap while the
    // reminder mutation is in flight would fire a second reminder email.
    if (reminderMut.isPending) return;
    const rawReminderEmail = invoice.customer?.email;
    const email =
      rawReminderEmail && !isInternalEmail(rawReminderEmail) ? rawReminderEmail : undefined;
    if (!email) {
      // Same pre-check as web: don't burn the round-trip on a guaranteed 400.
      // Import sentinels count as "no email" — they aren't real inboxes.
      showToast("No email on file — add one to this customer first.");
      return;
    }
    reminderMut.mutate(
      { id, email },
      {
        onSuccess: (res) => {
          // Same disclosure as the send path — otherwise whether the operator
          // hears about their broken mailbox depends on which button they pressed.
          const notice = smtpFallbackNotice(res);
          if (notice) alertInfo("Reminder sent", notice);
          else showToast(`Reminder emailed to ${res.sentTo}`);
        },
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  const handleDuplicate = () => {
    if (!id) return;
    // Real POST /invoices/:id/duplicate — preserves the box split + per-line
    // discount/taxRate (web hand-rolls a lossy re-create here; deliberately
    // not mirrored, RF-011).
    duplicateMut.mutate(id, {
      onSuccess: (inv) => {
        showToast(`New draft ${inv.invoiceNumber} created`);
        router.push(`/(operator)/invoices/${inv.id}`);
      },
      onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
    });
  };

  const handleRevert = () => {
    if (!id) return;
    confirm(
      "Revert to draft?",
      `${invoice.invoiceNumber} goes back to Draft so it can be edited; its Sent status is cleared.`,
      () =>
        revertMut.mutate(id, {
          onSuccess: () => showToast("Invoice reverted to draft"),
          onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
        }),
      { confirmText: "Revert" },
    );
  };

  const handleReopen = () => {
    if (!id) return;
    confirm(
      "Reopen invoice?",
      `${invoice.invoiceNumber} returns to Draft. Its recorded payments stay attached.`,
      () =>
        reopenMut.mutate(id, {
          onSuccess: () => showToast("Invoice reopened"),
          onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
        }),
      { confirmText: "Reopen" },
    );
  };

  const handleUnvoid = () => {
    if (!id) return;
    confirm(
      "Unvoid invoice?",
      `${invoice.invoiceNumber} returns to Draft and re-claims its billed quantities on the source order.`,
      () =>
        unvoidMut.mutate(id, {
          onSuccess: () => showToast("Invoice unvoided — now in Draft"),
          onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
        }),
      { confirmText: "Unvoid" },
    );
  };

  // Lifecycle flips live one tap behind a single More tile — four extra tiles
  // for rare transitions would drown the money actions (web keeps these in its
  // "..." menu for the same reason).
  const moreActions = [
    ...(flags.canDuplicate ? [{ label: "Duplicate", onPress: handleDuplicate }] : []),
    ...(flags.canRevertToDraft ? [{ label: "Revert to draft", onPress: handleRevert }] : []),
    ...(flags.canReopen ? [{ label: "Reopen invoice", onPress: handleReopen }] : []),
    ...(flags.canUnvoid ? [{ label: "Unvoid", onPress: handleUnvoid }] : []),
  ];
  const handleMore = () =>
    chooseAction("More actions", invoice.invoiceNumber, [
      ...moreActions.map((a) => ({
        label: a.label,
        style: "default" as const,
        onPress: a.onPress,
      })),
      { label: "Cancel", style: "cancel" as const },
    ]);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={invoice.invoiceNumber}
        leading={<NavBackButton label="Invoices" onPress={() => router.back()} />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ padding: 16, gap: 14 }}>
          <View style={styles.card}>
            <Pill variant={s.variant} dot>
              {s.label}
            </Pill>
            <Text style={styles.customer}>{invoice.customer?.businessName ?? "Customer"}</Text>
            {invoice.subject?.trim() ? (
              <Text style={styles.headerMeta} numberOfLines={2}>
                {invoice.subject}
              </Text>
            ) : null}
            {invoice.referenceNumber?.trim() ? (
              <Text style={styles.headerMeta} numberOfLines={1}>
                Ref: {invoice.referenceNumber}
              </Text>
            ) : null}
            <Text style={styles.balance}>{fmtCurrency(balance)}</Text>
            <Text style={styles.balanceSub}>
              of {fmtCurrency(invoice.total)} · paid {fmtCurrency(invoice.paidAmount ?? 0)}
            </Text>
            {/* B421: confirmed but non-cash — reduces the balance but is never
                counted in "paid" above. Neutral styling, own line so a
                narrow screen never wraps this mid-figure. */}
            {Number(invoice.creditApplied ?? 0) > 0 ? (
              <Text style={styles.balanceSub}>
                Credits applied {fmtCurrency(invoice.creditApplied ?? 0)}
              </Text>
            ) : null}
            {Number(invoice.advanceApplied ?? 0) > 0 ? (
              <Text style={styles.balanceSub}>
                Advance applied {fmtCurrency(invoice.advanceApplied ?? 0)}
              </Text>
            ) : null}
            <Pressable
              style={styles.dueRow}
              onPress={() => {
                setDueDateInput(invoice.dueDate ? invoice.dueDate.slice(0, 10) : "");
                setDueDateModal(true);
              }}
              hitSlop={4}
            >
              <Text style={styles.due}>
                {invoice.dueDate ? `Due ${fmtCalendarDate(invoice.dueDate)}` : "Set due date"}
              </Text>
              <Ionicons name="pencil-outline" size={12} color={ios.label3} />
            </Pressable>
            {paymentTermsLabel ? (
              <Text style={styles.headerMeta}>Terms: {paymentTermsLabel}</Text>
            ) : null}
          </View>

          {siblingInvoices.length > 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Also billed on this order</Text>
              <Text style={styles.siblingHint}>
                This sale was split into {siblingInvoices.length + 1} invoices by regulated
                category.
              </Text>
              <View style={{ gap: 8, marginTop: 6 }}>
                {siblingInvoices.map((sib) => {
                  const sp = statusPill(sib.status);
                  return (
                    <Pressable
                      key={sib.id}
                      style={styles.siblingRow}
                      onPress={() => router.push(`/(operator)/invoices/${sib.id}`)}
                    >
                      <Text style={styles.siblingNumber} numberOfLines={1}>
                        {sib.invoiceNumber}
                      </Text>
                      <Pill variant={sp.variant} small>
                        {sp.label}
                      </Pill>
                      <Text style={styles.siblingTotal}>{fmtCurrency(sib.total)}</Text>
                      <Ionicons name="chevron-forward" size={14} color={ios.label3} />
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ) : null}

          {/* Draft/Final PDF stage — one toggle governs both Share and Send
              (mirrors the web invoice-detail). Smart-defaults per stage. */}
          <View style={styles.variantRow}>
            <Text style={styles.variantLabel}>PDF STAGE</Text>
            <View style={{ flex: 1 }}>
              <SegmentedControl
                items={["Draft", "Final"]}
                value={pdfVariant === "draft" ? "Draft" : "Final"}
                onChange={(v) => {
                  const next: InvoicePdfVariant = v === "Draft" ? "draft" : "final";
                  setPdfVariantOverride(next);
                  // "PDF ready — tap to share" belongs to the stage that was
                  // prepared; once the stage changes the next tap prepares
                  // afresh, so the tile must stop claiming otherwise.
                  if (next !== pdfVariant) setPdfSharePhase("idle");
                }}
              />
            </View>
          </View>

          {/* Says why Send and Edit are absent, rather than leaving the operator
              hunting for buttons the server would have rejected anyway. */}
          {pendingMirror ? (
            <View style={styles.mirrorHint}>
              <Ionicons name="information-circle-outline" size={16} color={ios.label2} />
              <Text style={styles.mirrorHintText}>
                This invoice mirrors its order — it unlocks for editing and sending once the order
                is delivered.
              </Text>
            </View>
          ) : null}

          {/* Action grid */}
          <View style={styles.actionsGrid}>
            {canRecord ? (
              <ActionTile
                icon="cash-outline"
                label="Record payment"
                onPress={() => router.push(`/(operator)/invoices/${id}/record-payment`)}
              />
            ) : null}
            {canSend ? (
              <ActionTile
                icon="paper-plane-outline"
                label={sendMut.isPending ? "Sending…" : "Send"}
                // B6: was tappable while pending — a fast double-tap fired two send emails.
                disabled={sendMut.isPending}
                onPress={handleSend}
              />
            ) : null}
            {flags.canEdit && !pendingMirror ? (
              <ActionTile
                icon="pencil-outline"
                label="Edit invoice"
                onPress={() => router.push(`/(operator)/invoices/${id}/edit`)}
              />
            ) : null}
            {/* A pending mirror is driven by its order, so send/edit both live
                there. Offer the way through instead of two missing tiles. */}
            {pendingMirror && invoice.orderId ? (
              <ActionTile
                icon="cube-outline"
                label="Open order"
                onPress={() => router.push(`/(operator)/orders/${invoice.orderId}` as any)}
              />
            ) : null}
            <ActionTile
              icon="share-outline"
              label={
                pdfSharePhase === "preparing"
                  ? "Preparing PDF…"
                  : pdfSharePhase === "ready"
                    ? "PDF ready — tap to share"
                    : `Share ${pdfVariant === "draft" ? "draft" : "final"}`
              }
              // A second tap while the presigned-url mutation is in flight
              // would fire a concurrent one; "ready" stays tappable — that
              // tap IS the share.
              disabled={pdfSharePhase === "preparing"}
              onPress={() => handlePdf(pdfVariant)}
            />
            <ActionTile
              icon="print-outline"
              label={
                printing ? "Preparing PDF…" : `Print ${pdfVariant === "draft" ? "draft" : "final"}`
              }
              disabled={printing}
              onPress={() => handlePrint(pdfVariant)}
            />
            {flags.canSendReminder ? (
              <ActionTile
                icon="alarm-outline"
                label={reminderMut.isPending ? "Sending…" : "Send reminder"}
                // B6: was tappable while pending — a fast double-tap fired two reminder emails.
                disabled={reminderMut.isPending}
                onPress={handleReminder}
              />
            ) : null}
            {flags.canApplyCredit ? (
              <ActionTile
                icon="pricetag-outline"
                label="Apply credit"
                onPress={() => setCreditSheetOpen(true)}
              />
            ) : null}
            {/* Apply-advance is narrower than apply-credit: the server's inline
                status recompute doesn't preserve DRAFT (customers.service
                applyAdvancePaymentToInvoice), so a draft would silently flip
                to SENT — gate to the post-send statuses only. */}
            {["SENT", "VIEWED", "PARTIAL", "OVERDUE"].includes(invoice.status) ? (
              <ActionTile
                icon="wallet-outline"
                label="Apply advance"
                onPress={() => setAdvanceSheetOpen(true)}
              />
            ) : null}
            {moreActions.length > 0 ? (
              <ActionTile icon="ellipsis-horizontal" label="More" onPress={handleMore} />
            ) : null}
            {canWriteOff(invoice.status) ? (
              <ActionTile
                icon="remove-circle-outline"
                label="Write off"
                tone="danger"
                onPress={() => router.push(`/(operator)/invoices/${id}/write-off`)}
              />
            ) : null}
            {!isVoid ? (
              <ActionTile icon="ban-outline" label="Void" tone="danger" onPress={handleVoid} />
            ) : (
              // Voided invoices can be deleted entirely (server still rejects
              // if payments exist). Mirrors the web's delete affordance.
              <ActionTile
                icon="trash-outline"
                label={deleteMut.isPending ? "Deleting…" : "Delete invoice"}
                tone="danger"
                onPress={handleDelete}
              />
            )}
          </View>

          {/* Items */}
          {invoice.items && invoice.items.length > 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Items</Text>
              {invoice.items.map((it, i) => {
                const itemMsrp = (it as typeof it & ItemMsrpField).msrp;
                return (
                  <View
                    key={it.id}
                    style={[
                      styles.itemRow,
                      i > 0 && {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: ios.separator,
                      },
                    ]}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.itemName} numberOfLines={1}>
                        {it.description}
                      </Text>
                      <Text style={styles.itemSub}>
                        {it.boxes != null || it.pieces != null
                          ? // Boxed line: unitPrice is the BOX price — "qty × price"
                            // would read as pieces × box-price (visually wrong).
                            `${formatQtySplit({ qty: it.qty, boxes: it.boxes, pieces: it.pieces })} @ ${fmtCurrency(it.unitPrice)}/box`
                          : `${it.qty} × ${fmtCurrency(it.unitPrice)}`}
                      </Text>
                      {/* Suggested retail price snapshot — per PIECE, display-only. */}
                      {itemMsrp != null ? (
                        <Text style={styles.itemMsrp}>MSRP {fmtCurrency(itemMsrp)}/pc</Text>
                      ) : null}
                      {/* BUY_N_GET_M: name the free units, or the reduced line
                          subtotal reads as a pricing error (web parity). */}
                      {freeUnitsLabel(it.promoFreeUnits) ? (
                        <Text style={styles.itemFreeLabel}>
                          {freeUnitsLabel(it.promoFreeUnits)}
                        </Text>
                      ) : null}
                      {Number(it.discount ?? 0) > 0 ? (
                        // The shown subtotal is already post-discount; this line
                        // explains why it's less than qty × price.
                        <Text style={styles.itemSub}>
                          −{fmtCurrency(it.discount ?? 0)} discount
                        </Text>
                      ) : null}
                      {it.notes?.trim() ? (
                        <Text style={[styles.itemSub, { fontStyle: "italic" }]} numberOfLines={2}>
                          {it.notes}
                        </Text>
                      ) : null}
                      {it.priceType === "MANUAL" &&
                      it.originalPrice != null &&
                      Number(it.unitPrice) > Number(it.originalPrice) ? (
                        <Text
                          style={{ color: ios.system.greenInk, fontSize: 12, fontWeight: "600" }}
                        >
                          Upsell
                        </Text>
                      ) : null}
                    </View>
                    <Text style={styles.itemTotal}>{fmtCurrency(it.subtotal)}</Text>
                  </View>
                );
              })}
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Subtotal</Text>
                <Text style={styles.totalValue}>{fmtCurrency(invoice.subtotal)}</Text>
              </View>
              {invoice.taxAmount ? (
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>Tax</Text>
                  <Text style={styles.totalValue}>{fmtCurrency(invoice.taxAmount)}</Text>
                </View>
              ) : null}
              {invoice.discount ? (
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>Discount</Text>
                  <Text style={styles.totalValue}>{fmtCurrency(invoice.discount)}</Text>
                </View>
              ) : null}
              {Number(invoice.shippingFee ?? 0) > 0 ? (
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>Shipping</Text>
                  <Text style={styles.totalValue}>{fmtCurrency(invoice.shippingFee)}</Text>
                </View>
              ) : null}
              <View style={[styles.totalRow, { borderTopWidth: 0 }]}>
                <Text style={styles.totalLabelMain}>Total</Text>
                <Text style={styles.totalValueMain}>{fmtCurrency(invoice.total)}</Text>
              </View>
            </View>
          ) : null}

          {/* Carrier shipment — editable on any non-void invoice, but only shown
              for carrier-shipped rows. The invoice payload doesn't carry the
              order's fulfillPath (admin.ts's AdminInvoice.order is status/
              orderNumber only — not widened here), so an order-linked invoice
              shows the section only once tracking exists — it's recorded on the
              ORDER, which mirrors carrier/tracking down to its invoices. A
              standalone invoice has no order to record it on, so it always keeps
              the section (mirrors web's invoice detail gate). */}
          {!isVoid &&
          (!invoice.orderId || invoice.shippingCarrier || invoice.shippingTrackingNumber) ? (
            <ShipmentSection shipment={invoice} onEdit={() => setShipmentModal(true)} />
          ) : null}

          {/* Payments */}
          {invoice.payments && invoice.payments.length > 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Payments</Text>
              {invoice.payments.map((p, i) => {
                const pay = p as typeof p & PaymentImageFields;
                return (
                  <View
                    key={p.id}
                    style={[
                      styles.payRow,
                      i > 0 && {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: ios.separator,
                      },
                    ]}
                  >
                    <View style={{ flex: 1 }}>
                      <View style={styles.payMethodRow}>
                        <Text style={styles.payMethod}>{p.method}</Text>
                        {/* F03/R2 (REG-B11) — mirrors web's DraftPaymentBadge. A DRAFT
                            payment is excluded from every CONFIRMED_PAYMENT sum on the
                            server, so balanceDue/paidAmount above ignore this row. Without
                            the badge the screen contradicts itself: a listed +$200 next to
                            an unmoved balance. Web carries the explanation in a tooltip;
                            there's no hover on a phone, so it's a meta line here. */}
                        {p.status === "DRAFT" ? (
                          <Pill variant="yellow" small>
                            Draft — unconfirmed
                          </Pill>
                        ) : null}
                      </View>
                      {p.status === "DRAFT" ? (
                        <Text style={styles.payMeta}>Not counted toward the balance due</Text>
                      ) : null}
                      <Text style={styles.payMeta}>
                        {new Date(p.paidAt ?? p.createdAt).toLocaleDateString()}
                      </Text>
                      {p.reference ? <Text style={styles.payMeta}>Ref: {p.reference}</Text> : null}
                      {p.notes ? <Text style={styles.payMeta}>{p.notes}</Text> : null}
                      {/* Credit-note reason via relation (read-time, never copied).
                          Gated on the RELATION, not on `reason` — a credit with no
                          reason used to render nothing at all, hiding its number. */}
                      {p.method === "CREDIT_NOTE" && p.creditNote ? (
                        <Text style={styles.payMeta}>
                          Credit {p.creditNote.creditNoteNumber}
                          {p.creditNote.reason ? ` — ${p.creditNote.reason}` : ""}
                        </Text>
                      ) : null}
                      {/* Reversing an applied credit was web-only: a phone operator
                          could apply one and then had no way to take it back. */}
                      {p.method === "CREDIT_NOTE" && p.creditNote && !isVoid ? (
                        <Pressable
                          style={styles.viewReceiptRow}
                          onPress={() => handleUnapplyCredit(p.creditNote!.id, p.amount)}
                          hitSlop={4}
                        >
                          <Ionicons name="arrow-undo-outline" size={13} color={ios.brand} />
                          <Text style={styles.viewReceiptText}>
                            {unapplyCredit.isPending ? "Removing…" : "Remove credit"}
                          </Text>
                        </Pressable>
                      ) : null}
                      {pay.imageKey ? (
                        <Pressable
                          style={styles.viewReceiptRow}
                          onPress={() => handleViewReceipt(p.id)}
                          hitSlop={4}
                        >
                          <Ionicons name="image-outline" size={13} color={ios.brand} />
                          <Text style={styles.viewReceiptText}>
                            {loadingReceiptId === p.id ? "Loading…" : "View receipt"}
                          </Text>
                        </Pressable>
                      ) : null}
                    </View>
                    <Text style={styles.payAmount}>+{fmtCurrency(p.amount)}</Text>
                    {isPaymentEditable(p.method, p.status, invoice.status) ? (
                      <Pressable
                        hitSlop={8}
                        style={styles.payEditBtn}
                        onPress={() =>
                          router.push(`/(operator)/invoices/${id}/payments/${p.id}/edit`)
                        }
                        accessibilityLabel="Edit payment"
                      >
                        <Ionicons name="pencil-outline" size={16} color={ios.brand} />
                      </Pressable>
                    ) : null}
                  </View>
                );
              })}
            </View>
          ) : null}
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>

      {/* Due date editor modal */}
      <Modal
        visible={dueDateModal}
        transparent
        animationType="fade"
        onRequestClose={() => setDueDateModal(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setDueDateModal(false)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>Edit due date</Text>
            <Text style={styles.modalLabel}>Format: YYYY-MM-DD</Text>
            <TextInput
              style={styles.modalInput}
              value={dueDateInput}
              onChangeText={setDueDateInput}
              placeholder={new Date().toISOString().slice(0, 10)}
              placeholderTextColor={ios.label3}
              keyboardType="numbers-and-punctuation"
              autoFocus
            />
            <View style={{ flexDirection: "row", gap: 10, marginTop: 8 }}>
              <Pressable
                style={[styles.modalBtn, { flex: 1, backgroundColor: ios.fill3 }]}
                onPress={() => setDueDateModal(false)}
              >
                <Text style={[styles.modalBtnText, { color: ios.label }]}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.modalBtn,
                  { flex: 1, backgroundColor: ios.brand },
                  updateMut.isPending && { opacity: 0.6 },
                ]}
                onPress={() => {
                  if (!id) return;
                  updateMut.mutate(
                    { id, dueDate: dueDateInput.trim() || undefined },
                    {
                      onSuccess: () => {
                        showToast("Due date updated");
                        setDueDateModal(false);
                        refetch();
                      },
                      onError: (e: any) =>
                        showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
                    },
                  );
                }}
                disabled={updateMut.isPending}
              >
                {updateMut.isPending ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={[styles.modalBtnText, { color: "#fff" }]}>Save</Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <ShipmentEditModal
        open={shipmentModal}
        shipment={invoice}
        saving={shipmentMut.isPending}
        onClose={() => setShipmentModal(false)}
        onSave={handleSaveShipment}
      />

      {/* Mounted only while open so its credit-notes query never runs (or runs
          tenant-wide with an undefined customerId) in the background. */}
      {creditSheetOpen && invoice.customer?.id ? (
        <ApplyCreditSheet
          customerId={invoice.customer.id}
          invoiceId={invoice.id}
          invoiceNumber={invoice.invoiceNumber}
          balanceDue={Number(balance) || 0}
          onClose={() => setCreditSheetOpen(false)}
        />
      ) : null}

      {advanceSheetOpen && invoice.customer?.id ? (
        <ApplyAdvanceSheet
          customerId={invoice.customer.id}
          invoiceId={invoice.id}
          invoiceNumber={invoice.invoiceNumber}
          balanceDue={Number(balance) || 0}
          onClose={() => setAdvanceSheetOpen(false)}
        />
      ) : null}
    </SafeAreaView>
  );
}

/**
 * Invoice-side "Apply advance" — lists the customer's advance-payment wallet
 * rows with remaining balance and applies the tapped one (server caps at
 * min(wallet balance, invoice balance); reference AP-<id-8>). Web's invoice
 * detail page (B13) mirrors this same flow via ApplyAdvanceModal.
 */
function ApplyAdvanceSheet({
  customerId,
  invoiceId,
  invoiceNumber,
  balanceDue,
  onClose,
}: {
  customerId: string;
  invoiceId: string;
  invoiceNumber: string;
  balanceDue: number;
  onClose: () => void;
}) {
  const { data, isLoading } = useCustomerAdvancePayments(customerId);
  const applyMut = useApplyAdvancePayment();
  const open = (data ?? []).filter((ap) => Number(ap.balance) > 0.001);

  const handleApply = (apId: string, remaining: number) => {
    const applied = Math.min(remaining, balanceDue);
    confirm(
      "Apply advance?",
      `${fmtCurrency(applied)} of the customer's advance will be applied to ${invoiceNumber}.`,
      () =>
        applyMut.mutate(
          { customerId, advanceId: apId, invoiceId },
          {
            onSuccess: () => {
              showToast("Advance applied");
              onClose();
            },
            onError: (e: any) =>
              showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
          },
        ),
      { confirmText: "Apply" },
    );
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.creditBackdrop} onPress={onClose}>
        <Pressable style={styles.creditSheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.creditHeader}>
            <Text style={styles.creditTitle}>Apply advance</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={22} color={ios.label2} />
            </Pressable>
          </View>
          {isLoading ? (
            <View style={styles.center}>
              <ActivityIndicator color={ios.brand} />
            </View>
          ) : open.length === 0 ? (
            <View style={styles.center}>
              <Text style={styles.creditEmpty}>
                No advance balance for this customer. Record one from the customer screen, or an
                overpaid standalone payment creates one automatically.
              </Text>
            </View>
          ) : (
            <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false}>
              {open.map((ap, i) => {
                const remaining = Number(ap.balance) || 0;
                return (
                  <Pressable
                    key={ap.id}
                    style={[
                      styles.creditRow,
                      i > 0 && {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: ios.separator,
                      },
                      applyMut.isPending && { opacity: 0.5 },
                    ]}
                    disabled={applyMut.isPending}
                    onPress={() => handleApply(ap.id, remaining)}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.creditNumber} numberOfLines={1}>
                        {ap.method}
                        {ap.reference ? ` — ${ap.reference}` : ""}
                      </Text>
                      <Text style={styles.creditMeta}>
                        Received {new Date(ap.receivedAt ?? ap.createdAt).toLocaleDateString()} · of{" "}
                        {fmtCurrency(ap.amount)}
                      </Text>
                    </View>
                    <Text style={styles.creditRemaining}>{fmtCurrency(remaining)}</Text>
                    <Ionicons name="chevron-forward" size={14} color={ios.label3} />
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * Invoice-side "Apply credit" — lists the customer's OPEN credit notes and
 * applies the tapped one in full (mirrors the credit-note-side modal; web has
 * no invoice-side entry, this is a mobile-first surface the server fully
 * supports). Open = ISSUED + unexpired + dollars remaining; the list endpoint
 * doesn't filter expiry/balance, so isCreditOpenForApply does.
 */
function ApplyCreditSheet({
  customerId,
  invoiceId,
  invoiceNumber,
  balanceDue,
  onClose,
}: {
  customerId: string;
  invoiceId: string;
  invoiceNumber: string;
  balanceDue: number;
  onClose: () => void;
}) {
  const { data, isLoading } = useCreditNotes({ customerId, status: "ISSUED", limit: 100 });
  const applyMut = useApplyCreditNote();
  const now = new Date();
  const open = (data?.data ?? []).filter((cn) => isCreditOpenForApply(cn, now));

  const handleApply = (cnId: string, cnNumber: string, remaining: number) => {
    const applied = Math.min(remaining, balanceDue);
    confirm(
      "Apply credit?",
      `${fmtCurrency(applied)} from ${cnNumber} will be applied to ${invoiceNumber}.`,
      () =>
        applyMut.mutate(
          { id: cnId, invoiceId },
          {
            onSuccess: () => {
              showToast("Credit applied");
              onClose();
            },
            // The four server rejections here are actionable (expired, wrong
            // customer, no balance, terminal invoice) — surface them verbatim.
            onError: (e: any) =>
              showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
          },
        ),
      { confirmText: "Apply" },
    );
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.creditBackdrop} onPress={onClose}>
        <Pressable style={styles.creditSheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.creditHeader}>
            <Text style={styles.creditTitle}>Apply credit</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={22} color={ios.label2} />
            </Pressable>
          </View>
          {isLoading ? (
            <View style={styles.center}>
              <ActivityIndicator color={ios.brand} />
            </View>
          ) : open.length === 0 ? (
            <View style={styles.center}>
              <Text style={styles.creditEmpty}>
                No open credits for this customer. Issue one from the Credit notes tab first.
              </Text>
            </View>
          ) : (
            <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false}>
              {open.map((cn, i) => {
                const remaining = openCreditBalance(cn);
                return (
                  <Pressable
                    key={cn.id}
                    style={[
                      styles.creditRow,
                      i > 0 && {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: ios.separator,
                      },
                      applyMut.isPending && { opacity: 0.5 },
                    ]}
                    disabled={applyMut.isPending}
                    onPress={() => handleApply(cn.id, cn.creditNoteNumber, remaining)}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.creditNumber} numberOfLines={1}>
                        {cn.creditNoteNumber}
                        {cn.reason ? ` — ${cn.reason}` : ""}
                      </Text>
                      {cn.expiresAt ? (
                        <Text style={styles.creditMeta}>
                          Expires {fmtCalendarDate(cn.expiresAt)}
                        </Text>
                      ) : null}
                    </View>
                    <Text style={styles.creditRemaining}>{fmtCurrency(remaining)}</Text>
                    <Ionicons name="chevron-forward" size={14} color={ios.label3} />
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ActionTile({
  icon,
  label,
  onPress,
  tone = "default",
  disabled = false,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  tone?: "default" | "danger";
  disabled?: boolean;
}) {
  const isDanger = tone === "danger";
  return (
    <Pressable
      style={[styles.tile, isDanger && styles.tileDanger, disabled && { opacity: 0.5 }]}
      disabled={disabled}
      onPress={onPress}
    >
      <Ionicons name={icon} size={22} color={isDanger ? ios.system.red : ios.brand} />
      <Text style={[styles.tileLabel, isDanger && { color: ios.system.red }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14 },
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, marginBottom: 8 },
  siblingHint: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  siblingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  siblingNumber: { flex: 1, fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label },
  siblingTotal: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  customer: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label2, marginTop: 8 },
  headerMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 4 },
  balance: {
    fontSize: 32,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    marginTop: 6,
    fontVariant: ["tabular-nums"],
    letterSpacing: -0.8,
  },
  balanceSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  due: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label2 },
  dueRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 6 },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    backgroundColor: ios.bgElev,
    borderRadius: 20,
    padding: 20,
    width: "100%",
    maxWidth: 340,
    gap: 6,
  },
  modalTitle: { fontSize: 17, fontFamily: "Inter_700Bold", color: ios.label },
  modalLabel: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  modalInput: {
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: ios.label,
    marginTop: 4,
  },
  modalBtn: {
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  modalBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  actionsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  variantRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 12 },
  variantLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.8,
  },
  mirrorHint: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
  },
  mirrorHintText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    lineHeight: 18,
  },
  tile: {
    flexBasis: "47%",
    flexGrow: 1,
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 18,
    alignItems: "center",
    gap: 8,
  },
  tileDanger: { backgroundColor: ios.system.redWash },
  tileLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    textAlign: "center",
  },
  itemRow: { flexDirection: "row", alignItems: "center", paddingVertical: 8, gap: 10 },
  itemName: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  itemSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  itemMsrp: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label3, marginTop: 2 },
  itemFreeLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.brand,
    marginTop: 2,
  },
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
    marginTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
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
  payRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, gap: 10 },
  payMethodRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
  payMethod: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  payMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  payAmount: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: ios.system.greenInk,
    fontVariant: ["tabular-nums"],
  },
  viewReceiptRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  viewReceiptText: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.brand },
  payEditBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: ios.fill3,
    alignItems: "center",
    justifyContent: "center",
  },

  // ── Apply-credit sheet ────────────────────────────────────────────────────
  creditBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end",
  },
  creditSheet: {
    backgroundColor: ios.bg,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingBottom: 24,
  },
  creditHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  creditTitle: { fontSize: 16, fontFamily: "Inter_700Bold", color: ios.label },
  creditEmpty: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
  },
  creditRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  creditNumber: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  creditMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  creditRemaining: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: ios.system.greenInk,
    fontVariant: ["tabular-nums"],
  },
});
