import Link from "next/link";
import {
  Warehouse,
  Package,
  Route,
  ReceiptText,
  Wallet,
  BarChart3,
  Store,
  BrainCircuit,
  ShieldCheck,
  Tags,
  Repeat2,
  RotateCcw,
  HandCoins,
  FileUp,
  ShoppingCart,
  ArrowUpRight,
} from "lucide-react";
import { Eyebrow } from "./marketing";

// Copy and data are verbatim from the redesign's components/feature-catalog.tsx
// (M1 §10) — the 9-card capability grid, the 6-item wholesale-extras grid, and
// the 9-chip capability strip.

const capabilities = [
  {
    icon: Warehouse,
    name: "Inventory & purchasing",
    text: "Manage products, stock counts, suppliers, and purchase orders in your distribution workspace.",
    tag: "KNOW WHAT YOU HAVE",
  },
  {
    icon: Package,
    name: "Order management",
    text: "Keep customer orders, items, delivery details, and status together from intake to dispatch.",
    tag: "KEEP WORK MOVING",
  },
  {
    icon: Route,
    name: "Route planning & dispatch",
    text: "Organize stops, assign drivers, and prepare delivery manifests with a Google Maps handoff.",
    tag: "GIVE DRIVERS A CLEAR PLAN",
  },
  {
    icon: Wallet,
    name: "Customer accounts",
    text: "Find addresses, order history, balances, documents, and agreed pricing in the customer record.",
    tag: "ANSWER WITH CONTEXT",
  },
  {
    icon: ReceiptText,
    name: "Invoices & payments",
    text: "Work with invoices, recorded payments, payment requests, statements, and credit notes.",
    tag: "FOLLOW THE MONEY",
  },
  {
    icon: BarChart3,
    name: "Analytics & reporting",
    text: "Review sales, products, customers, and operations through dedicated reporting views.",
    tag: "SEE THE BUSINESS",
  },
  {
    icon: Store,
    name: "Retailer ordering platform",
    text: "Give connected retailers a place to browse supplier catalogs, place orders, and review their purchases.",
    tag: "CONNECT YOUR CUSTOMERS",
  },
  {
    icon: BrainCircuit,
    name: "AI purchase-invoice scanning",
    text: "Scan purchase invoices from multiple vendors to simplify inventory updates and costing, with less manual data entry.",
    tag: "FROM INVOICE TO INVENTORY",
  },
  {
    icon: ShieldCheck,
    name: "Regulated-goods workflows",
    text: "Dedicated tobacco inventory, purchase and sales records, monthly reporting, and customer license records.",
    tag: "HANDLE THE EXTRA REQUIREMENTS",
  },
];

const featureKeys = [
  "inventory",
  "orders",
  "routes",
  "accounts",
  "invoices",
  "analytics",
  "retailer-platform",
  "ai-invoice-scanning",
  "regulated-goods",
];

const details = [
  {
    icon: Tags,
    title: "Customer-specific pricing",
    text: "Keep agreed prices with the account.",
  },
  {
    icon: Repeat2,
    title: "Standing orders",
    text: "Keep repeat-order information within reach.",
  },
  {
    icon: ShoppingCart,
    title: "Suppliers & vendor bills",
    text: "Cover the purchasing side of the operation.",
  },
  {
    icon: RotateCcw,
    title: "Returns & credit notes",
    text: "Keep the exceptions connected to the sale.",
  },
  {
    icon: HandCoins,
    title: "Sales-agent commissions",
    text: "Review agent rates and commission records.",
  },
  {
    icon: FileUp,
    title: "Imports & migration setup",
    text: "Plan how existing records enter RouteFlow.",
  },
];

export function FeatureCatalog({ heading = false }: { heading?: boolean } = {}) {
  return (
    <div className="capability-catalog" id="capabilities">
      {heading && (
        <div className="section-heading split-heading">
          <div>
            <Eyebrow>THE FEATURES BEHIND THE FLOW</Eyebrow>
            <h2>
              More than a delivery tool.
              <br />
              Your wholesale operation.
            </h2>
          </div>
          <p>
            From the stock you buy to the account you collect. See the connected tools your team can
            work with.
          </p>
        </div>
      )}
      <div className="capability-grid">
        {capabilities.map((f, i) => (
          <article
            key={f.name}
            id={"feature-" + featureKeys[i]}
            className={"capability-card capability-" + i}
          >
            <f.icon size={27} />
            <span>{f.tag}</span>
            <h3>{f.name}</h3>
            <p>{f.text}</p>
          </article>
        ))}
      </div>
      <div className="wholesale-extras">
        <div>
          <Eyebrow>THE WHOLESALE DETAILS MATTER</Eyebrow>
          <h3>Built for the work around the order, too.</h3>
        </div>
        <div className="extras-grid">
          {details.map((f) => (
            <article key={f.title}>
              <f.icon size={20} />
              <div>
                <h4>{f.title}</h4>
                <p>{f.text}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
      <p className="capability-scope">
        Review feature availability, AI configuration, and regulated-item reporting requirements for
        your plan and operation. Reporting tools do not guarantee regulatory compliance.
      </p>
      <Link className="text-link" href="/book-a-demo">
        Show us the features that matter to your team <ArrowUpRight size={17} />
      </Link>
    </div>
  );
}

export function CapabilityStrip() {
  const icons = [
    Warehouse,
    Package,
    Route,
    Wallet,
    ReceiptText,
    BarChart3,
    Store,
    BrainCircuit,
    ShieldCheck,
  ];
  const labels = [
    "Inventory",
    "Orders",
    "Routes",
    "Accounts",
    "Invoicing",
    "Analytics",
    "Retailer portal",
    "AI assistance",
    "Regulated goods",
  ];
  return (
    <section className="capability-strip wrap" aria-label="RouteFlow capabilities">
      {icons.map((Icon, i) => (
        <Link key={featureKeys[i]} href={"/product#feature-" + featureKeys[i]}>
          <Icon size={18} />
          {labels[i]}
        </Link>
      ))}
    </section>
  );
}
