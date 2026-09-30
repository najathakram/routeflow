import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  Pressable,
  RefreshControl,
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
import { NavAction, NavBackButton, NavBar, Pill, type PillVariant } from "@routeflow/ui/mobile/ios";
import {
  useSupplierStatements,
  useScanStatement,
  getStatementAiError,
  type SupplierStatementScanStatus,
  type SupplierStatementScanSummary,
} from "../../../lib/api/supplier-statements";

// This screen can capture (upload or photograph) a supplier statement and read
// a scan's status and applied result. It does NOT host the reconciliation
// review grid — a dense line-by-line match table earns a desktop. After a
// capture succeeds, the operator is pointed at the web dashboard to review.

type Step = "list" | "scanning" | "result" | "error";

interface PickedAsset {
  uri: string;
  mimeType?: string | null;
  name: string;
}

interface DescribedScanError {
  title: string;
  message: string;
  canRetry: boolean;
}

/** Maps the four typed AI error codes to operator-facing copy. Retry is only
 *  ever offered for AI_UNAVAILABLE — the other three need a different file, a
 *  configured key, or are left for the web review screen to sort out, not a
 *  blind resubmit. */
function describeStatementScanError(error: unknown): DescribedScanError {
  const { code, message } = getStatementAiError(error);
  switch (code) {
    case "AI_KEY_INVALID":
      return {
        title: "Anthropic API key not configured",
        message: "Add it in Settings on the web dashboard, then try again.",
        canRetry: false,
      };
    case "AI_UNAVAILABLE":
      return {
        title: "AI is temporarily unavailable",
        message: message || "The scanning service is busy or unreachable. Try again in a moment.",
        canRetry: true,
      };
    case "AI_SCAN_REJECTED":
      return {
        title: "Couldn't read this statement",
        message: message || "Try a clearer photo or a different file.",
        canRetry: false,
      };
    case "AI_PARSE_FAILED":
      return {
        title: "Couldn't make sense of the result",
        message: message || "The AI's response didn't come back as expected. Try again.",
        canRetry: false,
      };
    default:
      return {
        title: "Couldn't scan statement",
        message: message || "Try a clearer photo or a different file.",
        canRetry: false,
      };
  }
}

function formatMoney(n: number | string | null | undefined): string {
  if (n == null) return "—";
  const v = typeof n === "string" ? Number(n) : n;
  return Number.isFinite(v) ? `$${v.toFixed(2)}` : "—";
}

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatPeriod(start: string | null | undefined, end: string | null | undefined): string {
  const a = formatDate(start);
  const b = formatDate(end);
  if (a && b) return `${a} – ${b}`;
  return a ?? b ?? "—";
}

function statusPill(status: SupplierStatementScanStatus): { variant: PillVariant; label: string } {
  switch (status) {
    case "SCANNED":
      return { variant: "orange", label: "Needs review" };
    case "APPLIED":
      return { variant: "green", label: "Applied" };
    case "DISCARDED":
      return { variant: "gray", label: "Discarded" };
  }
}

