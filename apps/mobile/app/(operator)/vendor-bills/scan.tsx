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
  useCheckVendorBillDuplicate,
  useCreateVendorBill,
  useSaveProductMapping,
  getDuplicateVendorBillError,
  type DuplicateVendorBillInfo,
  type PriorScanSummary,
} from "../../../lib/api/vendor-bills";
import { useSuppliers } from "../../../lib/api/purchase-orders";
import {
  buildBillDtoFromScan,
  duplicateBillPrompt,
  mappingsFromScan,
  priorScanPrompt,
  scanBillTotal,
  unmatchedCount,
  linkScanItem,
  applyLineEdit,
  type ScanBillDto,
  type ScanResultEx,
  type ScannedItemEx,
} from "../../../lib/vendor-bill-scan";
import { showToast } from "../../../lib/toast";
import { fmtCalendarDate } from "../../../lib/format-date";
import { chooseAction, confirm } from "../../../lib/confirm";
import { roundMoney } from "../../../lib/pricing";
import { ProductPickerSheet } from "../../../components/ProductPickerSheet";
import { InlineCreateProductSheet } from "../../../components/InlineCreateProductSheet";
import {
  LineEditSheet,
  type LineEditCommit,
  type LineEditLine,
} from "../../../components/LineEditSheet";
import type { CreatedProduct } from "../../../lib/api/products";

type Step = "upload" | "scanning" | "review";

