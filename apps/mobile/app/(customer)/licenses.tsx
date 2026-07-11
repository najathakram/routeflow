import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  useBuyerAuthorizations,
  useSubmitBuyerAuthorization,
  type BuyerAuthorizationRow,
} from "../../lib/api/buyer";
import {
  canSubmitLicense,
  licenseCtaLabel,
  licenseStatusPill,
} from "../../lib/buyer-licenses-logic";
import { showToast } from "../../lib/toast";

/**
 * Buyer self-serve licenses: per regulated category, show the current status and
 * let the buyer submit / renew a license (number + expiry + share consent).
 * Mirrors web's buyer/portal/[seller]/licenses page.
 */
export default function BuyerLicensesScreen() {
  const router = useRouter();
  const { data: rows, isLoading } = useBuyerAuthorizations();
  const submitMut = useSubmitBuyerAuthorization();
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Licenses"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: 16, gap: 10 }}
      >
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : !rows || rows.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>No regulated categories require a license here.</Text>
          </View>
        ) : (
          rows.map((row) => (
            <LicenseCard
              key={row.trackedCategoryId}
              row={row}
              open={openId === row.trackedCategoryId}
              onToggle={() =>
                setOpenId((id) => (id === row.trackedCategoryId ? null : row.trackedCategoryId))
              }
              submitting={submitMut.isPending}
              onSubmit={(licenseNumber, expiresAt, shareConsent) =>
                submitMut.mutate(
                  {
                    trackedCategoryId: row.trackedCategoryId,
                    licenseNumber,
                    expiresAt,
                    shareConsent,
                  },
                  {
                    onSuccess: () => {
                      showToast("License submitted for review");
                      setOpenId(null);
                    },
                    onError: (e: any) =>
                      showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
                  },
                )
              }
            />
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function LicenseCard({
  row,
  open,
  onToggle,
  submitting,
  onSubmit,
}: {
  row: BuyerAuthorizationRow;
  open: boolean;
  onToggle: () => void;
  submitting: boolean;
  onSubmit: (licenseNumber: string, expiresAtIso: string, shareConsent: boolean) => void;
}) {
  const pill = licenseStatusPill(row.status);
  const canSubmit = canSubmitLicense(row.status);
  const [license, setLicense] = useState(row.licenseNumber ?? "");
  const [expiry, setExpiry] = useState(row.expiresAt ? row.expiresAt.slice(0, 10) : "");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    if (license.trim() === "") return setError("Enter the license number.");
    const raw = expiry.trim();
    const d = new Date(raw);
    // Require an exact YYYY-MM-DD that round-trips — `new Date("2026-02-30")`
    // silently rolls to Mar 2 rather than failing, which would submit a wrong date.
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(raw) ||
      Number.isNaN(d.getTime()) ||
      d.toISOString().slice(0, 10) !== raw
    ) {
      return setError("Enter a valid expiry as YYYY-MM-DD.");
    }
    if (d.getTime() < Date.now()) return setError("The expiry date is in the past.");
    if (!consent) return setError("You must consent to share this license with the seller.");
    onSubmit(license.trim(), d.toISOString(), true);
  };

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.catName} numberOfLines={1}>
            {row.categoryName}
          </Text>
          {row.expiresAt ? (
            <Text style={styles.meta}>Expires {row.expiresAt.slice(0, 10)}</Text>
          ) : null}
        </View>
        <Pill variant={pill.variant} dot>
          {pill.label}
        </Pill>
      </View>

      {canSubmit ? (
        <>
          <Pressable style={styles.ctaBtn} onPress={onToggle}>
            <Ionicons
              name={open ? "chevron-up" : "shield-checkmark-outline"}
              size={16}
              color={ios.brand}
            />
            <Text style={styles.ctaText}>{open ? "Cancel" : licenseCtaLabel(row.status)}</Text>
          </Pressable>
          {open ? (
            <View style={styles.form}>
              <Text style={styles.fieldLabel}>License number</Text>
              <TextInput
                style={styles.input}
                value={license}
                onChangeText={setLicense}
                placeholder="License / permit number"
                placeholderTextColor={ios.label3}
                autoCapitalize="characters"
              />
              <Text style={styles.fieldLabel}>Expiry date</Text>
              <TextInput
                style={styles.input}
                value={expiry}
                onChangeText={setExpiry}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={ios.label3}
                keyboardType="numbers-and-punctuation"
              />
              <View style={styles.consentRow}>
                <Switch
                  value={consent}
                  onValueChange={setConsent}
                  trackColor={{ true: ios.brand }}
                />
                <Text style={styles.consentText}>
                  I consent to share this license with the seller for verification.
                </Text>
              </View>
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <Pressable
                style={[styles.submitBtn, submitting && { opacity: 0.5 }]}
                disabled={submitting}
                onPress={submit}
              >
                <Text style={styles.submitText}>
                  {submitting ? "Submitting…" : "Submit license"}
                </Text>
              </Pressable>
            </View>
          ) : null}
        </>
      ) : (
        <Text style={styles.verifiedNote}>Verified — no action needed.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, textAlign: "center" },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14, gap: 10 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  catName: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  meta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  verifiedNote: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  ctaBtn: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start" },
  ctaText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.brand },
  form: { gap: 8 },
  fieldLabel: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: ios.label2 },
  input: {
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.label,
  },
  consentRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 2 },
  consentText: { flex: 1, fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  error: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.system.red },
  submitBtn: {
    backgroundColor: ios.brand,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 2,
  },
  submitText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
});
