import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import {
  FilterChipRow,
  NavAction,
  NavBackButton,
  NavBar,
  Pill,
  ProgressTrack,
  SearchBar,
} from "@routeflow/ui/mobile/ios";
import {
  useAdminProductsInfinite,
  type AdminProduct,
  type StockStatusFilter,
} from "../../../lib/api/admin";
import { useTrackedCategories } from "../../../lib/api/tracked-categories";
import { flattenPages } from "../../../lib/paged-rows";
import { useDebounce } from "../../../lib/use-debounce";
import { PRODUCT_SEARCH_DEBOUNCE_MS } from "../../../lib/use-product-search";
import {
  isSnapshotFresh,
  NO_PENDING_SCROLL_RESTORE,
  queueScrollRestore,
  shouldContinuePageChase,
  snapshotHasSearchOrFilter,
  stepScrollRestore,
  type ListUiSnapshot,
  type ScrollRestoreState,
} from "../../../lib/list-ui-snapshot";
import {
  getListUiSnapshot,
  OPERATOR_PRODUCTS_LIST_ID,
  useListUiStore,
} from "../../../store/listUiStore";

/** The bits of list UI this screen's snapshot restores beyond the search term. */
interface ProductsListFilters {
  stockStatus?: StockStatusFilter;
  section?: string;
}

