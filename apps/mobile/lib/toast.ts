import { Platform, ToastAndroid, Alert } from "react-native";

export function showToast(message: string) {
  if (Platform.OS === "android") {
    ToastAndroid.show(message, ToastAndroid.SHORT);
  } else {
    // iOS doesn't have ToastAndroid, so we use a brief alert
    // Use a timeout to auto-dismiss is not possible with Alert, but we keep it simple
    Alert.alert("", message, [{ text: "OK" }], { cancelable: true });
  }
}
