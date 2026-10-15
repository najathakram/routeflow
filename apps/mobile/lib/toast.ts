import { Alert, Platform, ToastAndroid } from "react-native";
import { getToastHost } from "./toast-host";

export function showToast(message: string) {
  if (Platform.OS === "android") {
    ToastAndroid.show(message, ToastAndroid.SHORT);
  } else if (Platform.OS === "web") {
    if (typeof document === "undefined") return;
    const el = document.createElement("div");
    el.textContent = message;
    Object.assign(el.style, {
      position: "fixed",
      // Clear of the bottom nav (~57px + safe-area inset), which is now on every
      // operator screen rather than just the tab routes.
      bottom: "96px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "rgba(30,30,30,0.88)",
      color: "#fff",
      padding: "10px 18px",
      borderRadius: "24px",
      fontSize: "14px",
      fontFamily: "system-ui, sans-serif",
      zIndex: "999999",
      pointerEvents: "none",
      // B962: wrap inside the viewport (16px gutter each side) instead of clipping on both sides.
      // `left: 50%` leaves only the right half as shrink-to-fit room, so size to the content and
      // let maxWidth be the only cap.
      width: "max-content",
      maxWidth: "calc(100vw - 32px)",
      boxSizing: "border-box",
      whiteSpace: "normal",
      overflowWrap: "anywhere",
      textAlign: "center",
      transition: "opacity 0.3s",
    });
    document.body.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 350);
    }, 2200);
  } else {
    // iOS (REG-B151): route to whichever screen's InlineToast is currently
    // mounted (lib/toast-host.ts); when no host is registered, fall back to
    // a native alert so the message is never silently dropped.
    const host = getToastHost();
    if (host) {
      host(message);
    } else {
      Alert.alert(message);
    }
  }
}
