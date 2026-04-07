import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useState } from "react";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useOrder } from "../../../lib/api/orders";
import {
  useCreateReturn,
  type ReturnReason,
  type CreateReturnItemDto,
} from "../../../lib/api/returns";

const REASONS: { key: ReturnReason; label: string; desc: string }[] = [
  { key: "DAMAGED",          label: "Damaged",        desc: "Goods arrived damaged or broken" },
  { key: "WRONG_ITEM",       label: "Wrong Item",     desc: "Incorrect product was delivered" },
  { key: "CUSTOMER_REFUSED", label: "Refused",        desc: "I changed my mind / no longer need it" },
  { key: "QUALITY_ISSUE",    label: "Quality Issue",  desc: "Product did not meet quality standards" },
  { key: "EXCESS_ORDER",     label: "Too Much",       desc: "More than I needed was delivered" },
];

interface ReturnLine {
  itemId: string;
  productId: string;
  name: string;
  unit: string;
  orderedQty: number;
  returnQty: string;
  selected: boolean;
}

export default function RequestReturnScreen() {
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  const { data: order, isLoading } = useOrder(orderId ?? "");
  const { mutate: createReturn, isPending } = useCreateReturn();

  const [reason, setReason] = useState<ReturnReason>("DAMAGED");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<ReturnLine[]>([]);
  const [photo, setPhoto] = useState<string | null>(null);

  async function pickPhoto() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission needed", "Allow access to your photo library to attach a photo.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
      allowsEditing: true,
      aspect: [4, 3],
    });
    if (!result.canceled && result.assets[0]) {
      setPhoto(result.assets[0].uri);
    }
  }

  async function takePhoto() {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission needed", "Allow camera access to take a photo.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      quality: 0.8,
      allowsEditing: true,
      aspect: [4, 3],
    });
    if (!result.canceled && result.assets[0]) {
      setPhoto(result.assets[0].uri);
    }
  }

  // Initialise lines from order when it loads
  if (order && lines.length === 0 && order.lineItems.length > 0) {
    setLines(
      order.lineItems.map((i) => ({
        itemId: i.id,
        productId: i.productId,
        name: i.product?.name ?? i.productId,
        unit: i.product?.unit ?? "",
        orderedQty: i.qty,
        returnQty: "",
        selected: false,
      })),
    );
  }

  const toggleLine = (itemId: string) =>
    setLines((prev) =>
      prev.map((l) =>
        l.itemId === itemId
          ? { ...l, selected: !l.selected, returnQty: l.selected ? "" : String(l.orderedQty) }
          : l,
      ),
    );

  const updateQty = (itemId: string, qty: string) =>
    setLines((prev) => prev.map((l) => (l.itemId === itemId ? { ...l, returnQty: qty } : l)));

  const selectedLines = lines.filter((l) => l.selected);
  const isValid =
    selectedLines.length > 0 &&
    selectedLines.every((l) => {
      const n = parseInt(l.returnQty, 10);
      return !isNaN(n) && n > 0 && n <= l.orderedQty;
    });

  const handleSubmit = () => {
    if (!isValid || !orderId) return;

    const returnItems: CreateReturnItemDto[] = selectedLines.map((l) => ({
      productId: l.productId,
      qty: parseInt(l.returnQty, 10),
      reason,
      restock: reason !== "DAMAGED" && reason !== "QUALITY_ISSUE",
    }));

    createReturn(
      { orderId, reason, notes: notes || undefined, items: returnItems },
      {
        onSuccess: () => {
          Alert.alert(
            "Return Requested",
            "Your return request has been submitted. We'll be in touch shortly.",
            [{ text: "OK", onPress: () => router.replace("/(customer)/returns" as any) }],
          );
        },
        onError: (err: Error) => {
          Alert.alert("Error", "Failed to submit return.\n" + (err.message || ""));
        },
      },
    );
  };

  if (isLoading || !order) {
    return (
      <>
        <Stack.Screen options={{ title: "Request Return" }} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: "Request Return", headerBackTitle: "Order" }} />
      <View style={styles.container}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Order reference */}
          <View style={styles.orderCard}>
            <Ionicons name="receipt-outline" size={18} color={colors.brand[500]} />
            <View>
              <Text style={styles.orderNumber}>Order {order.orderNumber}</Text>
              <Text style={styles.orderMeta}>
                {order.lineItems.reduce((s, i) => s + Number(i.qty), 0)} items ·{" "}
                ${Number(order.total).toFixed(2)}
              </Text>
            </View>
          </View>

          {/* Reason */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Return Reason</Text>
            {REASONS.map(({ key, label, desc }) => (
              <Pressable
                key={key}
                style={[styles.reasonRow, reason === key && styles.reasonRowActive]}
                onPress={() => setReason(key)}
              >
                <View
                  style={[
                    styles.radioCircle,
                    reason === key && styles.radioCircleActive,
                  ]}
                >
                  {reason === key && <View style={styles.radioDot} />}
                </View>
                <View style={styles.reasonText}>
                  <Text style={[styles.reasonLabel, reason === key && { color: colors.brand[500] }]}>
                    {label}
                  </Text>
                  <Text style={styles.reasonDesc}>{desc}</Text>
                </View>
              </Pressable>
            ))}
          </View>

          {/* Items */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Items to Return</Text>
            {lines.map((line) => (
              <View key={line.itemId} style={styles.itemCard}>
                <Pressable style={styles.itemHeader} onPress={() => toggleLine(line.itemId)}>
                  <View style={[styles.checkbox, line.selected && styles.checkboxChecked]}>
                    {line.selected && <Ionicons name="checkmark" size={14} color="#fff" />}
                  </View>
                  <View style={styles.itemInfo}>
                    <Text style={styles.itemName}>{line.name}</Text>
                    <Text style={styles.itemMeta}>
                      {line.unit} · Delivered: {line.orderedQty}
                    </Text>
                  </View>
                </Pressable>

                {line.selected && (
                  <View style={styles.itemDetail}>
                    <Text style={styles.qtyLabel}>How many are you returning?</Text>
                    <View style={styles.qtyRow}>
                      <Pressable
                        style={styles.qtyStepBtn}
                        onPress={() => {
                          const n = parseInt(line.returnQty || "0", 10);
                          if (n > 1) updateQty(line.itemId, String(n - 1));
                        }}
                      >
                        <Text style={styles.qtyStepText}>−</Text>
                      </Pressable>
                      <TextInput
                        style={styles.qtyInput}
                        value={line.returnQty}
                        onChangeText={(v) => updateQty(line.itemId, v)}
                        keyboardType="number-pad"
                        placeholder="0"
                        maxLength={3}
                        textAlign="center"
                      />
                      <Pressable
                        style={styles.qtyStepBtn}
                        onPress={() => {
                          const n = parseInt(line.returnQty || "0", 10);
                          if (n < line.orderedQty) updateQty(line.itemId, String(n + 1));
                        }}
                      >
                        <Text style={styles.qtyStepText}>+</Text>
                      </Pressable>
                      <Text style={styles.qtyMax}>of {line.orderedQty}</Text>
                    </View>
                  </View>
                )}
              </View>
            ))}
          </View>

          {/* Photo */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Photo (optional)</Text>
            {photo ? (
              <View style={styles.photoPreviewWrap}>
                <Image source={{ uri: photo }} style={styles.photoPreview} resizeMode="cover" />
                <Pressable
                  style={styles.removePhotoBtn}
                  onPress={() => setPhoto(null)}
                  accessibilityLabel="Remove photo"
                >
                  <Ionicons name="close-circle" size={24} color="#fff" />
                </Pressable>
              </View>
            ) : (
              <View style={styles.photoActions}>
                <Pressable style={styles.photoBtn} onPress={takePhoto}>
                  <Ionicons name="camera-outline" size={22} color={colors.brand[600]} />
                  <Text style={styles.photoBtnText}>Take Photo</Text>
                </Pressable>
                <Pressable style={styles.photoBtn} onPress={pickPhoto}>
                  <Ionicons name="image-outline" size={22} color={colors.brand[600]} />
                  <Text style={styles.photoBtnText}>Choose from Library</Text>
                </Pressable>
              </View>
            )}
          </View>

          {/* Notes */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Additional Notes (optional)</Text>
            <TextInput
              style={styles.notesInput}
              placeholder="Describe the issue in more detail…"
              placeholderTextColor="#94a3b8"
              value={notes}
              onChangeText={setNotes}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />
          </View>
        </ScrollView>

        <View style={styles.footer}>
          {selectedLines.length > 0 && (
            <Text style={styles.selectedCount}>
              {selectedLines.length} item{selectedLines.length !== 1 ? "s" : ""} selected
            </Text>
          )}
          <Pressable
            style={[styles.submitBtn, (!isValid || isPending) && styles.submitBtnDisabled]}
            onPress={handleSubmit}
            disabled={!isValid || isPending}
          >
            {isPending ? (
              <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
            ) : (
              <Ionicons name="return-down-back-outline" size={22} color="#fff" style={{ marginRight: 8 }} />
            )}
            <Text style={styles.submitBtnText}>
              {isPending ? "Submitting…" : "Submit Return Request"}
            </Text>
          </Pressable>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface.raised },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  scroll: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 24,
    gap: 12,
  },
  orderCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 14,
    ...shadows.card,
  },
  orderNumber: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  orderMeta: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  section: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 10,
    ...shadows.card,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  reasonRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1.5,
    borderColor: "transparent",
    backgroundColor: colors.surface.raised,
  },
  reasonRowActive: {
    borderColor: colors.brand[500],
    backgroundColor: colors.brand[50],
  },
  radioCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: colors.surface.border,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    marginTop: 1,
  },
  radioCircleActive: { borderColor: colors.brand[500] },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.brand[500],
  },
  reasonText: { flex: 1, gap: 2 },
  reasonLabel: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  reasonDesc: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  itemCard: {
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.DEFAULT,
    overflow: "hidden",
  },
  itemHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.surface.border,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  checkboxChecked: {
    backgroundColor: colors.brand[500],
    borderColor: colors.brand[500],
  },
  itemInfo: { flex: 1, gap: 2 },
  itemName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  itemMeta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  itemDetail: {
    borderTopWidth: 1,
    borderTopColor: colors.surface.border,
    backgroundColor: colors.surface.raised,
    padding: 12,
    gap: 8,
  },
  qtyLabel: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "#64748b",
  },
  qtyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  qtyStepBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: colors.surface.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  qtyStepText: {
    fontSize: 20,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    lineHeight: 24,
  },
  qtyInput: {
    width: 60,
    height: 44,
    borderWidth: 1.5,
    borderColor: colors.brand[500],
    borderRadius: borderRadius.DEFAULT,
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
    backgroundColor: "#fff",
  },
  qtyMax: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  notesInput: {
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.DEFAULT,
    padding: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    minHeight: 80,
    backgroundColor: colors.surface.raised,
    textAlignVertical: "top",
  },
  footer: {
    paddingHorizontal: 16,
    paddingBottom: 28,
    paddingTop: 12,
    backgroundColor: "#fff",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
    gap: 8,
  },
  selectedCount: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "#94a3b8",
    textAlign: "center",
  },
  submitBtn: {
    height: 56,
    backgroundColor: colors.brand[500],
    borderRadius: borderRadius.DEFAULT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  submitBtnDisabled: { opacity: 0.4 },
  submitBtnText: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },

  photoActions: {
    flexDirection: "row",
    gap: 8,
  },
  photoBtn: {
    flex: 1,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 16,
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1.5,
    borderColor: colors.brand[100],
    borderStyle: "dashed",
    backgroundColor: colors.brand[50],
  },
  photoBtnText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[600],
    textAlign: "center",
  },
  photoPreviewWrap: {
    position: "relative",
    borderRadius: borderRadius.DEFAULT,
    overflow: "hidden",
  },
  photoPreview: {
    width: "100%",
    height: 200,
    borderRadius: borderRadius.DEFAULT,
  },
  removePhotoBtn: {
    position: "absolute",
    top: 8,
    right: 8,
    backgroundColor: "rgba(0,0,0,0.5)",
    borderRadius: 12,
  },
});
