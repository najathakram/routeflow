// Operator inline-return screen: lines -> quote -> confirm -> result. Mirrors the web
// RecordInlineReturnDialog (PR #1250): same endpoints/DTOs (@routeflow/types), state logic from
// @routeflow/returns, decision logic in lib/inline-return-screen.ts. The quote is rendered
// exactly as the server returned it — no client-side money math. `returnKey` comes from the
// persisted, offline-queue-safe nonce store, never minted per render.
import { useReducer, useState } from "react";
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
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, SearchBar } from "@routeflow/ui/mobile/ios";
import {
  applyCoveredPiecesToLines,
  buildCaptureRequest,
  buildQuoteRequest,
  DEFAULT_EXCESS_OPTION,
  dropExcessAndRequote,
  extractRefusalMessage,
  groupQuoteChunks,
  isBoxedProduct,
  sumChunkTotals,
  type ExcessOption,
  type InlineReturnLineDraft,
} from "@routeflow/returns";
import type { ReturnReason } from "@routeflow/types";
import { useAdminProducts } from "../../../lib/api/admin";
import { useCaptureInlineReturn, useInlineReturnQuote } from "../../../lib/api/inline-returns";
import { inlineReturnNonceKey } from "../../../lib/inline-return-submit-key";
import {
  canConfirmInlineReturn,
  canGetInlineReturnQuote,
  initialInlineReturnScreen,
  inlineReturnScreenReducer,
  screenReturnKey,
} from "../../../lib/inline-return-screen";
import { useInlineReturnSubmissionStore } from "../../../store/inlineReturnSubmissionStore";
import { sanitizeIntInput } from "../../../lib/qty";

const REASONS: { id: ReturnReason; label: string }[] = [
  { id: "DAMAGED", label: "Damaged" },
  { id: "WRONG_ITEM", label: "Wrong item" },
  { id: "CUSTOMER_REFUSED", label: "Refused" },
  { id: "QUALITY_ISSUE", label: "Quality issue" },
  { id: "EXCESS_ORDER", label: "Excess / overdelivery" },
];

const money = (n: number) => `$${Number(n).toFixed(2)}`;

