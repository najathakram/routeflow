import type { ComponentProps } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";

type IoniconName = ComponentProps<typeof Ionicons>["name"];

type PdfSharePhase = "idle" | "preparing" | "ready";

interface SendInvoiceSheetProps {
  open: boolean;
  onClose: () => void;
  customerName: string;
  invoiceNumber: string;
  totalFmt: string;
  /** Preferred messaging number (mobile||phone); WhatsApp + SMS hide when absent. */
  phone?: string;
  /** Email on file; the Email row hides when absent. */
  email?: string;
  /** True while the server-side email send is in flight. */
  emailSending?: boolean;
  /** Governs the "Share PDF" row's label/enabled state through the
   * prepare → (maybe) tap-again → share dance (share-pdf.ts's
   * ACTIVATION_BUDGET_MS contract): "preparing" while the fetch races the
   * budget (busy, disabled), "ready" when the budget ran out first — the
   * NEXT tap shares the by-then-cached PDF synchronously. */
  pdfPhase?: PdfSharePhase;
  /** Same states, for the WhatsApp row when it's attaching the actual PDF
   * (file-share mode) instead of opening the wa.me text link. */
  whatsAppPhase?: PdfSharePhase;
  onWhatsApp: () => void;
  onSms: () => void;
  onEmail: () => void;
  onSharePdf: () => void;
  /** Opens the PDF directly (window.open on web / Linking on native — see
   * `share-pdf.ts`'s `openPdfInTab`), independent of whether the OS/browser
   * share API is available or a share just failed. Always visible — this row
   * (with Share PDF and Mark as Sent) is the guaranteed floor so the sheet
   * never dead-ends, even when the share API is unavailable/fails and no
   * phone or email is on file. */
  onOpenPdf: () => void;
  /** True while the "Open PDF" fetch is in flight. */
  openPdfPending?: boolean;
  /** Marks the invoice SENT without emailing or sharing it — the SAME
   * mutation (`useSendInvoice`, called without an email) the invoice-detail
   * dialog already uses for its "Mark as Sent" action. Always visible: the
   * operator who delivers the PDF themselves (own phone, printed, etc.) needs
   * a way to close the loop even when no automated channel applies. */
  onMarkAsSent: () => void;
  /** True while the mark-as-sent mutation is in flight. Email rides the same
   * `useSendInvoice` instance, so the caller must discriminate on the in-flight
   * variables (`email == null` ⇒ mark-as-sent) rather than passing a bare
   * `isPending`, which would light up both rows at once. */
  markingSent?: boolean;
}

/** Turns a phase into the row's label — shared by the WhatsApp (file-share
 * mode) and Share-PDF rows since both go through the same prepare/tap-again
 * dance. */
function pdfPhaseLabel(phase: PdfSharePhase | undefined, idleLabel: string): string {
  if (phase === "preparing") return "Preparing PDF…";
  if (phase === "ready") return "PDF ready — tap to share";
  return idleLabel;
}

/**
 * Post-delivery channel picker — mirrors web's SendInvoiceModal. WhatsApp/SMS are
 * client deep-links (no status change, no PDF URL in the text — see
 * invoice-send-logic); Email is a real server send; Share PDF pushes the file
 * bytes through the OS share sheet. A bottom sheet so it can auto-open right after
 * an order is marked delivered without leaving the order screen.
 *
 * Phone/email rows hide when absent, but Share PDF · Open PDF · Mark as Sent
 * always render — on a device/browser where the OS share API is unavailable or
 * a share fails, Open PDF and Mark as Sent are the guaranteed path to
 * completion (A1, 2026-08-19: the sheet must never dead-end).
 */
export function SendInvoiceSheet({
  open,
  onClose,
  customerName,
  invoiceNumber,
  totalFmt,
  phone,
  email,
  emailSending,
  pdfPhase,
  whatsAppPhase,
  onWhatsApp,
  onSms,
  onEmail,
  onSharePdf,
  onOpenPdf,
  openPdfPending,
  onMarkAsSent,
  markingSent,
}: SendInvoiceSheetProps) {
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <Text style={styles.title}>Send invoice</Text>
        <Text style={styles.sub} numberOfLines={1}>
          {[invoiceNumber, totalFmt, customerName].filter(Boolean).join(" · ")}
        </Text>
        <View style={styles.rows}>
          {phone ? (
            <ChannelRow
              icon="logo-whatsapp"
              label={pdfPhaseLabel(whatsAppPhase, "WhatsApp")}
              tint="#25D366"
              onPress={onWhatsApp}
              disabled={whatsAppPhase === "preparing"}
            />
          ) : null}
          {phone ? (
            <ChannelRow icon="chatbubble-outline" label="Text message" onPress={onSms} />
          ) : null}
          {email ? (
            <ChannelRow
              icon="mail-outline"
              label={emailSending ? "Emailing…" : "Email"}
              onPress={onEmail}
              disabled={emailSending}
            />
          ) : null}
          <ChannelRow
            icon="share-outline"
            label={pdfPhaseLabel(pdfPhase, "Share PDF")}
            onPress={onSharePdf}
            disabled={pdfPhase === "preparing"}
          />
          <ChannelRow
            icon="open-outline"
            label={openPdfPending ? "Opening…" : "Open PDF"}
            onPress={onOpenPdf}
            disabled={openPdfPending}
          />
          <ChannelRow
            icon="checkmark-circle-outline"
            label={markingSent ? "Marking as sent…" : "Mark as sent — I'll deliver it myself."}
            onPress={onMarkAsSent}
            disabled={markingSent}
          />
          {!phone && !email ? (
            <Text style={styles.note}>
              No phone or email on file — share or download the PDF, then mark it sent.
            </Text>
          ) : null}
        </View>
        <Pressable style={styles.doneBtn} onPress={onClose}>
          <Text style={styles.doneText}>Done</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

function ChannelRow({
  icon,
  label,
  tint,
  onPress,
  disabled,
}: {
  icon: IoniconName;
  label: string;
  tint?: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      style={[styles.row, disabled && { opacity: 0.5 }]}
      onPress={onPress}
      disabled={disabled}
    >
      <Ionicons name={icon} size={20} color={tint ?? ios.brand} />
      <Text style={styles.rowLabel}>{label}</Text>
      <Ionicons name="chevron-forward" size={16} color={ios.gray[3]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: {
    backgroundColor: ios.bgElev,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 34,
  },
  handle: {
    alignSelf: "center",
    width: 36,
    height: 5,
    borderRadius: 3,
    backgroundColor: ios.fill3,
    marginBottom: 14,
  },
  title: { fontSize: 18, fontFamily: "Inter_700Bold", color: ios.label },
  sub: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 4 },
  rows: { gap: 8, marginTop: 14 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: ios.fill3,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 14,
  },
  rowLabel: { flex: 1, fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  note: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    paddingVertical: 4,
  },
  doneBtn: { alignItems: "center", paddingVertical: 14, marginTop: 12 },
  doneText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.brand },
});
