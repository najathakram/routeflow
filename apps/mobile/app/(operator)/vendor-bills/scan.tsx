import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import {
  useScanInvoice,
  useCreateVendorBill,
  useSaveProductMapping,
  type ScanResult,
  type ScannedItem,
} from "../../../lib/api/vendor-bills";
import { useSuppliers } from "../../../lib/api/purchase-orders";
import { showToast } from "../../../lib/toast";
import { confirm } from "../../../lib/confirm";

type Step = "upload" | "scanning" | "review";

export default function ScanInvoiceScreen() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("upload");
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [editedResult, setEditedResult] = useState<ScanResult | null>(null);

  const scanMut = useScanInvoice();
  const createMut = useCreateVendorBill();
  const saveMappingMut = useSaveProductMapping();
  const { data: suppliers } = useSuppliers();

  const pickImage = async (useCamera: boolean) => {
    const result = (useCamera && Platform.OS !== "web")
      ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.8 })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8 });

    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    setImageUri(asset.uri);
    setStep("scanning");

    const formData = new FormData();
    formData.append("image", {
      uri: asset.uri,
      name: "invoice.jpg",
      type: asset.mimeType ?? "image/jpeg",
    } as any);

    scanMut.mutate(formData, {
      onSuccess: (data) => {
        setScanResult(data);
        setEditedResult(data);
        setStep("review");
      },
      onError: (e: any) => {
        setStep("upload");
        showToast(e?.response?.data?.message ?? e?.message ?? "Could not read invoice. Try a clearer photo.");
      },
    });
  };

  const onSave = () => {
    if (!editedResult) return;

    // Save product mappings for AI to learn from
    const supplierName = editedResult.supplierName ?? "";
    for (const item of editedResult.items) {
      if (item.productId && supplierName) {
        saveMappingMut.mutate({
          supplierName,
          rawDescription: item.description,
          productId: item.productId,
        });
      }
    }

    const matchedSupplier = suppliers?.find(
      (s) => s.name.toLowerCase() === (editedResult.supplierName ?? "").toLowerCase(),
    );

    const dto: any = {
      supplierId: editedResult.supplierId ?? matchedSupplier?.id,
      billDate: editedResult.billDate,
      notes: editedResult.supplierName
        ? `AI scanned from ${editedResult.supplierName}`
        : undefined,
      items: editedResult.items
        .filter((i) => (i.qty ?? 0) > 0 || (i.unitCost ?? 0) > 0)
        .map((i) => ({
          description: i.description,
          productId: i.productId,
          qty: i.qty ?? 1,
          unitCost: i.unitCost ?? 0,
        })),
    };

    createMut.mutate(dto, {
      onSuccess: (bill) => {
        showToast("Vendor bill created");
        router.replace(`/(operator)/vendor-bills/${bill.id}`);
      },
      onError: (e: any) =>
        showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
    });
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={
          step === "upload"
            ? "Scan Invoice"
            : step === "scanning"
              ? "Scanning…"
              : "Review"
        }
        leading={
          <NavBackButton
            label="Cancel"
            onPress={() => {
              if (step === "review") {
                confirm("Discard scan?", "Your scanned data will be lost.", () => router.back(), {
                  confirmText: "Discard",
                  destructive: true,
                });
              } else {
                router.back();
              }
            }}
          />
        }
      />

      {step === "upload" ? (
        <UploadStep onPickImage={pickImage} />
      ) : step === "scanning" ? (
        <ScanningStep imageUri={imageUri} />
      ) : editedResult ? (
        <ReviewStep
          result={editedResult}
          onChange={setEditedResult}
          onSave={onSave}
          saving={createMut.isPending}
          imageUri={imageUri}
        />
      ) : null}
    </SafeAreaView>
  );
}

function UploadStep({ onPickImage }: { onPickImage: (camera: boolean) => void }) {
  const handleAddReceipt = () => {
    if (Platform.OS === "web") {
      // No camera in browser — go straight to file picker (which on mobile
      // browsers exposes the device camera as one of the file sources).
      onPickImage(false);
      return;
    }
    Alert.alert(
      "Add receipt",
      "Choose how to add your receipt image.",
      [
        { text: "Take photo", onPress: () => onPickImage(true) },
        { text: "Choose from library", onPress: () => onPickImage(false) },
        { text: "Cancel", style: "cancel" },
      ],
      { cancelable: true },
    );
  };

  return (
    <View style={styles.uploadStep}>
      <View style={styles.uploadIllustration}>
        <Ionicons name="document-text-outline" size={64} color={ios.brand} />
      </View>
      <Text style={styles.uploadTitle}>Scan a vendor invoice</Text>
      <Text style={styles.uploadSub}>
        Add a receipt — take a photo or pick from your library. Our AI will
        extract the supplier, items, and totals automatically.
      </Text>
      <Pressable
        style={[styles.uploadBtn, { backgroundColor: ios.brand }]}
        onPress={handleAddReceipt}
      >
        <Ionicons name="add-circle-outline" size={20} color="#fff" />
        <Text style={styles.uploadBtnText}>Add receipt</Text>
      </Pressable>
    </View>
  );
}

