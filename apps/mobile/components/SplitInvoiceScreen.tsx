import { useEffect, useMemo, useRef, useState } from "react";
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
import { ios } from "@routeflow/ui/tokens";
import { NavBar, NavBackButton, NavAction } from "@routeflow/ui/mobile/ios";
import { useCreatePartialInvoiceFromOrder } from "../lib/api/invoices";
import { showToast } from "../lib/toast";
// RN Alert.alert is a no-op for multi-button alerts on Expo Web; alertInfo
// routes through the cross-platform confirm modal instead.
import { alertInfo } from "../lib/confirm";

export interface SplitInvoiceItem {
  id: string;
  productName: string;
  qty: number;
  invoicedQty: number;
  unitPrice: number;
  /** Stored line subtotal — prorated for the preview so boxed lines aren't over-charged. */
  subtotal?: number;
  unit?: string;
}

/**
 * Preview line total for billing `billQty` of an order line. Mirrors the server:
 * prorate the STORED subtotal by qty (so boxed lines, whose unitPrice is the BOX
 * price, are never multiplied by the piece count). Falls back to qty × unitPrice
 * only when the line has no stored subtotal.
 */
function previewLineTotal(it: SplitInvoiceItem, billQty: number): number {
  if (it.subtotal != null && it.qty > 0) {
    return Math.round(((it.subtotal * billQty) / it.qty) * 100) / 100;
  }
  return Math.round(billQty * it.unitPrice * 100) / 100;
}

export interface SplitInvoiceScreenProps {
  orderId: string;
  orderNumber: string | null;
  items: SplitInvoiceItem[];
  defaultTerms?: string;
  /** Called after every successful create. Caller decides where to navigate next. */
  onCreated: (invoiceId: string) => void;
  onCancel: () => void;
  backLabel?: string;
}

const TERM_DAYS: Record<string, number> = {
  "Due on Receipt": 0,
  "Net 15": 15,
  "Net 30": 30,
  "Net 45": 45,
  "Net 60": 60,
};

const TERM_OPTIONS = Object.keys(TERM_DAYS);

function todayPlusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * One draft invoice in the composer. The operator builds N of these in the UI
 * before any server call; on Submit we POST `/invoices/from-order/.../partial`
 * for each draft sequentially. Each draft owns its own per-item qtys, terms,
 * due date and send-on-create flag.
 */
type DraftInvoice = {
  /** Local UUID for React key + remove. Not sent to the server. */
  id: string;
  /** orderItemId → qty (string so the user can clear/type freely). */
  qtyById: Record<string, string>;
  terms: string;
  dueDate: string;
  send: boolean;
};