export default function InlineReturnScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    customerId?: string;
    orderId?: string;
    customerName?: string;
  }>();
  const customerId = params.customerId ?? "";
  const orderId = params.orderId ?? "";

  const [screen, dispatch] = useReducer(inlineReturnScreenReducer, initialInlineReturnScreen);
  const [lines, setLines] = useState<InlineReturnLineDraft[]>([]);
  const [reason, setReason] = useState<ReturnReason | "">("");
  const [excessOption, setExcessOption] = useState<ExcessOption>(DEFAULT_EXCESS_OPTION);
  const [search, setSearch] = useState("");

  const quoteMut = useInlineReturnQuote();
  const captureMut = useCaptureInlineReturn();
  const getOrCreateNonce = useInlineReturnSubmissionStore((s) => s.getOrCreateNonce);
  const { data: products } = useAdminProducts(
    { search: search.trim(), limit: 8 },
    { enabled: search.trim().length > 1 },
  );

  const setLine = (productId: string, patch: Partial<InlineReturnLineDraft>) =>
    setLines((prev) => prev.map((l) => (l.productId === productId ? { ...l, ...patch } : l)));

  const getQuote = () =>
    quoteMut.mutate(buildQuoteRequest(customerId, lines), {
      onSuccess: (quote) => dispatch({ type: "quoted", quote }),
      onError: (e) => dispatch({ type: "refused", message: extractRefusalMessage(e) }),
    });

  const changeExcess = (option: ExcessOption) => {
    setExcessOption(option);
    if (option !== "RETURN_ONLY_PURCHASED" || screen.step !== "quote") return;
    quoteMut.mutate(dropExcessAndRequote(customerId, screen.quote), {
      onSuccess: (quote) => {
        dispatch({ type: "quoted", quote });
        // Capture reads quantities from `lines`, so apply the reduced amount there too.
        setLines((prev) => applyCoveredPiecesToLines(prev, quote));
      },
      onError: (e) => dispatch({ type: "refused", message: extractRefusalMessage(e) }),
    });
  };

  const confirm = () => {
    if (!canConfirmInlineReturn(reason)) return;
    const nonce = getOrCreateNonce(inlineReturnNonceKey(customerId, orderId));
    captureMut.mutate(
      buildCaptureRequest({
        customerId,
        orderId,
        lines,
        returnKey: screenReturnKey(customerId, orderId, lines, nonce),
        reason: reason as ReturnReason,
      }),
      {
        onSuccess: (result) => dispatch({ type: "captured", result }),
        onError: (e) => dispatch({ type: "refused", message: extractRefusalMessage(e) }),
      },
    );
  };

  const title =
    screen.step === "quote"
      ? "Quote"
      : screen.step === "success"
        ? "Return recorded"
        : "Inline return";

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={title}
        leading={
          <NavBackButton
            label={screen.step === "quote" ? "Items" : "Back"}
            onPress={() => (screen.step === "quote" ? dispatch({ type: "edit" }) : router.back())}
          />
        }
      />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        {params.customerName ? <Text style={styles.hint}>{params.customerName}</Text> : null}

        {screen.step === "lines" && (
          <>
            <Text style={styles.section}>What came back</Text>
            <SearchBar
              placeholder="Search products to add…"
              value={search}
              onChangeText={setSearch}
            />
            {(products?.data ?? [])
              .filter((p) => !lines.some((l) => l.productId === p.id))
              .map((p) => (
                <Pressable
                  key={p.id}
                  style={styles.pickRow}
                  onPress={() => {
                    setLines((prev) => [
                      ...prev,
                      {
                        productId: p.id,
                        productName: p.name,
                        unit: p.unit,
                        unitsPerBox: p.unitsPerBox ?? null,
                        boxes: "",
                        pieces: "",
                        reason: "",
                        note: "",
                      },
                    ]);
                    setSearch("");
                  }}
                >
                  <Text style={styles.name}>{p.name}</Text>
                </Pressable>
              ))}
            {lines.map((l) => (
              <View key={l.productId} style={styles.card}>
                <Text style={styles.name}>{l.productName}</Text>
                <View style={styles.qtyRow}>
                  {isBoxedProduct(l) && (
                    <QtyField
                      label="Boxes"
                      value={l.boxes}
                      onChange={(v) => setLine(l.productId, { boxes: v })}
                    />
                  )}
                  <QtyField
                    label={isBoxedProduct(l) ? "Pieces" : (l.unit ?? "Qty")}
                    value={l.pieces}
                    onChange={(v) => setLine(l.productId, { pieces: v })}
                  />
                  <Pressable
                    onPress={() => setLines((p) => p.filter((x) => x.productId !== l.productId))}
                  >
                    <Text style={styles.link}>Remove</Text>
                  </Pressable>
                </View>
              </View>
            ))}
            {!orderId ? (
              <Text style={styles.error}>Pick which order this credit applies to first.</Text>
            ) : null}
            <PrimaryButton
              label="Get quote"
              busy={quoteMut.isPending}
              disabled={!canGetInlineReturnQuote(lines, orderId)}
              onPress={getQuote}
            />
          </>
        )}

        {screen.step === "quote" && (
          <QuoteView
            quote={screen.quote}
            excessOption={excessOption}
            onExcessOption={changeExcess}
            reason={reason}
            onReason={setReason}
            busy={captureMut.isPending || quoteMut.isPending}
            onConfirm={confirm}
          />
        )}

        {screen.step === "success" && (
          <View style={styles.card}>
            <Text style={styles.name}>
              {screen.result.returnNumber
                ? `Return #${screen.result.returnNumber}`
                : "Return recorded"}
            </Text>
            {typeof screen.result.refundAmount === "number" && (
              <Text style={styles.hint}>Credit {money(screen.result.refundAmount)}</Text>
            )}
            {screen.result.creditNoteId ? (
              <Text style={styles.hint}>Credit note issued</Text>
            ) : null}
            <PrimaryButton
              label="Done"
              onPress={() => router.replace("/(operator)/returns" as any)}
            />
          </View>
        )}

        {screen.step === "refused" && (
          <View style={styles.card}>
            <Text style={styles.error}>{screen.message}</Text>
            <PrimaryButton label="Back" onPress={() => dispatch({ type: "edit" })} />
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function QuoteView(props: {
  quote: import("@routeflow/types").InlineReturnQuoteResponse;
  excessOption: ExcessOption;
  onExcessOption: (o: ExcessOption) => void;
  reason: ReturnReason | "";
  onReason: (r: ReturnReason) => void;
  busy: boolean;
  onConfirm: () => void;
}) {
  const { quote } = props;
  const { covered, excess } = groupQuoteChunks(quote);
  const excessTotals = sumChunkTotals(excess);
  return (
    <>
      <Text style={styles.section}>Matched to earlier orders</Text>
      {covered.map((c, i) => (
        <View key={`${c.sourceInvoiceItemId}-${i}`} style={styles.card}>
          <Text style={styles.name}>{c.pieces} pc · from an earlier order</Text>
          <Text style={styles.hint}>
            Net {money(c.subtotal)} · Tax {money(c.taxAmount)}
            {c.categoryTax > 0 ? ` · Levy ${money(c.categoryTax)}` : ""}
          </Text>
        </View>
      ))}
      {excess.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.name}>Not on any invoice</Text>
          <Text style={styles.hint}>
            {excess.reduce((s, c) => s + c.pieces, 0)} pc at current price · Net{" "}
            {money(excessTotals.subtotal)} · Tax {money(excessTotals.taxAmount)}
          </Text>
          {(
            [
              ["CREDIT_AT_CURRENT_PRICE", "Credit at current price"],
              ["RETURN_ONLY_PURCHASED", "Return only what was bought"],
            ] as const
          ).map(([value, label]) => (
            <Pressable
              key={value}
              style={[styles.chip, props.excessOption === value && styles.chipActive]}
              onPress={() => props.onExcessOption(value)}
            >
              <Text
                style={[styles.chipText, props.excessOption === value && styles.chipTextActive]}
              >
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      <View style={styles.card}>
        <Text style={styles.hint}>Subtotal {money(quote.subtotal)}</Text>
        <Text style={styles.hint}>Tax {money(quote.taxAmount)}</Text>
        {quote.categoryTax > 0 && <Text style={styles.hint}>Levy {money(quote.categoryTax)}</Text>}
        <Text style={styles.name}>Total {money(quote.total)}</Text>
        <Text style={styles.hint}>Issued as a credit note on the customer&apos;s balance.</Text>
      </View>
      <Text style={styles.section}>Reason</Text>
      <View style={styles.chips}>
        {REASONS.map((r) => (
          <Pressable
            key={r.id}
            style={[styles.chip, props.reason === r.id && styles.chipActive]}
            onPress={() => props.onReason(r.id)}
          >
            <Text style={[styles.chipText, props.reason === r.id && styles.chipTextActive]}>
              {r.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <PrimaryButton
        label="Issue credit note and receive goods"
        busy={props.busy}
        disabled={!canConfirmInlineReturn(props.reason)}
        onPress={props.onConfirm}
      />
    </>
  );
}

function QtyField(props: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <View>
      <Text style={styles.hint}>{props.label}</Text>
      <TextInput
        style={styles.qty}
        value={props.value}
        onChangeText={(v) => props.onChange(sanitizeIntInput(v))}
        placeholder="0"
        placeholderTextColor={ios.label3}
        keyboardType="number-pad"
      />
    </View>
  );
}

function PrimaryButton(props: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  const off = props.disabled || props.busy;
  return (
    <Pressable style={[styles.btn, off && { opacity: 0.5 }]} disabled={off} onPress={props.onPress}>
      {props.busy ? (
        <ActivityIndicator color="#fff" />
      ) : (
        <Text style={styles.btnText}>{props.label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  hint: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label2 },
  section: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    textTransform: "uppercase",
  },
  card: { backgroundColor: ios.bgElev, borderRadius: 12, padding: 14, gap: 6 },
  pickRow: { backgroundColor: ios.bgElev, borderRadius: 12, padding: 14 },
  name: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  qtyRow: { flexDirection: "row", alignItems: "flex-end", gap: 12 },
  qty: {
    width: 72,
    backgroundColor: ios.fill3,
    borderRadius: 10,
    padding: 10,
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    textAlign: "center",
  },
  link: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.brand, paddingBottom: 12 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: ios.fill3,
  },
  chipActive: { backgroundColor: ios.brand },
  chipText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label },
  chipTextActive: { color: "#fff" },
  error: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.system.red },
  btn: { backgroundColor: ios.brand, borderRadius: 14, paddingVertical: 16, alignItems: "center" },
  btnText: { color: "#fff", fontSize: 16, fontFamily: "Inter_600SemiBold" },
});
