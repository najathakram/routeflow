// Operator inline-return screen: lines -> quote -> confirm -> result. Mirrors the web
// RecordInlineReturnDialog (PR #1250): same endpoints/DTOs (@routeflow/types), state logic from
// @routeflow/returns, decision logic in lib/inline-return-screen.ts. The quote is rendered
// exactly as the server returned it — no client-side money math. `returnKey` comes from the
// persisted, offline-queue-safe nonce store, never minted per render, and capture sends the
// QUOTED snapshot (buildInlineReturnCapture), never the live lines.
import { useEffect, useReducer, useRef, useState } from "react";
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
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, SearchBar } from "@routeflow/ui/mobile/ios";
import {
  applyCoveredPiecesToLines,
  applyReturnScan,
  boxedProductIds,
  buildQuoteRequest,
  canReturnOnlyPurchased,
  CREDIT_OVERRIDE_REASON_MAX,
  creditOverrideNote,
  creditOverrideProblem,
  extractRefusalMessage,
  groupQuoteChunks,
  isBoxedProduct,
  keyReusedReturnOf,
  NOTHING_BOUGHT_BEFORE_MESSAGE,
  notBoughtBeforeNames,
  RETURNS_NOT_ENABLED_MESSAGE,
  sumChunkTotals,
  type ExcessOption,
  type InlineReturnLineDraft,
} from "@routeflow/returns";
import type { InlineReturnQuoteResponse, ReturnReason } from "@routeflow/types";
import { useAdminOrder, useAdminProducts } from "../../../lib/api/admin";
import { useInlineReturnsAddon } from "../../../lib/api/addons";
import { useCaptureInlineReturn, useInlineReturnQuote } from "../../../lib/api/inline-returns";
import {
  captureOutcomeFromError,
  inlineReturnNonceKey,
} from "../../../lib/inline-return-submit-key";
import {
  buildInlineReturnCapture,
  canConfirmInlineReturn,
  canGetInlineReturnQuote,
  canLeaveInlineReturn,
  canOverrideInlineReturnCredit,
  captureFailureMessage,
  formatRefundAmount,
  initialInlineReturnScreen,
  inlineReturnScreenReducer,
  inlineReturnsGate,
  linesFromOrder,
  onlyPurchasedRequote,
  sourceSaleOf,
  type PrefilledReturnLine,
} from "../../../lib/inline-return-screen";
import { useAuthStore } from "../../../lib/auth-store";
import { useInlineReturnRemoveGuard } from "../../../lib/use-inline-return-remove-guard";
import { useInlineReturnSubmissionStore } from "../../../store/inlineReturnSubmissionStore";
import { sanitizeIntInput } from "../../../lib/qty";
import { ScanOrderSheet } from "../../../components/ScanOrderSheet";
import { makeScanHandler } from "../../../lib/scan-ladder";
import { resolveProductByCode } from "../../../lib/barcode-resolve";
import { looksLikeScanCode, type ScanMatchable } from "../../../lib/wedge-scan";
import { bumpScanOrder, nextFlash, type ScanFlash } from "../../../lib/scan-tray";
import type { ScanOutcome } from "../../../lib/scan-loop";
import {
  returnLinePieces,
  returnTrayRows,
  setReturnLineQty,
  stepReturnLine,
} from "../../../lib/return-scan-tray";

