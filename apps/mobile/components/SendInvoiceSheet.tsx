import type { ComponentProps } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";

type IoniconName = ComponentProps<typeof Ionicons>["name"];

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
  /** True while the PDF is being fetched/shared — guards against a double-tap
   * firing two concurrent share sheets (expo-sharing throws on the second). */
  pdfSending?: boolean;
  onWhatsApp: () => void;
  onSms: () => void;
  onEmail: () => void;
  onSharePdf: () => void;
}

/**
 * Post-delivery channel picker — mirrors web's SendInvoiceModal. WhatsApp/SMS are
 * client deep-links (no status change, no PDF URL in the text — see
 * invoice-send-logic); Email is a real server send; Share PDF pushes the file
 * bytes through the OS share sheet. A bottom sheet so it can auto-open right after
 * an order is marked delivered without leaving the order screen.
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
  pdfSending,
  onWhatsApp,
  onSms,
  onEmail,
  onSharePdf,
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
            <ChannelRow icon="logo-whatsapp" label="WhatsApp" tint="#25D366" onPress={onWhatsApp} />
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
            label={pdfSending ? "Sharing…" : "Share PDF"}
            onPress={onSharePdf}
            disabled={pdfSending}
          />
          {!phone && !email ? (
            <Text style={styles.note}>No phone or email on file — share the PDF instead.</Text>
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
