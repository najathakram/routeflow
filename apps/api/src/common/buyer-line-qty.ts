import type { BUYER_LINE_QTY_MAX as SHARED_BUYER_LINE_QTY_MAX } from "@routeflow/types";

/**
 * The most one buyer order line may carry (qty, boxes or pieces). The ONE number lives in `@routeflow/types`
 * (`BUYER_LINE_QTY_MAX`, read by the web shop). The API may only `import type` from that package, so this is its
 * runtime copy: typed `typeof` the shared literal, so tsc fails here the moment the two differ, and
 * `buyer-create-order-qty-limit.spec.ts` pins them equal. Do not hand-edit without changing the shared constant.
 */
export const BUYER_LINE_QTY_MAX: typeof SHARED_BUYER_LINE_QTY_MAX = 100_000;
