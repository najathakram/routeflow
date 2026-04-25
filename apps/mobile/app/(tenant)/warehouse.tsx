import { useEffect } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";

export default function TenantWarehouseRelay() {
  const router = useRouter();
  useEffect(() => { router.push("/(operator)/warehouse"); }, []);
  return <View style={{ flex: 1, backgroundColor: ios.bg }} />;
}
