/**
 * Customer-file Licenses — the mobile mirror of web's AuthorizationsTab.
 * Resolves in the field what previously needed a laptop: review a buyer's
 * PENDING submission (approve/reject — a pending license still BLOCKS the
 * sale guard), renew an expiring/expired license, or proactively add one
 * before an order is ever attempted.
 */
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavAction, NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  useApproveAuthorization,
  useCreateAuthorization,
  useCustomerAuthorizations,
  useRejectAuthorization,
  useRenewAuthorization,
  type CustomerAuthorization,
} from "../../../../lib/api/authorizations";
import { useTrackedCategories } from "../../../../lib/api/tracked-categories";
import {
  authSourceLabel,
  authStatusPill,
  authorizationActionFlags,
  displayAuthStatus,
  expiryPhrase,
  validateLicenseForm,
} from "../../../../lib/customer-authorizations-logic";
import { FormSheet, FormField, FormSection, FormTextInput } from "../../../../components/FormSheet";
import { OptionPickerSheet } from "../../../../components/OptionPickerSheet";
import { showToast } from "../../../../lib/toast";
import { confirm } from "../../../../lib/confirm";

/** Capture (mode=create) or renew (category fixed) a license. */
function LicenseSheet({
  customerId,
  renewOf,
  onClose,
}: {
  customerId: string;
  /** When set, this is a RENEW of that row — category locked, fields prefilled. */
  renewOf: CustomerAuthorization | null;
  onClose: () => void;
}) {
  const createAuth = useCreateAuthorization(customerId);
  const renewAuth = useRenewAuthorization(customerId);
  const { data: categories } = useTrackedCategories({ active: true });
  const licensed = useMemo(() => (categories ?? []).filter((c) => c.requiresLicense), [categories]);

  const [categoryId, setCategoryId] = useState(renewOf?.trackedCategoryId ?? "");
  const [licenseNumber, setLicenseNumber] = useState(renewOf?.licenseNumber ?? "");
  const [expiresAt, setExpiresAt] = useState(
    renewOf?.expiresAt ? String(renewOf.expiresAt).slice(0, 10) : "",
  );
  const [pickerOpen, setPickerOpen] = useState(false);

  const categoryName =
    renewOf?.trackedCategory.name ?? licensed.find((c) => c.id === categoryId)?.name ?? "";
  const submitting = createAuth.isPending || renewAuth.isPending;

  const submit = () => {
    if (!renewOf && !categoryId) {
      showToast("Pick the regulated category.");
      return;
    }
    const error = validateLicenseForm({ licenseNumber, expiresAt });
    if (error) {
      showToast(error);
      return;
    }
    const payload = {
      licenseNumber: licenseNumber.trim(),
      expiresAt: new Date(`${expiresAt.trim()}T23:59:59`).toISOString(),
    };
    const opts = {
      onSuccess: () => {
        showToast(renewOf ? "License renewed" : "License captured — customer verified");
        onClose();
      },
      onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
    };
    if (renewOf) renewAuth.mutate({ aid: renewOf.id, ...payload }, opts);
    else createAuth.mutate({ trackedCategoryId: categoryId, ...payload }, opts);
  };

  // FormSheet is a full-screen ROUTE container, not an overlay — hosting it in
  // a Modal keeps this sheet inline on the licenses screen (the
  // RecordAdvanceModal pattern) without a nav round-trip.
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <FormSheet
        title={renewOf ? "Renew license" : "Add license"}
        subtitle={
          renewOf
            ? `${categoryName} — the customer stays verified with the new expiry.`
            : "Captured licenses verify the customer immediately."
        }
        submitLabel={renewOf ? "Renew" : "Verify"}
        onSubmit={submit}
        onCancel={onClose}
        submitting={submitting}
        bottomInset
      >
        <FormSection>
          {!renewOf ? (
            <FormField label="Regulated category">
              <Pressable style={styles.pickerField} onPress={() => setPickerOpen(true)}>
                <Text style={categoryId ? styles.pickerValue : styles.pickerPlaceholder}>
                  {categoryName || "Choose…"}
                </Text>
              </Pressable>
            </FormField>
          ) : null}
          <FormField label="License number">
            <FormTextInput
              value={licenseNumber}
              onChangeText={setLicenseNumber}
              placeholder="As printed on the license"
              autoCapitalize="characters"
            />
          </FormField>
          <FormField label="Expires" hint="YYYY-MM-DD">
            <FormTextInput
              value={expiresAt}
              onChangeText={setExpiresAt}
              placeholder="2027-01-31"
              keyboardType="numbers-and-punctuation"
            />
          </FormField>
        </FormSection>

        <OptionPickerSheet
          visible={pickerOpen}
          title="Regulated category"
          options={licensed.map((c) => ({ id: c.id, label: c.name }))}
          selectedId={categoryId || undefined}
          onClose={() => setPickerOpen(false)}
          onSelect={(opt) => {
            setCategoryId(opt.id);
            setPickerOpen(false);
          }}
        />
      </FormSheet>
    </Modal>
  );
}

