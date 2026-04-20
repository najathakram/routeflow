import { Stack } from "expo-router";

export default function RouteLayout() {
  // Each screen renders its own iOS NavBar; stack chrome is suppressed.
  return <Stack screenOptions={{ headerShown: false }} />;
}
