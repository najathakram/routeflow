import * as React from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { ios } from "@routeflow/ui/tokens";
import { ListGroup, ListRow, NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import {
  useCustomer,
  useCustomerDocuments,
  useDeleteCustomerDocument,
  type CustomerDocument,
} from "../../../../lib/api/customers";
import { sharePdf } from "../../../../lib/share-pdf";
import { showToast } from "../../../../lib/toast";
import { confirm } from "../../../../lib/confirm";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

/**
 * Customer document library — view, share, and delete. Upload is out of scope
 * for this screen (see docs modal on the web dashboard for that flow).
 *
 * Tapping a row VIEWS the document in-app: on native via expo-web-browser's
 * in-app browser sheet (the presigned `url` carries its own auth, no header
 * needed); on web via a modal <iframe> (no react-native-webview dependency,
 * so plain RN-web's DOM iframe is used — see components/MapView.tsx for the
 * same pattern).
 */
export default function CustomerDocumentsScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const customerId = id ?? "";

  const { data: customer } = useCustomer(customerId);
  const { data: docs = [], isLoading, isFetching, refetch } = useCustomerDocuments(customerId);
  const deleteMut = useDeleteCustomerDocument(customerId);

  const [webViewing, setWebViewing] = React.useState<CustomerDocument | null>(null);

  const onView = async (doc: CustomerDocument) => {
    if (Platform.OS === "web") {
      setWebViewing(doc);
      return;
    }
    try {
      await WebBrowser.openBrowserAsync(doc.url);
    } catch {
      showToast("Could not open the document.");
    }
  };

  const onShare = async (doc: CustomerDocument) => {
    try {
      await sharePdf({ url: doc.url, filename: doc.originalName, dialogTitle: "Share document" });
    } catch (e: any) {
      showToast(e?.message ?? "Could not share the document.");
    }
  };

  const onDelete = (doc: CustomerDocument) => {
    confirm(
      "Delete document?",
      `Delete "${doc.originalName}"? This cannot be undone.`,
      () => {
        deleteMut.mutate(doc.id, {
          onSuccess: () => showToast("Document deleted"),
          onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
        });
      },
      { confirmText: "Delete", destructive: true },
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Documents"
        leading={
          <NavBackButton
            label={customer?.businessName ?? "Back"}
            onPress={() =>
              router.canGoBack() ? router.back() : router.replace("/(operator)" as any)
            }
          />
        }
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
        ) : docs.length === 0 ? (
          <View style={styles.center}>
            <Ionicons name="document-text-outline" size={32} color={ios.gray[3]} />
            <Text style={styles.emptyText}>No documents on file.</Text>
          </View>
        ) : (
          <ListGroup>
            {docs.map((doc) => (
              <ListRow
                key={doc.id}
                icon={<Ionicons name="document-text-outline" size={16} color={ios.brand} />}
                iconBg={ios.brandWash}
                title={doc.originalName}
                subtitle={`${doc.docType} · ${formatBytes(doc.sizeBytes)} · ${formatDate(doc.createdAt)}`}
                onPress={() => onView(doc)}
                trailing={
                  <View style={styles.rowActions}>
                    <Pressable
                      style={styles.iconBtn}
                      hitSlop={8}
                      onPress={(e) => {
                        e.stopPropagation();
                        void onShare(doc);
                      }}
                    >
                      <Ionicons name="share-outline" size={18} color={ios.label2} />
                    </Pressable>
                    <Pressable
                      style={styles.iconBtn}
                      hitSlop={8}
                      onPress={(e) => {
                        e.stopPropagation();
                        onDelete(doc);
                      }}
                    >
                      <Ionicons name="trash-outline" size={18} color={ios.system.redInk} />
                    </Pressable>
                  </View>
                }
              />
            ))}
          </ListGroup>
        )}
        <View style={{ height: 24 }} />
      </ScrollView>

      {Platform.OS === "web" ? (
        <Modal
          visible={!!webViewing}
          transparent
          animationType="fade"
          onRequestClose={() => setWebViewing(null)}
        >
          <View style={styles.webBackdrop}>
            <View style={styles.webCard}>
              <View style={styles.webHeader}>
                <Text style={styles.webTitle} numberOfLines={1}>
                  {webViewing?.originalName}
                </Text>
                <Pressable style={styles.iconBtn} hitSlop={10} onPress={() => setWebViewing(null)}>
                  <Ionicons name="close" size={22} color={ios.label} />
                </Pressable>
              </View>
              <View style={styles.webBody}>
                {webViewing
                  ? React.createElement("iframe", {
                      src: webViewing.url,
                      title: webViewing.originalName,
                      style: { border: "none", width: "100%", height: "100%" },
                    })
                  : null}
              </View>
            </View>
          </View>
        </Modal>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 48, alignItems: "center", gap: 10 },
  emptyText: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label2 },
  rowActions: { flexDirection: "row", alignItems: "center", gap: 4 },
  iconBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  webBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  webCard: {
    width: "100%",
    maxWidth: 820,
    height: "85%",
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    overflow: "hidden",
  },
  webHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: 16,
    paddingRight: 8,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  webTitle: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    marginRight: 8,
  },
  webBody: { flex: 1 },
});
