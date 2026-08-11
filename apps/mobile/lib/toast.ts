import { Platform, ToastAndroid } from "react-native";

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
      whiteSpace: "nowrap",
      transition: "opacity 0.3s",
    });
    document.body.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 350);
    }, 2200);
  }
  // iOS: no-op — use in-screen feedback instead of Alert.alert
}
