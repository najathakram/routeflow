import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import {
  counterCustomerCreditView,
  type CounterCustomerCreditView,
  type CreditSource,
} from "../counter-customer-credit";

/**
 * CQ-07: the picked customer's account signal for the counter, from reads that already exist: the customer record
 * (`creditLimit`, `defaultPaymentTerms`), the operator statement (`outstandingAmount`, `overdueAmount`) and the business's
 * default terms. The query keys are the customer page's own (and the invoice settings' own), so a customer already open
 * there is not fetched twice. Nothing is written. Each read reports its OWN state, so a failure of one shows "—" for just
 * the fields that depend on it (see `counterCustomerCreditView`).
 */
function sourceOf(q: UseQueryResult<unknown>): CreditSource {
  if (q.isSuccess) return { state: "ready", data: q.data };
  // a read that cannot start (React Query pauses it while the browser is offline) is a failed read, not a spinner
  if (q.isError || q.fetchStatus === "paused") return { state: "failed" };
  return { state: "loading" };
}

export function useCounterCustomerCredit(customerId: string | null) {
  const id = customerId ?? "";
  const customer = useQuery({
    queryKey: ["customers", id],
    queryFn: () => apiClient.get(`/customers/${id}`).then((r) => r.data),
    enabled: !!id,
  });
  const statement = useQuery({
    queryKey: ["customers", id, "statement"],
    queryFn: () => apiClient.get(`/customers/${id}/statement`).then((r) => r.data),
    enabled: !!id,
  });
  const settings = useQuery({
    queryKey: ["invoice-settings"],
    queryFn: () => apiClient.get("/settings/invoice").then((r) => r.data),
    enabled: !!id,
  });
  const view: CounterCustomerCreditView = counterCustomerCreditView({
    customer: sourceOf(customer),
    statement: sourceOf(statement),
    settings: sourceOf(settings),
  });
  return { view };
}
