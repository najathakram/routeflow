import { useEffect } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";

export default function TenantDispatchRelay() {
  const router = useRouter();
  useEffect(() => {
    router.push("/(operator)/dispatch");
  }, []);
  return <View style={{ flex: 1, backgroundColor: ios.bg }} />;
}
