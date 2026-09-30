// Pure data + pure functions backing the OperationStory ("DeliveryDemo")
// interactive demo — ported verbatim (arithmetic and clamped chapter
// stepping only, no DOM/browser API) from the redesign's
// lib/operation-model.mjs. See ux-spec.md §3/§4, spec.md R7, T8a.

export interface ExampleRoute {
  name: string;
  driver: string;
  stops: string[];
  /** SVG path `d` attribute for the illustrative route line. */
  path: string;
}

export const exampleRoutes: ExampleRoute[] = [
  {
    name: "North run",
    driver: "Alex",
    stops: ["Warehouse", "Parkside Market", "Corner Store"],
    path: "M65 166 C112 166 107 71 182 71 S237 160 309 160 S341 100 393 76",
  },
  {
    name: "East run",
    driver: "Sam",
    stops: ["Warehouse", "Corner Store", "Parkside Market"],
    path: "M65 166 C107 220 214 235 278 192 S357 113 393 76 S216 7 182 71",
  },
];

export interface ExampleOrderOptions {
  delivered?: boolean;
  paid?: boolean;
}

export interface ExampleOrder {
  cases: number;
  waterTotal: number;
  snackTotal: number;
  total: number;
  available: number;
  reserved: number;
  delivered: boolean;
  paid: boolean;
  balance: number;
}

const MIN_CASES = 1;
const MAX_CASES = 12;
const CASE_PRICE = 18;
const SERVICE_FEE = 42;
const STARTING_INVENTORY = 148;
const FINAL_CHAPTER = 5;

export function exampleOrder(
  quantity: number = 4,
  { delivered = false, paid = false }: ExampleOrderOptions = {},
): ExampleOrder {
  const cases = Math.max(
    MIN_CASES,
    Math.min(MAX_CASES, Number.isFinite(quantity) ? Math.round(quantity) : 4),
  );
  const total = cases * CASE_PRICE + SERVICE_FEE;
  const isDelivered = Boolean(delivered);
  const isPaid = Boolean(paid && isDelivered);
  return {
    cases,
    waterTotal: cases * CASE_PRICE,
    snackTotal: SERVICE_FEE,
    total,
    available: STARTING_INVENTORY - cases,
    reserved: cases,
    delivered: isDelivered,
    paid: isPaid,
    balance: isPaid ? 0 : total,
  };
}

/** Clamped chapter stepping: never goes below 0 or past the final chapter. */
export function nextChapter(chapter: number): number {
  const current = Number.isFinite(chapter) ? Math.floor(chapter) : 0;
  return Math.min(FINAL_CHAPTER, Math.max(0, current + 1));
}
