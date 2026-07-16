import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
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
import { NavAction, NavBackButton, NavBar, SearchBar } from "@routeflow/ui/mobile/ios";
import { useAdminCustomers } from "../../../../lib/api/admin";
import { useProducts } from "../../../../lib/api/products";
import { useCreateInvoice, type CreateInvoiceItem } from "../../../../lib/api/invoices";
import { showToast } from "../../../../lib/toast";
import { incrementLine } from "../../../../lib/sale-line";
import { resolveProductByCode } from "../../../../lib/barcode-resolve";
// Compose "<Parent> - <Variant>" so variants don't show as "Strawberry" alone.
import { displayProductName as displayName } from "../../../../lib/product-display";
import { computeLineSubtotal, effectiveQty, roundMoney } from "../../../../lib/pricing";
import { MoneyTextInput } from "../../../../components/MoneyTextInput";
import { alertInfo, chooseAction } from "../../../../lib/confirm";
import { BarcodeFab } from "../../../../components/BarcodeFab";
import { InlineCreateProductSheet } from "../../../../components/InlineCreateProductSheet";
import type { CreatedProduct } from "../../../../lib/api/products";
import { ScanOutcome } from "../../../../lib/scan-loop";
import { withCartRows } from "../../../../lib/visible-cart";

/**
 * Standalone invoice composer for the mobile operator UI.
 *
 * Mirrors the new-order flow (customer picker → product list with cart
 * → terms/due-date → save) so operators have a familiar UI on both sides.
 * Posts to POST /invoices (not from-order/partial) — for splitting an
 * existing order into invoices, use the order detail's "Split into
 * invoice" entry.
 *
 * The screen also surfaces the floating BarcodeFab so an operator scrolling
 * the product list can scan-to-add without scrolling back up to the
 * SearchBar.
 */

const TERM_DAYS: Record<string, number> = {
  "Due on Receipt": 0,
  "Net 15": 15,
  "Net 30": 30,
  "Net 45": 45,
  "Net 60": 60,
};

const TERM_OPTIONS = Object.keys(TERM_DAYS);
const DEFAULT_TERMS = "Net 30";

function todayPlusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function toNumber(v: number | string | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

type Product = {
  id: string;
  name: string;
  sku?: string | null;
  barcode?: string | null;
  unit?: string;
  pricePerUnit: number | string;
  unitsPerBox?: number | null;
  parentProductId?: string | null;
  parent?: { id: string; name: string } | null;
};

// `unitPrice` is an optional one-time price override (the "discounted price").
// When unset, the catalog price is used. For boxed products it is the BOX price,
// matching the catalog price unit; computeLineSubtotal prorates pieces.
type LineState = { qty: number; boxes?: number; pieces?: number; unitPrice?: number };

/**
 * An ad-hoc, non-catalog ("unlisted") invoice line: free-text description +
 * required price; never boxed. Serialised as `{ description, qty, unitPrice }`
 * (no productId). Keyed locally by a synthetic id.
 */
type UnlistedLine = { id: string; name: string; unitPrice: number; qty: number };

function newLocalId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The effective per-unit price for a line: the override, else the catalog price. */
function effectiveUnitPrice(line: LineState | undefined, p: Product): number {
  return line?.unitPrice != null ? line.unitPrice : toNumber(p.pricePerUnit);
}

export default function NewInvoiceScreen() {
  const router = useRouter();
  const [pickedCustomerId, setPickedCustomerId] = useState<string | null>(null);
  const [pickedCustomerName, setPickedCustomerName] = useState<string | null>(null);

  // `router.back()` is a silent no-op on web when this URL was opened
  // directly (empty history stack). Always have a fallback destination.
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/(operator)/(tabs)/invoices" as any);
  };

  if (!pickedCustomerId) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <CustomerPicker
          onBack={goBack}
          onPick={(id, name) => {
            setPickedCustomerId(id);
            setPickedCustomerName(name);
          }}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <InvoiceComposer
        customerId={pickedCustomerId}
        customerName={pickedCustomerName}
        onBack={goBack}
        onChangeCustomer={() => {
          setPickedCustomerId(null);
          setPickedCustomerName(null);
        }}
        onSaved={(invoiceId, invoiceNumber) => {
          showToast(`Invoice ${invoiceNumber} created`);
          router.replace(`/(operator)/invoices/${invoiceId}` as any);
        }}
      />
    </SafeAreaView>
  );
}

// ─── Customer picker ─────────────────────────────────────────────────────────

