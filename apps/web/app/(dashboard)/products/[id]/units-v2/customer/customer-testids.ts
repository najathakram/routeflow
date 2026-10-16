/** Stable test ids for the units v2 Customer view (K6). Names follow the demo's #sec-customers anchors. */
export const CUSTOMER_VIEW_TESTIDS = {
  section: "units-v2-sec-customers",
  heading: "units-v2-h-cust",
  search: "units-v2-cust-select",
  result: (id: string) => `units-v2-cust-option-${id}`,
  chosen: "units-v2-cust-chosen",
  change: "units-v2-cust-change",
  blurb: "units-v2-cust-blurb",
  empty: "units-v2-cv-empty",
  body: "units-v2-cv-body",
  product: (id: string) => `units-v2-cv-product-${id}`,
  ordersIn: (id: string) => `units-v2-cv-orders-in-${id}`,
  prices: (id: string) => `units-v2-cust-prices-${id}`,
  row: (productId: string, ref: string) => `units-v2-cv-row-${productId}-${ref}`,
  where: (id: string) => `units-v2-cust-where-${id}`,
  prev: "units-v2-cv-prev",
  next: "units-v2-cv-next",
} as const;
