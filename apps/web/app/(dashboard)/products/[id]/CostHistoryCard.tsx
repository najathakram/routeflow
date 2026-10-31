"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useCostHistory } from "@/lib/api/cost-history";

export function CostHistoryCard({ productId }: { productId: string }) {
  const { data: history = [] } = useCostHistory(productId);

  if (history.length === 0) return null;

  const chartData = history.map((h) => ({
    date: new Date(h.date).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    purchaseCost: h.unitCost,
    avgCost: h.avgCostAfter,
    type: h.type,
  }));

  return (
    <div className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card">
      <div className="border-b border-surface-border px-5 py-3.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
          Purchase Cost History
        </h3>
      </div>
      <div className="p-5">
        <p className="mb-3 text-xs text-navy/70">
          Unit cost of each purchase (and manual cost-basis entries) with the running average cost.
        </p>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: "#1B3A5C99" }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "#1B3A5C99" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => `$${v}`}
            />
            <Tooltip
              contentStyle={{
                borderRadius: 8,
                border: "1px solid #e2e8f0",
                fontSize: 12,
                boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
              }}
              labelStyle={{ color: "#1B3A5C", fontWeight: 600 }}
              formatter={
                ((v: number, name: string) => [
                  `$${Number(v).toFixed(4)}`,
                  name === "purchaseCost" ? "Purchase cost" : "Avg cost after",
                ]) as any
              }
            />
            <Line
              type="stepAfter"
              dataKey="avgCost"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="purchaseCost"
              stroke="#f59e0b"
              strokeWidth={0}
              dot={{ r: 3, fill: "#f59e0b" }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