const MIN_TARGET = 44;

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
    sourceOrderId?: string;
  }>();
  const customerId = params.customerId ?? "";
  const orderId = params.orderId ?? "";

  const gate = inlineReturnsGate(useInlineReturnsAddon());
  const [screen, dispatch] = useReducer(inlineReturnScreenReducer, initialInlineReturnScreen);
  const [lines, setLines] = useState<PrefilledReturnLine[]>([]);
  const [reason, setReason] = useState<ReturnReason | "">("");
  const [search, setSearch] = useState("");
  // #2694: scan into "What came back" with the SAME ScanOrderSheet + resolve ladder as order items.
  const [scanOpen, setScanOpen] = useState(false);
  const [scanOrder, setScanOrder] = useState<string[]>([]);
  const [scanFlash, setScanFlash] = useState<ScanFlash | null>(null);
  /** #2647: a key-reused 409 means the earlier capture WAS recorded: clear the draft (the lines
   *  re-seed from the order, the reason resets) so the same goods are not re-entered and credited
   *  twice, and offer "Open RET-…". Any other refusal keeps the draft for a fix-and-retry. */
  const refuse = (message: string, e: unknown) => {
    const recorded = keyReusedReturnOf(e);
    if (recorded) {
      setLines([]);
      setReason("");
    }
    dispatch({ type: "refused", message, recorded });
  };

  const quoteMut = useInlineReturnQuote();
  const captureMut = useCaptureInlineReturn();
  const getOrCreateNonce = useInlineReturnSubmissionStore((s) => s.getOrCreateNonce);
  type ScannedProduct = ScanMatchable & {
    id: string;
    name: string;
    unit?: string | null;
    unitsPerBox?: number | null;
  };
  // A scan adds the product with 1 piece; a repeat adds a piece (applyReturnScan). Returns never
  // create products, so the ladder gets no onCreate; several matches hand the code to the search.
  const acceptScanned = (product: ScannedProduct): ScanOutcome => {
    setLines(
      (prev) => applyReturnScan(prev, product, (base) => ({ ...base, soldLabel: "" })).lines,
    );
    setScanOrder((order) => bumpScanOrder(order, product.id));
    setScanFlash((prev) => nextFlash(prev, product.id));
    setSearch("");
    if (scanOpen) return; // the tray row is the confirmation
    return { feedback: { kind: "added", text: `Added ${product.name}` } };
  };
  const handleScanned = makeScanHandler<ScannedProduct>({
    products: () => (products?.data ?? []) as ScannedProduct[],
    accept: acceptScanned,
    resolve: (c, signal) => resolveProductByCode<ScannedProduct>(c, signal),
    onAmbiguous: (code) => {
      setScanOpen(false);
      setSearch(code);
    },
  });
  const { data: products } = useAdminProducts(
    { search: search.trim(), limit: 8 },
    { enabled: search.trim().length > 1 },
  );

  // Pre-fill the order's own lines once (sold pack + sold quantities as context).
  const { data: order } = useAdminOrder(orderId);
  // SA-740: the sale the goods are from. A walk-in's order is that sale (the server refuses a walk-in quote without one);
  // a named customer's return stays unpinned. The order is loaded before the clerk can reach "Get quote" with lines.
  const sourceOrderId = sourceSaleOf({
    routeSourceOrderId: params.sourceOrderId,
    orderId,
    customerIsWalkIn: order?.customer?.isWalkIn,
  });
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || !order) return;
    prefilled.current = true;
    setLines((prev) => (prev.length > 0 ? prev : linesFromOrder(order.lineItems)));
  }, [order]);

  const canLeave = canLeaveInlineReturn(screen);

  // Lock EVERY removal path while a capture is in flight (Android back, this stack's swipe, a
  // parent-stack swipe): usePreventRemove, not a raw beforeRemove (see the hook).
  const signedOut = useAuthStore((s) => !s.user);
  // #2695: staff only — the server refuses the override fields from anyone else with a 400.
  const canOverrideCredit = canOverrideInlineReturnCredit(useAuthStore((s) => s.user));
  const overrideProblem = creditOverrideProblem(lines);
  useInlineReturnRemoveGuard(screen, {
    signedOut,
    onSignedOutRedirect: () => router.replace("/(auth)/login" as any),
  });

  const setLine = (productId: string, patch: Partial<InlineReturnLineDraft>) =>
    setLines((prev) => prev.map((l) => (l.productId === productId ? { ...l, ...patch } : l)));

  const requote = (
    request: ReturnType<typeof buildQuoteRequest>,
    build: (quote: InlineReturnQuoteResponse) => void,
  ) =>
    quoteMut.mutate(request, {
      onSuccess: build,
      onError: (e) => refuse(extractRefusalMessage(e), e),
    });

  const getQuote = () =>
    requote(buildQuoteRequest(customerId, lines, undefined, sourceOrderId), (quote) =>
      dispatch({ type: "quoted", quote, lines }),
    );

  const changeExcess = (option: ExcessOption) => {
    if (screen.step !== "quote") return;
    if (option !== "RETURN_ONLY_PURCHASED") {
      dispatch({ ...quotedEvent(screen), excessOption: option });
      return;
    }
    // #2693: nothing matched to an invoice ⇒ the re-quote would be EMPTY; never send it.
    if (!canReturnOnlyPurchased(screen.quote)) return;
    requote(
      onlyPurchasedRequote(customerId, screen.quote, screen.quotedLines, sourceOrderId),
      (quote) => {
        // Capture reads the quoted snapshot, so the reduced amount goes into the snapshot too.
        const reduced = applyCoveredPiecesToLines(screen.quotedLines, quote);
        setLines((prev) => applyCoveredPiecesToLines(prev, quote) as PrefilledReturnLine[]);
        dispatch({ type: "quoted", quote, lines: reduced, excessOption: option });
      },
    );
  };

  const confirm = () => {
    if (!canConfirmInlineReturn(reason)) return;
    const request = buildInlineReturnCapture(screen, {
      customerId,
      orderId,
      nonce: getOrCreateNonce(inlineReturnNonceKey(customerId, orderId)),
      reason: reason as ReturnReason,
      sourceOrderId,
    });
    if (!request) return;
    dispatch({ type: "captureStarted" });
    captureMut.mutate(request, {
      onSuccess: (result) => dispatch({ type: "captured", result }),
      onError: (e) =>
        // REG-B308: an offline-queued capture is a pending success, not a failure.
        captureOutcomeFromError(e).kind === "queued"
          ? dispatch({ type: "queued" })
          : refuse(captureFailureMessage(e), e),
    });
  };

  const title =
    screen.step === "quote" || screen.step === "capturing"
      ? "Quote"
      : screen.step === "success"
        ? "Return recorded"
        : screen.step === "queued"
          ? "Saved offline"
          : "Inline return";

  const busy = screen.step === "capturing" || captureMut.isPending;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      {/* Swipe-back is locked with the back button while a capture is in flight. */}
      <Stack.Screen options={{ gestureEnabled: canLeave }} />
      <NavBar
        inlineTitle={title}
        leading={
          <NavBackButton
            label={screen.step === "quote" ? "Items" : "Back"}
            onPress={() => {
              if (!canLeave) return;
              if (screen.step === "quote") dispatch({ type: "edit" });
              else router.back();
            }}
          />
        }
      />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        {params.customerName ? <Text style={styles.hint}>{params.customerName}</Text> : null}

        {gate === "loading" && screen.step === "lines" && <ActivityIndicator color={ios.brand} />}
        {gate === "blocked" && screen.step === "lines" && (
          <Text style={styles.error} accessibilityRole="alert">
            {RETURNS_NOT_ENABLED_MESSAGE}
          </Text>
        )}

        {gate === "allowed" && screen.step === "lines" && (
          <>
            <Text style={styles.section} accessibilityRole="header">
              What came back
            </Text>
            <SearchBar
              placeholder="Search or scan products to add…"
              value={search}
              onChangeText={setSearch}
              // A wedge / paste scanner ends with Enter; only a code-shaped term is a scan, so a
              // typed product NAME never auto-adds.
              onSubmitEditing={() => {
                const code = search.trim();
                if (!looksLikeScanCode(code)) return;
                setSearch("");
                void handleScanned(code);
              }}
              trailing={
                <Pressable
                  onPress={() => setScanOpen(true)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Scan items"
                >
                  <Ionicons name="barcode-outline" size={22} color={ios.brand} />
                </Pressable>
              }
            />
            {(products?.data ?? [])
              .filter((p) => !lines.some((l) => l.productId === p.id))
              .map((p) => (
                <Pressable
                  key={p.id}
                  style={styles.pickRow}
                  accessibilityRole="button"
                  accessibilityLabel={`Add ${p.name}`}
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
                        soldLabel: "",
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
                {l.soldLabel ? <Text style={styles.hint}>Sold: {l.soldLabel}</Text> : null}
                <View style={styles.qtyRow}>
                  {isBoxedProduct(l) && (
                    <QtyField
                      label={l.boxLabel ?? "Boxes"}
                      product={l.productName}
                      value={l.boxes}
                      onChange={(v) => setLine(l.productId, { boxes: v })}
                    />
                  )}
                  <QtyField
                    label={isBoxedProduct(l) ? "Pieces" : (l.unit ?? "Qty")}
                    product={l.productName}
                    value={l.pieces}
                    onChange={(v) => setLine(l.productId, { pieces: v })}
                  />
                  <Pressable
                    style={styles.remove}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${l.productName}`}
                    onPress={() => setLines((p) => p.filter((x) => x.productId !== l.productId))}
                  >
                    <Text style={styles.link}>Remove</Text>
                  </Pressable>
                </View>
                {canOverrideCredit && (
                  <View style={styles.overrideRow}>
                    <View>
                      <Text style={styles.hint}>
                        {isBoxedProduct(l) ? "Credit / box" : "Credit price"}
                      </Text>
                      <TextInput
                        style={styles.qty}
                        value={l.creditUnitPrice ?? ""}
                        accessibilityLabel={`Credit price, ${l.productName}`}
                        onChangeText={(v) => setLine(l.productId, { creditUnitPrice: v })}
                        placeholder="Quoted"
                        placeholderTextColor={ios.label3}
                        keyboardType="decimal-pad"
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.hint}>Why the lower price</Text>
                      <TextInput
                        style={styles.reasonInput}
                        value={l.overrideReason ?? ""}
                        accessibilityLabel={`Why the lower price, ${l.productName}`}
                        onChangeText={(v) => setLine(l.productId, { overrideReason: v })}
                        maxLength={CREDIT_OVERRIDE_REASON_MAX}
                        placeholderTextColor={ios.label3}
                      />
                    </View>
                  </View>
                )}
              </View>
            ))}
            {overrideProblem ? (
              <Text style={styles.error} accessibilityRole="alert">
                {overrideProblem}
              </Text>
            ) : null}
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

        {(screen.step === "quote" || screen.step === "capturing") && (
          <QuoteView
            quote={screen.quote}
            lines={screen.quotedLines}
            boxedIds={boxedProductIds(screen.quotedLines)}
            excessOption={screen.excessOption}
            onExcessOption={changeExcess}
            reason={reason}
            onReason={setReason}
            busy={busy || quoteMut.isPending}
            locked={screen.step === "capturing"}
            onConfirm={confirm}
          />
        )}

        {screen.step === "success" && (
          <View style={styles.card} accessibilityLiveRegion="polite">
            <Text style={styles.name} accessibilityRole="header">
              {screen.result.returnNumber
                ? `Return #${screen.result.returnNumber}`
                : "Return recorded"}
            </Text>
            {formatRefundAmount(screen.result.refundAmount) ? (
              <Text style={styles.hint}>
                Credit {formatRefundAmount(screen.result.refundAmount)}
              </Text>
            ) : null}
            {screen.result.creditNoteId ? (
              <Text style={styles.hint}>Credit note issued</Text>
            ) : null}
            <PrimaryButton
              label="Done"
              onPress={() => router.replace("/(operator)/returns" as any)}
            />
          </View>
        )}

        {screen.step === "queued" && (
          <View style={styles.card} accessibilityLiveRegion="polite">
            <Text style={styles.name} accessibilityRole="header">
              Saved offline
            </Text>
            <Text style={styles.hint}>
              The return will be submitted automatically when you are back online.
            </Text>
            <PrimaryButton
              label="Done"
              onPress={() => router.replace("/(operator)/returns" as any)}
            />
          </View>
        )}

        {screen.step === "refused" && (
          <View style={styles.card}>
            <Text style={styles.error} accessibilityRole="alert">
              {screen.message}
            </Text>
            {screen.recorded && (
              <PrimaryButton
                label={`Open ${screen.recorded.returnNumber ?? "the recorded return"}`}
                onPress={() =>
                  router.replace(`/(operator)/returns/${screen.recorded!.returnId}` as any)
                }
              />
            )}
            <PrimaryButton label="Back" onPress={() => dispatch({ type: "edit" })} />
          </View>
        )}
      </ScrollView>

      {/* #2694: the order items' scan sheet, price-less for returns. */}
      <ScanOrderSheet
        visible={scanOpen}
        rows={returnTrayRows(lines, scanOrder)}
        flash={scanFlash}
        totalItems={lines.reduce((n, l) => n + returnLinePieces(l), 0)}
        total={0}
        hideMoney
        onScanned={handleScanned}
        onChangeQty={(id, qty) => setLines((prev) => setReturnLineQty(prev, id, qty))}
        onIncrement={(id) => setLines((prev) => stepReturnLine(prev, id, +1))}
        onDecrement={(id) => setLines((prev) => stepReturnLine(prev, id, -1))}
        onRemove={(id) => setLines((prev) => prev.filter((l) => l.productId !== id))}
        onReview={() => setScanOpen(false)}
        onDone={() => setScanOpen(false)}
      />
    </SafeAreaView>
  );
}

/** Re-dispatches the current quote unchanged (used for the no-requote excess option switch). */
function quotedEvent(
  screen: Extract<ReturnType<typeof inlineReturnScreenReducer>, { step: "quote" }>,
) {
  return { type: "quoted" as const, quote: screen.quote, lines: screen.quotedLines };
}

function QuoteView(props: {
  quote: import("@routeflow/types").InlineReturnQuoteResponse;
  /** The quoted lines, for naming products option 3 would drop (#2693). */
  lines: ReadonlyArray<Pick<InlineReturnLineDraft, "productId" | "productName">>;
  /** #2695: products whose override note reads "per box". */
  boxedIds: Set<string>;
  excessOption: ExcessOption;
  onExcessOption: (o: ExcessOption) => void;
  reason: ReturnReason | "";
  onReason: (r: ReturnReason) => void;
  busy: boolean;
  /** A capture is in flight: every control here is inert. */
  locked: boolean;
  onConfirm: () => void;
}) {
  const { quote } = props;
  const { covered, excess } = groupQuoteChunks(quote);
  const excessTotals = sumChunkTotals(excess);
  const onlyBoughtPossible = canReturnOnlyPurchased(quote);
  const notBoughtBefore = onlyBoughtPossible ? notBoughtBeforeNames(quote, props.lines) : [];
  const optionDisabled = (value: ExcessOption) =>
    props.locked || (value === "RETURN_ONLY_PURCHASED" && !onlyBoughtPossible);
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
          {creditOverrideNote(c, money, props.boxedIds.has(c.productId)) ? (
            <Text style={styles.hint}>
              {creditOverrideNote(c, money, props.boxedIds.has(c.productId))}
            </Text>
          ) : null}
        </View>
      ))}
      {excess.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.name}>Not on any invoice</Text>
          <Text style={styles.hint}>
            {excess.reduce((s, c) => s + c.pieces, 0)} pc at current price · Net{" "}
            {money(excessTotals.subtotal)} · Tax {money(excessTotals.taxAmount)}
          </Text>
          {excess.map((c, i) =>
            creditOverrideNote(c, money, props.boxedIds.has(c.productId)) ? (
              <Text key={`excess-override-${i}`} style={styles.hint}>
                {creditOverrideNote(c, money, props.boxedIds.has(c.productId))}
              </Text>
            ) : null,
          )}
          {(
            [
              ["CREDIT_AT_CURRENT_PRICE", "Credit at current price"],
              ["RETURN_ONLY_PURCHASED", "Return only what was bought"],
            ] as const
          ).map(([value, label]) => (
            <Pressable
              key={value}
              style={[
                styles.chip,
                props.excessOption === value && styles.chipActive,
                optionDisabled(value) && !props.locked && styles.chipDisabled,
              ]}
              disabled={optionDisabled(value)}
              accessibilityRole="radio"
              accessibilityLabel={label}
              accessibilityState={{
                selected: props.excessOption === value,
                disabled: optionDisabled(value),
              }}
              onPress={() => props.onExcessOption(value)}
            >
              <Text
                style={[styles.chipText, props.excessOption === value && styles.chipTextActive]}
              >
                {label}
              </Text>
            </Pressable>
          ))}
          {!onlyBoughtPossible && <Text style={styles.hint}>{NOTHING_BOUGHT_BEFORE_MESSAGE}</Text>}
          {notBoughtBefore.length > 0 && (
            <Text style={styles.hint}>Not bought before: {notBoughtBefore.join(", ")}</Text>
          )}
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
            disabled={props.locked}
            accessibilityRole="radio"
            accessibilityLabel={r.label}
            accessibilityState={{ selected: props.reason === r.id, disabled: props.locked }}
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

