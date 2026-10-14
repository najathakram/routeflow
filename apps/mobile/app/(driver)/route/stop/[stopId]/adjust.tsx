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
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { useActiveRouteRun, useRouteRun } from "../../../../../lib/api/routes";
import { useOrder, type OrderItem } from "../../../../../lib/api/orders";
import {
  useCreateChangeRequest,
  useResolveChangeRequestAtStop,
  useDeclineChangeRequestAtStop,
  type CreateChangeRequestInput,
} from "../../../../../lib/api/change-requests";
import {
  buildAtDoorChangeRequests,
  dropHandedOffAdded,
  dropHandedOffQty,
  dropSucceededAddedLine,
  leftoverAddedMessage,
  type AtDoorAddedLine,
  type AtDoorEditedLine,
} from "../../../../../lib/at-door-diff";
import { computeLineSubtotal, normalizeBoxesPieces } from "@routeflow/pricing";
import { adjustLineFreeUnits, lineUnitsPerBox } from "../../../../../lib/at-door-line-units";
import { invoiceLineUnitNoun } from "../../../../../lib/invoice-line-display";
import { freeUnitsLabel } from "../../../../../lib/buyer-cart-logic";
import { sanitizeIntInput, parseIntQty } from "../../../../../lib/qty";
import { archivedMessage, resolveProductByCode } from "../../../../../lib/barcode-resolve";
import { confirm } from "../../../../../lib/confirm";
import { decideScanResult, runScanDecision } from "../../../../../lib/scan-suggestion";
import { ScanMatchPickerSheet } from "../../../../../components/ScanMatchPickerSheet";
import { useScanMatchPicker } from "../../../../../lib/use-scan-match-picker";
import { BarcodeFab } from "../../../../../components/BarcodeFab";
import { LicenseGuardModal } from "../../../../../components/LicenseGuardModal";
import { CreditLimitGuardModal } from "../../../../../components/CreditLimitGuardModal";
import { type BlockedCategory } from "../../../../../lib/api/authorizations";
import { type CreditLimitExceededInfo } from "../../../../../lib/credit-limit-error";
import {
  AT_STOP_RESTRICTED_SENT_COPY,
  classifyAtStopResolveError,
} from "../../../../../lib/at-stop-cr-outcome";
import { useRestrictionWarningRetry } from "../../../../../lib/use-restriction-warning-retry";
import { showToast } from "../../../../../lib/toast";
import { useOfflineQueue } from "../../../../../store/offlineQueue";

/**
 * At-the-door "Adjust order" (P10-POS-3 / pos-cost-roles-spec §3). Drives the
 * P5-09 change-request engine directly: every qty edit / removal / scanned
 * add becomes a `POST /orders/:id/change-requests` immediately self-resolved
 * `APPROVE_AT_STOP` (G6: "driver-at-stop is the primary authority"). The
 * server decides the persisted price at resolve — this screen NEVER derives
 * or sends a unitPrice; the on-screen total is an explicit ESTIMATE built
 * from the line's already-agreed unitPrice (existing lines only — newly
 * scanned lines are priced by the server and are excluded from the total).
 *
 * Operates on the stop's primary order only (`stop.orders[0]`), mirroring
 * web's `ArrivedStopSheet` simplification.
 */

interface ScannedProduct {
  id: string;
  name: string;
  unit?: string;
  unitsPerBox?: number | null;
  trackedCategoryId?: string | null;
}

interface AddedLineDraft {
  productId: string;
  name: string;
  unit?: string;
  unitsPerBox: number | null;
  trackedCategoryId: string | null;
  boxes: number;
  pieces: number;
  /** Total pieces — always the piece-equivalent, never a bare box count (see lib/at-door-diff.ts). */
  qty: number;
}

