/**
 * #2653 — the hybrid WebShell (owner 2026-09-28: "Hybrid now, native as we go"). Hosts the NEW
 * web for operators, tenant admins and buyers; drivers never land here (the native driver app).
 *
 * Security (SA-542): loads ONLY the web origin (url-policy). Other http(s) links and new windows
 * open in the system browser; every other scheme is refused. No file access. The bridge accepts
 * only the zod-validated envelope from the web origin (bridge-handler); nothing is ever injected
 * into the page — replies go out through postMessage alone.
 */
import * as React from "react";
import {
  ActivityIndicator,
  BackHandler,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from "react-native-webview";
import NetInfo from "@react-native-community/netinfo";
import { useLocalSearchParams, useRouter } from "expo-router";
import Constants from "expo-constants";
import {
  encodeNativeToWeb,
  shellUserAgentToken,
  type NativeToWebMessage,
} from "@routeflow/ui/shell-bridge";
import { BarcodeScanner } from "../../components/BarcodeScanner";
import { useAuthStore } from "../../lib/auth-store";
import { useBuyerSessionStore } from "../../lib/buyer-session-store";
import { registerPushToken } from "../../lib/auth";
import { classifyNavigation } from "../../lib/web-shell/url-policy";
import { handleBridgeMessage } from "../../lib/web-shell/bridge-handler";
import { shellEntryUrl } from "../../lib/web-shell/shell-config";
import { SHELL_CONFIG } from "../../lib/web-shell/shell-env";

const SHELL = SHELL_CONFIG;

// SA-542a: the web detects the shell by this UA token on its first request (hides Google, Q3).
const SHELL_UA = shellUserAgentToken(Constants.expoConfig?.version ?? "0");

let msgSeq = 0;
const newId = () => `n${Date.now().toString(36)}${(++msgSeq).toString(36)}`;

export default function WebShellScreen() {
  const router = useRouter();
  const { role } = useLocalSearchParams<{ role?: string }>();
  const staffUser = useAuthStore((s) => s.user);
  const staffLogout = useAuthStore((s) => s.logout);
  const buyerSignOut = useBuyerSessionStore((s) => s.signOut);
  const webRef = React.useRef<WebView>(null);
  const [canGoBack, setCanGoBack] = React.useState(false);
  const [offline, setOffline] = React.useState(false);
  const [loadError, setLoadError] = React.useState(false);
  const [scanReplyTo, setScanReplyTo] = React.useState<string | null>(null);

  // No shell config ⇒ this route must not be reachable; send the user back to the native start.
  React.useEffect(() => {
    if (!SHELL) router.replace("/");
  }, [router]);

  React.useEffect(() => NetInfo.addEventListener((s) => setOffline(s.isConnected === false)), []);

  // Android hardware back = WebView back while it has history.
  React.useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (canGoBack) {
        webRef.current?.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [canGoBack]);

  const reply = React.useCallback((msg: NativeToWebMessage) => {
    webRef.current?.postMessage(encodeNativeToWeb(msg));
  }, []);

  const signOut = React.useCallback(async () => {
    await Promise.allSettled([staffUser ? staffLogout() : Promise.resolve(), buyerSignOut()]);
    router.replace("/");
  }, [buyerSignOut, router, staffLogout, staffUser]);

  const onMessage = React.useCallback(
    (e: WebViewMessageEvent) => {
      if (!SHELL) return;
      const action = handleBridgeMessage(e.nativeEvent.data, e.nativeEvent.url, {
        allowed: SHELL.allowed,
        hasStaffSession: !!staffUser,
        scanAvailable: Platform.OS !== "web",
        newId,
      });
      switch (action.kind) {
        case "reply":
          reply(action.message);
          return;
        case "scan":
          setScanReplyTo(action.replyTo);
          return;
        case "push":
          void registerPushToken()
            .then(() => true)
            .catch(() => false)
            .then((registered) =>
              reply({
                v: 1,
                id: newId(),
                type: "push.result",
                payload: { replyTo: action.replyTo, registered },
              }),
            );
          return;
        case "logout":
          void signOut();
          return;
        case "drop":
          return;
      }
    },
    [reply, signOut, staffUser],
  );

  // Every top-frame navigation passes the allowlist; the rest opens outside or is refused.
  const onShouldStart = React.useCallback((req: WebViewNavigation & { isTopFrame?: boolean }) => {
    if (!SHELL) return false;
    const decision = classifyNavigation(req.url, SHELL.allowed, { isTopFrame: req.isTopFrame });
    if (decision === "external") void Linking.openURL(req.url);
    return decision === "load";
  }, []);

  if (!SHELL) return null;
  const entry = shellEntryUrl(SHELL, role === "buyer" ? "buyer" : "operator");

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      {offline || loadError ? (
        <View style={styles.banner} accessibilityRole="alert">
          <Text style={styles.bannerText}>
            {offline
              ? "You're offline. RouteFlow will reload when you're back online."
              : "RouteFlow couldn't load."}
          </Text>
          <Pressable
            onPress={() => {
              setLoadError(false);
              webRef.current?.reload();
            }}
            accessibilityRole="button"
            hitSlop={8}
          >
            <Text style={styles.bannerAction}>Retry</Text>
          </Pressable>
        </View>
      ) : null}
      <WebView
        ref={webRef}
        source={{ uri: entry }}
        applicationNameForUserAgent={SHELL_UA}
        originWhitelist={SHELL.allowed.map((o) => `${o}*`)}
        onShouldStartLoadWithRequest={onShouldStart}
        onOpenWindow={(e) => {
          if (classifyNavigation(e.nativeEvent.targetUrl, SHELL.allowed) !== "block") {
            void Linking.openURL(e.nativeEvent.targetUrl);
          }
        }}
        setSupportMultipleWindows={false}
        javaScriptCanOpenWindowsAutomatically={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
        // Sim proof F2: without these the camera video goes fullscreen and stalls.
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        allowsBackForwardNavigationGestures
        pullToRefreshEnabled
        sharedCookiesEnabled
        onNavigationStateChange={(s) => setCanGoBack(s.canGoBack)}
        onMessage={onMessage}
        onError={() => setLoadError(true)}
        onLoadEnd={() => setLoadError(false)}
        startInLoadingState
        renderLoading={() => (
          <View style={styles.loading}>
            <ActivityIndicator />
          </View>
        )}
      />
      {scanReplyTo ? (
        <View style={StyleSheet.absoluteFill}>
          <BarcodeScanner
            onScanned={(code) => {
              reply({
                v: 1,
                id: newId(),
                type: "scan.result",
                payload: { replyTo: scanReplyTo, code },
              });
              setScanReplyTo(null);
              return { close: true };
            }}
            onClose={() => {
              reply({
                v: 1,
                id: newId(),
                type: "scan.cancelled",
                payload: { replyTo: scanReplyTo },
              });
              setScanReplyTo(null);
            }}
          />
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#ffffff" },
  loading: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: "#FFF4E5",
  },
  bannerText: { flex: 1, fontSize: 14, color: "#7A4B00" },
  bannerAction: { fontSize: 14, fontWeight: "600", color: "#7A4B00" },
});