function toNumber(v: number | string | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

const FILTERS: { id: StockStatusFilter | undefined; label: string }[] = [
  { id: undefined, label: "All" },
  { id: "IN_STOCK", label: "In stock" },
  { id: "LOW", label: "Low" },
  { id: "OUT_OF_STOCK", label: "Out" },
];

export default function ProductsListScreen() {
  const router = useRouter();

  // ─── List-state restore ───────────────────────────────────────────────
  // Lazy-init (read once, on mount) from whatever the last visit to this
  // screen left behind. `initialSnapshot` is captured once — later writes to
  // the store never re-trigger this read, so editing a filter mid-session
  // can't clobber the value the page-chase is still chasing.
  const [initialSnapshot] = useState<ListUiSnapshot<ProductsListFilters> | null>(() => {
    const snapshot = getListUiSnapshot<ProductsListFilters>(OPERATOR_PRODUCTS_LIST_ID);
    return isSnapshotFresh(snapshot) ? snapshot : null;
  });

  const [filter, setFilter] = useState<StockStatusFilter | undefined>(
    initialSnapshot?.filters.stockStatus,
  );
  const [search, setSearch] = useState(initialSnapshot?.search ?? "");
  const [sectionFilter, setSectionFilter] = useState<string | undefined>(
    initialSnapshot?.filters.section,
  );
  const debouncedSearch = useDebounce(search, PRODUCT_SEARCH_DEBOUNCE_MS);

  const { data: sections } = useTrackedCategories({ active: true });
  const sectionNameById = useMemo(
    () => new Map((sections ?? []).map((s) => [s.id, s.name])),
    [sections],
  );
  const sectionFilters = useMemo(
    () => [
      { id: undefined as string | undefined, label: "All" },
      { id: "any", label: "Regulated" },
      ...(sections ?? []).map((s) => ({ id: s.id, label: s.name })),
      { id: "none", label: "Non-reg" },
    ],
    [sections],
  );
  // Infinite pages through the whole catalog — the previous single
  // `limit:100` request cut the list off at 100 rows.
  const {
    data,
    isLoading,
    isFetching,
    isFetchingNextPage,
    isPlaceholderData,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = useAdminProductsInfinite({
    stockStatus: filter,
    search: debouncedSearch.trim() || undefined,
    section: sectionFilter,
  });

  const products = useMemo(() => flattenPages<AdminProduct>(data?.pages), [data]);

  // Write-through: persist search/filters/paging every time any of them
  // change. Scroll offset is tracked separately (below) since it changes on
  // every frame, not on state changes.
  const scrollOffsetRef = useRef(initialSnapshot?.scrollOffset ?? 0);
  const persistSnapshot = useCallback(() => {
    useListUiStore.getState().saveListUi(OPERATOR_PRODUCTS_LIST_ID, {
      search,
      filters: { stockStatus: filter, section: sectionFilter },
      scrollOffset: scrollOffsetRef.current,
      pageCount: data?.pages.length ?? 1,
      savedAt: Date.now(),
    });
  }, [search, filter, sectionFilter, data?.pages.length]);
  useEffect(() => {
    persistSnapshot();
  }, [persistSnapshot]);

  // Bounded page-chase: re-fetch the pages the snapshot had loaded so the
  // scroll restore below lands somewhere real, capped by BOTH pages and rows
  // and skipped entirely when the snapshot carries a search term or filter
  // (that result set is short — the first page already covers it).
  const restoreAbandonedRef = useRef(false);
  // `initialSnapshot` never changes after mount, so this is referentially
  // stable across renders (always the same object, or always null).
  const chaseSnapshot =
    initialSnapshot && !snapshotHasSearchOrFilter(initialSnapshot) ? initialSnapshot : null;
  const rowsLoaded = products.length;
  const pagesLoaded = data?.pages.length ?? 0;
  const chaseDone =
    !chaseSnapshot ||
    restoreAbandonedRef.current ||
    !hasNextPage ||
    !shouldContinuePageChase({ pagesLoaded, rowsLoaded }, chaseSnapshot.pageCount);
  useEffect(() => {
    if (chaseSnapshot && !chaseDone && !isFetchingNextPage) fetchNextPage();
  }, [chaseSnapshot, chaseDone, isFetchingNextPage, fetchNextPage]);

  // One-shot scroll restore, re-armed on every focus. On the web build a
  // drill-in or tab switch does NOT unmount this screen — the stack hides it
  // with `display:none`, which resets the browser's scroller to 0 — so the
  // offset to come back to has to be captured on blur, while it is still
  // readable, rather than read from the frozen mount-time snapshot.
  const [restoreState, setRestoreState] = useState<ScrollRestoreState>(NO_PENDING_SCROLL_RESTORE);
  const listRef = useRef<FlatList<AdminProduct>>(null);
  const isFocusedRef = useRef(false);
  /** Where the next focus restores to: the snapshot on mount, the live offset thereafter. */
  const restoreOffsetRef = useRef(initialSnapshot?.scrollOffset ?? 0);
  /** The offset the restore last asked for — its own `onScroll` echo isn't a user scroll. */
  const restoreTargetRef = useRef<number | null>(null);

  const markUserScroll = useCallback(() => {
    if (restoreAbandonedRef.current) return;
    restoreAbandonedRef.current = true;
    setRestoreState(NO_PENDING_SCROLL_RESTORE);
  }, []);

  useFocusEffect(
    useCallback(() => {
      // Each focus is a fresh restore: a manual scroll on the previous visit
      // must not disable it for the rest of this (never-unmounted) screen's life.
      restoreAbandonedRef.current = false;
      isFocusedRef.current = true;
      setRestoreState(queueScrollRestore(restoreOffsetRef.current));
      return () => {
        isFocusedRef.current = false;
        restoreOffsetRef.current = scrollOffsetRef.current;
      };
    }, []),
  );

  const applyPendingRestore = useCallback(() => {
    // Wait for the page-chase so we don't jump short — AND for rows to exist:
    // the empty-list spinner fires `onContentSizeChange` too, and spending the
    // one-shot there scrolls a zero-height list (clamped to 0) and restores
    // nothing. `chaseDone` is true before the first page lands, so it alone is
    // not a "the list has content" signal.
    if (!chaseDone || products.length === 0) return;
    setRestoreState((prev) => {
      const { offset, state } = stepScrollRestore(prev);
      if (offset != null) {
        restoreTargetRef.current = offset;
        requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset, animated: false }));
      }
      return state;
    });
  }, [chaseDone, products.length]);

  // `onContentSizeChange` covers rows arriving after a remount; this covers the
  // web drill-in/tab flip, where the screen comes back at the same content size
  // and that callback never fires again.
  useEffect(() => {
    if (restoreState.pendingOffset != null) applyPendingRestore();
  }, [restoreState, applyPendingRestore]);

  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      // Blurred means hidden behind `display:none` on web, where the browser
      // resets the scroller to 0. That reset is not a position worth keeping.
      if (!isFocusedRef.current) return;
      const offset = e.nativeEvent.contentOffset.y;
      // react-native-web never fires `onScrollBeginDrag` (its ScrollViewBase
      // only wires `onScroll`), so on the deployed web build this is the one
      // place a real user scroll can be spotted: an offset that is neither 0
      // (layout/visibility resets) nor the one the restore just asked for.
      const target = restoreTargetRef.current;
      if (offset > 0 && (target == null || Math.abs(offset - target) > 1)) markUserScroll();
      scrollOffsetRef.current = offset;
      persistSnapshot();
    },
    [markUserScroll, persistSnapshot],
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Products"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        trailing={
          <View style={{ flexDirection: "row", gap: 6 }}>
            <Pressable
              style={styles.navBtn}
              onPress={() => router.push("/(operator)/products/scan")}
              hitSlop={6}
            >
              <Ionicons name="barcode-outline" size={18} color={ios.label} />
            </Pressable>
            <NavAction label="Add" bold onPress={() => router.push("/(operator)/products/new")} />
          </View>
        }
      />

      <SearchBar placeholder="Search name, SKU, barcode…" value={search} onChangeText={setSearch} />

      <FilterChipRow
        chips={FILTERS.map((f) => ({ label: f.label }))}
        value={FILTERS.find((f) => f.id === filter)?.label ?? "All"}
        onChange={(label) => setFilter(FILTERS.find((f) => f.label === label)?.id)}
      />

      {sections && sections.length > 0 ? (
        <FilterChipRow
          chips={sectionFilters.map((f) => ({ label: f.label }))}
          value={sectionFilters.find((f) => f.id === sectionFilter)?.label ?? "All"}
          onChange={(label) => setSectionFilter(sectionFilters.find((f) => f.label === label)?.id)}
        />
      ) : null}

      <FlatList
        ref={listRef}
        data={products}
        keyExtractor={(p) => p.id}
        renderItem={({ item }) => (
          <ProductRow
            p={item}
            sectionNameById={sectionNameById}
            onPress={() => router.push(`/(operator)/products/${item.id}`)}
          />
        )}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 8, paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={isFetching && !isLoading && !isFetchingNextPage}
            onRefresh={refetch}
          />
        }
        onEndReached={() => {
          // isPlaceholderData: the rows on screen still belong to a PREVIOUS
          // query key (keepPreviousData) — fetching "next page" here would
          // page the old key, not the one the operator is looking at.
          if (hasNextPage && !isFetchingNextPage && !isPlaceholderData) fetchNextPage();
        }}
        onEndReachedThreshold={0.5}
        onScroll={handleScroll}
        // Native only — react-native-web never emits it; there `handleScroll`
        // is what spots the operator taking over.
        onScrollBeginDrag={markUserScroll}
        scrollEventThrottle={100}
        onContentSizeChange={applyPendingRestore}
        ListEmptyComponent={
          isLoading ? (
            <View style={styles.center}>
              <ActivityIndicator color={ios.brand} />
            </View>
          ) : (
            <View style={styles.center}>
              <Text style={styles.emptyText}>
                {search ? "No products match." : "No products yet."}
              </Text>
              <Pressable
                style={styles.primaryBtn}
                onPress={() => router.push("/(operator)/products/new")}
              >
                <Ionicons name="add" size={16} color="#fff" />
                <Text style={styles.primaryBtnText}>Add product</Text>
              </Pressable>
            </View>
          )
        }
        ListFooterComponent={
          isFetchingNextPage ? (
            <View style={{ paddingVertical: 16 }}>
              <ActivityIndicator color={ios.brand} />
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}

function ProductRow({
  p,
  sectionNameById,
  onPress,
}: {
  p: AdminProduct;
  sectionNameById: Map<string, string>;
  onPress: () => void;
}) {
  const stock = toNumber(p.currentStock);
  const threshold = p.reorderPoint ?? 5;
  const pct = threshold > 0 ? Math.min(100, Math.round((stock / threshold) * 100)) : 100;
  const out = stock <= 0;
  const low = !out && stock <= threshold;
  const fill: "red" | "orange" | "brand" | "green" = out ? "red" : low ? "orange" : "brand";

  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.topRow}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.name} numberOfLines={1}>
            {p.name}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {p.sku ? `SKU ${p.sku}` : p.barcode ? `BC ${p.barcode}` : "No SKU"}
            {p.unit ? ` · ${p.unit}` : ""}
            {" · $"}
            {toNumber(p.pricePerUnit).toFixed(2)}
          </Text>
        </View>
        <Text style={styles.qty}>
          {stock}
          {p.reorderPoint != null ? <Text style={styles.min}> / {p.reorderPoint}</Text> : null}
        </Text>
      </View>
      <View style={styles.progressRow}>
        <View style={{ flex: 1 }}>
          <ProgressTrack percent={pct} height={3} fill={fill} />
        </View>
        {out ? (
          <Pill variant="red" small>
            Out
          </Pill>
        ) : low ? (
          <Pill variant="orange" small>
            Low
          </Pill>
        ) : !p.isActive ? (
          <Pill variant="gray" small>
            Inactive
          </Pill>
        ) : null}
        {p.trackedCategoryId && sectionNameById.get(p.trackedCategoryId) ? (
          <Pill variant="gray" small>
            {sectionNameById.get(p.trackedCategoryId)}
          </Pill>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  navBtn: {
    width: 34,
    height: 34,
    borderRadius: 999,
    backgroundColor: ios.fill3,
    alignItems: "center",
    justifyContent: "center",
  },
  center: { padding: 40, alignItems: "center", gap: 14 },
  emptyText: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label2 },
  primaryBtn: {
    backgroundColor: ios.brand,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
  },
  primaryBtnText: { color: "#fff", fontSize: 14, fontFamily: "Inter_600SemiBold" },
  row: {
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    padding: 14,
  },
  topRow: { flexDirection: "row", alignItems: "baseline", gap: 10 },
  name: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, letterSpacing: -0.2 },
  sub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  qty: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  min: { color: ios.label2, fontFamily: "Inter_400Regular" },
  progressRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
});
