// ─── Types ────────────────────────────────────────────────────────────────────

export type StockStatus = "IN_STOCK" | "LOW" | "OUT_OF_STOCK";
export type Category = "Beverages" | "Snacks" | "Cleaning Supplies";

export interface Product {
  id: string;
  name: string;
  sku: string;
  category: Category;
  description: string;
  unitOfMeasure: string;
  price: number;
  stockLevel: number;
  lowStockThreshold: number;
  isLocalOverride: boolean;
  zohoSyncPaused: boolean;
}

export function getStockStatus(product: Pick<Product, "stockLevel" | "lowStockThreshold">): StockStatus {
  if (product.stockLevel === 0) return "OUT_OF_STOCK";
  if (product.stockLevel <= product.lowStockThreshold) return "LOW";
  return "IN_STOCK";
}

// ─── Mock products ────────────────────────────────────────────────────────────

export const products: Product[] = [
  // Beverages
  {
    id: "PRD-001",
    name: "Big Red Soda",
    sku: "BEV-001",
    category: "Beverages",
    description: "Classic Big Red cherry-cream soda in 24-can cases. A Texas staple for restaurants and concession stands.",
    unitOfMeasure: "Case / 24",
    price: 18.99,
    stockLevel: 42,
    lowStockThreshold: 10,
    isLocalOverride: false,
    zohoSyncPaused: false,
  },
  {
    id: "PRD-002",
    name: "Lone Star Beer",
    sku: "BEV-002",
    category: "Beverages",
    description: "The National Beer of Texas. 12-pack of 12-oz cans.",
    unitOfMeasure: "12-Pack",
    price: 13.49,
    stockLevel: 8,
    lowStockThreshold: 10,
    isLocalOverride: false,
    zohoSyncPaused: false,
  },
  {
    id: "PRD-003",
    name: "Dr Pepper",
    sku: "BEV-003",
    category: "Beverages",
    description: "Born in Waco, TX. 24-can case of the original Dr Pepper.",
    unitOfMeasure: "Case / 24",
    price: 17.99,
    stockLevel: 67,
    lowStockThreshold: 15,
    isLocalOverride: false,
    zohoSyncPaused: false,
  },
  {
    id: "PRD-004",
    name: "Sweet Tea Gallon Jug",
    sku: "BEV-004",
    category: "Beverages",
    description: "Freshly brewed Southern sweet tea in 1-gallon jugs. Refrigerated; 7-day shelf life.",
    unitOfMeasure: "Gallon",
    price: 4.99,
    stockLevel: 0,
    lowStockThreshold: 5,
    isLocalOverride: false,
    zohoSyncPaused: false,
  },
  {
    id: "PRD-005",
    name: "Sparkling Water Case",
    sku: "BEV-005",
    category: "Beverages",
    description: "Unsweetened carbonated mineral water in 500ml bottles. 24 bottles per case.",
    unitOfMeasure: "Case / 24",
    price: 21.99,
    stockLevel: 31,
    lowStockThreshold: 8,
    isLocalOverride: false,
    zohoSyncPaused: false,
  },
  // Snacks
  {
    id: "PRD-006",
    name: "BBQ Kettle Chips",
    sku: "SNK-001",
    category: "Snacks",
    description: "Slow-cooked, thick-cut BBQ kettle chips. 1-lb resealable bag.",
    unitOfMeasure: "1-lb Bag",
    price: 6.49,
    stockLevel: 5,
    lowStockThreshold: 6,
    isLocalOverride: false,
    zohoSyncPaused: false,
  },
  {
    id: "PRD-007",
    name: "Jalapeño Peanuts",
    sku: "SNK-002",
    category: "Snacks",
    description: "Roasted Texas peanuts coated in jalapeño seasoning. 16-oz jar.",
    unitOfMeasure: "16-oz Jar",
    price: 5.99,
    stockLevel: 24,
    lowStockThreshold: 8,
    isLocalOverride: false,
    zohoSyncPaused: false,
  },
  {
    id: "PRD-008",
    name: "Beef Jerky Strips",
    sku: "SNK-003",
    category: "Snacks",
    description: "Peppered, slow-smoked beef jerky. 10-oz resealable bag. No preservatives.",
    unitOfMeasure: "10-oz Bag",
    price: 9.99,
    stockLevel: 0,
    lowStockThreshold: 5,
    isLocalOverride: false,
    zohoSyncPaused: false,
  },
  {
    id: "PRD-009",
    name: "Pecan Pralines",
    sku: "SNK-004",
    category: "Snacks",
    description: "Handmade Texas-style pecan pralines, individually wrapped. Box of 12.",
    unitOfMeasure: "Box / 12",
    price: 14.99,
    stockLevel: 19,
    lowStockThreshold: 6,
    isLocalOverride: false,
    zohoSyncPaused: false,
  },
  {
    id: "PRD-010",
    name: "Corn Tortilla Chips",
    sku: "SNK-005",
    category: "Snacks",
    description: "Restaurant-grade stone-ground corn tortilla chips. Bulk 5-lb bag.",
    unitOfMeasure: "5-lb Bag",
    price: 11.99,
    stockLevel: 33,
    lowStockThreshold: 10,
    isLocalOverride: false,
    zohoSyncPaused: false,
  },
  // Cleaning Supplies
  {
    id: "PRD-011",
    name: "Commercial Degreaser",
    sku: "CLN-001",
    category: "Cleaning Supplies",
    description: "Heavy-duty citrus-based degreaser. Safe for stainless steel and commercial kitchen use. 1-gallon jug.",
    unitOfMeasure: "1-gal Jug",
    price: 22.99,
    stockLevel: 14,
    lowStockThreshold: 5,
    isLocalOverride: true,
    zohoSyncPaused: true,
  },
  {
    id: "PRD-012",
    name: "Industrial Hand Soap",
    sku: "CLN-002",
    category: "Cleaning Supplies",
    description: "Lemon-scented, antibacterial industrial hand soap. 5-gallon pail with pump.",
    unitOfMeasure: "5-gal Pail",
    price: 39.99,
    stockLevel: 7,
    lowStockThreshold: 5,
    isLocalOverride: false,
    zohoSyncPaused: false,
  },
  {
    id: "PRD-013",
    name: "Sanitizer Concentrate",
    sku: "CLN-003",
    category: "Cleaning Supplies",
    description: "Food-safe quaternary ammonium sanitizer concentrate. Mix 1 oz per gallon. 2.5-gallon container.",
    unitOfMeasure: "2.5-gal",
    price: 31.99,
    stockLevel: 3,
    lowStockThreshold: 4,
    isLocalOverride: false,
    zohoSyncPaused: false,
  },
  {
    id: "PRD-014",
    name: "Mop Bucket with Wringer",
    sku: "CLN-004",
    category: "Cleaning Supplies",
    description: "Heavy-duty 35-quart plastic mop bucket with side-press wringer and caster wheels.",
    unitOfMeasure: "Each",
    price: 54.99,
    stockLevel: 6,
    lowStockThreshold: 2,
    isLocalOverride: false,
    zohoSyncPaused: false,
  },
  {
    id: "PRD-015",
    name: "Microfiber Towel Pack",
    sku: "CLN-005",
    category: "Cleaning Supplies",
    description: "Commercial-grade 16x16 microfiber cleaning towels. Color-coded. Pack of 24.",
    unitOfMeasure: "Pack / 24",
    price: 27.99,
    stockLevel: 0,
    lowStockThreshold: 3,
    isLocalOverride: false,
    zohoSyncPaused: false,
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getProduct(id: string): Product | undefined {
  return products.find((p) => p.id === id);
}

export const categories: Category[] = ["Beverages", "Snacks", "Cleaning Supplies"];

/** Deterministic 30-day demand data seeded by product ID. */
export function generateDemandData(productId: string): { day: string; units: number }[] {
  const seed = Array.from(productId).reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const base = new Date(2026, 1, 8); // Feb 8
  return Array.from({ length: 30 }, (_, i) => {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    const units = Math.max(
      1,
      Math.round(8 + ((seed * 3 + i * 7) % 14) + Math.round(Math.sin((i + seed) * 0.7) * 4)),
    );
    return { day: `${d.getMonth() + 1}/${d.getDate()}`, units };
  });
}