function QtyField(props: {
  label: string;
  product: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <View>
      <Text style={styles.hint}>{props.label}</Text>
      <TextInput
        style={styles.qty}
        value={props.value}
        accessibilityLabel={`${props.label} returned, ${props.product}`}
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
    <Pressable
      style={[styles.btn, off && { opacity: 0.5 }]}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: !!off, busy: !!props.busy }}
      onPress={props.onPress}
    >
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
  pickRow: {
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    padding: 14,
    minHeight: MIN_TARGET,
    justifyContent: "center",
  },
  name: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  qtyRow: { flexDirection: "row", alignItems: "flex-end", gap: 12 },
  qty: {
    width: 72,
    minHeight: MIN_TARGET,
    backgroundColor: ios.fill3,
    borderRadius: 10,
    padding: 10,
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    textAlign: "center",
  },
  overrideRow: { flexDirection: "row", alignItems: "flex-end", gap: 12 },
  reasonInput: {
    minHeight: MIN_TARGET,
    backgroundColor: ios.fill3,
    borderRadius: 10,
    padding: 10,
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: ios.label,
  },
  remove: { minHeight: MIN_TARGET, minWidth: MIN_TARGET, justifyContent: "center" },
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
  chipDisabled: { opacity: 0.4 },
  chipTextActive: { color: "#fff" },
  error: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.system.red },
  btn: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    minHeight: 48,
    justifyContent: "center",
    alignItems: "center",
  },
  btnText: { color: "#fff", fontSize: 16, fontFamily: "Inter_600SemiBold" },
});
