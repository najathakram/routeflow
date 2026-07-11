import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import {
  useCreateAuthorization,
  useCreateAuthorizationOverride,
  overrideScope,
  OVERRIDE_REASONS,
  type BlockedCategory,
} from "../lib/api/authorizations";

interface Props {
  open: boolean;
  customerId: string;
  blocked: BlockedCategory[];
  /** Present → override is ORDER-scoped; absent (pre-create) → 24h UNTIL scope. */
  orderId?: string;
  /** Called after every blocked category is cleared — the caller retries its mutation. */
  onResolved: () => void;
  /** Optional exit to drop the regulated lines (omit on the order-edit screen). */
  onRemoveLines?: (categoryIds: string[]) => void;
  onClose: () => void;
  /** Drivers can't capture/override (403) — show only the remove/cancel exits. */
  readOnly?: boolean;
}

type Mode = "choose" | "capture" | "override";

/**
 * Blocks a regulated sale (409 REGULATED_AUTH_REQUIRED) with the same 3 exits as
 * web's LicenseGuardModal: capture the customer's license, record a §8 override,
 * or remove the regulated line(s). Mirrors apps/web/.../LicenseGuardModal.tsx.
 */
export function LicenseGuardModal({
  open,
  customerId,
  blocked,
  orderId,
  onResolved,
  onRemoveLines,
  onClose,
  readOnly,
}: Props) {
  const [mode, setMode] = useState<Mode>("choose");
  const [error, setError] = useState<string | null>(null);
  // capture inputs, keyed by trackedCategoryId
  const [licenses, setLicenses] = useState<Record<string, string>>({});
  const [expiries, setExpiries] = useState<Record<string, string>>({});
  // override inputs
  const [reason, setReason] = useState<string>(OVERRIDE_REASONS[0]);
  const [ack, setAck] = useState("");

  const createAuth = useCreateAuthorization(customerId);
  const createOverride = useCreateAuthorizationOverride(customerId);
  const busy = createAuth.isPending || createOverride.isPending;

  const reset = () => {
    setMode("choose");
    setError(null);
    setLicenses({});
    setExpiries({});
    setReason(OVERRIDE_REASONS[0]);
    setAck("");
  };
  const close = () => {
    reset();
    onClose();
  };
  const resolved = () => {
    reset();
    onResolved();
  };

  const submitCapture = async () => {
    setError(null);
    // License number AND expiry are BOTH required for every blocked category
    // (mirrors web). Without this, capturing two blank fields would create a
    // permanent no-license/no-expiry VERIFIED authorization that silently and
    // permanently defeats the regulated-sale guard.
    for (const b of blocked) {
      const license = (licenses[b.trackedCategoryId] ?? "").trim();
      const exp = (expiries[b.trackedCategoryId] ?? "").trim();
      if (!license) {
        setError(`Enter the ${b.categoryName} license number.`);
        return;
      }
      if (!exp) {
        setError(`Enter the ${b.categoryName} expiry date (YYYY-MM-DD).`);
        return;
      }
      const d = new Date(exp);
      if (Number.isNaN(d.getTime())) {
        setError(`Enter the expiry date as YYYY-MM-DD for ${b.categoryName}.`);
        return;
      }
      if (d.getTime() < Date.now()) {
        setError(`${b.categoryName} license expiry is in the past.`);
        return;
      }
    }
    try {
      for (const b of blocked) {
        await createAuth.mutateAsync({
          trackedCategoryId: b.trackedCategoryId,
          licenseNumber: (licenses[b.trackedCategoryId] ?? "").trim(),
          expiresAt: new Date((expiries[b.trackedCategoryId] ?? "").trim()).toISOString(),
        });
      }
      resolved();
    } catch (e: any) {
      setError(e?.response?.data?.message ?? e?.message ?? "Couldn't save the license.");
    }
  };

  const submitOverride = async () => {
    setError(null);
    if (ack.trim() === "") {
      setError("Type the business name to acknowledge responsibility.");
      return;
    }
    try {
      const scope = overrideScope(orderId, Date.now());
      for (const b of blocked) {
        await createOverride.mutateAsync({
          trackedCategoryId: b.trackedCategoryId,
          reason,
          scope,
          acknowledgedTenant: ack.trim(),
        });
      }
      resolved();
    } catch (e: any) {
      setError(e?.response?.data?.message ?? e?.message ?? "Couldn't record the override.");
    }
  };

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Ionicons name="shield-half-outline" size={20} color={ios.system.orange} />
            <Text style={styles.title}>License required</Text>
          </View>
          <Text style={styles.sub}>
            {blocked.map((b) => b.categoryName).join(", ")} — this customer isn't verified to buy
            {blocked.length === 1 ? " this category." : " these categories."}
          </Text>

          <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
            {mode === "choose" ? (
              <View style={{ gap: 10 }}>
                {!readOnly ? (
                  <>
                    <ChoiceRow
                      icon="card-outline"
                      label="Capture license now"
                      sub="Record the customer's license number + expiry"
                      onPress={() => setMode("capture")}
                    />
                    <ChoiceRow
                      icon="alert-circle-outline"
                      label="Sell under responsibility"
                      sub="§8 override — you accept accountability for this sale"
                      onPress={() => setMode("override")}
                    />
                  </>
                ) : (
                  <Text style={styles.note}>
                    Only an operator can capture a license or override. Contact the office, or
                    remove the regulated line(s).
                  </Text>
                )}
                {onRemoveLines ? (
                  <ChoiceRow
                    icon="trash-outline"
                    label="Remove regulated line(s)"
                    sub="Take the blocked items off this order"
                    danger
                    onPress={() => {
                      onRemoveLines(blocked.map((b) => b.trackedCategoryId));
                      close();
                    }}
                  />
                ) : null}
              </View>
            ) : null}

            {mode === "capture" ? (
              <View style={{ gap: 14 }}>
                {blocked.map((b) => (
                  <View key={b.trackedCategoryId} style={{ gap: 6 }}>
                    <Text style={styles.fieldLabel}>{b.categoryName}</Text>
                    <TextInput
                      style={styles.input}
                      placeholder="License number"
                      placeholderTextColor={ios.label3}
                      value={licenses[b.trackedCategoryId] ?? ""}
                      onChangeText={(t) => setLicenses((m) => ({ ...m, [b.trackedCategoryId]: t }))}
                    />
                    <TextInput
                      style={styles.input}
                      placeholder="Expiry (YYYY-MM-DD)"
                      placeholderTextColor={ios.label3}
                      keyboardType="numbers-and-punctuation"
                      value={expiries[b.trackedCategoryId] ?? ""}
                      onChangeText={(t) => setExpiries((m) => ({ ...m, [b.trackedCategoryId]: t }))}
                    />
                  </View>
                ))}
              </View>
            ) : null}

            {mode === "override" ? (
              <View style={{ gap: 10 }}>
                <Text style={styles.fieldLabel}>Reason</Text>
                {OVERRIDE_REASONS.map((r) => (
                  <Pressable
                    key={r}
                    style={[styles.reasonRow, reason === r && styles.reasonRowActive]}
                    onPress={() => setReason(r)}
                  >
                    <Ionicons
                      name={reason === r ? "radio-button-on" : "radio-button-off"}
                      size={18}
                      color={reason === r ? ios.brand : ios.label3}
                    />
                    <Text style={styles.reasonText}>{r}</Text>
                  </Pressable>
                ))}
                <Text style={styles.fieldLabel}>Acknowledgement</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Type the business name to confirm"
                  placeholderTextColor={ios.label3}
                  value={ack}
                  onChangeText={setAck}
                />
              </View>
            ) : null}
          </ScrollView>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <View style={styles.btns}>
            <Pressable
              style={styles.btnGhost}
              onPress={mode === "choose" ? close : () => setMode("choose")}
            >
              <Text style={styles.btnGhostText}>{mode === "choose" ? "Cancel" : "Back"}</Text>
            </Pressable>
            {mode === "capture" ? (
              <Pressable
                style={[styles.btnFill, busy && styles.btnDisabled]}
                disabled={busy}
                onPress={submitCapture}
              >
                <Text style={styles.btnFillText}>{busy ? "Saving…" : "Save license"}</Text>
              </Pressable>
            ) : null}
            {mode === "override" ? (
              <Pressable
                style={[styles.btnFill, busy && styles.btnDisabled]}
                disabled={busy}
                onPress={submitOverride}
              >
                <Text style={styles.btnFillText}>{busy ? "Saving…" : "Confirm override"}</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}

function ChoiceRow({
  icon,
  label,
  sub,
  danger,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  sub: string;
  danger?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.choiceRow} onPress={onPress}>
      <Ionicons name={icon} size={22} color={danger ? ios.system.red : ios.brand} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.choiceLabel, danger && { color: ios.system.red }]}>{label}</Text>
        <Text style={styles.choiceSub}>{sub}</Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={ios.gray[3]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    padding: 20,
  },
  card: { backgroundColor: ios.bgElev, borderRadius: 18, padding: 18, gap: 12 },
  header: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { fontSize: 17, fontFamily: "Inter_700Bold", color: ios.label },
  sub: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  note: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, paddingVertical: 8 },
  choiceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: ios.fill3,
  },
  choiceLabel: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  choiceSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  fieldLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label2 },
  input: {
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.label,
  },
  reasonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  reasonRowActive: { backgroundColor: ios.brandWash },
  reasonText: { flex: 1, fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label },
  error: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.system.red },
  btns: { flexDirection: "row", gap: 10, marginTop: 4 },
  btnGhost: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: ios.fill3,
    alignItems: "center",
  },
  btnGhostText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  btnFill: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: ios.brand,
    alignItems: "center",
  },
  btnDisabled: { opacity: 0.5 },
  btnFillText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#fff" },
});
