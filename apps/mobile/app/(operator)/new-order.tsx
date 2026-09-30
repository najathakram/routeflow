import { useLocalSearchParams, useRouter } from "expo-router";
import { NewOrderScreen } from "../../components/NewOrderScreen";

/**
 * Operator-initiated order from Home or Dispatch. Picks a customer, then
 * renders products + save. Posts to POST /orders with the operator as creator.
 *
 * Both Back and post-save land on the orders LIST so the operator can
 * navigate freely. The defaults (`router.back()`) silently no-op when the
 * URL was opened directly with no back stack — that was the user's "back
 * is not working" report.
 *
 * `?resumeDraft=<id>` (DraftStrip's tap target, pos-cost-roles-spec §2)
 * resumes a parked order builder instead of starting empty.
 */
export default function OperatorNewOrderScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ resumeDraft?: string }>();
  const goToOrders = () => router.replace("/(operator)/(tabs)/orders" as any);
  return (
    <NewOrderScreen
      backLabel="Orders"
      onBack={goToOrders}
      onSaved={goToOrders}
      resumeDraftId={params.resumeDraft}
    />
  );
}