function ScanningStep({ imageUri }: { imageUri: string | null }) {
  return (
    <View style={styles.scanningStep}>
      {imageUri ? (
        <Image source={{ uri: imageUri }} style={styles.previewImg} resizeMode="cover" />
      ) : null}
      <View style={styles.scanningOverlay}>
        <ActivityIndicator size="large" color={ios.brand} />
        <Text style={styles.scanningTitle}>AI is reading your invoice…</Text>
        <Text style={styles.scanningSub}>This usually takes 10–20 seconds.</Text>
      </View>
    </View>
  );
}

function ConfidenceDot({ confidence }: { confidence: ScannedItem["confidence"] }) {
  const color =
    confidence === "high"
      ? ios.system.greenInk
      : confidence === "medium"
        ? ios.system.orangeInk
        : ios.system.redInk;
  return (
    <View style={[styles.confidenceDot, { backgroundColor: color }]} />
  );
}

function ReviewStep({
  result,
  onSave,
  saving,
  imageUri,
}: {
  result: ScanResult;
  onChange: (r: ScanResult) => void;
  onSave: () => void;
  saving: boolean;
  imageUri: string | null;
}) {
  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      {imageUri ? (
        <Image source={{ uri: imageUri }} style={styles.reviewImg} resizeMode="cover" />
      ) : null}

      <View style={styles.reviewSection}>
        <Text style={styles.reviewSectionTitle}>Extracted details</Text>
        <View style={styles.detailCard}>
          <DetailRow label="Supplier" value={result.supplierName ?? "—"} />
          <DetailRow label="Invoice #" value={result.invoiceNumber ?? "—"} />
          <DetailRow
            label="Date"
            value={
              result.billDate
                ? new Date(result.billDate).toLocaleDateString()
                : "—"
            }
          />
          <DetailRow
            label="Total"
            value={result.total != null ? `$${result.total.toFixed(2)}` : "—"}
          />
        </View>
      </View>

      {result.items.length > 0 ? (
        <View style={styles.reviewSection}>
          <Text style={styles.reviewSectionTitle}>
            Line items ({result.items.length})
          </Text>
          <View style={styles.itemsCard}>
            {result.items.map((item, i) => (
              <View
                key={i}
                style={[
                  styles.reviewItemRow,
                  i > 0 && {
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: ios.separator,
                  },
                ]}
              >
                <ConfidenceDot confidence={item.confidence} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.reviewItemName} numberOfLines={1}>
                    {item.productName ?? item.description}
                  </Text>
                  <Text style={styles.reviewItemMeta}>
                    {item.qty != null ? `${item.qty} × ` : ""}
                    {item.unitCost != null ? `$${item.unitCost.toFixed(2)}` : ""}
                  </Text>
                </View>
                {item.lineTotal != null ? (
                  <Text style={styles.reviewItemTotal}>
                    ${item.lineTotal.toFixed(2)}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
          <View style={styles.confidenceLegend}>
            <View style={[styles.confidenceDot, { backgroundColor: ios.system.greenInk }]} />
            <Text style={styles.legendText}>High match</Text>
            <View style={[styles.confidenceDot, { backgroundColor: ios.system.orangeInk }]} />
            <Text style={styles.legendText}>Partial match</Text>
            <View style={[styles.confidenceDot, { backgroundColor: ios.system.redInk }]} />
            <Text style={styles.legendText}>No match</Text>
          </View>
        </View>
      ) : null}

      <View style={{ paddingHorizontal: 16, paddingBottom: 32 }}>
        <Pressable
          style={styles.saveBtn}
          onPress={onSave}
          disabled={saving}
        >
          <Ionicons name="checkmark" size={16} color="#fff" />
          <Text style={styles.saveBtnText}>
            {saving ? "Creating bill…" : "Create vendor bill"}
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  uploadStep: {
    flex: 1,
    paddingHorizontal: 32,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  uploadIllustration: {
    width: 100,
    height: 100,
    borderRadius: 24,
    backgroundColor: ios.brandWash,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  uploadTitle: { fontSize: 22, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.4 },
  uploadSub: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 8,
  },
  uploadBtn: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 14,
  },
  uploadBtnText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
  scanningStep: { flex: 1, position: "relative" },
  previewImg: { width: "100%", height: 300 },
  scanningOverlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingVertical: 40,
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  scanningTitle: { fontSize: 18, fontFamily: "Inter_600SemiBold", color: "#fff" },
  scanningSub: { fontSize: 14, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.8)" },
  reviewImg: { width: "100%", height: 180 },
  reviewSection: { padding: 16, gap: 8 },
  reviewSectionTitle: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label2, letterSpacing: 0.4, textTransform: "uppercase" },
  detailCard: { backgroundColor: ios.bgElev, borderRadius: 12, overflow: "hidden" },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  detailLabel: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label2 },
  detailValue: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label, flex: 1, textAlign: "right" },
  itemsCard: { backgroundColor: ios.bgElev, borderRadius: 12, overflow: "hidden" },
  reviewItemRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
  },
  confidenceDot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  reviewItemName: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  reviewItemMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  reviewItemTotal: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label, fontVariant: ["tabular-nums"] },
  confidenceLegend: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingTop: 8,
    paddingHorizontal: 4,
    flexWrap: "wrap",
  },
  legendText: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginRight: 8 },
  saveBtn: {
    backgroundColor: ios.brand,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 16,
    borderRadius: 14,
  },
  saveBtnText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
});