let draftSeq = 0;
function makeDraft(defaultTerms: string): DraftInvoice {
  draftSeq += 1;
  return {
    id: `draft-${Date.now()}-${draftSeq}`,
    qtyById: {},
    terms: defaultTerms,
    dueDate: todayPlusDays(TERM_DAYS[defaultTerms] ?? 30),
    send: false,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Multi-invoice composer for splitting a single order into N partial invoices.
 *
 * Flow:
 *   1. Operator opens the screen — one empty draft is shown.
 *   2. Operator allocates per-item qtys to each draft + sets terms/due-date/send.
 *   3. "Add another invoice" appends another draft card.
 *   4. The composer enforces: per-item allocations across drafts can't exceed
 *      `qty - invoicedQty`. Inputs clamp on commit; the unallocated tally at
 *      the bottom shows what's left so the operator knows when they're done.
 *   5. "Create N invoices" iterates the drafts and POSTs each sequentially.
 *      First failure stops the loop and surfaces the server message — already-
 *      created invoices stay (the order has a linked-invoices list).
 *
 * Was a single-shot screen before. The user reported "we can't split into
 * multiple invoices, because we don't have the option" — meaning the UI made
 * it look like one Create = one invoice = done. This composer makes the
 * "build N invoices, then create them all" intent explicit.
 */
export function SplitInvoiceScreen({
  orderId,
  orderNumber,
  items,
  defaultTerms = "Net 30",
  onCreated,
  onCancel,
  backLabel = "Back",
}: SplitInvoiceScreenProps) {
  const billable = useMemo(() => items.filter((it) => it.qty - it.invoicedQty > 0.001), [items]);

  const [drafts, setDrafts] = useState<DraftInvoice[]>(() => [makeDraft(defaultTerms)]);

  // Track which drafts have been created in this session so a "Save all"
  // attempt that partially fails is recoverable (we skip already-saved ones).
  const [createdDraftIds, setCreatedDraftIds] = useState<Set<string>>(new Set());
  const [bulkPending, setBulkPending] = useState(false);
  const createPartial = useCreatePartialInvoiceFromOrder();

  // One-shot flag: pre-fill the first draft with all billable items at full
  // remaining qty when the order data first arrives. Operator can then dial
  // qtys down to free items for additional invoices. Per the user:
  // "the default to start with should be all assigned to the first invoice."
  const firstFillDone = useRef(false);

  // Reset draft state when the order's billable set is empty (everything
  // already invoiced) so the screen shows a clean done state.
  useEffect(() => {
    if (billable.length === 0) {
      setDrafts([]);
      firstFillDone.current = false;
      return;
    }
    if (firstFillDone.current) return;
    setDrafts((prev) => {
      // Only auto-populate when there's still exactly the seeded empty draft.
      if (prev.length !== 1) return prev;
      const first = prev[0]!;
      if (Object.keys(first.qtyById).length > 0) return prev;
      const qtyById: Record<string, string> = {};
      for (const it of billable) {
        const remaining = Math.max(0, it.qty - it.invoicedQty);
        qtyById[it.id] = String(remaining);
      }
      return [{ ...first, qtyById }];
    });
    firstFillDone.current = true;
  }, [billable]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const remainingForItem = (itemId: string, exceptDraftId?: string): number => {
    const item = billable.find((it) => it.id === itemId);
    if (!item) return 0;
    const totalRemaining = item.qty - item.invoicedQty;
    let allocated = 0;
    for (const d of drafts) {
      if (d.id === exceptDraftId) continue;
      // Don't double-count drafts that have already been saved this session.
      if (createdDraftIds.has(d.id)) continue;
      const v = Number(d.qtyById[itemId] ?? 0);
      if (Number.isFinite(v) && v > 0) allocated += v;
    }
    return Math.max(0, totalRemaining - allocated);
  };

  const allocatedForItem = (itemId: string): number => {
    let n = 0;
    for (const d of drafts) {
      if (createdDraftIds.has(d.id)) continue;
      const v = Number(d.qtyById[itemId] ?? 0);
      if (Number.isFinite(v) && v > 0) n += v;
    }
    return n;
  };

  const updateDraft = (id: string, patch: Partial<DraftInvoice>) =>
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  const setItemQty = (draftId: string, itemId: string, value: string) => {
    setDrafts((prev) =>
      prev.map((d) => {
        if (d.id !== draftId) return d;
        // Allow blank or partially-typed values; commit/clamp in onBlur logic.
        return { ...d, qtyById: { ...d.qtyById, [itemId]: value } };
      }),
    );
  };

  const commitItemQty = (draftId: string, itemId: string) => {
    setDrafts((prev) =>
      prev.map((d) => {
        if (d.id !== draftId) return d;
        const raw = d.qtyById[itemId];
        const n = Number(raw ?? 0);
        const safe = Number.isFinite(n) && n > 0 ? n : 0;
        // Cap at remaining (which already excludes other drafts' allocations).
        const cap = remainingForItem(itemId, draftId);
        const final = clamp(safe, 0, cap);
        return { ...d, qtyById: { ...d.qtyById, [itemId]: final === 0 ? "" : String(final) } };
      }),
    );
  };

  const setTerms = (draftId: string, terms: string) => {
    updateDraft(draftId, { terms, dueDate: todayPlusDays(TERM_DAYS[terms] ?? 30) });
  };

  const removeDraft = (draftId: string) => {
    setDrafts((prev) => prev.filter((d) => d.id !== draftId));
  };

  const addDraft = () => {
    setDrafts((prev) => [...prev, makeDraft(defaultTerms)]);
  };

  const subtotalFor = (draft: DraftInvoice): number => {
    let s = 0;
    for (const it of billable) {
      const q = Number(draft.qtyById[it.id] ?? 0);
      if (!Number.isFinite(q) || q <= 0) continue;
      s += previewLineTotal(it, q);
    }
    return s;
  };

  const draftHasItems = (draft: DraftInvoice): boolean => {
    for (const v of Object.values(draft.qtyById)) {
      const n = Number(v ?? 0);
      if (Number.isFinite(n) && n > 0) return true;
    }
    return false;
  };

  // ── Submit all ─────────────────────────────────────────────────────────────

  const submitAll = async () => {
    const submitable = drafts.filter((d) => !createdDraftIds.has(d.id) && draftHasItems(d));
    if (submitable.length === 0) {
      alertInfo(
        "Nothing to create",
        "Allocate at least one item to a draft before creating invoices.",
      );
      return;
    }
    // Validate each draft has a usable due date.
    for (const d of submitable) {
      if (!d.dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(d.dueDate)) {
        alertInfo(
          "Bad due date",
          `Invoice draft has an invalid due date (${d.dueDate || "blank"}). Format: YYYY-MM-DD.`,
        );
        return;
      }
    }

    setBulkPending(true);
    let lastInvoiceId: string | null = null;
    try {
      for (const d of submitable) {
        const chosen = billable
          .map((it) => ({ orderItemId: it.id, qty: Number(d.qtyById[it.id] ?? 0) }))
          .filter((row) => Number.isFinite(row.qty) && row.qty > 0);
        if (chosen.length === 0) continue;
        // eslint-disable-next-line no-await-in-loop -- sequential by design so the
        // server-side OrderItem.invoicedQty increments don't race each other.
        const invoice = await createPartial.mutateAsync({
          orderId,
          items: chosen,
          terms: d.terms,
          dueDate: d.dueDate,
          send: d.send,
        });
        setCreatedDraftIds((prev) => {
          const next = new Set(prev);
          next.add(d.id);
          return next;
        });
        lastInvoiceId = invoice.id;
      }
      showToast(`Created ${submitable.length} invoice${submitable.length === 1 ? "" : "s"}`);
      if (lastInvoiceId) onCreated(lastInvoiceId);
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? err?.message ?? "One or more invoices failed.";
      alertInfo("Couldn't create all invoices", msg);
    } finally {
      setBulkPending(false);
    }
  };

  // ── Computed ──────────────────────────────────────────────────────────────

  const drafsToCreate = drafts.filter((d) => !createdDraftIds.has(d.id) && draftHasItems(d));
  const totalToCreate = drafsToCreate.reduce((s, d) => s + subtotalFor(d), 0);
  const unallocated = billable.map((it) => ({
    item: it,
    left: remainingForItem(it.id),
  }));
  const allDoneNow = billable.length === 0;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Split into invoices"
        leading={<NavBackButton label={backLabel} onPress={onCancel} />}
        trailing={
          allDoneNow ? (
            <NavAction label="Done" bold onPress={onCancel} />
          ) : (
            <NavAction
              label={bulkPending ? "Saving…" : `Create ${drafsToCreate.length || ""}`}
              bold
              onPress={bulkPending || drafsToCreate.length === 0 ? undefined : submitAll}
            />
          )
        }
      />

      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        {!allDoneNow ? (
          <View style={styles.helperCard}>
            <Ionicons name="information-circle-outline" size={18} color={ios.brand} />
            <Text style={styles.helperText}>
              Build one or more invoices for order {orderNumber ?? orderId.slice(0, 8)}. Allocate
              items to each draft, set its terms and due date, then tap Create to make them all at
              once.
            </Text>
          </View>
        ) : null}

        {allDoneNow ? (
          <View style={styles.card}>
            <View style={{ alignItems: "center", paddingVertical: 16, gap: 6 }}>
              <Ionicons name="checkmark-circle" size={32} color={ios.system.greenInk} />
              <Text style={styles.allDoneTitle}>All items invoiced</Text>
              <Text style={styles.allDoneSub}>
                Nothing left on this order to bill. To re-split, open one of the existing invoices
                and tap Void or Delete — that frees the items so you can split again.
              </Text>
            </View>
          </View>
        ) : (
          drafts.map((draft, i) => {
            const created = createdDraftIds.has(draft.id);
            const subtotal = subtotalFor(draft);
            return (
              <View key={draft.id} style={[styles.card, created && { opacity: 0.5 }]}>
                <View style={styles.cardHeader}>
                  <Text style={styles.cardTitle}>Invoice {i + 1}</Text>
                  {created ? (
                    <View style={styles.createdBadge}>
                      <Ionicons name="checkmark-circle" size={14} color={ios.system.greenInk} />
                      <Text style={styles.createdBadgeText}>Created</Text>
                    </View>
                  ) : drafts.length > 1 ? (
                    <Pressable onPress={() => removeDraft(draft.id)} hitSlop={8}>
                      <Text style={styles.removeText}>Remove</Text>
                    </Pressable>
                  ) : null}
                </View>

                {billable.map((it) => {
                  const cap = remainingForItem(it.id, draft.id);
                  const value = draft.qtyById[it.id] ?? "";
                  const numValue = Number(value);
                  const lineTotal =
                    Number.isFinite(numValue) && numValue > 0 ? previewLineTotal(it, numValue) : 0;
                  // Global "left to allocate" (across all drafts in this
                  // session). Updates live as the operator types — that's
                  // what they asked for: "if we have 10 units ... and split
                  // into 5, it should show 5 more left."
                  const totalRemaining = it.qty - it.invoicedQty;
                  const globalLeft = remainingForItem(it.id);
                  return (
                    <View key={it.id} style={styles.itemRow}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.itemName} numberOfLines={1}>
                          {it.productName}
                        </Text>
                        <Text style={styles.itemSub}>
                          <Text
                            style={{
                              color: globalLeft > 0 ? ios.system.orangeInk : ios.system.greenInk,
                              fontFamily: "Inter_700Bold",
                            }}
                          >
                            {globalLeft}
                          </Text>{" "}
                          of {totalRemaining} {it.unit ?? "ea"} left · ${it.unitPrice.toFixed(2)}/ea
                        </Text>
                      </View>
                      <TextInput
                        keyboardType="decimal-pad"
                        style={styles.qtyInput}
                        editable={!created}
                        value={value}
                        onChangeText={(v) => setItemQty(draft.id, it.id, v)}
                        onBlur={() => commitItemQty(draft.id, it.id)}
                        selectTextOnFocus
                        placeholder="0"
                        placeholderTextColor={ios.label3}
                      />
                      <View style={styles.quickRow}>
                        <Pressable
                          onPress={() => {
                            updateDraft(draft.id, {
                              qtyById: { ...draft.qtyById, [it.id]: "" },
                            });
                          }}
                          style={styles.quickBtn}
                          hitSlop={4}
                          disabled={created}
                        >
                          <Text style={styles.quickBtnText}>None</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => {
                            const half = Math.ceil(cap / 2);
                            updateDraft(draft.id, {
                              qtyById: {
                                ...draft.qtyById,
                                [it.id]: half > 0 ? String(half) : "",
                              },
                            });
                          }}
                          style={styles.quickBtn}
                          hitSlop={4}
                          disabled={created || cap <= 0}
                        >
                          <Text style={styles.quickBtnText}>Half</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => {
                            updateDraft(draft.id, {
                              qtyById: {
                                ...draft.qtyById,
                                [it.id]: cap > 0 ? String(cap) : "",
                              },
                            });
                          }}
                          style={styles.quickBtn}
                          hitSlop={4}
                          disabled={created || cap <= 0}
                        >
                          <Text style={styles.quickBtnText}>All</Text>
                        </Pressable>
                      </View>
                      <Text style={styles.lineTotal}>${lineTotal.toFixed(2)}</Text>
                    </View>
                  );
                })}

                {/* Per-draft footer: terms + due date + send + subtotal */}
                <View style={styles.draftFooter}>
                  <Text style={styles.draftFooterLabel}>Terms</Text>
                  <View style={styles.termsRow}>
                    {TERM_OPTIONS.map((t) => {
                      const active = t === draft.terms;
                      return (
                        <Pressable
                          key={t}
                          style={[styles.termPill, active && styles.termPillActive]}
                          onPress={() => setTerms(draft.id, t)}
                          disabled={created}
                        >
                          <Text style={[styles.termPillText, active && styles.termPillTextActive]}>
                            {t}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  <Text style={styles.draftFooterLabel}>Due date</Text>
                  <TextInput
                    value={draft.dueDate}
                    onChangeText={(v) => updateDraft(draft.id, { dueDate: v })}
                    placeholder="YYYY-MM-DD"
                    style={styles.dueInput}
                    editable={!created}
                  />
                  <Pressable
                    style={styles.sendRow}
                    onPress={() => updateDraft(draft.id, { send: !draft.send })}
                    disabled={created}
                  >
                    <View style={[styles.checkbox, draft.send && styles.checkboxOn]}>
                      {draft.send ? <Text style={styles.checkboxTick}>✓</Text> : null}
                    </View>
                    <Text style={styles.sendLabel}>Send immediately on create</Text>
                  </Pressable>
                  <View style={styles.subtotalRow}>
                    <Text style={styles.subtotalLabel}>Invoice subtotal</Text>
                    <Text style={styles.subtotalValue}>${subtotal.toFixed(2)}</Text>
                  </View>
                </View>
              </View>
            );
          })
        )}

        {!allDoneNow ? (
          <Pressable style={styles.addInvoiceBtn} onPress={addDraft}>
            <Ionicons name="add-circle-outline" size={18} color={ios.brand} />
            <Text style={styles.addInvoiceBtnText}>Add another invoice</Text>
          </Pressable>
        ) : null}

        {/* Unallocated tally — gives the operator visibility into what hasn't
            been put on any draft yet. Helps them know when they're done. */}
        {!allDoneNow && unallocated.some((u) => u.left > 0) ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Not yet allocated</Text>
            {unallocated
              .filter((u) => u.left > 0)
              .map((u) => (
                <View key={u.item.id} style={styles.unallocRow}>
                  <Text style={styles.unallocName} numberOfLines={1}>
                    {u.item.productName}
                  </Text>
                  <Text style={styles.unallocQty}>
                    {u.left} {u.item.unit ?? "ea"}
                  </Text>
                </View>
              ))}
          </View>
        ) : null}

        {/* Bottom action — only visible when there's at least one valid draft */}
        {drafsToCreate.length > 0 ? (
          <View style={styles.bottomAction}>
            <View>
              <Text style={styles.bottomActionEyebrow}>
                {drafsToCreate.length} INVOICE{drafsToCreate.length === 1 ? "" : "S"} TO CREATE
              </Text>
              <Text style={styles.bottomActionTotal}>${totalToCreate.toFixed(2)}</Text>
            </View>
            <Pressable
              style={[styles.primaryBtn, bulkPending && styles.primaryBtnDisabled]}
              onPress={submitAll}
              disabled={bulkPending}
            >
              <Text style={styles.primaryBtnText}>
                {bulkPending
                  ? "Creating…"
                  : `Create ${drafsToCreate.length} invoice${drafsToCreate.length === 1 ? "" : "s"}`}
              </Text>
              <Ionicons name="arrow-forward" size={14} color="#fff" />
            </Pressable>
          </View>
        ) : null}
      </ScrollView>

      {bulkPending ? (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator color={ios.brand} />
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  card: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 14,
    gap: 10,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cardTitle: { fontSize: 15, fontFamily: "Inter_700Bold", color: ios.label },
  removeText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.system.redInk },

  helperCard: {
    backgroundColor: ios.brandWash,
    borderRadius: 12,
    padding: 12,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  helperText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.brand,
    lineHeight: 18,
  },

  createdBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: ios.system.greenWash,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  createdBadgeText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.system.greenInk,
  },

  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
    flexWrap: "wrap",
  },
  itemName: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  itemSub: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 2,
  },
  qtyInput: {
    width: 60,
    borderWidth: 1,
    borderColor: ios.separator,
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 6,
    textAlign: "right",
    color: ios.label,
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    fontVariant: ["tabular-nums"],
  },
  quickRow: { flexDirection: "row", gap: 4 },
  quickBtn: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: ios.fill3,
  },
  quickBtnText: { fontSize: 11, fontFamily: "Inter_600SemiBold", color: ios.brand },
  lineTotal: {
    minWidth: 60,
    textAlign: "right",
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },

  draftFooter: {
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
    gap: 8,
  },
  draftFooterLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
  },
  termsRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  termPill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: ios.separator,
  },
  termPillActive: { backgroundColor: ios.brand, borderColor: ios.brand },
  termPillText: { fontSize: 12, color: ios.label },
  termPillTextActive: { color: "#fff", fontFamily: "Inter_600SemiBold" },
  dueInput: {
    borderWidth: 1,
    borderColor: ios.separator,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: ios.label,
  },
  sendRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 },
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
  subtotalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  subtotalLabel: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.label2,
  },
  subtotalValue: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },

  addInvoiceBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: ios.brandWash,
    borderRadius: 14,
    paddingVertical: 14,
  },
  addInvoiceBtnText: {
    color: ios.brand,
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },

  unallocRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  unallocName: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.label,
  },
  unallocQty: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: ios.label2,
    fontVariant: ["tabular-nums"],
  },

  bottomAction: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  bottomActionEyebrow: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    color: ios.label2,
    letterSpacing: 0.4,
  },
  bottomActionTotal: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  primaryBtn: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  primaryBtnDisabled: { opacity: 0.4 },
  primaryBtnText: { color: "#fff", fontSize: 14, fontFamily: "Inter_600SemiBold" },

  allDoneTitle: { fontSize: 16, fontFamily: "Inter_700Bold", color: ios.label },
  allDoneSub: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
  },

  loadingOverlay: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.05)",
  },
});
