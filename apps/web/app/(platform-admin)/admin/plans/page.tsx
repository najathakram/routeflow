"use client";

import * as React from "react";
import { superAdminClient } from "@/lib/admin-api";
import { AdminCard } from "../../_components/AdminCard";
import { AdminStatCard } from "../../_components/AdminStatCard";
import { Check, X } from "lucide-react";

// ─── Plan definitions ──────────────────────────────────────────────────────────

interface PlanDef {
  name: string;
  monthlyPrice: number;
  annualPrice: number;
  color: string;
}

const PLANS: Record<string, PlanDef> = {
  STARTER: { name: "Starter", monthlyPrice: 29, annualPrice: 290, color: "text-slate-300" },
  PROFESSIONAL: {
    name: "Professional",
    monthlyPrice: 79,
    annualPrice: 790,
    color: "text-blue-400",
  },
  ENTERPRISE: {
    name: "Enterprise",
    monthlyPrice: 199,
    annualPrice: 1990,
    color: "text-purple-400",
  },
};

interface Feature {
  name: string;
  starter: boolean | string;
  professional: boolean | string;
  enterprise: boolean | string;
}

const FEATURES: Feature[] = [
  { name: "Max Users", starter: "5", professional: "25", enterprise: "Unlimited" },
  { name: "Max Customers", starter: "50", professional: "500", enterprise: "Unlimited" },
  { name: "Orders & Invoices", starter: true, professional: true, enterprise: true },
  { name: "Route Management", starter: true, professional: true, enterprise: true },
  { name: "Returns & Credit Notes", starter: true, professional: true, enterprise: true },
  { name: "Inventory & Purchase Orders", starter: false, professional: true, enterprise: true },
  { name: "Route Optimization", starter: false, professional: true, enterprise: true },
  { name: "AI Receipt Scanning", starter: false, professional: false, enterprise: true },
  { name: "API Access", starter: false, professional: false, enterprise: true },
  { name: "Custom Branding", starter: false, professional: true, enterprise: true },
  { name: "Advanced Reporting", starter: false, professional: true, enterprise: true },
  { name: "Priority Support", starter: false, professional: false, enterprise: true },
  { name: "Dedicated Account Manager", starter: false, professional: false, enterprise: true },
];

function FeatureValue({ value }: { value: boolean | string }) {
  if (typeof value === "string") return <span className="text-white text-sm">{value}</span>;
  return value ? (
    <Check className="h-4 w-4 text-green-400 mx-auto" />
  ) : (
    <X className="h-4 w-4 text-slate-600 mx-auto" />
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function PlansPage() {
  const [planBreakdown, setPlanBreakdown] = React.useState<Record<string, number>>({});
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    superAdminClient
      .get("/platform-admin/stats")
      .then((res) => setPlanBreakdown(res.data.planBreakdown ?? {}))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Plans & Features</h1>
        <p className="mt-1 text-sm text-slate-400">
          Feature comparison matrix and tenant distribution by plan
        </p>
      </div>

      {/* Plan summary cards */}
      {!loading && (
        <div className="grid grid-cols-3 gap-4">
          {Object.entries(PLANS).map(([key, plan]) => (
            <AdminStatCard
              key={key}
              label={plan.name}
              value={planBreakdown[key] ?? 0}
              sub={`$${plan.monthlyPrice}/mo · $${plan.annualPrice}/yr`}
              className="text-center"
            />
          ))}
        </div>
      )}

      {/* Pricing cards */}
      <div className="grid grid-cols-3 gap-4">
        {Object.entries(PLANS).map(([key, plan]) => (
          <div
            key={key}
            className={`rounded-xl bg-slate-800 p-6 ring-1 ring-white/5 ${key === "PROFESSIONAL" ? "ring-2 ring-blue-500/50" : ""}`}
          >
            {key === "PROFESSIONAL" && (
              <span className="mb-3 inline-block rounded-full bg-blue-600 px-3 py-0.5 text-xs font-semibold text-white">
                Most Popular
              </span>
            )}
            <h3 className={`text-lg font-bold ${plan.color}`}>{plan.name}</h3>
            <div className="mt-2 flex items-baseline gap-1">
              <span className="text-3xl font-bold text-white">${plan.monthlyPrice}</span>
              <span className="text-sm text-slate-500">/month</span>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              ${plan.annualPrice}/year (save{" "}
              {Math.round((1 - plan.annualPrice / (plan.monthlyPrice * 12)) * 100)}%)
            </p>
            <div className="mt-4 text-sm text-slate-400">
              {planBreakdown[key] ?? 0} active tenant{(planBreakdown[key] ?? 0) !== 1 ? "s" : ""}
            </div>
          </div>
        ))}
      </div>

      {/* Feature Matrix */}
      <AdminCard title="Feature Comparison" noPadding>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-xs uppercase tracking-wider text-slate-500">
                <th className="px-5 py-3 text-left w-1/3">Feature</th>
                <th className="px-5 py-3 text-center">Starter</th>
                <th className="px-5 py-3 text-center">Professional</th>
                <th className="px-5 py-3 text-center">Enterprise</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50">
              {FEATURES.map((f) => (
                <tr key={f.name} className="hover:bg-slate-700/20">
                  <td className="px-5 py-3 text-slate-300">{f.name}</td>
                  <td className="px-5 py-3 text-center">
                    <FeatureValue value={f.starter} />
                  </td>
                  <td className="px-5 py-3 text-center">
                    <FeatureValue value={f.professional} />
                  </td>
                  <td className="px-5 py-3 text-center">
                    <FeatureValue value={f.enterprise} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AdminCard>
    </div>
  );
}
