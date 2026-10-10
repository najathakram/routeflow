import { Stack } from "expo-router";

/** #2653: the hybrid WebShell group — one full-screen route, no native header. */
export default function ShellLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