export default function ScanInvoiceScreen() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("upload");
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<ScanResultEx | null>(null);
  const [editedResult, setEditedResult] = useState<ScanResultEx | null>(null);

  const scanMut = useScanInvoice();
  const createMut = useCreateVendorBill();
  const checkDuplicateMut = useCheckVendorBillDuplicate();
  const saveMappingMut = useSaveProductMapping();
  const { data: suppliers } = useSuppliers();

  const pickImage = async (useCamera: boolean) => {
    const result =
      useCamera && Platform.OS !== "web"
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.8 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8 });

    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    setImageUri(asset.uri);
    setStep("scanning");

    const formData = new FormData();
    // The API reads FilesInterceptor("images", …) — the field MUST be "images"
    // (the old "image" field silently delivered zero files to the scanner).
    formData.append("images", {
      uri: asset.uri,
      name: "invoice.jpg",
      type: asset.mimeType ?? "image/jpeg",
    } as any);

    scanMut.mutate(formData, {
      onSuccess: (data) => {
        setScanResult(data);
        setEditedResult(data);
        setStep("review");
        // Land on the review either way — the extraction is real work, already
        // done. The prompt only tells the operator where it came from.
        if (data.priorScan) announcePriorScan(data.priorScan);
      },
      onError: (e: any) => {
        setStep("upload");
        showToast(
          e?.response?.data?.message ??
            e?.message ??
            "Could not read invoice. Try a clearer photo.",
        );
      },
    });
  };

  /** Same shape as the duplicate alert: what happened last time, and the one
   *  action that follows from it. */
  const announcePriorScan = (prior: PriorScanSummary) => {
    const { title, message, billId, billLabel } = priorScanPrompt(prior);
    chooseAction(
      title,
      message,
      billId
        ? [
            {
              label: billLabel,
              onPress: () => router.replace(`/(operator)/vendor-bills/${billId}`),
            },
            { label: "Review anyway", style: "cancel" },
          ]
        : [{ label: "Continue" }],
    );
  };

  const promptDuplicate = (duplicate: DuplicateVendorBillInfo, dto: ScanBillDto) => {
    const { message, destructive } = duplicateBillPrompt(duplicate);
    chooseAction("Already scanned", message, [
      {
        label: "Open existing bill",
        onPress: () => router.replace(`/(operator)/vendor-bills/${duplicate.billId}`),
      },
      {
        label: "Create anyway",
        style: destructive ? "destructive" : "default",
        onPress: () => submitBill(dto, true),
      },
      { label: "Cancel", style: "cancel" },
    ]);
  };

  const submitBill = (dto: ScanBillDto, allowDuplicate?: boolean) => {
    createMut.mutate(allowDuplicate ? { ...dto, allowDuplicate: true } : dto, {
      onSuccess: (bill) => {
        showToast("Vendor bill created");
        router.replace(`/(operator)/vendor-bills/${bill.id}`);
      },
      onError: (e: any) => {
        // Covers the race the pre-flight probe can't see: a matching bill
        // created between the check and this POST.
        const dup = getDuplicateVendorBillError(e);
        if (dup) {
          promptDuplicate(dup.duplicate, dto);
          return;
        }
        showToast(e?.response?.data?.message ?? e?.message ?? "Try again.");
      },
    });
  };

  const onSave = async () => {
    if (!editedResult) return;

    // Save product mappings for AI to learn from
    for (const mapping of mappingsFromScan(editedResult)) {
      saveMappingMut.mutate(mapping);
    }

    const dto = buildBillDtoFromScan(editedResult, suppliers);
    const identifiable = !!dto.supplierInvoiceNumber || !!(dto.supplierId && dto.billDate);

    if (identifiable) {
      try {
        const { duplicate } = await checkDuplicateMut.mutateAsync({
          supplierId: dto.supplierId,
          supplierInvoiceNumber: dto.supplierInvoiceNumber,
          total: scanBillTotal(dto),
          billDate: dto.billDate,
        });
        if (duplicate) {
          promptDuplicate(duplicate, dto);
          return;
        }
      } catch {
        // A failed probe must never block the operator — create() re-checks
        // server-side and 409s, which submitBill handles.
      }
    }

    submitBill(dto);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={
          step === "upload" ? "Scan Invoice" : step === "scanning" ? "Scanning…" : "Review"
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
          checking={checkDuplicateMut.isPending}
          imageUri={imageUri}
          onOpenBill={(billId) => router.replace(`/(operator)/vendor-bills/${billId}`)}
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
        Add a receipt — take a photo or pick from your library. Our AI will extract the supplier,
        items, and totals automatically.
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

function ConfidenceDot({ confidence }: { confidence: ScannedItemEx["confidence"] }) {
  const color =
    confidence === "high"
      ? ios.system.greenInk
      : confidence === "medium"
        ? ios.system.orangeInk
        : ios.system.redInk;
  return <View style={[styles.confidenceDot, { backgroundColor: color }]} />;
}

/** The alert is a moment; this is the standing record of it. Amber when a bill
 *  already exists (a mistake to avoid), green when an abandoned review was
 *  simply restored (work already paid for). */
function PriorScanBanner({
  prior,
  onOpenBill,
}: {
  prior: PriorScanSummary;
  onOpenBill: (billId: string) => void;
}) {
  const { message, billId, billLabel } = priorScanPrompt(prior);
  const ink = billId ? ios.system.orangeInk : ios.system.greenInk;
  const wash = billId ? ios.system.orangeWash : ios.system.greenWash;
  return (
    <View style={[styles.priorBanner, { backgroundColor: wash }]}>
      <Ionicons
        name={billId ? "alert-circle" : "checkmark-circle"}
        size={16}
        color={ink}
        style={{ marginTop: 1 }}
      />
      <View style={{ flex: 1, gap: 6 }}>
        <Text style={[styles.priorBannerText, { color: ink }]}>{message}</Text>
        {billId ? (
          <Pressable onPress={() => onOpenBill(billId)}>
            <Text style={[styles.priorBannerLink, { color: ink }]}>{billLabel}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function ReviewStep({
  result,
  onChange,
  onSave,
  saving,
  checking,
  imageUri,
  onOpenBill,
}: {
  result: ScanResultEx;
  onChange: (r: ScanResultEx) => void;
  onSave: () => void;
  saving: boolean;
  checking: boolean;
  imageUri: string | null;
  onOpenBill: (billId: string) => void;
}) {
  // Row index whose "link existing product" picker / "create product" sheet /
  // "edit line" sheet is open (mutually exclusive).
  const [linkFor, setLinkFor] = useState<number | null>(null);
  const [createFor, setCreateFor] = useState<number | null>(null);
  const [editFor, setEditFor] = useState<number | null>(null);
  const unmatched = unmatchedCount(result);

  const applyLink = (index: number, productId: string, productName: string) => {
    onChange(linkScanItem(result, index, productId, productName));
  };

  const applyEdit = (index: number, commit: LineEditCommit) => {
    onChange(
      applyLineEdit(
        result,
        index,
        commit.snap,
        commit.unit,
        commit.piecesPerBox,
        commit.catalogUnitsPerBox,
      ),
    );
  };

  const editLine: LineEditLine | null =
    editFor != null && result.items[editFor]
      ? {
          extractedName: result.items[editFor].extractedName,
          qty: result.items[editFor].qty ?? 0,
          unitCost: result.items[editFor].unitCost ?? 0,
          packSize: result.items[editFor].packSize,
          matchedProductId: result.items[editFor].matchedProductId,
        }
      : null;

  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      {imageUri ? (
        <Image source={{ uri: imageUri }} style={styles.reviewImg} resizeMode="cover" />
      ) : null}

      {result.priorScan ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
          <PriorScanBanner prior={result.priorScan} onOpenBill={onOpenBill} />
        </View>
      ) : null}

      <View style={styles.reviewSection}>
        <Text style={styles.reviewSectionTitle}>Extracted details</Text>
        <View style={styles.detailCard}>
          <DetailRow label="Supplier" value={result.supplier ?? "—"} />
          <DetailRow label="Invoice #" value={result.invoiceNumber ?? "—"} />
          <DetailRow
            label="Date"
            value={result.invoiceDate ? fmtCalendarDate(result.invoiceDate) : "—"}
          />
          <DetailRow
            label="Total"
            value={result.total != null ? `$${result.total.toFixed(2)}` : "—"}
          />
        </View>
      </View>

      {result.items.length > 0 ? (
        <View style={styles.reviewSection}>
          <Text style={styles.reviewSectionTitle}>Line items ({result.items.length})</Text>

          {unmatched > 0 ? (
            <View style={styles.unmatchedBanner}>
              <Ionicons name="alert-circle" size={16} color={ios.system.orangeInk} />
              <Text style={styles.unmatchedText}>
                {unmatched} item{unmatched === 1 ? "" : "s"} didn&apos;t match a product. Link or
                create each so it updates stock — unlinked lines won&apos;t restock.
              </Text>
            </View>
          ) : null}

          <View style={styles.itemsCard}>
            {result.items.map((item, i) => {
              const isMatched = !!item.matchedProductId;
              return (
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
                      {item.matchedProductName ?? item.extractedName}
                    </Text>
                    <Text style={styles.reviewItemMeta}>
                      {item.qty != null ? `${item.qty} × ` : ""}
                      {item.unitCost != null ? `$${item.unitCost.toFixed(2)}` : ""}
                      {isMatched && item.matchedProductName ? " · linked" : ""}
                      {item.matchSource === "alias" || item.matchSource === "memory"
                        ? " · remembered"
                        : ""}
                    </Text>
                    <View style={styles.lineActions}>
                      {!isMatched ? (
                        <>
                          <Pressable style={styles.lineActionBtn} onPress={() => setLinkFor(i)}>
                            <Ionicons name="link" size={13} color={ios.brand} />
                            <Text style={styles.lineActionText}>Link</Text>
                          </Pressable>
                          <Pressable style={styles.lineActionBtn} onPress={() => setCreateFor(i)}>
                            <Ionicons name="add-circle-outline" size={13} color={ios.brand} />
                            <Text style={styles.lineActionText}>Create</Text>
                          </Pressable>
                        </>
                      ) : (
                        <Pressable style={styles.lineActionBtn} onPress={() => setLinkFor(i)}>
                          <Ionicons name="swap-horizontal" size={13} color={ios.label2} />
                          <Text style={[styles.lineActionText, { color: ios.label2 }]}>Change</Text>
                        </Pressable>
                      )}
                      <Pressable style={styles.lineActionBtn} onPress={() => setEditFor(i)}>
                        <Ionicons name="create-outline" size={13} color={ios.label2} />
                        <Text style={[styles.lineActionText, { color: ios.label2 }]}>Edit</Text>
                      </Pressable>
                    </View>
                    {!isMatched && item.candidates?.length ? (
                      <View style={styles.candidateChips}>
                        {item.candidates.slice(0, 3).map((c) => (
                          <Pressable
                            key={c.productId}
                            style={styles.candidateChip}
                            onPress={() => applyLink(i, c.productId, c.name)}
                          >
                            <Text style={styles.candidateChipText} numberOfLines={1}>
                              Did you mean {c.name}? ({Math.round(c.score * 100)}%)
                            </Text>
                          </Pressable>
                        ))}
                      </View>
                    ) : null}
                  </View>
                  {item.lineTotal != null ? (
                    <Text style={styles.reviewItemTotal}>${item.lineTotal.toFixed(2)}</Text>
                  ) : null}
                </View>
              );
            })}
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
        <Pressable style={styles.saveBtn} onPress={onSave} disabled={saving || checking}>
          <Ionicons name="checkmark" size={16} color="#fff" />
          <Text style={styles.saveBtnText}>
            {checking ? "Checking…" : saving ? "Creating bill…" : "Create vendor bill"}
          </Text>
        </Pressable>
      </View>

      <ProductPickerSheet
        visible={linkFor != null}
        title="Link to product"
        selectedId={
          linkFor != null ? (result.items[linkFor]?.matchedProductId ?? undefined) : undefined
        }
        onClose={() => setLinkFor(null)}
        onSelect={(p) => {
          if (linkFor != null)
            applyLink(linkFor, p.id, p.parent?.name ? `${p.parent.name} - ${p.name}` : p.name);
          setLinkFor(null);
        }}
      />

      <InlineCreateProductSheet
        visible={createFor != null}
        initialName={createFor != null ? result.items[createFor]?.extractedName : undefined}
        initialCode={createFor != null ? (result.items[createFor]?.sku ?? undefined) : undefined}
        initialPrice={
          createFor != null && (result.items[createFor]?.unitCost ?? 0) > 0
            ? roundMoney((result.items[createFor]!.unitCost as number) * 1.3)
            : undefined
        }
        initialCost={
          createFor != null ? (result.items[createFor]?.unitCost ?? undefined) : undefined
        }
        initialUnitsPerBox={
          createFor != null ? (result.items[createFor]?.packSize ?? undefined) : undefined
        }
        onClose={() => setCreateFor(null)}
        onCreated={(product: CreatedProduct) => {
          if (createFor != null) applyLink(createFor, product.id, product.name);
          setCreateFor(null);
        }}
      />

      <LineEditSheet
        visible={editFor != null}
        line={editLine}
        onClose={() => setEditFor(null)}
        onSave={(commit) => {
          if (editFor != null) applyEdit(editFor, commit);
          setEditFor(null);
        }}
      />
    </ScrollView>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue} numberOfLines={1}>
        {value}
      </Text>
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
  reviewSectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
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
  detailValue: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: ios.label,
    flex: 1,
    textAlign: "right",
  },
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
  reviewItemTotal: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  priorBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    borderRadius: 10,
    padding: 10,
  },
  priorBannerText: { fontSize: 12, fontFamily: "Inter_500Medium", lineHeight: 16 },
  priorBannerLink: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    textDecorationLine: "underline",
  },
  unmatchedBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: ios.system.orangeWash,
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
  },
  unmatchedText: {
    flex: 1,
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: ios.system.orangeInk,
    lineHeight: 16,
  },
  lineActions: { flexDirection: "row", gap: 12, marginTop: 6 },
  lineActionBtn: { flexDirection: "row", alignItems: "center", gap: 3, marginTop: 6 },
  lineActionText: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: ios.brand },
  candidateChips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  candidateChip: {
    backgroundColor: ios.brandWash,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    maxWidth: "100%",
  },
  candidateChipText: { fontSize: 11, fontFamily: "Inter_500Medium", color: ios.brand },
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
