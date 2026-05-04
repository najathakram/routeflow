import { useEffect, useMemo, useState } from "react";
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
import {
  NavAction,
  NavBackButton,
  NavBar,
  SearchBar,
} from "@routeflow/ui/mobile/ios";
import { useAdminCustomers } from "../../../../lib/api/admin";
import { useProducts } from "../../../../lib/api/products";
import { useCreateInvoice, type CreateInvoiceItem } from "../../../../lib/api/invoices";
import { showToast } from "../../../../lib/toast";
import { resolveProductByCode } from "../../../../lib/barcode-resolve";
import { computeLineSubtotal, effectiveQty } from "../../../../lib/pricing";
import { alertInfo, chooseAction } from "../../../../lib/confirm";
import { BarcodeFab } from "../../../../components/BarcodeFab";

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
  parent?: { id: string; name: string } | null;
};

type LineState = { qty: number; boxes?: number; pieces?: number };

function displayName(p: Product): string {
  if (p.parent?.name) return `${p.parent.name} - ${p.name}`;
  return p.name;
}

export default function NewInvoiceScreen() {
  const router = useRouter();
  const [pickedCustomerId, setPickedCustomerId] = useState<string | null>(null);
  const [pickedCustomerName, setPickedCustomerName] = useState<string | null>(null);

  if (!pickedCustomerId) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <CustomerPicker
          onBack={() => router.back()}
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
        onBack={() => router.back()}
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
      <NavBar
        inlineTitle="New invoice"
        leading={<NavBackButton label="Back" onPress={onBack} />}
      />
      <SearchBar
        placeholder="Search customers…"
        value={search}
        onChangeText={setSearch}
      />
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
  const [scannedById, setScannedById] = useState<Record<string, Product>>({});
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
      const prev = m[id] ?? { qty: 0 };
      if (isBoxed) {
        const boxes = (prev.boxes ?? 0) + 1;
        const pieces = prev.pieces ?? 0;
        return { ...m, [id]: { qty: boxes * upb + pieces, boxes, pieces } };
      }
      return { ...m, [id]: { qty: (prev.qty ?? 0) + 1 } };
    });
    if (snapshot && !productById.has(id)) {
      setScannedById((m) => ({ ...m, [id]: snapshot }));
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

  const handleScanned = async (code: string) => {
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
      showToast(`Added ${displayName(local)}`);
      return;
    }
    try {
      const result = await resolveProductByCode<Product>(trimmed);
      if (!result.notFound && result.product?.id) {
        addOne(result.product.id, result.product);
        showToast(`Added ${displayName(result.product)}`);
        return;
      }
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? err?.message ?? "Couldn't look up barcode.";
      showToast(msg);
      return;
    }
    chooseAction(
      `No product for "${trimmed}"`,
      "Add it as a new product? (Your in-progress invoice won't be saved if you continue.)",
      [
        { label: "Cancel", style: "cancel" },
        {
          label: "Create",
          onPress: () =>
            router.push({
              pathname: "/(operator)/products/new",
              params: { barcode: trimmed },
            }),
        },
      ],
    );
  };

  const filtered = useMemo(() => products, [products]);

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
        unitPrice: toNumber(p.pricePerUnit),
        qty,
        boxes: line.boxes ?? null,
        pieces: line.pieces ?? null,
        unitsPerBox: p.unitsPerBox ?? null,
      });
    }
    return { total, totalItems };
  }, [items, productById]);

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
        unitPrice: toNumber(p.pricePerUnit),
        ...(line.boxes != null ? { boxes: line.boxes } : {}),
        ...(line.pieces != null ? { pieces: line.pieces } : {}),
      });
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

      <ScrollView showsVerticalScrollIndicator={false}>
        <SearchBar
          placeholder="Search items…"
          value={search}
          onChangeText={setSearch}
        />

        {productsLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : filtered.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyText}>
              No products{search ? " match your search" : ""}.
            </Text>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, paddingTop: 14, gap: 10 }}>
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
                <View key={p.id} style={styles.productRow}>
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
                  <Text
                    style={[
                      styles.termPillText,
                      active && styles.termPillTextActive,
                    ]}
                  >
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
          <Pressable
            style={styles.sendRow}
            onPress={() => setSend((s) => !s)}
          >
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
            <Pressable
              style={styles.viewBtn}
              onPress={() => setReviewOpen(true)}
              hitSlop={4}
            >
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
            <Text style={styles.confirmBtnText}>
              {createMut.isPending ? "Saving…" : "Create"}
            </Text>
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
        total={total}
        onRemove={removeLine}
        onIncrement={addOne}
        onDecrement={removeOne}
      />

      <BarcodeFab onScanned={handleScanned} hidden={reviewOpen} />
    </>
  );
}

// ─── Review sheet ────────────────────────────────────────────────────────────

function ReviewSheet({
  open,
  onClose,
  items,
  productById,
  total,
  onRemove,
  onIncrement,
  onDecrement,
}: {
  open: boolean;
  onClose: () => void;
  items: Record<string, LineState>;
  productById: Map<string, Product>;
  total: number;
  onRemove: (id: string) => void;
  onIncrement: (id: string) => void;
  onDecrement: (id: string) => void;
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
    <Modal
      visible={open}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
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
            {rows.length === 0 ? (
              <View style={[styles.center, { paddingVertical: 40 }]}>
                <Text style={styles.emptyText}>No items.</Text>
              </View>
            ) : (
              rows.map(({ id, product, line }) => {
                const upb = Number(product.unitsPerBox ?? 0);
                const isBoxed = upb > 1;
                const qty = effectiveQty(line, product.unitsPerBox);
                const lineTotal = computeLineSubtotal({
                  unitPrice: toNumber(product.pricePerUnit),
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
                      <Text style={styles.reviewMeta}>
                        ${toNumber(product.pricePerUnit).toFixed(2)}
                        {isBoxed ? ` / box of ${upb}` : product.unit ? ` / ${product.unit}` : ""}
                      </Text>
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
          </ScrollView>
        </View>
      </View>
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
  sheetTitle: { flex: 1, textAlign: "center", fontSize: 16, fontFamily: "Inter_700Bold", color: ios.label },
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
});