export default function AdjustOrderScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const params = useLocalSearchParams<{ stopId: string; runId?: string }>();
  const stopId = params.stopId;

  const { data: activeData, isLoading: activeLoading } = useActiveRouteRun();
  const runId = params.runId ?? activeData?.data?.[0]?.id;
  const { data: run, isLoading: runLoading } = useRouteRun(runId ?? "");
  const stop = useMemo(() => run?.stops?.find((s) => s.id === stopId), [run, stopId]);
  const orderId = stop?.orders?.[0]?.id;
  const { data: order, isLoading: orderLoading, refetch: refetchOrder } = useOrder(orderId ?? "");

  // Adjustable = not cancelled, not already (partially) delivered — the server
  // 409s LINE_ALREADY_DELIVERED otherwise; gate client-side so the common case
  // never round-trips an error (spec: guards fire inline, never a second screen).
  const adjustable = useMemo(
    () =>
      (order?.lineItems ?? []).filter(
        (li) => li.status !== "CANCELLED" && Number(li.deliveredQty ?? 0) === 0,
      ),
    [order],
  );

  const [qtyById, setQtyById] = useState<Record<string, number>>({});
  const [added, setAdded] = useState<AddedLineDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const matchPicker = useScanMatchPicker();
  const [licenseBlock, setLicenseBlock] = useState<BlockedCategory[] | null>(null);
  const [creditBlock, setCreditBlock] = useState<CreditLimitExceededInfo | null>(null);
  const pendingRef = useRef<{ diff: CreateChangeRequestInput[]; index: number } | null>(null);
  // Id of a CR that was created (buyer already notified) but blocked at resolve
  // BY THE REGULATED GUARD SPECIFICALLY — remembered so it can be declined (cleaned
  // up) when the driver removes the offending line or cancels, instead of lingering
  // PENDING. Deliberately deferred (not declined immediately like every other resolve
  // failure below, B790): removing the line or getting an override are both real next
  // steps here, not just "retry the same thing again".
  const blockedCrRef = useRef<string | null>(null);
  // Set by processDiff right after a batch finishes successfully — the actual
  // toast/navigate decision waits for the effect below, which reads `added`
  // only once React has settled it to its TRUE latest value (never a value
  // read mid-function, which could miss a concurrent re-scan's own setAdded).
  const batchJustCompletedRef = useRef(false);
  // Row 510: a DRIVER may not override a selling restriction, so a restricted add/raise is refused at resolve with the
  // fixed "Ask the office to approve this sale" block. The shared modal shows it (the same copy and legal lines the
  // office sees); the CR stays PENDING for the office to approve with an override.
  const rw = useRestrictionWarningRetry();
  // Set when an entry was handed to the office this batch: the closing toast must not claim a plain "Order updated".
  const handedToOfficeRef = useRef(false);
  // Always the latest render's continuation, so the modal's OK (rendered a render later) resumes with current closures.
  const resumeAfterBlockRef = useRef<() => void>(() => undefined);

  const createCr = useCreateChangeRequest(orderId ?? "");
  const resolveCr = useResolveChangeRequestAtStop(orderId ?? "");
  const declineCr = useDeclineChangeRequestAtStop(orderId ?? "");

  // Best-effort cleanup for the orphaned PENDING CR described above. Fire-and-forget
  // (offline → the interceptor queues the decline; a failure just leaves the office
  // to resolve it manually, same as any other declined request). Clears the ref so
  // it can't be declined twice (Remove fires both onRemoveLines and onClose).
  const declineOrphanedBlockedCr = () => {
    const crId = blockedCrRef.current;
    blockedCrRef.current = null;
    if (crId) {
      declineCr.mutate({
        crId,
        reason: "Regulated item removed at the door — customer not licensed.",
      });
    }
  };

  // Live ESTIMATE only — existing lines use the persisted (agreed) unitPrice
  // via computeLineSubtotal (boxed-safe, never qty*unitPrice on a boxed line).
  // Added (scanned) lines are priced by the SERVER at approval, so they are
  // deliberately excluded from this number.
  const estimatedTotal = useMemo(() => {
    let sum = 0;
    for (const li of adjustable) {
      const qty = qtyById[li.id] ?? li.qty;
      if (qty <= 0) continue;
      const upb = lineUnitsPerBox(li);
      // BUY_N_GET_M: the agreed line already has free units off — bill them off
      // the estimate too, or the door total over-states what the buyer owes.
      const freeUnits = adjustLineFreeUnits(li, qty);
      if (upb > 1) {
        const split = normalizeBoxesPieces({ qty, unitsPerBox: upb });
        sum += computeLineSubtotal({
          unitPrice: Number(li.unitPrice),
          qty: split.qty,
          boxes: split.boxes,
          pieces: split.pieces,
          unitsPerBox: upb,
          freeUnits,
        });
      } else {
        sum += computeLineSubtotal({ unitPrice: Number(li.unitPrice), qty, freeUnits });
      }
    }
    return sum;
  }, [adjustable, qtyById]);

  async function handleScanned(code: string): Promise<void> {
    const trimmed = code.trim();
    if (!trimmed) return;
    try {
      const result = await resolveProductByCode<ScannedProduct>(trimmed);
      if (result.archived) {
        // F30 / R5: the product exists but the tenant retired it — a sellable
        // at-door line is exactly what it must NOT silently become.
        showToast(archivedMessage(result.product));
        return;
      }
      if (result.notFound || !result.product?.id) {
        showToast(`No product for "${trimmed}"`);
        return;
      }
      const addScanned = (p: ScannedProduct) => {
        const upb = Number(p.unitsPerBox ?? 0);
        setAdded((prev) => {
          const idx = prev.findIndex((a) => a.productId === p.id);
          if (idx >= 0) {
            const cur = prev[idx]!;
            if (upb > 1) {
              const boxes = cur.boxes + 1;
              const next: AddedLineDraft = { ...cur, boxes, qty: boxes * upb + cur.pieces };
              return prev.map((a, i) => (i === idx ? next : a));
            }
            const next: AddedLineDraft = { ...cur, qty: cur.qty + 1 };
            return prev.map((a, i) => (i === idx ? next : a));
          }
          // Boxed products ALWAYS carry an explicit boxes/pieces split — a bare
          // qty is read as a BOX count by one of the server's two ADD_ITEM code
          // paths (the "merge into an existing line" branch treats qty as a raw
          // piece delta; the "new line" branch derives pieces from boxes/pieces
          // when present). Sending both keeps qty and boxes/pieces consistent
          // (qty = the true piece-equivalent) so either server path is correct.
          const draft: AddedLineDraft =
            upb > 1
              ? {
                  productId: p.id,
                  name: p.name,
                  unit: p.unit,
                  unitsPerBox: upb,
                  trackedCategoryId: p.trackedCategoryId ?? null,
                  boxes: 1,
                  pieces: 0,
                  qty: upb,
                }
              : {
                  productId: p.id,
                  name: p.name,
                  unit: p.unit,
                  unitsPerBox: null,
                  trackedCategoryId: p.trackedCategoryId ?? null,
                  boxes: 0,
                  pieces: 0,
                  qty: 1,
                };
          return [...prev, draft];
        });
        showToast(`Added ${p.name}`);
      };
      // B1220: a lone fuzzy match asks first; 2+ matches open a list — neither adds unprompted.
      if (
        !runScanDecision(decideScanResult(result, "add"), addScanned, confirm, {
          pick: matchPicker.open,
        })
      ) {
        addScanned(result.product);
      }
    } catch (err: any) {
      showToast(err?.response?.data?.message ?? err?.message ?? "Couldn't look up barcode.");
    }
  }

  const removeAdded = (productId: string) =>
    setAdded((prev) => prev.filter((a) => a.productId !== productId));

  async function submitEntry(entry: CreateChangeRequestInput): Promise<boolean> {
    let createdCrId: string | null = null;
    try {
      const cr = await createCr.mutateAsync(entry);
      createdCrId = cr.id;
      await resolveCr.mutateAsync({ crId: cr.id });
      // The route-run cache (stop item lists, stop totals on index.tsx/payment.tsx)
      // is separate from ["orders", orderId] — invalidate it too so those screens
      // reflect the change immediately, not just this one.
      qc.invalidateQueries({ queryKey: ["route-runs"] });
      return true;
    } catch (e: any) {
      const outcome = classifyAtStopResolveError(e);
      switch (outcome.action) {
        case "offline":
          // Connection dropped mid-batch: the two-step create→resolve can't complete
          // offline (resolve needs the create's server id), so stop honestly rather
          // than echo the interceptor's reassuring "Action queued." The driver must
          // retry once back online (handleSave also refuses to start while offline).
          // The create itself may have landed — its own queued resolve will settle
          // it once reconnected, so this is NOT a decline-worthy failure (B790).
          showToast("Connection lost — reconnect and save again.");
          if (createdCrId && entry.type === "ADD_ITEM" && entry.productId) {
            // The create already succeeded and the resolve is now queued for
            // offline replay — it WILL land once reconnected, so drop the
            // draft now, or the next Save resends this ADD_ITEM on top of the
            // queued replay (B795, #1302 round 1 finding 2).
            setAdded((prev) => dropSucceededAddedLine(prev, entry));
          }
          return false;
        case "regulated":
          // The CR was created (and the buyer notified) but the regulated guard
          // rejected it at resolve — remember it so the Remove/Cancel exits can
          // decline the otherwise-orphaned PENDING request (deferred — see
          // blockedCrRef above for why this one stays deferred, B790).
          blockedCrRef.current = createdCrId;
          setLicenseBlock(outcome.blocked);
          return false;
        case "restricted":
          // Row 510. Mirrors "regulated" above: the CR was created (the buyer is notified) and the resolve refused, so
          // it stays PENDING and is NOT declined here. Unlike "regulated" it is never declined later either (no
          // blockedCrRef): the office approves it with an override (a declined CR cannot be approved), and neither
          // Remove nor Cancel may undo that. The entry now belongs to the office, so drop the local edit or a bare
          // re-tap of "Save changes" files a SECOND CR for it (an ADD_ITEM draft, or a CHANGE_QTY / REMOVE_ITEM qty).
          setAdded((prev) => dropHandedOffAdded(prev, entry));
          setQtyById((m) => dropHandedOffQty(m, entry));
          handedToOfficeRef.current = true;
          // The batch pauses behind the modal (return false, like the regulated guard) and resumes AFTER the driver
          // reads it, at the NEXT entry.
          rw.handle(
            e,
            () => undefined,
            () => resumeAfterBlockRef.current(),
          );
          return false;
        case "already-resolved":
          // Name a DECLINED resolution distinctly (#1302 round 1 finding 3) — an
          // APPROVED-elsewhere race and an office decline read very differently to
          // the driver. No status from the server => the generic toast.
          showToast(
            outcome.status === "DECLINED"
              ? "That line was declined by the office — refreshed."
              : "That line changed elsewhere — refreshed.",
          );
          return true; // don't block the rest of the batch on a benign race
        case "credit":
          // B790: decline immediately, unlike the regulated case above — there is
          // no driver-safe next step that resolves THIS CR (Cancel is the only
          // exit; see CreditLimitGuardModal below), so leaving it PENDING would
          // just accumulate a duplicate on every retry.
          if (createdCrId) declineCr.mutate({ crId: createdCrId, reason: outcome.reason });
          setCreditBlock(outcome.info);
          return false;
        case "decline":
          // LINE_ALREADY_DELIVERED / STOP_ALREADY_COMPLETED / CHANGE_WINDOW_CLOSED /
          // any other or future code (B753) — decline immediately (B790: this used
          // to just toast and return false, leaving the CR PENDING forever while a
          // bare retry created a second one for the same edit) and surface the
          // server's message. Never a partial silent failure.
          if (createdCrId) declineCr.mutate({ crId: createdCrId, reason: outcome.reason });
          showToast(outcome.reason);
          return false;
      }
    }
  }

  // Resumable batch runner — retrying after the license guard re-enters at the
  // SAME index instead of rebuilding the diff, so an already-submitted ADD_ITEM
  // (still present in local `added` state) is never re-diffed and resent.
  async function processDiff(diff: CreateChangeRequestInput[], startIndex: number) {
    for (let i = startIndex; i < diff.length; i++) {
      const entry = diff[i]!;
      const ok = await submitEntry(entry);
      if (!ok) {
        pendingRef.current = { diff, index: i };
        setSaving(false);
        return;
      }
      // B795: a bare re-tap of "Save changes" (the credit-block Cancel, a
      // message-less 409, an offline drop, and the license modal's Cancel all
      // leave the driver here) rebuilds a FRESH diff from `added` at index 0 --
      // drop this entry's draft now, or a succeeded ADD_ITEM gets re-diffed and
      // double-adds the line server-side.
      setAdded((prev) => dropSucceededAddedLine(prev, entry));
    }
    pendingRef.current = null;
    setSaving(false);
    // B795 review round 2: the toast/navigate decision below waits for the
    // effect (reads the TRUE latest `added`) rather than deciding here --
    // a concurrent re-scan's own setAdded may not have committed yet.
    batchJustCompletedRef.current = true;
  }

  // Fires once the batch-completion flag is set AND `saving` has settled to
  // false, reading whatever `added` React has ACTUALLY committed by then. A
  // concurrent re-scan mid-batch can leave units here that were never part of
  // the diff just processed -- never silently discard them by navigating away
  // (Opus review, #1302 round 2: router.back() used to fire unconditionally).
  useEffect(() => {
    if (!batchJustCompletedRef.current || saving) return;
    batchJustCompletedRef.current = false;
    const leftover = leftoverAddedMessage(added);
    if (leftover) {
      showToast(leftover);
      return;
    }
    const handedOff = handedToOfficeRef.current;
    handedToOfficeRef.current = false;
    showToast(handedOff ? AT_STOP_RESTRICTED_SENT_COPY : "Order updated");
    router.back();
  }, [saving, added, router]);

  resumeAfterBlockRef.current = () => {
    const pending = pendingRef.current;
    if (!pending) return;
    setSaving(true);
    processDiff(pending.diff, pending.index + 1);
  };

  async function handleSave() {
    if (!orderId) return;
    // At-door adjustments are a two-step create→self-resolve per line, which
    // cannot complete offline: the resolve needs the create's server-assigned id,
    // and a lone queued create would replay on reconnect as a dangling PENDING
    // request (the order would NOT actually change). So require connectivity up
    // front rather than silently enqueue a half-applied edit.
    if (!useOfflineQueue.getState().isOnline) {
      showToast("You're offline — reconnect to save at-door changes.");
      return;
    }
    setSaving(true);
    // Pre-save refetch mitigates the endpoints' lack of a server idempotency
    // key: an offline retry whose earlier response was lost must not re-diff
    // (and re-submit) a change that already landed on reconnect. Best-effort —
    // fall back to the cached order if the refetch itself fails (e.g. offline).
    let freshOrder = order;
    try {
      const fresh = await refetchOrder();
      if (fresh.data) freshOrder = fresh.data;
    } catch {
      // ignore — proceed with the cached order
    }

    const diff = buildAtDoorChangeRequests({
      originals: (freshOrder?.lineItems ?? []).map((li) => ({
        id: li.id,
        qty: li.qty,
        status: li.status,
        deliveredQty: li.deliveredQty,
      })),
      edited: Object.entries(qtyById).map(([lineId, qty]): AtDoorEditedLine => ({ lineId, qty })),
      added: added.map((a): AtDoorAddedLine => ({
        productId: a.productId,
        qty: a.qty,
        ...(a.unitsPerBox && a.unitsPerBox > 1 ? { boxes: a.boxes, pieces: a.pieces } : {}),
      })),
    });

    if (diff.length === 0) {
      setSaving(false);
      router.back();
      return;
    }
    await processDiff(diff, 0);
  }

  if (activeLoading || runLoading || orderLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Adjust order"
          leading={<NavBackButton label="Stop" onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  if (!stop) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Adjust order"
          leading={<NavBackButton label="Stop" onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <Ionicons name="alert-circle-outline" size={36} color={ios.label3} />
          <Text style={styles.emptyTitle}>Stop not found</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!orderId || !order) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Adjust order"
          leading={<NavBackButton label="Stop" onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <Ionicons name="cube-outline" size={36} color={ios.label3} />
          <Text style={styles.emptyTitle}>No order at this stop</Text>
          <Text style={styles.emptySub}>There's nothing to adjust here yet.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Adjust order"
        leading={<NavBackButton label="Stop" onPress={() => router.back()} />}
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 24 }}
      >
        {adjustable.length === 0 && added.length === 0 ? (
          <View style={styles.emptyInline}>
            <Text style={styles.emptyInlineText}>No adjustable items on this order.</Text>
          </View>
        ) : (
          <>
            {adjustable.length > 0 ? <SectionRow title="Order items" /> : null}
            {adjustable.map((li) => (
              <AdjustLineRow
                key={li.id}
                li={li}
                qty={qtyById[li.id] ?? li.qty}
                onChangeQty={(q) => setQtyById((m) => ({ ...m, [li.id]: q }))}
              />
            ))}

            {added.length > 0 ? <SectionRow title="Scanned at the door" /> : null}
            {added.map((a) => (
              <AddedLineRow key={a.productId} line={a} onRemove={() => removeAdded(a.productId)} />
            ))}
          </>
        )}

        <View style={styles.scanHint}>
          <Ionicons name="barcode-outline" size={16} color={ios.label2} />
          <Text style={styles.scanHintText}>Scan an item to add it to this order.</Text>
        </View>

        <View style={styles.totalBlock}>
          <Text style={styles.totalLabel}>
            EST. TOTAL{added.length > 0 ? " (excl. new items)" : ""}
          </Text>
          <Text style={styles.totalValue}>${estimatedTotal.toFixed(2)}</Text>
        </View>

        <View style={{ paddingHorizontal: 16 }}>
          <Pressable
            style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
            onPress={saving ? undefined : handleSave}
            disabled={saving}
          >
            <Text style={styles.saveBtnText}>{saving ? "Saving…" : "Save changes"}</Text>
          </Pressable>
        </View>
      </ScrollView>

      {/* B795 review round 2: hide the scanner while saving too, not just
          during the license block -- a scan landing mid-batch grows a draft
          past what a just-sent ADD_ITEM already covers. */}
      <BarcodeFab onScanned={handleScanned} aimAssist hidden={saving || !!licenseBlock} />
      {rw.modal}
      <ScanMatchPickerSheet {...matchPicker.props} />

      {/* Regulated-license guard — drivers can't capture/override (403 server-side),
          so this is read-only; the only real exit besides Cancel is dropping the
          scanned line that triggered the block. Never a second screen. */}
      <LicenseGuardModal
        open={!!licenseBlock}
        customerId={stop.customerId}
        blocked={licenseBlock ?? []}
        orderId={orderId}
        readOnly
        onRemoveLines={(categoryIds) => {
          setAdded((prev) =>
            prev.filter((a) => !a.trackedCategoryId || !categoryIds.includes(a.trackedCategoryId)),
          );
          setLicenseBlock(null);
          // Decline the PENDING CR the create already wrote so it doesn't orphan.
          declineOrphanedBlockedCr();
          const pending = pendingRef.current;
          if (pending) {
            setSaving(true);
            processDiff(pending.diff, pending.index + 1);
          }
          showToast("Removed the regulated item — continuing.");
        }}
        onResolved={() => {
          setLicenseBlock(null);
          const pending = pendingRef.current;
          if (pending) {
            setSaving(true);
            processDiff(pending.diff, pending.index);
          }
        }}
        onClose={() => {
          setLicenseBlock(null);
          // Cancelling still leaves the created-but-unresolved CR — clean it up too.
          declineOrphanedBlockedCr();
          pendingRef.current = null;
        }}
      />

      {/* Credit-limit guard — Cancel-only. Unlike the license guard there is no
          driver-safe "go fix this" destination (DRIVER can't reach /invoices), and
          no server override exists to record here. The driver's real recourse is
          simply not pushing this line further; office resolves it later. */}
      <CreditLimitGuardModal
        open={!!creditBlock}
        info={creditBlock}
        onCancel={() => {
          setCreditBlock(null);
          pendingRef.current = null;
        }}
      />
    </SafeAreaView>
  );
}

