import { API_ERROR_CODES } from "@routeflow/types";

/** The body `field` of a TEXT_CELL_FORMULA_LEAD refusal (the input to focus), or null for any other error. */
export function refusedTextField(err: unknown): string | null {
  const data = (err as { response?: { data?: { code?: unknown; field?: unknown } } } | null)
    ?.response?.data;
  return data?.code === API_ERROR_CODES.TEXT_CELL_FORMULA_LEAD && typeof data.field === "string"
    ? data.field
    : null;
}
