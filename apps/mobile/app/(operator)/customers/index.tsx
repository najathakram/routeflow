import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import {
  FilterChipRow,
  NavAction,
  NavBackButton,
  NavBar,
  SearchBar,
  SegmentedControl,
} from "@routeflow/ui/mobile/ios";
import { useAdminCustomers, type AdminCustomer } from "../../../lib/api/admin";
import { useSuppliers, type Supplier } from "../../../lib/api/purchase-orders";
import { AppMapView, type MapPin } from "../../../components/MapView";

type CustomerWithAddress = AdminCustomer & {
  addresses?: Array<{ lat?: number | null; lng?: number | null; line1?: string; city?: string }>;
};

type Tab = "Customers" | "Suppliers" | "Map";

// "Sells regulated items" filter — mirrors the web customers list chip. Kept as a
// local id/label pair like the returns-list FILTERS above.
const REGULATED_FILTERS = [
  { id: "ALL", label: "All" },
  { id: "REGULATED", label: "Regulated" },
] as const;
type RegulatedFilterId = (typeof REGULATED_FILTERS)[number]["id"];

function initialsFor(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

export default function CustomersListScreen() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("Customers");
  const [search, setSearch] = useState("");
  const [regulatedFilter, setRegulatedFilter] = useState<RegulatedFilterId>("ALL");

  const customersQ = useAdminCustomers({
    search: tab === "Customers" || tab === "Map" ? search.trim() || undefined : undefined,
    limit: 100,
    ...(regulatedFilter === "REGULATED" ? { regulated: "1" } : {}),
  });
  const suppliersQ = useSuppliers();

  const customers = (customersQ.data?.data ?? []) as CustomerWithAddress[];
  const suppliers = suppliersQ.data ?? [];

  const filteredSuppliers = useMemo(() => {
    if (!search.trim()) return suppliers;
    const q = search.toLowerCase();
    return suppliers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.contactName ?? "").toLowerCase().includes(q) ||
        (s.email ?? "").toLowerCase().includes(q),
    );
  }, [suppliers, search]);

  const isLoading = tab === "Suppliers" ? suppliersQ.isLoading : customersQ.isLoading;
  const isFetching = tab === "Suppliers" ? (suppliersQ.isFetching ?? false) : customersQ.isFetching;
  const refetch = tab === "Suppliers" ? suppliersQ.refetch : customersQ.refetch;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Contacts"
        subtitle={
          tab === "Suppliers"
            ? filteredSuppliers.length > 0
              ? `${filteredSuppliers.length} supplier${filteredSuppliers.length === 1 ? "" : "s"}`
              : undefined
            : customers.length > 0
              ? `${customers.length} customer${customers.length === 1 ? "" : "s"}`
              : undefined
        }
        leading={
          <NavBackButton
            label="Back"
            onPress={() =>
              router.canGoBack() ? router.back() : router.replace("/(operator)" as any)
            }
          />
        }
        trailing={
          tab === "Suppliers" ? (
            <NavAction label="Add" bold onPress={() => router.push("/(operator)/suppliers/new")} />
          ) : tab === "Customers" ? (
            <NavAction label="Add" bold onPress={() => router.push("/(operator)/customers/new")} />
          ) : null
        }
      />

      <View style={{ paddingHorizontal: 16, paddingTop: 6 }}>
        <SegmentedControl
          items={["Customers", "Suppliers", "Map"]}
          value={tab}
          onChange={(v) => setTab(v as Tab)}
        />
      </View>

      <SearchBar
        placeholder={tab === "Suppliers" ? "Search suppliers…" : "Search customers…"}
        value={search}
        onChangeText={setSearch}
      />

      {tab !== "Suppliers" ? (
        <FilterChipRow
          chips={REGULATED_FILTERS.map((f) => ({ label: f.label }))}
          value={REGULATED_FILTERS.find((f) => f.id === regulatedFilter)?.label ?? "All"}
          onChange={(label) =>
            setRegulatedFilter(
              (REGULATED_FILTERS.find((f) => f.label === label)?.id ?? "ALL") as RegulatedFilterId,
            )
          }
        />
      ) : null}

      {tab === "Suppliers" ? (
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
          ) : filteredSuppliers.length === 0 ? (
            <View style={styles.center}>
              <Text style={styles.emptyText}>
                {search ? "No suppliers match." : "No suppliers yet."}
              </Text>
              <Pressable
                style={styles.primaryBtn}
                onPress={() => router.push("/(operator)/suppliers/new")}
              >
                <Ionicons name="add" size={16} color="#fff" />
                <Text style={styles.primaryBtnText}>Add supplier</Text>
              </Pressable>
            </View>
          ) : (
            <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 24 }}>
              {filteredSuppliers.map((s) => (
                <SupplierRow
                  key={s.id}
                  supplier={s}
                  onPress={() => router.push(`/(operator)/suppliers/${s.id}/edit`)}
                />
              ))}
            </View>
          )}
        </ScrollView>
      ) : tab === "Customers" ? (
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
          ) : customers.length === 0 ? (
            <View style={styles.center}>
              <Text style={styles.emptyText}>
                {search ? "No customers match." : "No customers yet."}
              </Text>
              <Pressable
                style={styles.primaryBtn}
                onPress={() => router.push("/(operator)/customers/new")}
              >
                <Ionicons name="add" size={16} color="#fff" />
                <Text style={styles.primaryBtnText}>Add customer</Text>
              </Pressable>
            </View>
          ) : (
            <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 24 }}>
              {customers.map((c) => (
                <Pressable
                  key={c.id}
                  style={styles.row}
                  onPress={() => router.push(`/(operator)/customers/${c.id}`)}
                >
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>{initialsFor(c.businessName)}</Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.name} numberOfLines={1}>
                      {c.businessName}
                    </Text>
                    {c.contactName || c.phone ? (
                      <Text style={styles.sub} numberOfLines={1}>
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
      ) : (
        <CustomersMap
          customers={customers}
          onPickCustomer={(id) => router.push(`/(operator)/customers/${id}`)}
        />
      )}
    </SafeAreaView>
  );
}