// ─── Rows ───────────────────────────────────────────────────────────────────

function SectionRow({ title }: { title: string }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.sectionTitle}>{title}</Text>
    </View>
  );
}

function AdjustLineRow({
  li,
  qty,
  onChangeQty,
}: {
  li: OrderItem;
  qty: number;
  onChangeQty: (qty: number) => void;
}) {
  const upb = lineUnitsPerBox(li);
  const isBoxed = upb > 1;
  // Seed once from the line's STORED split — never re-derive on every render,
  // so an in-flight refetch (pre-save) doesn't reset an in-progress edit.
  const seed = useMemo(
    () =>
      normalizeBoxesPieces({ boxes: li.boxes, pieces: li.pieces, qty: li.qty, unitsPerBox: upb }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [li.id],
  );
  const [boxes, setBoxesState] = useState(seed.boxes ?? 0);
  const [pieces, setPiecesState] = useState(seed.pieces ?? 0);

  const applyBoxes = (n: number) => {
    const b = Math.max(0, Math.trunc(n));
    setBoxesState(b);
    onChangeQty(b * upb + pieces);
  };
  const applyPieces = (n: number) => {
    const p = Math.max(0, Math.min(upb > 1 ? upb - 1 : 0, Math.trunc(n)));
    setPiecesState(p);
    onChangeQty(boxes * upb + p);
  };
  const applyQty = (n: number) => onChangeQty(Math.max(0, Math.trunc(n)));

  const removed = qty <= 0;
  const freeUnits = adjustLineFreeUnits(li, qty);
  const freeLabel = freeUnitsLabel(freeUnits);
  const lineTotal = isBoxed
    ? computeLineSubtotal({
        unitPrice: Number(li.unitPrice),
        qty,
        boxes,
        pieces,
        unitsPerBox: upb,
        freeUnits,
      })
    : computeLineSubtotal({ unitPrice: Number(li.unitPrice), qty, freeUnits });

  return (
    <View style={[styles.card, removed && styles.cardRemoved]}>
      <View style={styles.cardHeader}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.cardName} numberOfLines={2}>
            {li.product?.name ?? li.name ?? "Item"}
          </Text>
          <Text style={styles.cardMeta}>
            ${Number(li.unitPrice).toFixed(2)}
            {/* #2055: the price suffix names the LINE's own unit (Case, Pallet), never the
                hardcoded word "box" — upb is already line-snapshot-first via lineUnitsPerBox
                above (B657); only the noun itself was still hardcoded. */}
            {isBoxed ? ` / ${invoiceLineUnitNoun(li)} of ${upb}` : ""}
          </Text>
          {/* BUY_N_GET_M: name the free units, or the reduced line total reads
              as a pricing error at the door. */}
          {freeLabel ? <Text style={styles.cardFreeLabel}>{freeLabel}</Text> : null}
        </View>
        <Text style={[styles.cardTotal, removed && styles.cardTotalRemoved]}>
          {removed ? "Removed" : `$${lineTotal.toFixed(2)}`}
        </Text>
      </View>

      {isBoxed ? (
        <View style={{ gap: 8 }}>
          <QtyStepperRow label="Boxes" value={boxes} onChange={applyBoxes} />
          <QtyStepperRow label="Loose pieces" value={pieces} onChange={applyPieces} max={upb - 1} />
        </View>
      ) : (
        <QtyStepperRow label="Qty" value={qty} onChange={applyQty} />
      )}

      <Pressable
        style={styles.trashRow}
        onPress={() => {
          setBoxesState(0);
          setPiecesState(0);
          onChangeQty(0);
        }}
        hitSlop={6}
      >
        <Ionicons name="trash-outline" size={14} color={ios.system.redInk} />
        <Text style={styles.trashText}>Remove line</Text>
      </Pressable>
    </View>
  );
}

