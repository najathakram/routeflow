import { useRouter } from "expo-router";
import { NewOrderScreen } from "../../components/NewOrderScreen";

/**
 * Operator-initiated order from Home or Dispatch. Picks a customer, then
 * renders products + save. Posts to POST /orders with the operator as creator.
 *
 * After save (including after the merge/replace decision), land on the
 * orders LIST so the operator can navigate freely. Default `router.back()`
 * would dump them on whatever they came from (e.g. /home), and the user
 * reported that as feeling stuck.
 */
export default function OperatorNewOrderScreen() {
  const router = useRouter();
  return (
    <NewOrderScreen
      backLabel="Back"
      onSaved={() => {
        router.replace("/(operator)/(tabs)/orders" as any);
      }}
    />
  );
}
