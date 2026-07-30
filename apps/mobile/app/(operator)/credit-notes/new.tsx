import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill, SearchBar } from "@routeflow/ui/mobile/ios";
import { useAdminCustomers } from "../../../lib/api/admin";
import { useCreateCreditNote, useInvoicesForCustomer } from "../../../lib/api/credit-notes";
import { MoneyTextInput } from "../../../components/MoneyTextInput";
import { showToast } from "../../../lib/toast";

// A standalone credit needs no invoice at all; when one IS picked every status
// is fair game except these two dead ends (mirrors the web WP7 invoice picker).
const HIDDEN_INVOICE_STATUSES = new Set(["VOID", "WRITTEN_OFF"]);

function invoiceStatusPill(status: string): {
  variant: "brand" | "green" | "orange" | "red" | "gray";
  label: string;
} {
  switch (status) {
    case "DRAFT":
      return { variant: "gray", label: "Draft" };
    case "SENT":
      return { variant: "brand", label: "Sent" };
    case "VIEWED":
      return { variant: "brand", label: "Viewed" };
    case "PARTIAL":
      return { variant: "orange", label: "Partial" };
    case "PAID":
      return { variant: "green", label: "Paid" };
    case "OVERDUE":
      return { variant: "red", label: "Overdue" };
    default:
      return { variant: "gray", label: status };
  }
}

function fmtCurrency(n: number | string | undefined): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

export default function NewCreditNoteScreen() {
  const router = useRouter();
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState<string | null>(null);

  const handleBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/(operator)/credit-notes" as any);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      {!customerId ? (
        <CustomerPickerStep
          onBack={handleBack}
          onPick={(id, name) => {
            setCustomerId(id);
            setCustomerName(name);
          }}
        />
      ) : (
        <CreditNoteFormStep
          customerId={customerId}
          customerName={customerName}
          onChangeCustomer={() => {
            setCustomerId(null);
            setCustomerName(null);
          }}
          onCreated={(id) => router.replace(`/(operator)/credit-notes/${id}`)}
        />
      )}
    </SafeAreaView>
  );
}

// ─────────────────────── Step 1: customer (mirrors NewOrderScreen's CustomerPickerView) ───────────────────────

