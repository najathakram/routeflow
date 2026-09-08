// Verbatim audience copy for the reskinned auth surface.
// Transcribed from the redesign source (read-only reference):
// C:/Users/nakram/Documents/Codex/2026-09-06/rev/work/routeflow-redesign/components/auth-preview.tsx:33-75
// .claude/pipeline/2026-09-07-auth-redesign/build-plan.md — P1 auth-shell

export type AuthAudience = "distributor" | "retailer";

export const AUTH_STORY: Record<
  AuthAudience,
  { kicker: string; heading: string; paragraph: string }
> = {
  distributor: {
    kicker: "For distributors",
    heading: "A clearer picture of your business.",
    paragraph: "Connect your warehouse, delivery team, and customer accounts.",
  },
  retailer: {
    kicker: "For retailers",
    heading: "Stock your shelves. Stay in control.",
    paragraph: "Keep supplier orders and purchases in one place.",
  },
};

export const AUTH_ORBIT = {
  orderLabel: "Order RF-1042",
  orderStatus: "Ready for the next stop.",
  steps: ["Order", "Route", "Delivery", "Invoice"] as const,
};

export const AUTH_AI_CHIP = {
  title: "AI purchase-invoice scanning",
  body: "Multiple vendors. Easier inventory and costing.",
};

export const AUTH_TAGLINE = "One brand. One connected workflow.";
