import { useEffect, useState } from "react";
import { Linking, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { CARRIERS, carrierLabel, getTrackingUrl } from "../lib/shipping";
import { showToast } from "../lib/toast";

/**
 * Carrier shipment UI shared by the operator order- and invoice-detail screens.
 * Mirrors web's behaviour: shows carrier + tracking number, a tappable
 * "Track package" row when `getTrackingUrl` resolves a URL, and an edit modal
 * with a carrier picker (from CARRIERS) + tracking-number input that can also
 * clear the shipment. The tracking URL is always derived from (carrier, number).
 */

export interface ShipmentInfo {
  shippingCarrier?: string | null;
  shippingTrackingNumber?: string | null;
  shippedAt?: string | null;
}

/** Read-only shipment card with an "Add tracking" / "Edit shipment" button. */
export function ShipmentSection({
  shipment,
  onEdit,
}: {
  shipment: ShipmentInfo;
  onEdit: () => void;
}) {
  const carrier = shipment.shippingCarrier ?? null;
  const tracking = shipment.shippingTrackingNumber ?? null;
  const hasShipment = !!(carrier || tracking);
  const url = getTrackingUrl(carrier, tracking);

  const openTracking = () => {
    if (!url) return;
    Linking.openURL(url).catch(() => showToast("Couldn't open the tracking link."));
  };

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.cardTitle}>Shipment</Text>
        <Pressable onPress={onEdit} hitSlop={8} style={styles.editBtn}>
          <Ionicons
            name={hasShipment ? "create-outline" : "add-circle-outline"}
            size={16}
            color={ios.brand}
          />
          <Text style={styles.linkText}>{hasShipment ? "Edit shipment" : "Add tracking"}</Text>
        </Pressable>
      </View>

      {!hasShipment ? (
        <Text style={styles.empty}>No carrier shipment recorded.</Text>
      ) : (
        <View style={{ gap: 8 }}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Carrier</Text>
            <Text style={styles.rowValue}>{carrierLabel(carrier) || "—"}</Text>
          </View>
          {tracking ? (
            url ? (
              <Pressable style={styles.trackRow} onPress={openTracking} hitSlop={4}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.rowLabel}>Tracking</Text>
                  <Text style={styles.trackNumber} numberOfLines={1}>
                    {tracking}
                  </Text>
                </View>
                <View style={styles.trackBtn}>
                  <Ionicons name="open-outline" size={14} color={ios.brand} />
                  <Text style={styles.trackBtnText}>Track package</Text>
                </View>
              </Pressable>
            ) : (
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Tracking</Text>
                <Text style={styles.rowValue} numberOfLines={1}>
                  {tracking}
                </Text>
              </View>
            )
          ) : null}
          {shipment.shippedAt ? (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Shipped</Text>
              <Text style={styles.rowValue}>
                {new Date(shipment.shippedAt).toLocaleDateString()}
              </Text>
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}

/**
 * Modal to record / edit / clear the carrier shipment. Carrier picker (CARRIERS)
 * + tracking-number input. "Save" sends the chosen values; "Clear shipment"
 * sends empty strings (the API treats empty as clear). `saving` disables Save.
 */
export function ShipmentEditModal({
  open,
  shipment,
  saving,
  onClose,
  onSave,
}: {
  open: boolean;
  shipment: ShipmentInfo;
  saving: boolean;
  onClose: () => void;
  onSave: (carrier: string, trackingNumber: string) => void;
}) {
  const [carrier, setCarrier] = useState<string>("");
  const [tracking, setTracking] = useState<string>("");

  // Seed the inputs from the current shipment each time the modal opens.
  useEffect(() => {
    if (!open) return;
    setCarrier(shipment.shippingCarrier ?? "");
    setTracking(shipment.shippingTrackingNumber ?? "");
  }, [open, shipment.shippingCarrier, shipment.shippingTrackingNumber]);

  const hasExisting = !!(shipment.shippingCarrier || shipment.shippingTrackingNumber);
  // The carrier picker stores the exact CARRIERS label; match case-insensitively
  // so a legacy/hand-typed value still highlights its chip when it lines up.
  const selectedLabel = CARRIERS.find(
    (c) => c.label.toLowerCase() === carrier.trim().toLowerCase(),
  )?.label;

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.modalTitle}>{hasExisting ? "Edit shipment" : "Add tracking"}</Text>
          <Text style={styles.modalSub}>
            Record the carrier and tracking number when goods ship via a carrier.
          </Text>

          <Text style={styles.fieldLabel}>Carrier</Text>
          <View style={styles.carrierRow}>
            {CARRIERS.map((c) => {
              const active = selectedLabel === c.label;
              return (
                <Pressable
                  key={c.id}
                  style={[styles.carrierChip, active && styles.carrierChipActive]}
                  onPress={() => setCarrier(c.label)}
                >
                  <Text style={[styles.carrierChipText, active && styles.carrierChipTextActive]}>
                    {c.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.fieldLabel}>Tracking number</Text>
          <TextInput
            style={styles.input}
            value={tracking}
            onChangeText={setTracking}
            placeholder="e.g. 1Z999AA10123456784"
            placeholderTextColor={ios.label3}
            autoCapitalize="characters"
            autoCorrect={false}
          />

          <View style={styles.btns}>
            {hasExisting ? (
              <Pressable
                style={[styles.btnDanger, saving && styles.btnDisabled]}
                onPress={() => onSave("", "")}
                disabled={saving}
              >
                <Text style={styles.btnDangerText}>Clear</Text>
              </Pressable>
            ) : (
              <Pressable style={styles.btnGhost} onPress={onClose}>
                <Text style={styles.btnGhostText}>Cancel</Text>
              </Pressable>
            )}
            <Pressable
              style={[styles.btnFill, saving && styles.btnDisabled]}
              onPress={() => onSave(carrier.trim(), tracking.trim())}
              disabled={saving}
            >
              <Text style={styles.btnFillText}>{saving ? "Saving…" : "Save"}</Text>
            </Pressable>
          </View>
          {hasExisting ? (
            <Pressable onPress={onClose} hitSlop={6} style={styles.cancelLink}>
              <Text style={styles.cancelLinkText}>Cancel</Text>
            </Pressable>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14, gap: 10 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  editBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
  linkText: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.brand },
  empty: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  rowLabel: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  rowValue: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: ios.label,
    flexShrink: 1,
    textAlign: "right",
  },
  trackRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: ios.brandWash,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  trackNumber: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
    marginTop: 1,
  },
  trackBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
  trackBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.brand },

  // Modal
  overlay: {
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
    maxWidth: 380,
  },
  modalTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.3,
    marginBottom: 2,
  },
  modalSub: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, marginBottom: 14 },
  fieldLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.3,
    marginBottom: 8,
  },
  carrierRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 16 },
  carrierChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: ios.separator,
  },
  carrierChipActive: { backgroundColor: ios.brand, borderColor: ios.brand },
  carrierChipText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label },
  carrierChipTextActive: { color: "#fff", fontFamily: "Inter_600SemiBold" },
  input: {
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    fontFamily: "Inter_500Medium",
    color: ios.label,
    marginBottom: 16,
  },
  btns: { flexDirection: "row", gap: 10 },
  btnGhost: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: ios.fill3,
  },
  btnGhostText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  btnDanger: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: ios.system.redWash,
  },
  btnDangerText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.system.red },
  btnFill: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: ios.brand,
  },
  btnFillText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#fff" },
  btnDisabled: { opacity: 0.5 },
  cancelLink: { alignItems: "center", paddingTop: 12 },
  cancelLinkText: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label2 },
});
