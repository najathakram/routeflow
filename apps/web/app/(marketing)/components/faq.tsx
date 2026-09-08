"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";

// Copy verbatim from the redesign's components/faq.tsx (M1 §1.9 / §2c) —
// two hardcoded Q&A sets, selected via the `retail` prop. Re-implemented on
// native `<details>/<summary>` (ux-spec.md §4) instead of the shadcn
// `Accordion` the redesign used (no `@radix-ui/react-accordion` in this
// repo's dependency set — standing rules), with a controlled `openIndex` so
// only the most recently opened item stays expanded.

const GENERAL: Array<[string, string]> = [
  [
    "Who is RouteFlow for?",
    "RouteFlow is for wholesalers and distributors who take customer orders and run deliveries, along with the retailers who order from them. The distributor workspace covers operations; the retailer portal covers purchasing.",
  ],
  [
    "Can retailers order through RouteFlow?",
    "Yes. Retailers can use the web portal to browse catalogs and place orders with their connected suppliers. A retailer account does not provide access to every supplier automatically.",
  ],
  [
    "Do I need to install an app?",
    "You can access RouteFlow through a web browser. Native iOS and Android apps are not part of this website’s availability promise; ask the team for their current release status.",
  ],
  [
    "Can I bring my existing customer and product data?",
    "The distributor workspace includes import options. Bring a sample of your existing files to the demo so the team can confirm supported formats, field mapping, and setup needs.",
  ],
  [
    "What will we cover in a demo?",
    "Start with your ordering and delivery process. Ask to see order intake, route planning, delivery confirmation, and customer records, then discuss the plan and setup that fit your team.",
  ],
];

const RETAILER: Array<[string, string]> = [
  [
    "Do I need a supplier connection?",
    "Yes. Your supplier connection determines the catalogs, prices, and ordering options available to your account. Ask your distributor how to connect.",
  ],
  [
    "Can I use the portal on my phone?",
    "Use the retailer web portal from a supported browser. You do not need to wait for a native mobile app to access the web portal.",
  ],
  [
    "Who handles my order or delivery questions?",
    "Contact the distributor fulfilling the order for product availability, delivery arrangements, returns, or account terms.",
  ],
  [
    "Will this create a new distributor account?",
    "No. Choose the retailer registration link to create a retailer account. Distributor sign-in and signup use a separate workflow.",
  ],
];

export function FAQ({ retail = false }: { retail?: boolean } = {}) {
  const items = retail ? RETAILER : GENERAL;
  const [openIndex, setOpenIndex] = React.useState<number | null>(null);

  return (
    <section className="section faq-section wrap">
      <div>
        <p className="eyebrow">
          <span />A FEW USEFUL ANSWERS
        </p>
        <h2>
          Before you <br />
          get started.
        </h2>
        <p>Have a question about your setup?</p>
        <Link className="text-link" href="/contact">
          Talk to the team ↗
        </Link>
      </div>
      <div className="faq-list">
        {items.map(([question, answer], i) => (
          <details
            key={question}
            data-slot="accordion-item"
            open={openIndex === i}
            onToggle={(event) => {
              if (event.currentTarget.open) setOpenIndex(i);
            }}
          >
            <summary data-slot="accordion-trigger">
              {question}
              <ChevronDown size={18} aria-hidden="true" />
            </summary>
            <div data-slot="accordion-content">
              <div>{answer}</div>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