function AddedLineRow({ line, onRemove }: { line: AddedLineDraft; onRemove: () => void }) {
  const isBoxed = !!line.unitsPerBox && line.unitsPerBox > 1;
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.cardName} numberOfLines={2}>
            {line.name}
          </Text>
          <Text style={styles.cardMeta}>
            {isBoxed
              ? `${line.boxes} box${line.boxes === 1 ? "" : "es"}${line.pieces > 0 ? ` + ${line.pieces} pcs` : ""}`
              : `Qty ${line.qty}`}
          </Text>
        </View>
        <Text style={styles.cardEst}>Priced at approval</Text>
      </View>
      <Pressable style={styles.trashRow} onPress={onRemove} hitSlop={6}>
        <Ionicons name="trash-outline" size={14} color={ios.system.redInk} />
        <Text style={styles.trashText}>Remove</Text>
      </Pressable>
    </View>
  );
}

function QtyStepperRow({
  label,
  value,
  onChange,
  max,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  max?: number;
}) {
  // Local draft so the user can clear the input without it snapping back to 0.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const dec = () => onChange(Math.max(0, value - 1));
  const inc = () => onChange(max != null ? Math.min(max, value + 1) : value + 1);

  return (
    <View style={styles.stepperRow}>
      <Text style={styles.stepperLabel}>{label}</Text>
      <View style={styles.stepper}>
        <Pressable style={styles.stepBtn} onPress={dec} hitSlop={6}>
          <Text style={styles.stepText}>−</Text>
        </Pressable>
        <TextInput
          style={styles.qtyInput}
          value={draft}
          onChangeText={(txt) => {
            const clean = sanitizeIntInput(txt);
            setDraft(clean);
            if (clean === "") return;
            const n = parseIntQty(clean, value);
            onChange(max != null ? Math.min(max, n) : n);
          }}
          onBlur={() => {
            if (draft === "") onChange(0);
            setDraft(String(value));
          }}
          keyboardType="number-pad"
          returnKeyType="done"
          maxLength={5}
          selectTextOnFocus
        />
        <Pressable style={styles.stepBtn} onPress={inc} hitSlop={6}>
          <Text style={styles.stepText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 40,
  },
  emptyTitle: { fontSize: 17, fontFamily: "Inter_600SemiBold", color: ios.label, marginTop: 6 },
  emptySub: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
  },
  emptyInline: {
    marginHorizontal: 16,
    marginTop: 16,
    paddingVertical: 24,
    paddingHorizontal: 14,
    backgroundColor: ios.bgElev,
    borderRadius: 12,
  },
  emptyInlineText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
  },
  sectionRow: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  scanHint: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginTop: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: ios.fill3,
    borderRadius: 10,
  },
  scanHintText: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, flex: 1 },
  card: {
    marginHorizontal: 16,
    marginTop: 10,
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 14,
    gap: 10,
  },
  cardRemoved: { opacity: 0.55 },
  cardHeader: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  cardName: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  cardMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  cardFreeLabel: { fontSize: 11, fontFamily: "Inter_600SemiBold", color: ios.brand, marginTop: 2 },
  cardTotal: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  cardTotalRemoved: { color: ios.system.redInk },
  cardEst: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.brand,
    textTransform: "uppercase",
  },
  trashRow: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start" },
  trashText: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: ios.system.redInk },
  stepperRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  stepperLabel: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label2 },
  stepper: { flexDirection: "row", alignItems: "center", gap: 0 },
  stepBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: ios.fill3,
    alignItems: "center",
    justifyContent: "center",
  },
  stepText: { fontSize: 18, fontFamily: "Inter_600SemiBold", color: ios.label },
  qtyInput: {
    minWidth: 40,
    textAlign: "center",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
    paddingHorizontal: 6,
  },
  totalBlock: {
    marginHorizontal: 16,
    marginTop: 18,
    marginBottom: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  totalLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.6,
  },
  totalValue: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  saveBtn: {
    backgroundColor: ios.system.green,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
  },
  saveBtnDisabled: { opacity: 0.55 },
  saveBtnText: { color: "#fff", fontSize: 17, fontFamily: "Inter_600SemiBold" },
});