export default function SupplierStatementsScreen() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("list");
  const [pendingAsset, setPendingAsset] = useState<PickedAsset | null>(null);
  const [lastResult, setLastResult] = useState<SupplierStatementScanSummary | null>(null);
  const [scanError, setScanError] = useState<DescribedScanError | null>(null);

  const { data, isLoading, isFetching, refetch } = useSupplierStatements({ limit: 30 });
  const scans = data?.data ?? [];
  const scanMut = useScanStatement();

  const submitAsset = (asset: PickedAsset) => {
    setPendingAsset(asset);
    setStep("scanning");

    const formData = new FormData();
    // Field name is "files" (a statement page can be a PDF or an image,
    // unlike the invoice scanner's all-image "images" field) — matches the
    // web client's `scanStatement`, which hits this same endpoint.
    formData.append("files", {
      uri: asset.uri,
      name: asset.name,
      type: asset.mimeType ?? "image/jpeg",
    } as any);

    scanMut.mutate(formData, {
      onSuccess: (result) => {
        setLastResult(result);
        setStep("result");
      },
      onError: (err) => {
        setScanError(describeStatementScanError(err));
        setStep("error");
      },
    });
  };

  const pickImage = async (useCamera: boolean) => {
    const result =
      useCamera && Platform.OS !== "web"
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.8 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8 });

    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    submitAsset({ uri: asset.uri, mimeType: asset.mimeType, name: "statement.jpg" });
  };

  const handleAdd = () => {
    if (Platform.OS === "web") {
      // No camera in browser — go straight to the file picker (which on
      // mobile browsers exposes the device camera as one of the sources).
      pickImage(false);
      return;
    }
    Alert.alert(
      "Add statement",
      "Choose how to add the supplier statement.",
      [
        { text: "Take photo", onPress: () => pickImage(true) },
        { text: "Choose from library", onPress: () => pickImage(false) },
        { text: "Cancel", style: "cancel" },
      ],
      { cancelable: true },
    );
  };

  const backToList = () => {
    setStep("list");
    setPendingAsset(null);
    setLastResult(null);
    setScanError(null);
    refetch();
  };

  const retry = () => {
    if (pendingAsset) submitAsset(pendingAsset);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={
          step === "list"
            ? "Supplier Statements"
            : step === "scanning"
              ? "Scanning…"
              : step === "result"
                ? "Statement captured"
                : "Couldn't scan"
        }
        leading={
          step === "list" ? (
            <NavBackButton label="Finance" onPress={() => router.back()} />
          ) : (
            <NavBackButton label={step === "result" ? "Close" : "Cancel"} onPress={backToList} />
          )
        }
        trailing={step === "list" ? <NavAction label="Add" bold onPress={handleAdd} /> : undefined}
      />

      {step === "list" ? (
        <ListStep
          scans={scans}
          isLoading={isLoading}
          isFetching={isFetching}
          onRefresh={refetch}
          onAdd={handleAdd}
        />
      ) : step === "scanning" ? (
        <ScanningStep imageUri={pendingAsset?.uri ?? null} />
      ) : step === "result" && lastResult ? (
        <ResultStep result={lastResult} onDone={backToList} />
      ) : step === "error" && scanError ? (
        <ErrorStep
          error={scanError}
          onRetry={scanError.canRetry ? retry : undefined}
          onBack={backToList}
        />
      ) : null}
    </SafeAreaView>
  );
}

