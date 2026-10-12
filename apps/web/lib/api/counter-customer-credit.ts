import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import {
  counterCustomerCreditView,
  type CounterCustomerCreditView,
} from "../counter-customer-credit";

/**
 * CQ-07: the picked customer's account signal for the counter, from reads that already exist: the customer record
 * (`creditLimit`, `defaultPaymentTerms`), the operator statement (`outstandingAmount`, `overdueAmount`) and the business's
 * default terms. The query keys are the customer page's own, so a customer already open there is not fetched twice.
 * Nothing is written, and a failed read just leaves that part unknown (the screen says so, the sale is never blocked).
 */
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
  const settings = useQuery<{ defaultTerms?: string }>({
    queryKey: ["invoice-settings"],
    queryFn: () => apiClient.get("/settings/invoice").then((r) => r.data),
    enabled: !!id,
  });
  const view: CounterCustomerCreditView = counterCustomerCreditView({
    customer: customer.data,
    statement: statement.data,
    tenantTerms: settings.data?.defaultTerms,
  });
  return {
    view,
    loading: customer.isLoading || statement.isLoading,
    /** the balance could not be read at all: nothing about the account is shown as a number */
    failed: !!id && customer.isError && statement.isError,
  };
}