function CustomerPicker({
  onBack,
  onPick,
}: {
  onBack: () => void;
  onPick: (id: string, name: string) => void;
}) {
  const [search, setSearch] = useState("");
  const { data, isLoading } = useAdminCustomers({
    search: search.trim() || undefined,
    limit: 100,
  });
  const customers = data?.data ?? [];

  return (
    <>
      <NavBar inlineTitle="New invoice" leading={<NavBackButton label="Back" onPress={onBack} />} />
      <SearchBar placeholder="Search customers…" value={search} onChangeText={setSearch} />
      <ScrollView showsVerticalScrollIndicator={false}>
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : customers.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyText}>
              {search ? "No customers match." : "No customers yet."}
            </Text>
          </View>
        ) : (
          <View style={styles.customerList}>
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
                  {c.contactName ? (
                    <Text style={styles.customerSub} numberOfLines={1}>
                      {c.contactName}
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

// ─── Composer ────────────────────────────────────────────────────────────────

function InvoiceComposer({
  customerId,
  customerName,
  onBack,
  onChangeCustomer,
  onSaved,
}: {
  customerId: string;
  customerName: string | null;
  onBack: () => void;
  onChangeCustomer: () => void;
  onSaved: (invoiceId: string, invoiceNumber: string) => void;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<Record<string, LineState>>({});
  // Ad-hoc lines not in the catalog (no productId on submit).
  const [unlisted, setUnlisted] = useState<UnlistedLine[]>([]);
  const [unlistedModalOpen, setUnlistedModalOpen] = useState(false);
  const [scannedById, setScannedById] = useState<Record<string, Product>>({});
  // Scroll the just-scanned product row into view as the operator scans.
  const scrollRef = useRef<ScrollView>(null);
  const listTopRef = useRef(0);
  const rowYRef = useRef<Map<string, number>>(new Map());
  const [scrollToId, setScrollToId] = useState<string | null>(null);
  // Scanned/typed code with no product match → prefills the inline create sheet.
  const [createCode, setCreateCode] = useState<string | null>(null);
  // See NewOrderScreen: pending target survives so a freshly-pinned scanned row
  // can finish the scroll from its own onLayout (which fires after this effect).
  const scrollToIdRef = useRef<string | null>(null);
  const scrollToRow = (id: string) => {
    const y = rowYRef.current.get(id);
    if (y == null) return false;
    scrollRef.current?.scrollTo({ y: Math.max(0, listTopRef.current + y - 12), animated: true });
    return true;
  };
  useEffect(() => {
    if (!scrollToId) return;
    scrollToIdRef.current = scrollToId;
    if (scrollToRow(scrollToId)) {
      scrollToIdRef.current = null;
      setScrollToId(null);
    }
  }, [scrollToId, items]);
  const [terms, setTerms] = useState(DEFAULT_TERMS);
  const [dueDate, setDueDate] = useState(() => todayPlusDays(TERM_DAYS[DEFAULT_TERMS] ?? 30));
  const [send, setSend] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);

  const { data: productsData, isLoading: productsLoading } = useProducts({
    search: search.trim() || undefined,
    limit: 0,
  });
  const products: Product[] = productsData?.data ?? [];

  const productById = useMemo(() => {
    const m = new Map<string, Product>();
    for (const p of products) m.set(p.id, p);
    for (const id of Object.keys(scannedById)) {
      if (!m.has(id)) m.set(id, scannedById[id]);
    }
    return m;
  }, [products, scannedById]);

  const addOne = (id: string, snapshot?: Product) => {
    const p = snapshot ?? productById.get(id);
    const upb = Number(p?.unitsPerBox ?? 0);
    const isBoxed = upb > 1;
    setItems((m) => {
      const prev: LineState = m[id] ?? { qty: 0 };
      // ...prev preserved so a repeat scan / +1 keeps unitPrice + note.
      return { ...m, [id]: incrementLine(prev, isBoxed, upb) };
    });
    // Always retain the snapshot (see NewOrderScreen): the empty-search query
    // can be GC'd while a search is held, so setSearch("") after a local scan
    // may briefly refetch cold — the snapshot keeps this row resolvable.
    if (snapshot) {
      setScannedById((m) => (id in m ? m : { ...m, [id]: snapshot }));
    }
  };

  const removeOne = (id: string) => {
    const p = productById.get(id);
    const upb = Number(p?.unitsPerBox ?? 0);
    const isBoxed = upb > 1;
    setItems((m) => {
      const prev = m[id];
      if (!prev) return m;
      const next = { ...m };
      if (isBoxed) {
        const boxes = Math.max(0, (prev.boxes ?? 0) - 1);
        const pieces = prev.pieces ?? 0;
        if (boxes === 0 && pieces === 0) delete next[id];
        else next[id] = { qty: boxes * upb + pieces, boxes, pieces };
      } else {
        const qty = Math.max(0, (prev.qty ?? 0) - 1);
        if (qty === 0) delete next[id];
        else next[id] = { qty };
      }
      return next;
    });
  };

  const removeLine = (id: string) =>
    setItems((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });

  // Set (or clear) a one-time price override for a line. Empty/invalid clears it.
  const setLinePrice = (id: string, value: number | null) =>
    setItems((m) => {
      const prev = m[id];
      if (!prev) return m;
      if (value == null || value < 0) {
        const { unitPrice: _drop, ...rest } = prev;
        return { ...m, [id]: rest };
      }
      return { ...m, [id]: { ...prev, unitPrice: value } };
    });

  // ── Unlisted (ad-hoc, non-catalog) line helpers ──────────────────────────
  const addUnlisted = (name: string, unitPrice: number, qty: number) =>
    setUnlisted((u) => [...u, { id: newLocalId(), name: name.trim(), unitPrice, qty }]);
  const updateUnlistedQty = (id: string, qty: number) =>
    setUnlisted((u) =>
      qty <= 0 ? u.filter((x) => x.id !== id) : u.map((x) => (x.id === id ? { ...x, qty } : x)),
    );
  const updateUnlistedPrice = (id: string, value: number | null) =>
    setUnlisted((u) => {
      const price = value == null || value < 0 ? 0 : value;
      return u.map((x) => (x.id === id ? { ...x, unitPrice: price } : x));
    });
  const removeUnlisted = (id: string) => setUnlisted((u) => u.filter((x) => x.id !== id));

  // Continuous-scan handler: the scanner overlay stays open between items and
  // renders the returned feedback; only the create-product hand-off (and the
  // Done button) closes it.
  const handleScanned = async (code: string): Promise<ScanOutcome> => {
    const trimmed = code.trim();
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();
    const local = products.find(
      (p) =>
        (p.barcode ?? "").toLowerCase() === lower ||
        (p.sku ?? "").toLowerCase() === lower ||
        (p.id ?? "").toLowerCase() === lower,
    );
    if (local) {
      addOne(local.id, local);
      setSearch(""); // an active search would hide the added row (web clears too)
      setScrollToId(local.id);
      return { feedback: { kind: "added", text: `Added ${displayName(local)}` } };
    }
    try {
      const result = await resolveProductByCode<Product>(trimmed);
      if (!result.notFound && result.product?.id) {
        addOne(result.product.id, result.product);
        setSearch("");
        setScrollToId(result.product.id);
        return { feedback: { kind: "added", text: `Added ${displayName(result.product)}` } };
      }
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? err?.message ?? "Couldn't look up barcode.";
      return { feedback: { kind: "error", text: msg } };
    }
    chooseAction(
      `No product for "${trimmed}"`,
      "Add it as a new product or a variant of an existing one? Your invoice stays as it is.",
      [
        { label: "Cancel", style: "cancel" },
        { label: "Create", onPress: () => setCreateCode(trimmed) },
      ],
    );
    return { close: true };
  };

  // Create-on-miss: overlays the invoice builder (never navigates away) so the
  // in-progress invoice is preserved; the new product lands in the cart.
  const handleInlineCreated = (product: CreatedProduct) => {
    const snapshot: Product = {
      id: product.id,
      name: product.name,
      sku: product.sku ?? null,
      barcode: product.barcode ?? null,
      unit: product.unit,
      pricePerUnit: product.pricePerUnit,
      unitsPerBox: product.unitsPerBox ?? null,
      parentProductId: product.parentProductId ?? null,
      parent: null,
    };
    addOne(product.id, snapshot);
    setScrollToId(product.id);
    setCreateCode(null);
    showToast(`Added ${displayName(snapshot as any, products as any)}`);
  };

  const filtered = useMemo(() => {
    // While browsing (no active search), pin cart lines the catalog page would
    // hide so every scanned item keeps a visible row.
    if (search.trim()) return products;
    return withCartRows(products, Object.keys(items), (id) => productById.get(id));
  }, [products, search, items, productById]);

  const { total, totalItems } = useMemo(() => {
    let total = 0;
    let totalItems = 0;
    for (const [id, line] of Object.entries(items)) {
      const p = productById.get(id);
      if (!p) continue;
      const qty = effectiveQty(line, p.unitsPerBox);
      if (qty <= 0) continue;
      totalItems += qty;
      total += computeLineSubtotal({
        unitPrice: effectiveUnitPrice(line, p),
        qty,
        boxes: line.boxes ?? null,
        pieces: line.pieces ?? null,
        unitsPerBox: p.unitsPerBox ?? null,
      });
    }
    // Unlisted lines: never boxed, simple unitPrice × qty.
    for (const u of unlisted) {
      if (u.qty <= 0) continue;
      totalItems += u.qty;
      total += computeLineSubtotal({ unitPrice: u.unitPrice, qty: u.qty });
    }
    return { total: roundMoney(total), totalItems };
  }, [items, productById, unlisted]);

  const createMut = useCreateInvoice();
  const canSave = totalItems > 0 && !createMut.isPending;

  const onTermsChange = (t: string) => {
    setTerms(t);
    setDueDate(todayPlusDays(TERM_DAYS[t] ?? 30));
  };

  const onSave = () => {
    if (!canSave) {
      alertInfo("Add at least one item", "Tap + on any product to start the invoice.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      alertInfo("Bad due date", "Use the format YYYY-MM-DD.");
      return;
    }
    const payload: CreateInvoiceItem[] = [];
    for (const [productId, line] of Object.entries(items)) {
      const p = productById.get(productId);
      if (!p) continue;
      const qty = effectiveQty(line, p.unitsPerBox);
      if (qty <= 0) continue;
      payload.push({
        description: displayName(p),
        productId,
        qty,
        unitPrice: effectiveUnitPrice(line, p),
        ...(line.boxes != null ? { boxes: line.boxes } : {}),
        ...(line.pieces != null ? { pieces: line.pieces } : {}),
      });
    }
    // Unlisted lines → `{ description, qty, unitPrice }` (no productId).
    for (const u of unlisted) {
      if (u.qty <= 0 || u.name.trim() === "" || u.unitPrice <= 0) continue;
      payload.push({ description: u.name.trim(), qty: u.qty, unitPrice: u.unitPrice });
    }
    createMut.mutate(
      { customerId, items: payload, dueDate, terms, send },
      {
        onSuccess: (inv) => {
          onSaved(inv.id, inv.invoiceNumber);
        },
        onError: (err: any) => {
          alertInfo(
            "Couldn't create invoice",
            err?.response?.data?.message ?? err?.message ?? "Try again.",
          );
        },
      },
    );
  };

  return (
    <>
      <NavBar
        inlineTitle="New invoice"
        leading={<NavBackButton label="Back" onPress={onBack} />}
        trailing={
          <NavAction
            label={createMut.isPending ? "Saving…" : "Save"}
            bold
            onPress={canSave ? onSave : undefined}
          />
        }
      />

      <View style={styles.customerChipWrap}>
        <Pressable style={styles.customerChip} onPress={onChangeCustomer}>
          <Ionicons name="person-outline" size={14} color={ios.brand} />
          <Text style={styles.customerChipText} numberOfLines={1}>
            {customerName ?? "Customer"}
          </Text>
          <Text style={styles.customerChipChange}>Change</Text>
        </Pressable>
      </View>

      <ScrollView ref={scrollRef} showsVerticalScrollIndicator={false}>
        <SearchBar placeholder="Search items…" value={search} onChangeText={setSearch} />

        {productsLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : filtered.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyText}>No products{search ? " match your search" : ""}.</Text>
          </View>
        ) : (
          <View
            style={{ paddingHorizontal: 16, paddingTop: 14, gap: 10 }}
            onLayout={(e) => {
              listTopRef.current = e.nativeEvent.layout.y;
            }}
          >
            {filtered.map((p) => {
              const line = items[p.id];
              const q = line ? effectiveQty(line, p.unitsPerBox) : 0;
              const price = toNumber(p.pricePerUnit);
              const upb = Number(p.unitsPerBox ?? 0);
              const isBoxed = upb > 1;
              const stepLabel = isBoxed
                ? `${line?.boxes ?? 0}b${(line?.pieces ?? 0) > 0 ? ` + ${line?.pieces ?? 0}` : ""}`
                : `${q}`;
              return (
                <View
                  key={p.id}
                  onLayout={(e) => {
                    rowYRef.current.set(p.id, e.nativeEvent.layout.y);
                    if (scrollToIdRef.current === p.id && scrollToRow(p.id)) {
                      scrollToIdRef.current = null;
                      setScrollToId(null);
                    }
                  }}
                  style={styles.productRow}
                >
                  <View style={styles.productImg} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.productName} numberOfLines={1}>
                      {displayName(p)}
                    </Text>
                    <Text style={styles.productMeta}>
                      {p.sku ? `SKU ${p.sku} · ` : ""}${price.toFixed(2)}
                      {isBoxed ? ` / box of ${upb}` : p.unit ? ` / ${p.unit}` : ""}
                    </Text>
                  </View>
                  {q > 0 ? (
                    <View style={styles.stepper}>
                      <Pressable style={styles.stepBtn} onPress={() => removeOne(p.id)}>
                        <Text style={styles.stepBtnText}>−</Text>
                      </Pressable>
                      <Text style={styles.stepQty}>{stepLabel}</Text>
                      <Pressable style={styles.stepBtn} onPress={() => addOne(p.id)}>
                        <Text style={styles.stepBtnText}>+</Text>
                      </Pressable>
                    </View>
                  ) : (
                    <Pressable style={styles.addBtn} onPress={() => addOne(p.id)}>
                      <Text style={styles.addBtnText}>+</Text>
                    </Pressable>
                  )}
                </View>
              );
            })}
          </View>
        )}

        {/* Add an ad-hoc line that isn't in the catalog (free-text + price). */}
        <View style={styles.unlistedCtaWrap}>
          <Pressable style={styles.unlistedCta} onPress={() => setUnlistedModalOpen(true)}>
            <Ionicons name="add-circle-outline" size={18} color={ios.brand} />
            <Text style={styles.unlistedCtaText}>Add unlisted item</Text>
          </Pressable>
          {unlisted.length > 0 ? (
            <Text style={styles.unlistedCount}>
              {unlisted.length} custom line{unlisted.length === 1 ? "" : "s"}
            </Text>
          ) : null}
        </View>

        {/* Terms + due date — always shown so the operator can tweak before save */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Payment terms</Text>
          <View style={styles.termsRow}>
            {TERM_OPTIONS.map((t) => {
              const active = t === terms;
              return (
                <Pressable
                  key={t}
                  style={[styles.termPill, active && styles.termPillActive]}
                  onPress={() => onTermsChange(t)}
                >
                  <Text style={[styles.termPillText, active && styles.termPillTextActive]}>
                    {t}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.dueLabel}>Due date</Text>
          <TextInput
            value={dueDate}
            onChangeText={setDueDate}
            placeholder="YYYY-MM-DD"
            style={styles.dueInput}
          />
          <Pressable style={styles.sendRow} onPress={() => setSend((s) => !s)}>
            <View style={[styles.checkbox, send && styles.checkboxOn]}>
              {send ? <Text style={styles.checkboxTick}>✓</Text> : null}
            </View>
            <Text style={styles.sendLabel}>Send immediately on create</Text>
          </Pressable>
        </View>

        <View style={{ height: 16 }} />
      </ScrollView>

      <View style={styles.footer}>
        <Pressable
          style={styles.footerTotalTap}
          onPress={totalItems > 0 ? () => setReviewOpen(true) : undefined}
          disabled={totalItems === 0}
          hitSlop={6}
        >
          <Text style={styles.footerEyebrow}>
            {totalItems} ITEM{totalItems === 1 ? "" : "S"}
          </Text>
          <Text style={styles.footerTotal}>${total.toFixed(2)}</Text>
        </Pressable>
        <View style={styles.footerActions}>
          {totalItems > 0 ? (
            <Pressable style={styles.viewBtn} onPress={() => setReviewOpen(true)} hitSlop={4}>
              <Ionicons name="list-outline" size={14} color={ios.brand} />
              <Text style={styles.viewBtnText}>View / edit</Text>
            </Pressable>
          ) : null}
          <Pressable
            style={[
              styles.confirmBtn,
              (!canSave || createMut.isPending) && styles.confirmBtnDisabled,
            ]}
            disabled={!canSave}
            onPress={onSave}
          >
            <Text style={styles.confirmBtnText}>{createMut.isPending ? "Saving…" : "Create"}</Text>
            <Ionicons name="arrow-forward" size={14} color="#fff" />
          </Pressable>
        </View>
      </View>

      {/* Review sheet — same UX as new-order's cart sheet */}
      <ReviewSheet
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        items={items}
        productById={productById}
        unlisted={unlisted}
        total={total}
        onRemove={removeLine}
        onIncrement={addOne}
        onDecrement={removeOne}
        onSetPrice={setLinePrice}
        onChangeUnlistedQty={updateUnlistedQty}
        onChangeUnlistedPrice={updateUnlistedPrice}
        onRemoveUnlisted={removeUnlisted}
        onAddUnlisted={() => {
          setReviewOpen(false);
          setUnlistedModalOpen(true);
        }}
      />

      <UnlistedItemModal
        open={unlistedModalOpen}
        onClose={() => setUnlistedModalOpen(false)}
        onAdd={(name, unitPrice, qty) => {
          addUnlisted(name, unitPrice, qty);
          setUnlistedModalOpen(false);
          showToast(`Added ${name}`);
        }}
      />

      <BarcodeFab continuous onScanned={handleScanned} hidden={reviewOpen || unlistedModalOpen} />

      <InlineCreateProductSheet
        visible={createCode != null}
        initialCode={createCode ?? undefined}
        onClose={() => setCreateCode(null)}
        onCreated={handleInlineCreated}
      />
    </>
  );
}

// ─── Review sheet ────────────────────────────────────────────────────────────

function ReviewSheet({
  open,
  onClose,
  items,
  productById,
  unlisted,
  total,
  onRemove,
  onIncrement,
  onDecrement,
  onSetPrice,
  onChangeUnlistedQty,
  onChangeUnlistedPrice,
  onRemoveUnlisted,
  onAddUnlisted,
}: {
  open: boolean;
  onClose: () => void;
  items: Record<string, LineState>;
  productById: Map<string, Product>;
  unlisted: UnlistedLine[];
  total: number;
  onRemove: (id: string) => void;
  onIncrement: (id: string) => void;
  onDecrement: (id: string) => void;
  onSetPrice: (id: string, value: number | null) => void;
  onChangeUnlistedQty: (id: string, n: number) => void;
  onChangeUnlistedPrice: (id: string, value: number | null) => void;
  onRemoveUnlisted: (id: string) => void;
  onAddUnlisted: () => void;
}) {
  const rows = useMemo(() => {
    const list: { id: string; product: Product; line: LineState }[] = [];
    for (const [id, line] of Object.entries(items)) {
      const p = productById.get(id);
      if (!p) continue;
      list.push({ id, product: p, line });
    }
    list.sort((a, b) => displayName(a.product).localeCompare(displayName(b.product)));
    return list;
  }, [items, productById]);

  return (
    <Modal visible={open} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Pressable onPress={onClose} hitSlop={8} style={styles.sheetHeaderBtn}>
              <Ionicons name="chevron-down" size={22} color={ios.label2} />
            </Pressable>
            <Text style={styles.sheetTitle}>Review invoice</Text>
            <Text style={styles.sheetCount}>${total.toFixed(2)}</Text>
          </View>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16, gap: 10 }}
          >
            {rows.length === 0 && unlisted.length === 0 ? (
              <View style={[styles.center, { paddingVertical: 40 }]}>
                <Text style={styles.emptyText}>No items.</Text>
              </View>
            ) : (
              rows.map(({ id, product, line }) => {
                const upb = Number(product.unitsPerBox ?? 0);
                const isBoxed = upb > 1;
                const qty = effectiveQty(line, product.unitsPerBox);
                const catalogPrice = toNumber(product.pricePerUnit);
                const effUnit = effectiveUnitPrice(line, product);
                const isOverridden = line.unitPrice != null && line.unitPrice !== catalogPrice;
                const lineTotal = computeLineSubtotal({
                  unitPrice: effUnit,
                  qty,
                  boxes: line.boxes ?? null,
                  pieces: line.pieces ?? null,
                  unitsPerBox: product.unitsPerBox ?? null,
                });
                const stepLabel = isBoxed
                  ? `${line.boxes ?? 0}b${(line.pieces ?? 0) > 0 ? ` + ${line.pieces ?? 0}` : ""}`
                  : `${qty}`;
                return (
                  <View key={id} style={styles.reviewRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.reviewName}>{displayName(product)}</Text>
                      <View style={styles.priceEditRow}>
                        <Text style={styles.priceCurrency}>$</Text>
                        <MoneyTextInput
                          value={line.unitPrice ?? null}
                          onChangeValue={(v) => onSetPrice(id, v)}
                          placeholder={catalogPrice.toFixed(2)}
                          style={[styles.priceInput, isOverridden && styles.priceInputActive]}
                        />
                        <Text style={styles.reviewMeta}>
                          {isBoxed ? `/ box of ${upb}` : product.unit ? `/ ${product.unit}` : ""}
                        </Text>
                        {isOverridden ? (
                          <Text style={styles.priceWas}>was ${catalogPrice.toFixed(2)}</Text>
                        ) : null}
                      </View>
                    </View>
                    <View style={styles.stepper}>
                      <Pressable style={styles.stepBtn} onPress={() => onDecrement(id)}>
                        <Text style={styles.stepBtnText}>−</Text>
                      </Pressable>
                      <Text style={styles.stepQty}>{stepLabel}</Text>
                      <Pressable style={styles.stepBtn} onPress={() => onIncrement(id)}>
                        <Text style={styles.stepBtnText}>+</Text>
                      </Pressable>
                    </View>
                    <Text style={styles.reviewTotal}>${lineTotal.toFixed(2)}</Text>
                    <Pressable onPress={() => onRemove(id)} hitSlop={6} style={styles.removeBtn}>
                      <Ionicons name="trash-outline" size={16} color={ios.system.redInk} />
                    </Pressable>
                  </View>
                );
              })
            )}
            {unlisted.map((u) => {
              const lineTotal = computeLineSubtotal({ unitPrice: u.unitPrice, qty: u.qty });
              return (
                <View key={u.id} style={styles.reviewRow}>
                  <View style={{ flex: 1 }}>
                    <View style={styles.unlistedTagRow}>
                      <Text style={styles.reviewName} numberOfLines={1}>
                        {u.name || "Unlisted item"}
                      </Text>
                      <View style={styles.customTag}>
                        <Text style={styles.customTagText}>Custom</Text>
                      </View>
                    </View>
                    <View style={styles.priceEditRow}>
                      <Text style={styles.priceCurrency}>$</Text>
                      <MoneyTextInput
                        value={u.unitPrice || null}
                        onChangeValue={(v) => onChangeUnlistedPrice(u.id, v)}
                        placeholder="0.00"
                        style={[styles.priceInput, styles.priceInputActive]}
                      />
                      <Text style={styles.reviewMeta}>/ unit</Text>
                    </View>
                  </View>
                  <View style={styles.stepper}>
                    <Pressable
                      style={styles.stepBtn}
                      onPress={() => onChangeUnlistedQty(u.id, Math.max(0, u.qty - 1))}
                    >
                      <Text style={styles.stepBtnText}>−</Text>
                    </Pressable>
                    <Text style={styles.stepQty}>{u.qty}</Text>
                    <Pressable
                      style={styles.stepBtn}
                      onPress={() => onChangeUnlistedQty(u.id, u.qty + 1)}
                    >
                      <Text style={styles.stepBtnText}>+</Text>
                    </Pressable>
                  </View>
                  <Text style={styles.reviewTotal}>${lineTotal.toFixed(2)}</Text>
                  <Pressable
                    onPress={() => onRemoveUnlisted(u.id)}
                    hitSlop={6}
                    style={styles.removeBtn}
                  >
                    <Ionicons name="trash-outline" size={16} color={ios.system.redInk} />
                  </Pressable>
                </View>
              );
            })}
            <Pressable style={styles.reviewAddUnlisted} onPress={onAddUnlisted} hitSlop={4}>
              <Ionicons name="add-circle-outline" size={16} color={ios.brand} />
              <Text style={styles.reviewAddUnlistedText}>Add unlisted item</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ─── Unlisted item modal ─────────────────────────────────────────────────────

function UnlistedItemModal({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (name: string, unitPrice: number, qty: number) => void;
}) {
  const [name, setName] = useState("");
  const [priceText, setPriceText] = useState("");
  const [qtyText, setQtyText] = useState("1");

  useEffect(() => {
    if (open) {
      setName("");
      setPriceText("");
      setQtyText("1");
    }
  }, [open]);

  const price = parseFloat(priceText);
  const qty = parseInt(qtyText || "0", 10);
  const valid = name.trim() !== "" && Number.isFinite(price) && price > 0 && qty > 0;

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.unlistedOverlay} onPress={onClose}>
        <Pressable style={styles.unlistedCard} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.unlistedTitle}>Add unlisted item</Text>
          <Text style={styles.unlistedSub}>A one-off line that isn't in your catalog.</Text>

          <Text style={styles.unlistedFieldLabel}>Item description</Text>
          <TextInput
            style={styles.unlistedInput}
            value={name}
            onChangeText={setName}
            placeholder="e.g. Delivery surcharge"
            placeholderTextColor={ios.label3}
            autoFocus
          />

          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.unlistedFieldLabel}>Unit price</Text>
              <TextInput
                style={styles.unlistedInput}
                value={priceText}
                onChangeText={setPriceText}
                placeholder="0.00"
                placeholderTextColor={ios.label3}
                keyboardType="decimal-pad"
                selectTextOnFocus
              />
            </View>
            <View style={{ width: 96 }}>
              <Text style={styles.unlistedFieldLabel}>Qty</Text>
              <TextInput
                style={styles.unlistedInput}
                value={qtyText}
                onChangeText={(t) => setQtyText(t.replace(/[^0-9]/g, ""))}
                placeholder="1"
                placeholderTextColor={ios.label3}
                keyboardType="number-pad"
                maxLength={5}
                selectTextOnFocus
              />
            </View>
          </View>

          <View style={styles.modalBtns}>
            <Pressable style={styles.modalBtnGhost} onPress={onClose}>
              <Text style={styles.modalBtnGhostText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.modalBtnFill, !valid && styles.modalBtnDisabled]}
              onPress={() => valid && onAdd(name.trim(), price, qty)}
              disabled={!valid}
            >
              <Text style={styles.modalBtnFillText}>Add to invoice</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bgElev },
  center: { padding: 40, alignItems: "center" },
  emptyText: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },

  customerList: {
    marginHorizontal: 16,
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
  },
  customerRow: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
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
  customerSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 1,
  },

  customerChipWrap: { paddingHorizontal: 16, paddingTop: 10 },
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

  productRow: {
    backgroundColor: ios.bg,
    borderRadius: 14,
    padding: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  productImg: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: ios.brandWash,
  },
  productName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  productMeta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 1,
    fontVariant: ["tabular-nums"],
  },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: ios.bgElev,
    borderRadius: 10,
    padding: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
  },
  stepBtn: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  stepBtnText: { color: ios.brand, fontSize: 18 },
  stepQty: {
    minWidth: 28,
    textAlign: "center",
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  addBtn: {
    width: 36,
    height: 36,
    backgroundColor: ios.brandWash,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  addBtnText: { color: ios.brand, fontSize: 20 },

  section: {
    marginHorizontal: 16,
    marginTop: 16,
    backgroundColor: ios.bg,
    borderRadius: 14,
    padding: 14,
    gap: 10,
  },
  sectionTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  termsRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  termPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: ios.separator,
  },
  termPillActive: { backgroundColor: ios.brand, borderColor: ios.brand },
  termPillText: { fontSize: 13, color: ios.label },
  termPillTextActive: { color: "#fff", fontFamily: "Inter_600SemiBold" },
  dueLabel: { fontSize: 12, color: ios.label2, marginTop: 4 },
  dueInput: {
    borderWidth: 1,
    borderColor: ios.separator,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: ios.label,
  },
  sendRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 4 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: ios.separator,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: { backgroundColor: ios.brand, borderColor: ios.brand },
  checkboxTick: { color: "#fff", fontFamily: "Inter_700Bold" },
  sendLabel: { fontSize: 13, color: ios.label },

  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 16,
    backgroundColor: ios.bgElev,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  footerTotalTap: { paddingVertical: 4, paddingRight: 8 },
  footerEyebrow: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    color: ios.label2,
    letterSpacing: 0.4,
  },
  footerTotal: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  footerActions: { flexDirection: "row", gap: 8, alignItems: "center" },
  viewBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: ios.brandWash,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 14,
  },
  viewBtnText: { color: ios.brand, fontSize: 14, fontFamily: "Inter_600SemiBold" },
  confirmBtn: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  confirmBtnDisabled: { opacity: 0.4 },
  confirmBtnText: { color: "#fff", fontSize: 14, fontFamily: "Inter_600SemiBold" },

  // Review sheet
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: ios.bg,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    maxHeight: "92%",
    minHeight: "55%",
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  sheetHeaderBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  sheetTitle: {
    flex: 1,
    textAlign: "center",
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: ios.label,
  },
  sheetCount: {
    width: 80,
    textAlign: "right",
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    marginRight: 6,
    fontVariant: ["tabular-nums"],
  },
  reviewRow: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  reviewName: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  reviewMeta: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  priceEditRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  priceCurrency: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  priceInput: {
    minWidth: 56,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: ios.separator,
    borderRadius: 8,
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  priceInputActive: { borderColor: ios.brand, color: ios.brand },
  priceWas: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textDecorationLine: "line-through",
  },
  reviewTotal: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
    minWidth: 60,
    textAlign: "right",
  },
  removeBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: ios.system.redWash,
    borderRadius: 8,
  },

  // ── Unlisted item CTA + tag + modal ───────────────────────────────────────
  unlistedCtaWrap: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    marginTop: 16,
  },
  unlistedCta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: ios.brandWash,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  unlistedCtaText: { color: ios.brand, fontSize: 14, fontFamily: "Inter_600SemiBold" },
  unlistedCount: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.label2 },
  unlistedTagRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  customTag: {
    backgroundColor: ios.system.orangeWash,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  customTagText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.system.orangeInk,
    letterSpacing: 0.2,
  },
  reviewAddUnlisted: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: ios.brandWash,
    borderRadius: 12,
    paddingVertical: 12,
  },
  reviewAddUnlistedText: { color: ios.brand, fontSize: 14, fontFamily: "Inter_600SemiBold" },
  unlistedOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  unlistedCard: {
    backgroundColor: ios.bgElev,
    borderRadius: 20,
    padding: 20,
    width: "100%",
    maxWidth: 380,
  },
  unlistedTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.3,
    marginBottom: 2,
  },
  unlistedSub: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginBottom: 12,
  },
  unlistedFieldLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.3,
    marginBottom: 6,
  },
  unlistedInput: {
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    fontFamily: "Inter_500Medium",
    color: ios.label,
    marginBottom: 12,
  },
  modalBtns: { flexDirection: "row", gap: 10, marginTop: 4 },
  modalBtnGhost: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: ios.fill3,
  },
  modalBtnGhostText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  modalBtnFill: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: ios.brand,
  },
  modalBtnDisabled: { opacity: 0.4 },
  modalBtnFillText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#fff" },
});
