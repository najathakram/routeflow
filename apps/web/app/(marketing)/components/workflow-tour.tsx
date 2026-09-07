"use client";

import Link from "next/link";
import * as Tabs from "@radix-ui/react-tabs";
import { Package, Route, CheckCheck, ReceiptText, Check, ArrowUpRight } from "lucide-react";

// Copy verbatim from the redesign's components/workflow-tour.tsx (M1 §2b);
// re-implemented on `@radix-ui/react-tabs` instead of shadcn's `Tabs`
// wrapper — same `data-state` attributes drive marketing.css's `.tour-tabs`
// selectors.

const steps = [
  {
    id: "orders",
    label: "Take the order",
    icon: Package,
    title: "Know what needs to go, and who it’s for.",
    text: "Keep the customer, items, and order status together. Give the office and warehouse the same starting point.",
    points: ["Customer-specific product pricing", "An order history your team can find"],
    caption: "ORDER DETAILS",
    sampleTitle: "Parkside Market",
    status: "Ready to dispatch",
    rows: [
      ["Spring water · 24-pack", "4 cases"],
      ["Sparkling water · 12-pack", "2 cases"],
      ["Mixed snacks · 30-pack", "1 case"],
    ],
    foot: ["Delivery notes", "Use the rear receiving entrance."],
  },
  {
    id: "routes",
    label: "Plan the route",
    icon: Route,
    title: "Send drivers out with a clear next stop.",
    text: "Group orders into a delivery run, assign a driver, and keep the stop details connected to each customer.",
    points: ["Orders and stops in one route view", "Driver assignments and delivery notes"],
    caption: "DELIVERY RUN",
    sampleTitle: "North route",
    status: "On the road",
    rows: [
      ["01 · Warehouse", "Departed"],
      ["02 · Parkside Market", "Complete"],
      ["03 · Corner Wholesale", "Next stop"],
    ],
    foot: ["Driver", "Alex · 6 stops on this run"],
  },
  {
    id: "delivery",
    label: "Confirm delivery",
    icon: CheckCheck,
    title: "Keep a record of the handoff.",
    text: "Follow delivery status and refer back to proof of delivery when your customer or team needs an answer.",
    points: ["Delivery status tied to the order", "Proof of delivery for the customer record"],
    caption: "DELIVERY RECORD",
    sampleTitle: "Order #RF-1024",
    status: "Delivered",
    rows: [
      ["Customer", "Parkside Market"],
      ["Delivery run", "North route"],
      ["Proof of delivery", "Attached"],
    ],
    foot: ["Delivery note", "Received at the rear entrance."],
  },
  {
    id: "accounts",
    label: "Follow the account",
    icon: ReceiptText,
    title: "Pick up the conversation with context.",
    text: "Look up invoices, recorded payments, and order history from the customer account without starting from scratch.",
    points: ["Invoices and recorded payments", "Customer-level order history"],
    caption: "CUSTOMER ACCOUNT",
    sampleTitle: "Parkside Market",
    status: "Account overview",
    rows: [
      ["Order #RF-1024", "Delivered"],
      ["Invoice #INV-024", "$168.00"],
      ["Payment record", "Recorded"],
    ],
    foot: ["Your next conversation", "Keep the supporting records close at hand."],
  },
];

export function WorkflowTour() {
  return (
    <Tabs.Root defaultValue="orders" className="workflow-tour">
      <Tabs.List className="tour-tabs" aria-label="Explore the wholesale workflow">
        {steps.map((step, i) => (
          <Tabs.Trigger key={step.id} value={step.id}>
            <span className="tab-number">0{i + 1}</span>
            {step.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {steps.map((step) => (
        <Tabs.Content key={step.id} value={step.id} className="tour-panel">
          <div className="tour-copy">
            <step.icon className="feature-icon" size={28} />
            <h3>{step.title}</h3>
            <p>{step.text}</p>
            <ul className="check-list">
              {step.points.map((point) => (
                <li key={point}>
                  <Check size={18} />
                  {point}
                </li>
              ))}
            </ul>
            <Link className="text-link" href="/contact">
              See it in a demo <ArrowUpRight size={17} />
            </Link>
          </div>
          <div className="tour-preview">
            <p className="tour-example-label">ILLUSTRATIVE PRODUCT VIEW</p>
            <div className="record-card">
              <div className="record-caption">
                {step.caption}
                <step.icon size={20} />
              </div>
              <h4>{step.sampleTitle}</h4>
              <span className="record-status">
                <span />
                {step.status}
              </span>
              <div className="record-rows">
                {step.rows.map(([key, val]) => (
                  <div key={key}>
                    <span>{key}</span>
                    <strong>{val}</strong>
                  </div>
                ))}
              </div>
              <div className="record-note">
                <span>{step.foot[0]}</span>
                <p>{step.foot[1]}</p>
              </div>
            </div>
          </div>
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}