export default function CustomerLicensesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const customerId = id!;

  const { data, isLoading, isFetching, refetch, isError } = useCustomerAuthorizations(customerId);
  const approve = useApproveAuthorization(customerId);
  const reject = useRejectAuthorization(customerId);

  const [sheet, setSheet] = useState<{ renewOf: CustomerAuthorization | null } | null>(null);

  const rows = data ?? [];
  const onError = (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again.");

  const onApprove = (a: CustomerAuthorization) =>
    approve.mutate(a.id, {
      onSuccess: () => showToast(`${a.trackedCategory.name} license verified`),
      onError,
    });

  const onReject = (a: CustomerAuthorization) =>
    confirm(
      "Reject this license?",
      "The buyer will need to resubmit. This category stays locked for them until a license is verified.",
      () =>
        reject.mutate({ aid: a.id }, { onSuccess: () => showToast("License rejected"), onError }),
      { confirmText: "Reject", destructive: true },
    );

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Licenses"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        trailing={<NavAction label="Add" bold onPress={() => setSheet({ renewOf: null })} />}
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isFetching && !isLoading} onRefresh={refetch} />
        }
      >
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : isError ? (
          <View style={styles.center}>
            <Text style={styles.empty}>Couldn&apos;t load licenses. Pull to retry.</Text>
          </View>
        ) : rows.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>
              No licenses on file. Capture one before a regulated order gets blocked.
            </Text>
            <Pressable style={styles.emptyCta} onPress={() => setSheet({ renewOf: null })}>
              <Text style={styles.emptyCtaText}>Add license</Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 24, paddingTop: 8 }}>
            {rows.map((a) => {
              const status = displayAuthStatus(a);
              const pill = authStatusPill(status);
              const flags = authorizationActionFlags(status);
              const expiry = expiryPhrase(a.expiresAt);
              return (
                <View key={a.id} style={styles.row}>
                  <View style={styles.rowHead}>
                    <Text style={styles.title} numberOfLines={1}>
                      {a.trackedCategory.name}
                    </Text>
                    <Pill variant={pill.variant} dot>
                      {pill.label}
                    </Pill>
                  </View>
                  <Text style={styles.meta} numberOfLines={1}>
                    {authSourceLabel(a.source)}
                    {a.licenseNumber ? ` · #${a.licenseNumber}` : ""}
                    {expiry ? ` · ${expiry}` : ""}
                  </Text>
                  {a.verifiedByName && a.verifiedAt ? (
                    <Text style={styles.verified}>
                      Verified by {a.verifiedByName} on {String(a.verifiedAt).slice(0, 10)}
                    </Text>
                  ) : null}
                  {flags.canApprove || flags.canRenew ? (
                    <View style={styles.actionRow}>
                      {flags.canApprove ? (
                        <>
                          <Pressable
                            style={[styles.actionBtn, styles.actionPrimary]}
                            onPress={() => onApprove(a)}
                            disabled={approve.isPending}
                          >
                            <Text style={styles.actionPrimaryText}>Approve</Text>
                          </Pressable>
                          <Pressable
                            style={[styles.actionBtn, styles.actionDanger]}
                            onPress={() => onReject(a)}
                            disabled={reject.isPending}
                          >
                            <Text style={styles.actionDangerText}>Reject</Text>
                          </Pressable>
                        </>
                      ) : null}
                      {flags.canRenew ? (
                        <Pressable
                          style={[styles.actionBtn, styles.actionPrimary]}
                          onPress={() => setSheet({ renewOf: a })}
                        >
                          <Text style={styles.actionPrimaryText}>Renew</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>

      {sheet ? (
        <LicenseSheet
          customerId={customerId}
          renewOf={sheet.renewOf}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center", gap: 12 },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, textAlign: "center" },
  emptyCta: {
    backgroundColor: ios.brand,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  emptyCtaText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: "#fff" },
  row: { backgroundColor: ios.bgElev, borderRadius: 12, padding: 14 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  meta: { marginTop: 6, fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  verified: { marginTop: 3, fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label3 },
  actionRow: { flexDirection: "row", gap: 8, marginTop: 10 },
  actionBtn: {
    borderRadius: 9,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  actionPrimary: { backgroundColor: ios.brand },
  actionPrimaryText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#fff" },
  actionDanger: { backgroundColor: ios.fill3 },
  actionDangerText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.system.red },
  pickerField: {
    borderRadius: 10,
    backgroundColor: ios.fill3,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  pickerValue: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.label },
  pickerPlaceholder: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.label3 },
});