function CustomerPickerStep({
  onBack,
  onPick,
}: {
  onBack: () => void;
  onPick: (id: string, name: string) => void;
}) {
  const [search, setSearch] = useState("");
  const { data, isLoading } = useAdminCustomers({
    search: search.trim() || undefined,
    limit: 50,
  });
  const customers = data?.data ?? [];

  return (
    <>
      <NavBar
        inlineTitle="New Credit Note"
        leading={<NavBackButton label="Back" onPress={onBack} />}
      />
      <SearchBar placeholder="Search customers…" value={search} onChangeText={setSearch} />
      <ScrollView showsVerticalScrollIndicator={false}>
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : customers.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>
              {search ? "No customers match that search." : "No customers yet."}
            </Text>
          </View>
        ) : (
          <View style={styles.list}>
            {customers.map((c, i) => (
              <Pressable
                key={c.id}
                style={[
                  styles.customerRow,
                  i > 0 && {
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: ios.separator,
                  },
                ]}
                onPress={() => onPick(c.id, c.businessName)}
              >
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>
                    {c.businessName
                      .split(/\s+/)
                      .filter(Boolean)
                      .slice(0, 2)
                      .map((w) => w[0]?.toUpperCase() ?? "")
                      .join("") || "?"}
                  </Text>
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.customerName} numberOfLines={1}>
                    {c.businessName}
                  </Text>
                  {c.contactName || c.phone ? (
                    <Text style={styles.customerSub} numberOfLines={1}>
                      {[c.contactName, c.phone].filter(Boolean).join(" · ")}
                    </Text>
                  ) : null}
                </View>
                <Ionicons name="chevron-forward" size={16} color={ios.gray[3]} />
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </>
  );
}

// ─────────────────────── Step 2: amount, reason, expiry, optional invoice ───────────────────────

function CreditNoteFormStep({
  customerId,
  customerName,
  onChangeCustomer,
  onCreated,
}: {
  customerId: string;
  customerName: string | null;
  onChangeCustomer: () => void;
  onCreated: (id: string) => void;
}) {
  const createMut = useCreateCreditNote();
  const { data: invoicesData, isLoading: invoicesLoading } = useInvoicesForCustomer(customerId);
  const invoices = useMemo(
    () => (invoicesData?.data ?? []).filter((i) => !HIDDEN_INVOICE_STATUSES.has(i.status)),
    [invoicesData],
  );

  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (amount == null || amount <= 0) {
      setError("Enter a credit amount.");
      return;
    }
    if (!reason.trim()) {
      setError("Enter a reason for this credit.");
      return;
    }
    let isoExpiresAt: string | undefined;
    if (expiresAt.trim()) {
      const d = new Date(expiresAt.trim());
      if (Number.isNaN(d.getTime())) {
        setError("Enter the expiry as YYYY-MM-DD.");
        return;
      }
      isoExpiresAt = d.toISOString();
    }
    setError(null);
    createMut.mutate(
      {
        customerId,
        amount,
        reason: reason.trim(),
        invoiceId: invoiceId ?? undefined,
        expiresAt: isoExpiresAt,
      },
      {
        onSuccess: (created) => {
          showToast("Credit note created");
          onCreated(created.id);
        },
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  return (
    <>
      <NavBar
        inlineTitle="New Credit Note"
        leading={<NavBackButton label="Back" onPress={onChangeCustomer} />}
      />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.formBody}>
        <Pressable style={styles.customerChip} onPress={onChangeCustomer}>
          <Ionicons name="person-outline" size={14} color={ios.brand} />
          <Text style={styles.customerChipText} numberOfLines={1}>
            {customerName ?? "Customer"}
          </Text>
          <Text style={styles.customerChipChange}>Change</Text>
        </Pressable>

        <View>
          <Text style={styles.sectionTitle}>Amount</Text>
          <View style={[styles.card, styles.amountCard]}>
            <Text style={styles.amountCurrency}>$</Text>
            <MoneyTextInput
              value={amount}
              onChangeValue={setAmount}
              placeholder="0.00"
              style={styles.amountInput}
              returnKeyType="done"
            />
          </View>
        </View>

        <View>
          <Text style={styles.sectionTitle}>Reason</Text>
          <TextInput
            style={styles.notes}
            value={reason}
            onChangeText={setReason}
            placeholder="Why is this credit being issued?"
            placeholderTextColor={ios.label3}
            multiline
          />
        </View>

        <View>
          <Text style={styles.sectionTitle}>Expiry (optional)</Text>
          <TextInput
            style={styles.input}
            value={expiresAt}
            onChangeText={setExpiresAt}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={ios.label3}
            keyboardType="numbers-and-punctuation"
          />
        </View>

        <View>
          <Text style={styles.sectionTitle}>Invoice (optional)</Text>
          <View style={styles.card}>
            <Pressable
              style={[styles.invoiceRow, invoiceId == null && styles.invoiceRowActive]}
              onPress={() => setInvoiceId(null)}
            >
              <Text style={styles.invoiceRowText}>No invoice — standalone credit</Text>
              {invoiceId == null ? <Ionicons name="checkmark" size={16} color={ios.brand} /> : null}
            </Pressable>
            {invoicesLoading ? (
              <View style={styles.center}>
                <ActivityIndicator color={ios.brand} />
              </View>
            ) : invoices.length === 0 ? (
              <Text style={styles.emptyInvoices}>No invoices for this customer.</Text>
            ) : (
              invoices.map((inv) => {
                const active = invoiceId === inv.id;
                const s = invoiceStatusPill(inv.status);
                return (
                  <Pressable
                    key={inv.id}
                    style={[
                      styles.invoiceRow,
                      { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: ios.separator },
                      active && styles.invoiceRowActive,
                    ]}
                    onPress={() => setInvoiceId(active ? null : inv.id)}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.invoiceNum} numberOfLines={1}>
                        {inv.invoiceNumber}
                      </Text>
                      <Text style={styles.invoiceTotal}>{fmtCurrency(inv.total)}</Text>
                    </View>
                    <Pill variant={s.variant} small>
                      {s.label}
                    </Pill>
                    {active ? (
                      <Ionicons
                        name="checkmark"
                        size={16}
                        color={ios.brand}
                        style={{ marginLeft: 8 }}
                      />
                    ) : null}
                  </Pressable>
                );
              })
            )}
          </View>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable
          style={[styles.submitBtn, createMut.isPending && { opacity: 0.5 }]}
          disabled={createMut.isPending}
          onPress={submit}
        >
          <Text style={styles.submitText}>
            {createMut.isPending ? "Creating…" : "Create credit note"}
          </Text>
        </Pressable>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, textAlign: "center" },
  list: { paddingHorizontal: 16, gap: 8, paddingVertical: 8 },
  customerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    padding: 14,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 999,
    backgroundColor: ios.brandWash,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: ios.brand, fontSize: 13, fontFamily: "Inter_700Bold" },
  customerName: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  customerSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 1 },

  formBody: { padding: 16, gap: 14, paddingBottom: 32 },
  customerChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: ios.brandWash,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignSelf: "flex-start",
    maxWidth: "100%",
  },
  customerChipText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.brand,
    flexShrink: 1,
  },
  customerChipChange: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: ios.brand,
    opacity: 0.65,
    marginLeft: 6,
  },
  sectionTitle: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  card: { backgroundColor: ios.bgElev, borderRadius: 12, padding: 14 },
  amountCard: { flexDirection: "row", alignItems: "center", gap: 4 },
  amountCurrency: { fontSize: 28, fontFamily: "Inter_700Bold", color: ios.label },
  amountInput: {
    flex: 1,
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    padding: 0,
    fontVariant: ["tabular-nums"],
  },
  notes: {
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    padding: 12,
    minHeight: 64,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.label,
    textAlignVertical: "top",
  },
  input: {
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    padding: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.label,
  },
  invoiceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
  },
  invoiceRowActive: { backgroundColor: ios.brandWash, borderRadius: 10 },
  invoiceRowText: { flex: 1, fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  invoiceNum: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  invoiceTotal: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 1,
    fontVariant: ["tabular-nums"],
  },
  emptyInvoices: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    paddingVertical: 8,
  },
  error: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.system.red },
  submitBtn: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 4,
  },
  submitText: { color: "#fff", fontSize: 16, fontFamily: "Inter_600SemiBold" },
});