function ListStep({
  scans,
  isLoading,
  isFetching,
  onRefresh,
  onAdd,
}: {
  scans: SupplierStatementScanSummary[];
  isLoading: boolean;
  isFetching: boolean;
  onRefresh: () => void;
  onAdd: () => void;
}) {
  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl refreshing={isFetching && !isLoading} onRefresh={onRefresh} />
      }
    >
      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      ) : scans.length === 0 ? (
        <View style={styles.center}>
          <View style={styles.uploadIllustration}>
            <Ionicons name="document-text-outline" size={48} color={ios.brand} />
          </View>
          <Text style={styles.empty}>No statements yet.</Text>
          <Text style={styles.emptySub}>
            Upload or photograph a supplier statement — our AI will read it, then it will be ready
            to reconcile on the web dashboard.
          </Text>
          <Pressable style={styles.primaryBtn} onPress={onAdd}>
            <Ionicons name="add-circle-outline" size={16} color="#fff" />
            <Text style={styles.primaryBtnText}>Add statement</Text>
          </Pressable>
        </View>
      ) : (
        <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 8, paddingBottom: 32 }}>
          {scans.map((s) => (
            <StatementRow key={s.id} scan={s} />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function StatementRow({ scan }: { scan: SupplierStatementScanSummary }) {
  const pill = statusPill(scan.status);
  const applied = formatDate(scan.appliedAt);
  return (
    <View style={styles.row}>
      <View style={styles.rowHead}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {scan.supplierNameRaw ?? "Unknown supplier"}
          </Text>
          <Text style={styles.rowSub} numberOfLines={1}>
            {formatPeriod(scan.periodStart, scan.periodEnd)}
          </Text>
        </View>
        <Pill variant={pill.variant} dot>
          {pill.label}
        </Pill>
      </View>
      <View style={styles.rowFoot}>
        <Text style={styles.rowTotal}>{formatMoney(scan.closingBalance)}</Text>
        {scan.status === "APPLIED" && applied ? (
          <Text style={styles.appliedNote}>Applied {applied}</Text>
        ) : (
          <Text style={styles.rowSub}>
            {scan.lineCount != null ? `${scan.lineCount} lines` : ""}
          </Text>
        )}
      </View>
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
        <Text style={styles.scanningTitle}>AI is reading your statement…</Text>
        <Text style={styles.scanningSub}>This can take up to a minute.</Text>
      </View>
    </View>
  );
}

function ResultStep({
  result,
  onDone,
}: {
  result: SupplierStatementScanSummary;
  onDone: () => void;
}) {
  return (
    <ScrollView contentContainerStyle={styles.centerStep} showsVerticalScrollIndicator={false}>
      <View style={styles.resultIllustration}>
        <Ionicons name="checkmark-circle" size={56} color={ios.system.greenInk} />
      </View>
      <Text style={styles.resultTitle}>Ready to review on the web dashboard</Text>
      <Text style={styles.resultSub}>
        We read this statement. Matching it against your bills — and applying it — happens on the
        review screen on the desktop.
      </Text>
      <View style={styles.detailCard}>
        <DetailRow label="Supplier" value={result.supplierNameRaw ?? "—"} />
        <DetailRow label="Period" value={formatPeriod(result.periodStart, result.periodEnd)} />
        <DetailRow label="Opening balance" value={formatMoney(result.openingBalance)} />
        <DetailRow label="Closing balance" value={formatMoney(result.closingBalance)} />
        <DetailRow
          label="Lines"
          value={result.lineCount != null ? String(result.lineCount) : "—"}
        />
      </View>
      <Pressable style={styles.saveBtn} onPress={onDone}>
        <Text style={styles.saveBtnText}>Done</Text>
      </Pressable>
    </ScrollView>
  );
}

function ErrorStep({
  error,
  onRetry,
  onBack,
}: {
  error: DescribedScanError;
  onRetry?: () => void;
  onBack: () => void;
}) {
  return (
    <ScrollView contentContainerStyle={styles.centerStep} showsVerticalScrollIndicator={false}>
      <View style={[styles.resultIllustration, { backgroundColor: ios.system.redWash }]}>
        <Ionicons name="alert-circle" size={56} color={ios.system.redInk} />
      </View>
      <Text style={styles.resultTitle}>{error.title}</Text>
      <Text style={styles.resultSub}>{error.message}</Text>
      {onRetry ? (
        <Pressable style={styles.saveBtn} onPress={onRetry}>
          <Ionicons name="refresh" size={16} color="#fff" />
          <Text style={styles.saveBtnText}>Retry</Text>
        </Pressable>
      ) : null}
      <Pressable style={styles.secondaryBtn} onPress={onBack}>
        <Text style={styles.secondaryBtnText}>Back to statements</Text>
      </Pressable>
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
  center: { padding: 40, alignItems: "center", gap: 12 },
  centerStep: { flexGrow: 1, padding: 32, alignItems: "center", justifyContent: "center", gap: 10 },
  uploadIllustration: {
    width: 88,
    height: 88,
    borderRadius: 22,
    backgroundColor: ios.brandWash,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  empty: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: ios.label },
  emptySub: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
    lineHeight: 18,
    paddingHorizontal: 8,
  },
  primaryBtn: {
    backgroundColor: ios.brand,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    marginTop: 4,
  },
  primaryBtnText: { color: "#fff", fontSize: 14, fontFamily: "Inter_600SemiBold" },
  row: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  rowTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  rowSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  rowFoot: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  rowTotal: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  appliedNote: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: ios.system.greenInk },
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
  resultIllustration: {
    width: 96,
    height: 96,
    borderRadius: 24,
    backgroundColor: ios.system.greenWash,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  resultTitle: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    textAlign: "center",
    letterSpacing: -0.3,
  },
  resultSub: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 4,
  },
  detailCard: {
    width: "100%",
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    overflow: "hidden",
    marginTop: 8,
  },
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
  saveBtn: {
    width: "100%",
    backgroundColor: ios.brand,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 16,
    borderRadius: 14,
    marginTop: 16,
  },
  saveBtnText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
  secondaryBtn: { paddingVertical: 14, alignItems: "center" },
  secondaryBtnText: { color: ios.brand, fontSize: 14, fontFamily: "Inter_600SemiBold" },
});