function SupplierRow({ supplier, onPress }: { supplier: Supplier; onPress: () => void }) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={[styles.avatar, { backgroundColor: ios.system.purpleWash }]}>
        <Text style={[styles.avatarText, { color: ios.system.purpleInk }]}>
          {initialsFor(supplier.name)}
        </Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.name} numberOfLines={1}>
          {supplier.name}
        </Text>
        {supplier.contactName || supplier.phone || supplier.email ? (
          <Text style={styles.sub} numberOfLines={1}>
            {[supplier.contactName, supplier.phone ?? supplier.email].filter(Boolean).join(" · ")}
          </Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={16} color={ios.gray[3]} />
    </Pressable>
  );
}

function CustomersMap({
  customers,
  onPickCustomer,
}: {
  customers: CustomerWithAddress[];
  onPickCustomer: (id: string) => void;
}) {
  const pins = useMemo<MapPin[]>(
    () =>
      customers
        .map((c) => {
          const lat = c.addresses?.[0]?.lat;
          const lng = c.addresses?.[0]?.lng;
          if (typeof lat !== "number" || typeof lng !== "number") return null;
          return {
            id: c.id,
            lat,
            lng,
            title: c.businessName,
            subtitle: c.addresses?.[0]?.city ?? undefined,
            color: "gray" as const,
            onPress: () => onPickCustomer(c.id),
          } satisfies MapPin;
        })
        .filter(Boolean) as MapPin[],
    [customers, onPickCustomer],
  );

  return (
    <View style={{ flex: 1 }}>
      {pins.length === 0 ? (
        <View style={styles.mapHint}>
          <Ionicons name="information-circle-outline" size={16} color={ios.label2} />
          <Text style={styles.mapHintText}>
            Customer addresses with coordinates will appear here.
          </Text>
        </View>
      ) : null}
      <AppMapView pins={pins} fitToPins />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
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
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 999,
    backgroundColor: ios.brandWash,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: ios.brand, fontSize: 14, fontFamily: "Inter_700Bold" },
  name: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  sub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 2,
  },
  mapHint: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    padding: 12,
    backgroundColor: ios.bgElev,
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 10,
  },
  mapHintText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    flex: 1,
  },
});
